// TizenBrew runs this in a vm sandbox with `tizen` and Node's `require`.
// It only owns the HTTP server; the handlers live in core.js, fetched from the
// CDN so they can be reloaded without rebooting the TV.
var http = require('http');
var https = require('https');
var vm = require('vm');

var PORT = 8095;
var BIND = '0.0.0.0'; // spike only: lets the PC read /status. Final build binds 127.0.0.1.
var CORE_URL = 'https://cdn.jsdelivr.net/gh/SufenueS1/tvhome@main/service/core.js';

var state = { logs: [], core: null, coreError: null, loadedAt: null };

function log(msg) {
  state.logs.push(new Date().toISOString() + ' ' + msg);
  if (state.logs.length > 300) state.logs.shift();
}

function fetchText(url, cb) {
  https.get(url + '?t=' + Date.now(), function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { body += c; });
    res.on('end', function () { cb(res.statusCode === 200 ? null : new Error('HTTP ' + res.statusCode), body); });
  }).on('error', function (e) { cb(e); });
}

function loadCore(done) {
  fetchText(CORE_URL, function (err, src) {
    if (err) { state.coreError = String(err); log('core load failed: ' + err); return done && done(err); }
    try {
      var sandbox = { require: require, tizen: tizen, console: console, setTimeout: setTimeout,
        clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
        Buffer: Buffer, process: process, module: { exports: {} }, log: log };
      vm.runInNewContext(src, sandbox);
      state.core = sandbox.module.exports;
      state.coreError = null;
      state.loadedAt = new Date().toISOString();
      log('core loaded');
      done && done(null);
    } catch (e) {
      state.coreError = String(e && e.stack || e);
      log('core eval failed: ' + state.coreError);
      done && done(e);
    }
  });
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  var path = req.url.split('?')[0];
  if (path === '/__reload') {
    return loadCore(function (err) { send(res, err ? 500 : 200, { ok: !err, error: state.coreError }); });
  }
  if (path === '/__logs') return send(res, 200, { logs: state.logs, coreError: state.coreError, loadedAt: state.loadedAt });
  if (!state.core) return send(res, 503, { error: 'core not loaded', coreError: state.coreError });
  try {
    state.core.handle(req, res, send);
  } catch (e) {
    log('handler error: ' + (e && e.stack || e));
    send(res, 500, { error: String(e) });
  }
}).listen(PORT, BIND, function () { log('listening on ' + BIND + ':' + PORT); });

loadCore();
