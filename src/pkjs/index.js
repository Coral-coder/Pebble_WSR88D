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
var clayPreview = require('./preview.js');
var clay = new Clay(clayConfig, clayPreview, { autoHandleEvents: false });

var tiles = require('./tiles.js');
var render = require('./render.js');
var transport = require('./transport.js');

// Must match src/c/wsr88d.h
var REQ_REFRESH = 1;
var REQ_HELLO = 2;
var IMG_KIND_BASE = 0;
var IMG_KIND_RADAR = 1;

var RADAR_INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
var WX_URL = 'https://api.open-meteo.com/v1/forecast';
var RADAR_ALPHA_MIN = 40;
var RADAR_MAX_ZOOM = 7;          // RainViewer tile cap

var dims = { w: 200, h: 164 };   // updated from the watch's SCR_W/SCR_H
var busy = false;
var pending = false;
var lastBaseKey = null;          // skip resending the map when unchanged

// Exact-preview state: the actual pixel buffers (RLE) last sent to the watch,
// stashed so the settings page can render a pixel-accurate preview.
var pv = { w: 200, h: 164, base: null, radar: null, wx: ['', '', ''], scan: '' };

function savePreview() {
  try {
    if (!pv.base) return;
    localStorage.setItem('wsr-preview', JSON.stringify(pv));
  } catch (e) {}
}

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
    zoom: Math.max(3, Math.min(11, num(s.ZOOM, 6) | 0)),
    // Map style: 0 light, 1 light high-contrast, 2 dark, 3 dark high-contrast.
    // High-contrast (1) is the default — it reads best on the watch.
    style: num(s.MAP_STYLE, 1) | 0,
    invert: num(s.MAP_STYLE, 1) >= 2 ? 1 : 0,
    contrast: (num(s.MAP_STYLE, 1) | 0) === 1 ||
              (num(s.MAP_STYLE, 1) | 0) === 3 ? 1 : 0,
    units: num(s.SET_UNITS, 0) | 0,
    updateMin: num(s.SET_UPDATE_MIN, 10) | 0
  };
}

// Always fetch the high-contrast CARTO Voyager tiles; dark mode is produced by
// inverting them in render.js (Dark Matter tiles quantize to near-black).
// "Detailed" (2) keeps place labels; otherwise a cleaner no-labels style.
function mapStyleUrl(c) {
  var labels = c.detail >= 2;
  return 'https://a.basemaps.cartocdn.com/rastertiles/voyager' +
         (labels ? '' : '_nolabels') + '/{z}/{x}/{y}.png';
}

// Repair stored settings that were written in Clay's raw (unflattened) form,
// e.g. { LOC_MODE: { value: "0" } }. Such objects crash Clay's component
// manipulators on the next config open, so unwrap them to scalars.
function sanitizeStoredSettings() {
  var s;
  try { s = JSON.parse(localStorage.getItem('clay-settings')); }
  catch (e) { return; }
  if (!s || typeof s !== 'object') return;
  var changed = false;
  Object.keys(s).forEach(function (k) {
    if (s[k] && typeof s[k] === 'object' && 'value' in s[k]) {
      s[k] = s[k].value;
      changed = true;
    }
  });
  if (changed) {
    try { localStorage.setItem('clay-settings', JSON.stringify(s)); }
    catch (e) {}
  }
}

function syncSettingsToWatch() {
  var c = getConfig();
  transport.sendDict({
    SET_UPDATE_MIN: c.updateMin,
    SET_ANIMATE: c.animate,
    SET_FRAMES: c.frames,
    SET_UNITS: c.units,
    SET_SCHEME: c.scheme,
    SET_INVERT: c.invert
  }, function () {});
}

// --- small helpers --------------------------------------------------------

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// True viewing radius from the zoom level, screen width and latitude.
function rangeValue(lat, c) {
  var mpp = 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, c.zoom);
  var halfMeters = (dims.w / 2) * mpp;
  return c.units === 1 ? Math.round(halfMeters / 1000)
                       : Math.round(halfMeters / 1609.34);
}

function scanLabel(unixSec, lat, c) {
  var d = new Date(unixSec * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '  ' +
         rangeValue(lat, c) + (c.units === 1 ? 'km' : 'mi');
}

// WMO weather code -> short condition word for the watch header.
function wmoText(code) {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'PCldy';
  if (code === 3) return 'Cloud';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drzl';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Shwrs';
  if (code <= 86) return 'Snow';
  return 'Storm';
}

// Fetch current conditions + today's high/low + rain chance, send to watch.
function fetchWeather(loc, c) {
  var unit = c.units === 1 ? 'celsius' : 'fahrenheit';
  var url = WX_URL + '?latitude=' + loc.lat.toFixed(4) +
            '&longitude=' + loc.lon.toFixed(4) +
            '&current=temperature_2m,weather_code' +
            '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
            '&temperature_unit=' + unit + '&timezone=auto&forecast_days=1';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.timeout = 15000;
  xhr.onload = function () {
    try {
      var j = JSON.parse(xhr.responseText);
      var t = Math.round(j.current.temperature_2m);
      var hi = Math.round(j.daily.temperature_2m_max[0]);
      var lo = Math.round(j.daily.temperature_2m_min[0]);
      var pop = j.daily.precipitation_probability_max[0];
      pv.wx = [t + '° ' + wmoText(j.current.weather_code),
               'H' + hi + ' L' + lo,
               'Rain ' + (pop == null ? 0 : pop) + '%'];
      transport.sendDict({
        WX_NOW: pv.wx[0], WX_HILO: pv.wx[1], WX_POP: pv.wx[2]
      }, function () {});
    } catch (e) { /* leave weather blank on parse failure */ }
  };
  xhr.send();
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

    fetchWeather(loc, c);  // fire-and-forget; updates the header when it lands

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
  var zMap = c.zoom;                              // map zoom (3..11)
  var zRad = Math.min(zMap, RADAR_MAX_ZOOM);      // radar tiles cap at 7
  var W = dims.w, H = dims.h;
  var nframes = frames.length;
  var mapUrl = mapStyleUrl(c);

  var baseKey = [loc.lat.toFixed(3), loc.lon.toFixed(3), zMap, c.detail,
                 c.style, W, H, mapUrl].join('|');
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
        tiles.buildViewport(loc.lat, loc.lon, zMap, zRad, W, H, urlFn,
          function (err, view) {
            var rle = render.radarToRLE(view, W, H, RADAR_ALPHA_MIN);
            if (item.i === nframes - 1) {     // newest frame -> preview
              pv.radar = Array.prototype.slice.call(rle);
            }
            transport.sendImage(IMG_KIND_RADAR, item.i, rle, function () {
              next(null);
            });
          });
      }, function () {
        pv.scan = scanLabel(frames[nframes - 1].time, loc.lat, c);
        savePreview();
        transport.sendDict({ BATCH: 0, STATUS: pv.scan },
          function () { finish(null); });
      });
    }

    if (!needBase) { sendFrames(); return; }

    var mapFn = function (tx, ty, zz) {
      return mapUrl.replace('{z}', zz).replace('{x}', tx).replace('{y}', ty);
    };
    tiles.buildViewport(loc.lat, loc.lon, zMap, zMap, W, H, mapFn,
      function (err, view, ok) {
        if (!ok) { finish('Map offline'); return; }
        var rle = render.mapToRLE(view, W, H, c.invert, c.contrast);
        pv.w = W; pv.h = H; pv.base = Array.prototype.slice.call(rle);
        lastBaseKey = baseKey;
        transport.sendImage(IMG_KIND_BASE, 0, rle, function () {
          sendFrames();
        });
      });
  });
}

// --- Pebble events --------------------------------------------------------

Pebble.addEventListener('ready', function () {
  sanitizeStoredSettings();
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
  sanitizeStoredSettings();       // repair any legacy bad storage before prefill
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // clay.getSettings() flattens {value:x} wrappers to scalars and writes them
  // to localStorage itself — do NOT overwrite that (raw form crashes Clay's
  // manipulators on the next open and breaks getConfig()).
  clay.getSettings(e.response);
  syncSettingsToWatch();
  lastBaseKey = null;             // settings may change the map; force resend
  doRefresh(true);
});
