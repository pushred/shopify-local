#!/usr/bin/env node

const Path = require('path');
const zlib = require('zlib');

const chokidar = require('chokidar');
const Hapi = require('hapi');
const hoek = require('hoek');
const {omit} = require('lodash');
const wreck = require('wreck');

const MIN = 1000 * 60;
const PORT = 3000;
const THEME_PATH = Path.join(process.cwd(), 'shopify', 'theme');

var cache;
var cachedPaths = [];

function startProxy () {
  const server = new Hapi.Server();
  const liquidFiles = chokidar.watch(Path.join(THEME_PATH, '**', '*.liquid'));

  server.connection({ port: PORT });

  cache = server.cache({
    segment: 'shopify',
    expiresIn: 30 * MIN
  }); // catbox policy object

  liquidFiles.on('change', () => {
    cachedPaths.forEach(path => cache.drop(path));
  });

  const logging = {
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
    require('inert')
    //logging
  ], function (err) {
    if (err) console.log('register error', err);

    server.start(function (err) {
      console.log('Server started at: ' + server.info.uri);
    });
  });

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

  server.route({
    method: 'GET',
    path: '/{path*}',
    handler: function (request, reply) {
      cache.get(request.path, (err, cachedResponse, details, report) => {
        let cacheControl = request.headers['cache-control'];

        //if (cachedBody) console.log('cached', cachedBody, details, report);

        console.log(cachedResponse);

        return cachedResponse && (cacheControl !== 'no-cache')
          ? reply(cachedResponse.body).type(cachedResponse.type).charset(cachedResponse.charset)
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

  server.route({
    method: 'GET',
    path: '/assets/{file}',
    handler: {
      directory: {
        path: Path.join(THEME_PATH, 'assets')
      }
    }
  });

}

function cacheResponse (err, response, request, reply) {
  var contentType = response.headers['content-type'].split(';').shift().trim(); // strip charset
  var charset = response.headers['content-type'].split('charset=').pop().trim(); // extract charset
  var contentEnc = response.headers['content-encoding'];

  if (/(text|json)/.test(contentType) === false) console.log('skipping', request.path, contentType);

  if (response.statusCode === 304 || /(text|json)/.test(contentType) === false) return reply(null, response);

  wreck.read(response, null, (err, body) => {
    if (err) console.log('read error', err);

    //var newResponse = hoek.clone(response);
    //response.headers = omit(response.headers, ['cache-control', 'content-security-policy-report-only', 'x-xss-protection']);

    var responseBody = (contentEnc === 'gzip')
      ? zlib.gunzipSync(body).toString()
      : zlib.body.toString();

    // point theme asset references to static root
    responseBody = responseBody.replace(/\"(https?|\/\/)(.*\/t\/[0-9]*\/assets)/gi, '"/assets');

    // install browsersync
    responseBody = responseBody.replace(/<\/body>/gi, `
      <script async src="http://${request.info.hostname}:3001/browser-sync/browser-sync-client.js?v=2.17.6"></script>
    `);

    cache.set(request.path, { type: contentType, charset: charset, body: responseBody }, null, err => {
      if (err) console.log('cache error', err);
      cachedPaths.push(request.path);
      reply(null, responseBody);
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

        if (Path.extname(request.path) === '.json') {
          var proxyHeaders = {
            'content-type': 'application/json'
          }
        }

        return next(null, baseUrl + request.path + (request.url.search || ''), Object.assign({}, newHeaders, proxyHeaders));
    };
}

(module.parent)
  ? module.exports = startProxy
  : startProxy();
