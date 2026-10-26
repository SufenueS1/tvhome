// Spike handlers. Loaded by service.js; `log`, `tizen` and `require` are sandbox globals.
var url = require('url');

var queue = [];   // commands the page picks up by polling /cmd
var reports = {}; // facts the page reports about itself

function launch(id, cb) {
  try {
    tizen.application.launch(id, function () { cb(null); }, function (e) { cb(e && e.message || String(e)); });
  } catch (e) { cb('throw: ' + (e && e.message || e)); }
}

module.exports.handle = function (req, res, send) {
  var u = url.parse(req.url, true);
  var q = u.query;
  switch (u.pathname) {
    case '/status': {
      var info = { node: process.version, tizenType: typeof tizen, reports: reports };
      try { info.self = tizen.application.getCurrentApplication().appInfo.id; } catch (e) { info.selfError = String(e); }
      return send(res, 200, info);
    }
    case '/apps':
      try {
        return tizen.application.getAppsInfo(function (list) {
          send(res, 200, list.map(function (a) { return { id: a.id, name: a.name, show: a.show, icon: a.iconPath }; }));
        }, function (e) { send(res, 500, { error: e && e.message || String(e) }); });
      } catch (e) { return send(res, 500, { error: 'throw: ' + (e && e.message || e) }); }
    case '/launch':
      return launch(q.id, function (err) { log('launch ' + q.id + ' -> ' + (err || 'ok')); send(res, err ? 500 : 200, { ok: !err, error: err }); });
    case '/queue':
      queue.push(q.cmd);
      return send(res, 200, { queued: q.cmd });
    case '/cmd':
      return send(res, 200, { cmd: queue.shift() || null });
    case '/report':
      reports[q.k] = q.v;
      log('report ' + q.k + '=' + q.v);
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: 'unknown ' + u.pathname });
  }
};
