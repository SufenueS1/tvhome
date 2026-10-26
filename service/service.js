// TizenBrew runs this in a vm sandbox with `tizen` and Node's `require`, inside its own
// service process. This file only owns the HTTP server and never throws; everything
// else lives in core.js, fetched from the CDN so it can be reloaded (GET /__reload)
// without rebooting the TV. Keep this file small: changing it needs a TV reboot.
var http = require('http');
var https = require('https');
var vm = require('vm');

var PORT = 8095;
var CORE_URL = 'https://cdn.jsdelivr.net/gh/SufenueS1/tvhome@main/service/core.js';

var state = { logs: [], core: null, coreError: null, loadedAt: null, loading: false };

function log(msg) {
  state.logs.push(new Date().toISOString() + ' ' + msg);
  if (state.logs.length > 300) state.logs.shift();
}

function fetchText(url, cb) {
  try {
    https.get(url + '?t=' + Date.now(), function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () { cb(res.statusCode === 200 ? null : new Error('HTTP ' + res.statusCode), body); });
      res.on('error', function (e) { cb(e); });
    }).on('error', function (e) { cb(e); });
  } catch (e) { cb(e); }
}

function loadCore(done) {
  fetchText(CORE_URL, function (err, src) {
    if (err) { state.coreError = String(err); log('core load failed: ' + err); return done && done(err); }
    try {
      var sandbox = { require: require, tizen: tizen, console: console, setTimeout: setTimeout,
        clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
        Buffer: Buffer, process: process, module: { exports: {} }, log: log };
      vm.runInNewContext(src, sandbox, { filename: 'core.js' });
      var next = sandbox.module.exports;
      if (state.core && state.core.dispose) {
        try { state.core.dispose(); } catch (e) { log('dispose failed: ' + e); }
      }
      state.core = next;
      if (next.init) next.init();
      state.coreError = null;
      state.loadedAt = new Date().toISOString();
      log('core loaded');
      if (done) done(null);
    } catch (e) {
      state.coreError = String(e && e.stack || e);
      log('core eval failed: ' + state.coreError);
      if (done) done(e);
    }
  });
}

function reply(res, code, obj) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  } catch (e) { log('reply failed: ' + e); }
}

var server = http.createServer(function (req, res) {
  try {
    var path = req.url.split('?')[0];
    if (path === '/__reload') {
      return loadCore(function (err) { reply(res, err ? 500 : 200, { ok: !err, error: state.coreError }); });
    }
    if (path === '/__logs') return reply(res, 200, { logs: state.logs, coreError: state.coreError, loadedAt: state.loadedAt });
    if (!state.core) return reply(res, 503, { error: 'core not loaded', coreError: state.coreError });
    state.core.handle(req, res);
  } catch (e) {
    log('handler error: ' + (e && e.stack || e));
    reply(res, 500, { error: String(e) });
  }
});
server.on('error', function (e) {
  log('server error: ' + e);
  // Port busy (e.g. an old copy still running): try again shortly.
  setTimeout(function () { try { server.listen(PORT, '0.0.0.0'); } catch (x) { log('relisten failed: ' + x); } }, 5000);
});
server.on('clientError', function (e, socket) { try { socket.destroy(); } catch (x) {} });
server.listen(PORT, '0.0.0.0', function () { log('listening on ' + PORT); });

loadCore();
