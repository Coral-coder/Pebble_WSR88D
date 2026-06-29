/* KSC weather products. Each product is text (v1): fetch(cb) -> cb(err,{title,
 * body}). The Cape is a fixed location, so no geolocation is needed. Image
 * products (SKEW-T, TDRWP, Cape windflow) are added in a later iteration once
 * their URLs/formats are verified on the phone. */

// Kennedy Space Center / Cape Canaveral.
var LAT = 28.5729, LON = -80.6490;
var PT = LAT.toFixed(4) + ',' + LON.toFixed(4);
var NWS = 'https://api.weather.gov';
var OM = 'https://api.open-meteo.com/v1/forecast';
var AFD_OFFICE = 'MLB';          // NWS Melbourne CWA covers KSC/CCSFS
var CAP = 2800;                  // keep bodies within the watch's text buffer

function clean(s) {
  if (!s) return '';
  return String(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/°/g, ' ')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function getJSON(url, cb) {
  var x = new XMLHttpRequest();
  x.open('GET', url, true); x.timeout = 20000;
  try { x.setRequestHeader('Accept', 'application/geo+json'); } catch (e) {}
  try { x.setRequestHeader('User-Agent', 'KSC-Weather-Pebble (dsthunder@gmail.com)'); } catch (e) {}
  x.onload = function () {
    if (x.status < 200 || x.status >= 300) { cb(new Error('HTTP ' + x.status)); return; }
    try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
  };
  x.onerror = function () { cb(new Error('network')); };
  x.ontimeout = function () { cb(new Error('timeout')); };
  x.send();
}

function compass(deg) {
  var d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return d[Math.round(((deg % 360) / 22.5)) % 16];
}
function wmo(code) {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

// 7-day NWS forecast (two-step: point -> forecast URL).
function forecast(cb) {
  getJSON(NWS + '/points/' + PT, function (e, p) {
    if (e || !p || !p.properties || !p.properties.forecast) { cb(e || new Error('no point')); return; }
    getJSON(p.properties.forecast, function (e2, f) {
      if (e2 || !f || !f.properties) { cb(e2 || new Error('no forecast')); return; }
      var ps = f.properties.periods || [], out = '';
      for (var i = 0; i < ps.length && out.length < CAP; i++) {
        out += clean(ps[i].name) + ': ' + clean(ps[i].detailedForecast) + '\n\n';
      }
      cb(null, { title: 'Forecast', body: out || 'No forecast available.' });
    });
  });
}

// Active NWS watches/warnings/advisories for the Cape.
function advisories(cb) {
  getJSON(NWS + '/alerts/active?point=' + PT, function (e, j) {
    if (e) { cb(e); return; }
    var fs = (j && j.features) || [];
    if (!fs.length) { cb(null, { title: 'Advisories', body: 'No active advisories for the Cape.' }); return; }
    var out = '';
    for (var i = 0; i < fs.length && out.length < CAP; i++) {
      var a = fs[i].properties || {};
      out += '* ' + clean(a.event) + '\n' + clean(a.headline) + '\n' +
             clean(a.description) + '\n\n';
    }
    cb(null, { title: 'Advisories', body: out });
  });
}

// Current conditions (Open-Meteo, no key).
function current(cb) {
  var url = OM + '?latitude=' + LAT + '&longitude=' + LON +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,' +
    'wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';
  getJSON(url, function (e, j) {
    if (e || !j || !j.current) { cb(e || new Error('no data')); return; }
    var c = j.current;
    var body =
      'Sky: ' + wmo(c.weather_code) + '\n' +
      'Temp: ' + Math.round(c.temperature_2m) + ' F\n' +
      'Feels: ' + Math.round(c.apparent_temperature) + ' F\n' +
      'Humidity: ' + Math.round(c.relative_humidity_2m) + ' %\n' +
      'Wind: ' + compass(c.wind_direction_10m) + ' ' + Math.round(c.wind_speed_10m) + ' mph\n' +
      'Gusts: ' + Math.round(c.wind_gusts_10m) + ' mph\n' +
      'Pressure: ' + Math.round(c.pressure_msl) + ' hPa\n' +
      'Updated: ' + clean(c.time);
    cb(null, { title: 'Current', body: body });
  });
}

// NWS Area Forecast Discussion (the forecaster's technical writeup).
function discussion(cb) {
  getJSON(NWS + '/products/types/AFD/locations/' + AFD_OFFICE, function (e, j) {
    var g = (j && (j['@graph'] || j.products)) || [];
    if (e || !g.length) { cb(e || new Error('no AFD list')); return; }
    getJSON(NWS + '/products/' + g[0].id, function (e2, p) {
      if (e2 || !p || !p.productText) { cb(e2 || new Error('no AFD text')); return; }
      cb(null, { title: 'Forecast Discussion', body: clean(p.productText).slice(0, CAP) });
    });
  });
}

module.exports = [
  { id: 'forecast',   title: 'Forecast',            kind: 0, fetch: forecast },
  { id: 'advisories', title: 'Advisories',          kind: 0, fetch: advisories },
  { id: 'current',    title: 'Current Conditions',  kind: 0, fetch: current },
  { id: 'afd',        title: 'Forecast Discussion', kind: 0, fetch: discussion }
];
