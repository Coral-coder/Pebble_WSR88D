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
var MAP_BUILD_TIMEOUT = 35000;   // give up waiting on the map (radar still ships)

var dims = { w: 200, h: 164 };   // updated from the watch's SCR_W/SCR_H
var busy = false;
var pending = false;
// Identity of the map currently on the watch; the map is only re-fetched when
// the view params change or the user moves >10% of the map width.
var lastBase = null;             // { lat, lon, zoom, detail, style, w, h, url }
var lastBaseRLE = null;          // the full-res map RLE, cached on the phone
var restoreDims = null;          // { w, h } the cached RLE was rendered for
var lastRadar = null;            // { rle, scan } — newest radar frame + label
// Set on a watch/phone (re)launch: immediately push the cached full-res map +
// last radar scan so the watch shows the last known state within a second,
// BEFORE any network fetch. Fresh data then replaces it when it arrives.
var restorePending = false;

// When we couldn't get a fresh map and are riding the cached one, retry the
// map on this interval instead of waiting for the full update cycle.
var MAP_RETRY_MS = 5 * 60 * 1000;
var mapRetryTimer = null;

function scheduleMapRetry() {
  if (mapRetryTimer) clearTimeout(mapRetryTimer);
  mapRetryTimer = setTimeout(function () { mapRetryTimer = null; doRefresh(); }, MAP_RETRY_MS);
}
function clearMapRetry() {
  if (mapRetryTimer) { clearTimeout(mapRetryTimer); mapRetryTimer = null; }
}

// Persist the last good map (full-res RLE + view identity) on the phone so a
// PebbleKit-JS reload doesn't re-fetch an unchanged view (which otherwise
// causes a needless Overpass round-trip and "Roads busy" on every relaunch).
function saveBase(rle) {
  try {
    localStorage.setItem('wsr_base_gs', JSON.stringify({
      meta: lastBase, rle: Array.prototype.slice.call(rle)
    }));
  } catch (e) { /* storage full / unavailable — fine, just won't persist */ }
}
function loadBase() {
  try {
    var s = JSON.parse(localStorage.getItem('wsr_base_gs'));
    if (s && s.meta) {
      lastBase = s.meta;
      lastBaseRLE = (s.rle && s.rle.length) ? s.rle : null;
      restoreDims = { w: s.meta.w, h: s.meta.h };
      return;
    }
    // No current-format cache: fall back to the pre-grayscale cache as a
    // DISPLAY-ONLY map so the watch shows the last map instead of nothing.
    // Leave lastBase null so needBase stays true and a fresh grayscale map is
    // still fetched to replace it.
    var old = JSON.parse(localStorage.getItem('wsr_base'));
    if (old && old.meta && old.rle && old.rle.length) {
      lastBaseRLE = old.rle;
      restoreDims = { w: old.meta.w, h: old.meta.h };
    }
  } catch (e) { lastBase = null; lastBaseRLE = null; restoreDims = null; }
}

// Same for the newest radar frame: keep it (with its scan label) so a relaunch
// can restore the full last-known picture, not just the map.
function saveRadar() {
  try {
    if (lastRadar && lastRadar.rle) {
      localStorage.setItem('wsr_radar_gs', JSON.stringify(lastRadar));
    }
  } catch (e) { /* storage full — fine */ }
}
function loadRadar() {
  try {
    var r = JSON.parse(localStorage.getItem('wsr_radar_gs'));
    if (r && r.rle && r.rle.length) lastRadar = r;
  } catch (e) { lastRadar = null; }
}

// Instantly restore the watch's last-known scene from the phone cache: map
// first, then the newest radar frame as a 1-frame batch (with its old scan
// label — honest about its age). Runs before the network fetch so the watch is
// never blank while we wait on GPS/RainViewer/Overpass.
function pushCachedScene(done) {
  var haveBase = lastBaseRLE && restoreDims &&
                 restoreDims.w === dims.w && restoreDims.h === dims.h;
  // Radar is restored only alongside a dims-matched base — a frame cached for
  // different pixel dims would paint misaligned garbage.
  var haveRadar = haveBase && lastRadar && lastRadar.rle;
  function sendRadar() {
    if (!haveRadar) { done(); return; }
    transport.sendDict({ BATCH: 1, NFRAMES: 1 }, function (e) {
      if (e) { done(); return; }
      transport.sendImage(IMG_KIND_RADAR, 0, lastRadar.rle, function () {
        transport.sendDict({ BATCH: 0, STATUS: lastRadar.scan || '' },
          function () { done(); });
      });
    });
  }
  if (haveBase) transport.sendImage(IMG_KIND_BASE, 0, lastBaseRLE, sendRadar);
  else if (haveRadar) sendRadar();
  else done();
}

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

function saveLoc(loc) {
  try { localStorage.setItem('wsr_loc', JSON.stringify(loc)); } catch (e) {}
}
function loadLoc() {
  try {
    var l = JSON.parse(localStorage.getItem('wsr_loc'));
    if (l && isFinite(l.lat) && isFinite(l.lon)) return l;
  } catch (e) {}
  return null;
}

function getLocation(c, cb) {
  if (c.locMode === 1 && isFinite(c.lat) && isFinite(c.lon)) {
    cb(null, { lat: c.lat, lon: c.lon });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      saveLoc(loc);                     // remember for GPS-failure fallback
      cb(null, loc);
    },
    function (err) {
      // GPS unavailable/denied/slow must not block everything: fall back to the
      // last known location so the map + radar still load.
      var last = loadLoc();
      if (last) { sendStatus('Using last location'); cb(null, last); }
      else cb(err || new Error('location'));
    },
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
  var restore = restorePending;
  restorePending = false;

  // On a relaunch, put the last-known map + radar on the watch FIRST — the
  // fresh fetch (location, radar index, tiles) can take many seconds or fail.
  if (restore) { pushCachedScene(function () { refreshFetch(c); }); }
  else refreshFetch(c);
}

function refreshFetch(c) {
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

  // Send a freshly-built base RLE to the watch and record it as the current map.
  function stashAndSendBase(rle, done) {
    pv.w = W; pv.h = H; pv.base = Array.prototype.slice.call(rle);
    lastBase = { lat: loc.lat, lon: loc.lon, zoom: zMap, detail: c.detail,
                 style: c.style, w: W, h: H, url: plan.url };
    lastBaseRLE = pv.base;
    restoreDims = { w: W, h: H };
    saveBase(rle);                       // cache the full-res map on the phone
    transport.sendImage(IMG_KIND_BASE, 0, rle, function () { done(true); });
  }

  // Fetch the base map (network only — does NOT send). cb(rleUint8 | null);
  // null means "no usable map" and the watch keeps its cached one.
  function fetchBaseRLE(cb) {
    if (isVector) {
      sendStatus('Loading map...');
      var ink = c.style === 5 ? 0xFF : 0xC0;
      vector.buildRoadsRLE(loc.lat, loc.lon, zMap, W, H, ink, c.detail,
        function (err, rle) {
          if (err || !rle) { sendStatus('Roads busy — kept cached map'); cb(null); return; }
          cb(rle);
        });
    } else {
      var mapFn = function (tx, ty, zz) {
        return plan.url.replace('{z}', zz).replace('{x}', tx).replace('{y}', ty);
      };
      tiles.buildViewport(loc.lat, loc.lon, zMap, zMap, W, H, mapFn,
        function (err, view, ok) {
          cb(ok ? render.mapToRLE(view, W, H, plan.mode) : null);
        });
    }
  }

  // Radar and map load in PARALLEL. The radar is fetched, streamed, and
  // DISPLAYED first (so a slow/failing map never delays it); the map is fetched
  // concurrently and streamed afterwards (sends can't interleave on the one
  // AppMessage channel). A timeout caps how long we wait on the map.
  var baseRLE = null;
  var baseFetchDone = !needBase, baseSent = false, radarDone = false;

  function maybeSendBase() {
    if (!radarDone || !baseFetchDone || baseSent) return;
    baseSent = true;
    if (baseRLE) {
      clearMapRetry();   // got a fresh map — no need to retry soon
      stashAndSendBase(baseRLE, function () { finish(null); });
    } else {
      // Wanted a new map but rode the cached one — retry sooner than the
      // normal update cycle so a transient Overpass outage self-heals.
      if (needBase) scheduleMapRetry();
      finish(null);
    }
  }

  if (needBase) {
    fetchBaseRLE(function (rle) {
      if (baseSent) return;                 // map arrived after we gave up
      baseRLE = rle; baseFetchDone = true; maybeSendBase();
    });
    setTimeout(function () {                 // don't wait forever on the map
      if (!baseFetchDone && !baseSent) {
        sendStatus('Map slow — kept cached map');
        baseFetchDone = true; baseRLE = null; maybeSendBase();
      }
    }, MAP_BUILD_TIMEOUT);
  }

  function sendFrames(whenDone) {
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
          if (item.i === nframes - 1) pv.radar = Array.prototype.slice.call(rle);
          transport.sendImage(IMG_KIND_RADAR, item.i, rle, function () { next(null); });
        });
    }, whenDone);
  }

  transport.sendDict({ BATCH: 1, NFRAMES: nframes }, function (e) {
    if (e) { finish('Link error'); return; }
    sendFrames(function () {
      pv.scan = scanLabel(frames[nframes - 1].time, loc.lat, c);
      // Retain the newest frame + label on the phone for instant restore.
      if (pv.radar && pv.radar.length) {
        lastRadar = { rle: pv.radar, scan: pv.scan };
        saveRadar();
      }
      transport.sendDict({ BATCH: 0, STATUS: pv.scan }, function () {
        radarDone = true;   // radar is now on screen over the (cached) map
        maybeSendBase();    // ship the fresh map if it finished loading
      });
    });
  });
}

// --- Pebble events --------------------------------------------------------

Pebble.addEventListener('ready', function () {
  sanitizeStoredSettings();
  loadBase();              // restore the phone-side map cache (skip needless refetch)
  loadRadar();             // ...and the newest radar frame
  restorePending = true;   // put the last-known scene on the watch immediately
  syncSettingsToWatch();
  doRefresh();
  checkForUpdate();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.SCR_W) dims.w = p.SCR_W;
  if (p.SCR_H) dims.h = p.SCR_H;
  // A request (launch or interval) refreshes radar; the map is only re-fetched
  // if the view changed or we've moved >10% of the map width. A HELLO means the
  // watchface just (re)launched — instantly restore the last-known map + radar
  // from the phone cache before the fresh fetch starts.
  if (p.REQUEST === REQ_HELLO) restorePending = true;
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
