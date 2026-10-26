// Home service handlers. Loaded by service.js; `log`, `tizen` and `require` are sandbox globals.
// Local requests (the Home page) get the full API. LAN requests get read-only
// endpoints, the PC agent endpoints, and admin endpoints only with the agent's key.
var url = require('url');
var fs = require('fs');
var tls = require('tls');
var crypto = require('crypto');
var dgram = require('dgram');

var CONFIG_PATH = '/home/owner/share/tvhome.json';
var AGENT_GRACE_MS = 5000; // between polls the agent still counts as online for this long

var cfg = {};
var queue = [];        // commands for the page (dev/testing), picked up via /cmd
var reports = {};      // facts the page reports about itself
var pc = { lastSeen: 0, waiting: null };
var iconCache = {};
var appCache = null;

function loadConfig() {
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { cfg = {}; }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { log('config save failed: ' + e); }
}

function isLocal(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function hasKey(req) {
  // Until a PC agent registers there is no key, so the LAN can set things up.
  if (!cfg.pc || !cfg.pc.token) return true;
  return req.headers['x-home-key'] === cfg.pc.token;
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function (c) { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', function () { try { cb(null, body ? JSON.parse(body) : {}); } catch (e) { cb(e); } });
}

// ---- apps ----------------------------------------------------------------

function listApps(cb) {
  if (appCache && Date.now() - appCache.at < 60000) return cb(null, appCache.list);
  try {
    tizen.application.getAppsInfo(function (list) {
      var out = [];
      list.forEach(function (a) {
        if (!a.show || !a.iconPath) return;
        iconCache[a.id] = a.iconPath;
        out.push({ id: a.id, name: a.name });
      });
      appCache = { at: Date.now(), list: out };
      cb(null, out);
    }, function (e) { cb(e && e.message || String(e)); });
  } catch (e) { cb(String(e)); }
}

function launch(id, cb) {
  try {
    tizen.application.launch(id, function () { cb(null); }, function (e) { cb(e && e.message || String(e)); });
  } catch (e) { cb(String(e && e.message || e)); }
}

function sendIcon(res, id, send) {
  var p = iconCache[id];
  if (!p) return send(res, 404, { error: 'no icon' });
  fs.readFile(p, function (err, buf) {
    if (err) return send(res, 404, { error: 'icon read failed' });
    var type = /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png';
    send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
  });
}

// ---- TV remote keys (Samsung websocket API on this TV) --------------------
// Used for HDMI switching. The first use shows an Allow prompt for "Home" on the TV.

function wsFrame(text) {
  var payload = Buffer.from(text);
  var mask = crypto.randomBytes(4);
  var len = payload.length;
  var head = len < 126 ? Buffer.from([0x81, 0x80 | len])
    : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]);
  for (var i = 0; i < len; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, payload]);
}

function tvKey(key, cb) {
  var done = false;
  function finish(err) { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch (e) {} cb(err); }
  var timer = setTimeout(function () { finish('timeout (was the Allow prompt answered?)'); }, 35000);
  var name = Buffer.from('Home').toString('base64');
  var path = '/api/v2/channels/samsung.remote.control?name=' + name + (cfg.tvToken ? '&token=' + cfg.tvToken : '');
  var buf = Buffer.alloc(0);
  var upgraded = false;
  var sock = tls.connect({ host: '127.0.0.1', port: 8002, rejectUnauthorized: false }, function () {
    sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:8002\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('error', function (e) { finish(String(e)); });
  sock.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      var end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      if (buf.slice(0, 12).toString().indexOf('101') < 0) return finish('upgrade refused');
      upgraded = true;
      buf = buf.slice(end + 4);
    }
    while (buf.length >= 2) {
      var len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      var text = buf.slice(off, off + len).toString();
      buf = buf.slice(off + len);
      var msg; try { msg = JSON.parse(text); } catch (e) { continue; }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token) { cfg.tvToken = msg.data.token; saveConfig(); }
        sock.write(wsFrame(JSON.stringify({ method: 'ms.remote.control', params: {
          Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } })));
        setTimeout(function () { finish(null); }, 400);
      } else if (msg.event === 'ms.channel.unauthorized' || msg.event === 'ms.channel.timeOut') {
        finish('not allowed on the TV');
      }
    }
  });
}

// ---- PC link -------------------------------------------------------------
// The PC agent registers itself and long-polls /pc/next for commands, so the PC
// needs no inbound firewall rule.

// Commands are handed straight to a waiting poll and never queued, so nothing
// fires late (e.g. a shutdown pressed while the PC slept running when it wakes).
function pcOnline() { return !!pc.waiting || Date.now() - pc.lastSeen < AGENT_GRACE_MS; }

function pcCommand(action) {
  if (!pc.waiting) return false;
  var w = pc.waiting; pc.waiting = null;
  w(action);
  return true;
}

function wake(cb) {
  if (!cfg.pc || !cfg.pc.mac) return cb('PC not set up');
  var mac = Buffer.from(cfg.pc.mac.replace(/[^0-9a-f]/gi, ''), 'hex');
  if (mac.length !== 6) return cb('bad MAC');
  var packet = Buffer.alloc(102, 0xff);
  for (var i = 0; i < 16; i++) mac.copy(packet, 6 + i * 6);
  var targets = ['255.255.255.255'];
  if (cfg.pc.host) targets.push(cfg.pc.host.replace(/\.\d+$/, '.255'));
  var s = dgram.createSocket('udp4');
  s.on('error', function (e) { try { s.close(); } catch (x) {} cb(String(e)); });
  s.bind(function () {
    s.setBroadcast(true);
    var left = targets.length * 3;
    targets.forEach(function (t) {
      for (var n = 0; n < 3; n++) {
        s.send(packet, 0, packet.length, 9, t, function () { if (--left === 0) { s.close(); cb(null); } });
      }
    });
  });
}

// ---- HTTP ----------------------------------------------------------------

var READ_ONLY = { '/apps': 1, '/icon': 1, '/status': 1, '/config': 1 };

module.exports.init = function () { initialized = true; loadConfig(); log('config: pc=' + !!(cfg.pc && cfg.pc.token) + ' tvToken=' + !!cfg.tvToken); };

module.exports.dispose = function () {
  if (pc.waiting) pc.waiting(null);
};

var initialized = false;

module.exports.handle = function (req, res, send) {
  if (!initialized) { initialized = true; module.exports.init(); }
  var u = url.parse(req.url, true);
  var q = u.query;
  var p = u.pathname;
  var local = isLocal(req);

  // PC agent endpoints authenticate themselves.
  if (p === '/pc/register') {
    return readBody(req, function (err, b) {
      if (err || !b.token) return send(res, 400, { error: 'bad body' });
      if (cfg.pc && cfg.pc.token && cfg.pc.token !== b.token) return send(res, 403, { error: 'token mismatch' });
      cfg.pc = { token: b.token, name: b.name, mac: b.mac, host: req.socket.remoteAddress.replace('::ffff:', '') };
      if (b.weather) cfg.weather = b.weather;
      saveConfig();
      pc.lastSeen = Date.now();
      log('pc registered: ' + b.name + ' @ ' + cfg.pc.host);
      send(res, 200, { ok: true });
    });
  }
  if (p === '/pc/next') {
    if (!cfg.pc || q.token !== cfg.pc.token) return send(res, 403, { error: 'unknown agent' });
    pc.lastSeen = Date.now();
    cfg.pc.host = req.socket.remoteAddress.replace('::ffff:', '');
    if (pc.waiting) pc.waiting(null); // only one poller at a time
    var answered = false;
    var waiter = function (cmd) {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      if (pc.waiting === waiter) pc.waiting = null;
      pc.lastSeen = Date.now();
      send(res, 200, { cmd: cmd || null });
    };
    var timer = setTimeout(function () { waiter(null); }, 25000);
    pc.waiting = waiter;
    req.on('close', function () {
      if (!answered) { answered = true; clearTimeout(timer); if (pc.waiting === waiter) pc.waiting = null; }
    });
    return;
  }

  if (!local && !READ_ONLY[p] && !hasKey(req)) return send(res, 403, { error: 'forbidden' });

  switch (p) {
    case '/status':
      return send(res, 200, { node: process.version, pcOnline: pcOnline(), pcPaired: !!(cfg.pc && cfg.pc.token),
        tvKeyPaired: !!cfg.tvToken, reports: local || hasKey(req) ? reports : undefined });
    case '/config':
      return send(res, 200, { weather: cfg.weather || null,
        pc: cfg.pc ? { name: cfg.pc.name, online: pcOnline(), canWake: !!cfg.pc.mac } : null });
    case '/apps':
      return listApps(function (err, list) { send(res, err ? 500 : 200, err ? { error: err } : list); });
    case '/icon':
      if (!iconCache[q.id]) return listApps(function () { sendIcon(res, q.id, send); });
      return sendIcon(res, q.id, send);
    case '/launch':
      return launch(q.id, function (err) { log('launch ' + q.id + ' -> ' + (err || 'ok')); send(res, err ? 500 : 200, { ok: !err, error: err }); });
    case '/tv/key':
      if (!/^KEY_[A-Z0-9_]+$/.test(q.k || '')) return send(res, 400, { error: 'bad key' });
      return tvKey(q.k, function (err) { log('key ' + q.k + ' -> ' + (err || 'ok')); send(res, err ? 500 : 200, { ok: !err, error: err }); });
    case '/pc/wake':
      return wake(function (err) { log('wake -> ' + (err || 'sent')); send(res, err ? 500 : 200, { ok: !err, error: err }); });
    case '/pc/power':
      if (['shutdown', 'restart', 'sleep', 'lock', 'cancel'].indexOf(q.action) < 0) return send(res, 400, { error: 'bad action' });
      // The agent re-polls right after each reply; give it a moment if we caught that gap.
      var tries = 0;
      return (function attempt() {
        if (pcCommand(q.action)) { log('pc ' + q.action); return send(res, 200, { ok: true }); }
        if (++tries > 15 || Date.now() - pc.lastSeen > AGENT_GRACE_MS) return send(res, 409, { error: 'PC is offline' });
        setTimeout(attempt, 100);
      })();
    case '/queue':
      queue.push(q.cmd);
      return send(res, 200, { queued: q.cmd });
    case '/cmd':
      return send(res, 200, { cmd: queue.shift() || null });
    case '/report':
      reports[q.k] = q.v;
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: 'unknown ' + p });
  }
};
