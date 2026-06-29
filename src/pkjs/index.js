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
var vector = require('./vector.js');
var transport = require('./transport.js');
var BUILD = require('./build_number.js');   // CI run number this app was built from

var REPO = 'Coral-coder/Pebble_WSR88D';
var notifiedBuild = 0;

// Check GitHub for a newer release and notify on the watch if one exists.
// (The settings page also shows a one-tap install link — see preview.js.)
function checkForUpdate() {
  try {
    var x = new XMLHttpRequest();
    x.open('GET', 'https://api.github.com/repos/' + REPO + '/releases/latest', true);
    x.timeout = 15000;
    x.onload = function () {
      try {
        var r = JSON.parse(x.responseText);
        var m = /(\d+)/.exec(r.tag_name || '');
        var latest = m ? parseInt(m[1], 10) : 0;
        if (latest > BUILD && latest !== notifiedBuild) {
          notifiedBuild = latest;
          if (Pebble.showSimpleNotificationOnPebble) {
            Pebble.showSimpleNotificationOnPebble('WSR-88D Radar update',
              'Build ' + latest + ' is available. Open the watchface settings to install.');
          }
        }
      } catch (e) {}
    };
    x.send();
  } catch (e) {}
}

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
// Identity of the map currently on the watch; the map is only re-fetched when
// the view params change or the user moves >10% of the map width.
var lastBase = null;             // { lat, lon, zoom, detail, style, w, h }

function distanceM(lat1, lon1, lat2, lon2) {
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Exact-preview state: the actual pixel buffers (RLE) last sent to the watch.
// Passed to the settings page via Clay userData (the config webview has its own
// localStorage, so it can't read ours — it must come through the config URL).
var pv = { w: 200, h: 164, base: null, radar: null, wx: ['', '', ''], scan: '' };

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
    detail: Math.max(1, Math.min(5, num(s.DETAIL, 3) | 0)),
    zoom: Math.max(3, Math.min(11, num(s.ZOOM, 6) | 0)),
    // Map style (see mapPlan): 1 light HC (default), 3 dark HC, 4 Stamen Toner
    // streets, 0 full color, 2 dark grayscale, 9 custom URL.
    style: num(s.MAP_STYLE, 1) | 0,
    invert: [2, 3, 5].indexOf(num(s.MAP_STYLE, 1) | 0) >= 0 ? 1 : 0,
    stadiaKey: typeof s.STADIA_KEY === 'string' ? s.STADIA_KEY.replace(/\s/g, '') : '',
    mapUrlCustom: (typeof s.MAP_URL === 'string' && s.MAP_URL.indexOf('{z}') >= 0)
      ? s.MAP_URL : '',
    units: num(s.SET_UNITS, 0) | 0,
    updateMin: num(s.SET_UPDATE_MIN, 10) | 0
  };
}

// Resolve the tile URL + render mode + dark background for the chosen style.
// Stamen Toner (style 4) is the only source with true black roads on white,
// so it's the "streets" option; it needs a free Stadia Maps API key. Without a
// key it falls back to the no-key high-contrast land/water map.
function mapPlan(c) {
  var labels = c.detail >= 4;
  var voy = 'https://a.basemaps.cartocdn.com/rastertiles/voyager' +
            (labels ? '' : '_nolabels') + '/{z}/{x}/{y}.png';
  switch (c.style) {
    case 0: return { url: voy, mode: 'color', invert: 0 };
    case 2: return { url: voy, mode: 'darkgray', invert: 1 };
    case 3: return { url: voy, mode: 'darkhc', invert: 1 };
    case 4:
      if (c.stadiaKey) {
        return { url: 'https://tiles.stadiamaps.com/tiles/stamen_toner/' +
                 '{z}/{x}/{y}.png?api_key=' + encodeURIComponent(c.stadiaKey),
                 mode: 'raw', invert: 0 };
      }
      return { url: voy, mode: 'hc', invert: 0, note: 'Add a Stadia key for streets' };
    case 9:
      if (c.mapUrlCustom) return { url: c.mapUrlCustom, mode: 'color', invert: 0 };
      return { url: voy, mode: 'hc', invert: 0 };
    default: return { url: voy, mode: 'hc', invert: 0 };  // 1 = light HC
  }
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
  if (pending) { pending = false; doRefresh(); }
}

function doRefresh() {
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
      runRefresh(c, loc, idx.host, frames);
    });
  });
}

function runRefresh(c, loc, host, frames) {
  pv.lat = loc.lat; pv.lon = loc.lon;            // for the live settings preview
  var zMap = c.zoom;                              // map zoom (3..11)
  var zRad = Math.min(zMap, RADAR_MAX_ZOOM);      // radar tiles cap at 7
  var W = dims.w, H = dims.h;
  var nframes = frames.length;
  var isVector = (c.style === 1 || c.style === 5);  // bold roads+coastline
  var plan = isVector ? { url: 'vector', mode: '' } : mapPlan(c);
  if (plan.note) sendStatus(plan.note);

  // Re-fetch the map ONLY when the view params change or the user has moved
  // more than 10% of the visible map width. Otherwise keep what's on the watch.
  var sameView = lastBase && lastBase.zoom === zMap && lastBase.detail === c.detail &&
                 lastBase.style === c.style && lastBase.w === W && lastBase.h === H &&
                 lastBase.url === plan.url;
  var mpp = 156543.03 * Math.cos(loc.lat * Math.PI / 180) / Math.pow(2, zMap);
  var moved = sameView ? distanceM(lastBase.lat, lastBase.lon, loc.lat, loc.lon) : Infinity;
  var needBase = !sameView || moved > 0.10 * (W * mpp);

  function stashAndSendBase(rle, done) {
    pv.w = W; pv.h = H; pv.base = Array.prototype.slice.call(rle);
    lastBase = { lat: loc.lat, lon: loc.lon, zoom: zMap, detail: c.detail,
                 style: c.style, w: W, h: H, url: plan.url };
    transport.sendImage(IMG_KIND_BASE, 0, rle, function () { done(true); });
  }

  // Build the base map via raster tiles (Voyager/Toner/custom) at `mode`.
  function buildRaster(url, mode, done) {
    var mapFn = function (tx, ty, zz) {
      return url.replace('{z}', zz).replace('{x}', tx).replace('{y}', ty);
    };
    tiles.buildViewport(loc.lat, loc.lon, zMap, zMap, W, H, mapFn,
      function (err, view, ok) {
        if (!ok) { done(false); return; }
        stashAndSendBase(render.mapToRLE(view, W, H, mode), done);
      });
  }

  function buildBase(done) {
    if (isVector) {
      sendStatus('Loading map...');
      var ink = c.style === 5 ? 0xFF : 0xC0;
      vector.buildRoadsRLE(loc.lat, loc.lon, zMap, W, H, ink, c.detail,
        function (err, rle) {
          if (err || !rle) {
            // Keep the existing good map rather than blanking it; only fall
            // back to a raster map if we've never drawn one yet.
            if (lastBase) { done(true); return; }
            sendStatus('Roads unavailable');
            buildRaster(mapPlan({ style: 1, detail: c.detail }).url, 'hc', done);
            return;
          }
          stashAndSendBase(rle, done);
        });
    } else {
      buildRaster(plan.url, plan.mode, done);
    }
  }

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
        transport.sendDict({ BATCH: 0, STATUS: pv.scan },
          function () { finish(null); });
      });
    }

    if (!needBase) { sendFrames(); return; }

    // Always refresh the radar, whether or not the map (re)loaded — a map
    // fetch failure must never block the radar (or a scheme change).
    buildBase(function () { sendFrames(); });
  });
}

// --- Pebble events --------------------------------------------------------

Pebble.addEventListener('ready', function () {
  sanitizeStoredSettings();
  syncSettingsToWatch();
  doRefresh();
  checkForUpdate();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.SCR_W) dims.w = p.SCR_W;
  if (p.SCR_H) dims.h = p.SCR_H;
  // A request (launch or interval) refreshes radar; the map is only re-fetched
  // if the view changed or we've moved >10% of the map width. On reload the
  // watch shows its cached map, so no forced map refetch here.
  if (typeof p.REQUEST !== 'undefined') doRefresh();
});

// Hand the phone's last location + weather to the config page (the config
// webview has its own origin and can't read our storage, so it rides in the
// config URL). Kept small — the live preview fetches its own map/radar.
function setUserData() {
  try {
    clay.meta = clay.meta || {};
    clay.meta.userData = {
      w: pv.w, h: pv.h, wx: pv.wx, scan: pv.scan, lat: pv.lat, lon: pv.lon,
      build: BUILD, repo: REPO
    };
  } catch (e) {}
}

function openConfig() {
  setUserData();
  Pebble.openURL(clay.generateUrl());
}

Pebble.addEventListener('showConfiguration', function () {
  sanitizeStoredSettings();       // repair any legacy bad storage before prefill
  openConfig();
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // clay.getSettings() flattens {value:x} wrappers to scalars and writes them
  // to localStorage itself — do NOT overwrite that (raw form crashes Clay's
  // manipulators on the next open and breaks getConfig()). It also returns the
  // parsed settings, which carry the KEEP_OPEN flag set by the Save/Exit
  // buttons in the settings page.
  clay.getSettings(e.response);
  syncSettingsToWatch();
  // The map re-fetches only if style/detail/zoom actually changed (handled by
  // the view check in runRefresh); scheme/units changes just update the radar.
  doRefresh();
});
