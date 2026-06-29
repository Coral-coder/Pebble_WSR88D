/* KSC Weather — PebbleKit JS. Holds the product registry and answers the
 * watch's requests: WXREQ_LIST returns the product titles; WXREQ_PRODUCT
 * fetches the latest content for one product and streams it to the watch.
 * Everything is fetched fresh on demand, so opening a product always shows the
 * latest data. */

var transport = require('./transport.js');
var products = require('./products.js');

var WXREQ_LIST = 1;
var WXREQ_PRODUCT = 2;

function sendList() {
  transport.sendDict({ PCOUNT: products.length }, function () {});
  products.forEach(function (p, i) {
    transport.sendDict({ PINDEX: i, PTITLE: p.title, PKIND: p.kind }, function () {});
  });
}

function sendProduct(idx) {
  var p = products[idx];
  if (!p) { transport.sendDict({ ERR: 'Unknown product' }, function () {}); return; }
  transport.sendDict({ STATUS: 'Loading ' + p.title + '...' }, function () {});
  try {
    p.fetch(function (err, res) {
      if (err || !res) {
        transport.sendText(p.title, 'Could not load: ' + (err && err.message ? err.message : 'error') +
          '\n\nPull again to retry.', function () {});
        return;
      }
      transport.sendText(res.title || p.title, res.body || '', function () {});
    });
  } catch (e) {
    transport.sendText(p.title, 'Error: ' + e.message, function () {});
  }
}

Pebble.addEventListener('ready', function () {
  sendList();
});

Pebble.addEventListener('appmessage', function (e) {
  var d = e.payload || {};
  if (typeof d.REQUEST === 'undefined') return;
  if (d.REQUEST === WXREQ_LIST) { sendList(); return; }
  if (d.REQUEST === WXREQ_PRODUCT) { sendProduct(d.PIDX | 0); return; }
});
