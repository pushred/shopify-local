const MIN = 1000 * 60;

const zlib = require('zlib');

const Hapi = require('hapi');
const hoek = require('hoek');
const {omit} = require('lodash');
const wreck = require('wreck');

const server = new Hapi.Server();

const cache = server.cache({
  segment: 'shopify',
  expiresIn: 30 * MIN
}); // catbox policy object

server.connection({ port: 3000 });

// shortcircuit CSP/XSS violation reports

server.route({
  method: 'POST',
  path: '/csp-report/{id*}',
  config: {
    payload: {
      parse: false,
      allow: 'application/csp-report'
    }
  },
  handler: function (request, reply) {
    return reply(null, 200);
  }
});

/*

  config: {
    cache: {
        expiresIn: 90 * 1000
    }
  },

*/

server.route({
  method: 'GET',
  path: '/{path*}',
  handler: function (request, reply) {
    cache.get(request.path, (err, cachedBody, details, report) => {
      let cacheControl = request.headers['cache-control'];

      //if (cachedBody) console.log('cached', cachedBody, details, report);

      return cachedBody && (cacheControl !== 'no-cache')
        ? reply(cachedBody)
        : reply.proxy({
            passThrough: true,
            localStatePassThrough: true,
            rejectUnauthorized: false,
            mapUri: getUri('https', 'ten-thousand-variants.myshopify.com', 443, request.path),
            onResponse: cacheResponse
          });
    });
  }
});

var good = {
  register: require('good'),
  options: {
    reporters: {
      console: [{
        module: 'good-squeeze',
        name: 'Squeeze',
        args: [{ log: '*', response: '*' }]
      }, {
        module: 'good-console'
      }, 'stdout']
    }
  }
};

server.register([
  require('h2o2'),
  //good
], function (err) {
  if (err) console.log('register error', err);

  server.start(function (err) {
    console.log('Server started at: ' + server.info.uri);
  });
});

function cacheResponse (err, response, request, reply) {
  var contentType = response.headers['content-type'];
  var contentEnc = response.headers['content-encoding'];

  if (/(text|json)/.test(contentType) === false) console.log('skipping', request.path, contentType);

  if (response.statusCode === 304 || /(text|json)/.test(contentType) === false) return reply(null, response);

  wreck.read(response, null, (err, body) => {
    if (err) console.log('read error', err);

    //var newResponse = hoek.clone(response);
    //response.headers = omit(response.headers, ['cache-control', 'content-security-policy-report-only', 'x-xss-protection']);

    if (contentEnc === 'gzip') body = zlib.gunzipSync(body);

    cache.set(request.path, body.toString(), null, err => {
      if (err) console.log('cache error', err);
      reply(null, body.toString());
    });
  });
}

function getUri (protocol, host, port, uri) {

    if (protocol &&
        protocol[protocol.length - 1] !== ':') {
        protocol += ':';
    }

    protocol = protocol || 'http:';
    port = port || (protocol === 'http:' ? 80 : 443);

    const baseUrl = protocol + '//' + host + ':' + port;

    return function (request, next) {
        //var headers = omit(hoek.clone(request.headers), ['cache-control']);
        var headers = hoek.clone(request.headers);

        var newHeaders = Object.keys(headers).reduce((newHeaders, key) => {
          let val = headers[key];

          newHeaders[key] = /\.dev/.test(val)
            ? 'ten-thousand-variants.myshopify.com'
            : val;

          return newHeaders;
        }, {});

        return next(null, baseUrl + request.path + (request.url.search || ''), newHeaders);
    };
};
