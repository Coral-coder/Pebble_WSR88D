/* Vector basemap: query OpenStreetMap (Overpass API, free, no key) for major
 * roads + coastline + water in the current view and draw them as bold lines.
 * Produces a clean, glanceable, high-contrast map (no labels, no minor streets,
 * no quantization) that renders perfectly in the watch's color space.
 *
 * Uses the same Web-Mercator projection as the radar tiles so the roads line
 * up with the radar exactly.
 */
var render = require('./render.js');

// Several public Overpass mirrors. The default instance is frequently busy or
// rate-limited; trying mirrors in turn makes "Roads unavailable" (which leaves
// nothing to cache) rare instead of common.
var OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter?data=',
  'https://overpass.kumi.systems/api/interpreter?data=',
  'https://lz4.overpass-api.de/api/interpreter?data=',
  'https://overpass.openstreetmap.fr/api/interpreter?data='
];
var OVERPASS_TIMEOUT = 10000;   // per-mirror; several mirrors tried in turn
var TILE = 256;

function lonToX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z) * TILE; }
function latToY(lat, z) {
  var r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 *
         Math.pow(2, z) * TILE;
}
function xToLon(px, z) { return px / TILE / Math.pow(2, z) * 360 - 180; }
function yToLat(px, z) {
  var n = Math.PI - 2 * Math.PI * (px / TILE) / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// Road classes by detail level (1 = major only .. 5 = down to residential).
function highwayRegex(detail) {
  var c = ['motorway', 'trunk'];
  if (detail >= 2) c.push('primary');
  if (detail >= 3) c.push('secondary');
  if (detail >= 4) c.push('tertiary');
  if (detail >= 5) c.push('residential', 'unclassified');
  return c.join('|');
}

// Minimum water-body boundary size by detail level: higher detail shows
// smaller bodies.
function waterMinNodes(detail) {
  var m = 50 - detail * 9;
  return m < 8 ? 8 : m;
}

// Collect fillable water polygons (node arrays) from natural=water ways and
// multipolygon relations, keeping only those with >= minNodes boundary points.
function waterPolys(els, minNodes) {
  var out = [];
  for (var e = 0; e < els.length; e++) {
    var el = els[e], tags = el.tags || {};
    if (tags.natural !== 'water') continue;
    if (el.type === 'way' && el.geometry && el.geometry.length >= minNodes) {
      out.push(el.geometry);
    } else if (el.type === 'relation' && el.members) {
      for (var m = 0; m < el.members.length; m++) {
        var mm = el.members[m];
        if (mm.type === 'way' && (mm.role === 'outer' || !mm.role) &&
            mm.geometry && mm.geometry.length >= minNodes) {
          out.push(mm.geometry);
        }
      }
    }
  }
  return out;
}

// Scanline-fill a polygon (array of [x,y]) into the color buffer.
function fillPoly(buf, W, H, pts, col) {
  var minY = H, maxY = 0, i, j;
  for (i = 0; i < pts.length; i++) {
    if (pts[i][1] < minY) minY = pts[i][1];
    if (pts[i][1] > maxY) maxY = pts[i][1];
  }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (var y = minY; y <= maxY; y++) {
    var xs = [];
    for (i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var yi = pts[i][1], yj = pts[j][1];
      if ((yi > y) !== (yj > y)) {
        xs.push(pts[i][0] + (y - yi) / (yj - yi) * (pts[j][0] - pts[i][0]));
      }
    }
    xs.sort(function (a, b) { return a - b; });
    for (var k = 0; k + 1 < xs.length; k += 2) {
      var x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (var x = x0; x <= x1; x++) buf[y * W + x] = col;
    }
  }
}

// Draw a thick line segment into the W*H color buffer (t = pixel thickness).
function drawSeg(buf, W, H, x0, y0, x1, y1, col, t) {
  var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  var err = dx - dy, x = x0, y = y0, guard = dx + dy + 4;
  while (guard-- > 0) {
    for (var oy = 0; oy < t; oy++) {
      var py = y + oy; if (py < 0 || py >= H) continue;
      for (var ox = 0; ox < t; ox++) {
        var px = x + ox; if (px < 0 || px >= W) continue;
        buf[py * W + px] = col;
      }
    }
    if (x === x1 && y === y1) break;
    var e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// Build a bold roads+coastline RLE for the view. ink is the line GColor8 byte
// (0xC0 black for light maps, 0xFF white for dark). detail (1..5) scales road
// classes and the water-size threshold. cb(err, rleUint8).
function buildRoadsRLE(lat, lon, z, W, H, ink, detail, cb) {
  var cx = lonToX(lon, z), cy = latToY(lat, z);
  var tlx = cx - W / 2, tly = cy - H / 2;
  var west = xToLon(tlx, z), east = xToLon(tlx + W, z);
  var north = yToLat(tly, z), south = yToLat(tly + H, z);
  var bb = south + ',' + west + ',' + north + ',' + east;

  // Major roads + coastline + water (ways AND multipolygon relations — big
  // lagoons/rivers are often relations). Small ponds are filtered by size at
  // render time so only real bodies of water show.
  var q = '[out:json][timeout:25];(' +
    'way["highway"~"^(' + highwayRegex(detail) + ')$"](' + bb + ');' +
    'way["natural"="coastline"](' + bb + ');' +
    'way["natural"="water"](' + bb + ');' +
    'relation["natural"="water"](' + bb + ');' +
    ');out geom;';

  // Turn an Overpass element list into the bold-roads RLE.
  function renderEls(els) {
    var buf = new Uint8Array(W * H);  // 0 = transparent
    var water = ink === 0xFF ? 0xD5 : 0xEA;  // gray water fill
    var e, n, g, tags, pts;
    // Pass 1: fill water bodies (ways + relation outers) above the threshold.
    var polys = waterPolys(els, waterMinNodes(detail));
    for (e = 0; e < polys.length; e++) {
      g = polys[e]; pts = [];
      for (n = 0; n < g.length; n++) {
        pts.push([lonToX(g[n].lon, z) - tlx, latToY(g[n].lat, z) - tly]);
      }
      fillPoly(buf, W, H, pts, water);
    }
    // Pass 2: roads + coastline as thin lines on top.
    for (e = 0; e < els.length; e++) {
      tags = els[e].tags || {};
      if (tags.natural === 'water') continue;
      g = els[e].geometry; if (!g || g.length < 2) continue;
      var t = (tags.highway === 'motorway' || tags.highway === 'trunk') ? 2 : 1;
      var px = null, py = null;
      for (n = 0; n < g.length; n++) {
        var sx = Math.round(lonToX(g[n].lon, z) - tlx);
        var sy = Math.round(latToY(g[n].lat, z) - tly);
        if (px !== null) drawSeg(buf, W, H, px, py, sx, sy, ink, t);
        px = sx; py = sy;
      }
    }
    // Guard: if essentially nothing was drawn (geometry off-view, or a result
    // with no usable roads), treat it as a miss so we keep the cached map
    // rather than shipping a near-blank one that would wipe the screen.
    var inkPx = 0;
    for (var q2 = 0; q2 < buf.length; q2++) { if (buf[q2]) inkPx++; }
    if (inkPx < 30) return null;
    return render.encodeRLE(buf);
  }

  // Try each mirror in turn; only give up (and keep the cached map) once every
  // mirror has failed or returned nothing.
  function attempt(i) {
    if (i >= OVERPASS_MIRRORS.length) { cb(new Error('overpass unavailable')); return; }
    var next = function () { attempt(i + 1); };
    var xhr = new XMLHttpRequest();
    try { xhr.open('GET', OVERPASS_MIRRORS[i] + encodeURIComponent(q), true); }
    catch (eo) { next(); return; }
    xhr.timeout = OVERPASS_TIMEOUT;
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) { next(); return; }
      var els;
      try { els = (JSON.parse(xhr.responseText).elements) || []; }
      catch (ep) { next(); return; }
      if (!els.length) { next(); return; }   // flaky/empty mirror -> try another
      var rle;
      try { rle = renderEls(els); }
      catch (er) { cb(er); return; }
      if (!rle) { next(); return; }           // nothing usable drawn -> try another
      cb(null, rle);
    };
    xhr.onerror = next;
    xhr.ontimeout = next;
    try { xhr.send(); } catch (es) { next(); }
  }
  attempt(0);
}

module.exports = { buildRoadsRLE: buildRoadsRLE };
