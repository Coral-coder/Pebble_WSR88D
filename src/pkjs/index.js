/* WSR-88D Radar — PebbleKit JS.
 *
 * Responds to refresh requests from the watch by:
 *   1. resolving the location (GPS or manual),
 *   2. reading the RainViewer frame index (no API key required),
 *   3. fetching CARTO map tiles + RainViewer radar tiles on the shared
 *      z/x/y grid, decoding them with UPNG,
 *   4. converting the map to black line-art and the radar to Pebble colors,
 *   5. streaming compact RLE pixel images to the watch.
 */

var Clay = require('pebble-clay');
var clayConfig = require('./config.js');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var tiles = require('./tiles.js');
var render = require('./render.js');
var transport = require('./transport.js');

// Must match src/c/wsr88d.h
var REQ_REFRESH = 1;
var REQ_HELLO = 2;
var IMG_KIND_BASE = 0;
var IMG_KIND_RADAR = 1;

var RADAR_INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
var RADAR_ALPHA_MIN = 40;

// Range labels (mirrors settings.c) for the bottom status line.
var RANGE_MI = [220, 110, 55];
var RANGE_KM = [350, 175, 90];

var dims = { w: 200, h: 176 };   // updated from the watch's SCR_W/SCR_H
var busy = false;
var pending = false;
var lastBaseKey = null;          // skip resending the map when unchanged

// --- settings -------------------------------------------------------------

function num(v, dflt) {
  var n = parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function getConfig() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('clay-settings')) || {}; }
  catch (e) { s = {}; }
  return {
    locMode: num(s.LOC_MODE, 0) | 0,
    lat: num(s.LOC_LAT, NaN),
    lon: num(s.LOC_LON, NaN),
    scheme: num(s.SET_SCHEME, 2) | 0,
    smooth: s.RADAR_SMOOTH === false ? 0 : 1,
    snow: s.RADAR_SNOW === false ? 0 : 1,
    frames: Math.max(1, Math.min(10, num(s.SET_FRAMES, 10) | 0)),
    animate: s.SET_ANIMATE === false ? 0 : 1,
    detail: num(s.MAP_DETAIL, 1) | 0,
    range: num(s.SET_RANGE, 1) | 0,
    mapUrl: s.MAP_URL ||
      'https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
    units: num(s.SET_UNITS, 0) | 0,
    updateMin: num(s.SET_UPDATE_MIN, 10) | 0
  };
}

function syncSettingsToWatch() {
  var c = getConfig();
  transport.sendDict({
    SET_UPDATE_MIN: c.updateMin,
    SET_ANIMATE: c.animate,
    SET_FRAMES: c.frames,
    SET_UNITS: c.units,
    SET_RANGE: c.range,
    SET_SCHEME: c.scheme
  }, function () {});
}

// --- small helpers --------------------------------------------------------

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function rangeValue(c) {
  var i = c.range >= 0 && c.range <= 2 ? c.range : 1;
  return c.units === 1 ? RANGE_KM[i] : RANGE_MI[i];
}

function scanLabel(unixSec, c) {
  var d = new Date(unixSec * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '  ' +
         rangeValue(c) + (c.units === 1 ? 'km' : 'mi');
}

function sendStatus(text) { transport.sendDict({ STATUS: text }, function () {}); }
function sendErr(text) { transport.sendDict({ ERR: text }, function () {}); }

function getLocation(c, cb) {
  if (c.locMode === 1 && isFinite(c.lat) && isFinite(c.lon)) {
    cb(null, { lat: c.lat, lon: c.lon });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) { cb(null, { lat: pos.coords.latitude, lon: pos.coords.longitude }); },
    function (err) { cb(err || new Error('location')); },
    { timeout: 15000, maximumAge: 600000, enableHighAccuracy: false });
}

function fetchRadarIndex(cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', RADAR_INDEX_URL, true);
  xhr.timeout = 15000;
  xhr.onload = function () {
    try { cb(null, JSON.parse(xhr.responseText)); }
    catch (e) { cb(e); }
  };
  xhr.onerror = function () { cb(new Error('network')); };
  xhr.ontimeout = function () { cb(new Error('timeout')); };
  xhr.send();
}

// --- refresh orchestration ------------------------------------------------

function finish(errText) {
  busy = false;
  if (errText) sendErr(errText);
  if (pending) { pending = false; doRefresh(false); }
}

function doRefresh(forceBase) {
  if (busy) { pending = true; return; }
  busy = true;

  var c = getConfig();
  sendStatus('Locating...');

  getLocation(c, function (err, loc) {
    if (err) { finish('No location'); return; }

    fetchRadarIndex(function (err2, idx) {
      if (err2 || !idx || !idx.radar || !idx.radar.past ||
          idx.radar.past.length === 0) {
        finish('No radar data');
        return;
      }
      var past = idx.radar.past;
      var n = Math.min(c.frames, past.length);
      var frames = past.slice(past.length - n);   // oldest .. newest
      runRefresh(c, loc, idx.host, frames, forceBase);
    });
  });
}

function runRefresh(c, loc, host, frames, forceBase) {
  var z = 5 + (c.range >= 0 && c.range <= 2 ? c.range : 1);  // 5/6/7
  var W = dims.w, H = dims.h;
  var nframes = frames.length;

  var baseKey = [loc.lat.toFixed(3), loc.lon.toFixed(3), z, c.detail, W, H,
                 c.mapUrl].join('|');
  var needBase = forceBase || baseKey !== lastBaseKey;

  transport.sendDict({ BATCH: 1, NFRAMES: nframes }, function (e) {
    if (e) { finish('Link error'); return; }

    function sendFrames() {
      var items = frames.map(function (f, i) { return { f: f, i: i }; });
      tiles.series(items, function (item, next) {
        var f = item.f;
        var urlFn = function (tx, ty, zz) {
          return host + f.path + '/256/' + zz + '/' + tx + '/' + ty + '/' +
                 c.scheme + '/' + c.smooth + '_' + c.snow + '.png';
        };
        tiles.buildViewport(loc.lat, loc.lon, z, W, H, urlFn,
          function (err, view) {
            var rle = render.radarToRLE(view, W, H, RADAR_ALPHA_MIN);
            transport.sendImage(IMG_KIND_RADAR, item.i, rle, function () {
              next(null);
            });
          });
      }, function () {
        transport.sendDict({ BATCH: 0,
          STATUS: scanLabel(frames[nframes - 1].time, c) },
          function () { finish(null); });
      });
    }

    if (!needBase) { sendFrames(); return; }

    var mapFn = function (tx, ty, zz) {
      return c.mapUrl.replace('{z}', zz).replace('{x}', tx).replace('{y}', ty);
    };
    tiles.buildViewport(loc.lat, loc.lon, z, W, H, mapFn,
      function (err, view, ok) {
        if (!ok) { finish('Map offline'); return; }
        var rle = render.mapEdgesToRLE(view, W, H, c.detail);
        lastBaseKey = baseKey;
        transport.sendImage(IMG_KIND_BASE, 0, rle, function () {
          sendFrames();
        });
      });
  });
}

// --- Pebble events --------------------------------------------------------

Pebble.addEventListener('ready', function () {
  syncSettingsToWatch();
  doRefresh(true);
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.SCR_W) dims.w = p.SCR_W;
  if (p.SCR_H) dims.h = p.SCR_H;
  if (typeof p.REQUEST !== 'undefined') {
    var hello = p.REQUEST === REQ_HELLO;
    if (hello) lastBaseKey = null;  // watch reloaded: resend the map too
    doRefresh(hello);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // convert=false returns raw values (numbers/booleans/strings), which is the
  // format both getConfig() and Clay's own prefill (generateUrl) expect.
  var dict = clay.getSettings(e.response, false);
  try { localStorage.setItem('clay-settings', JSON.stringify(dict)); }
  catch (err) {}
  syncSettingsToWatch();
  lastBaseKey = null;             // settings may change the map; force resend
  doRefresh(true);
});
