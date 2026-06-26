/* Vector basemap: query OpenStreetMap (Overpass API, free, no key) for major
 * roads + coastline + water in the current view and draw them as bold lines.
 * Produces a clean, glanceable, high-contrast map (no labels, no minor streets,
 * no quantization) that renders perfectly in the watch's color space.
 *
 * Uses the same Web-Mercator projection as the radar tiles so the roads line
 * up with the radar exactly.
 */
var render = require('./render.js');

var OVERPASS = 'https://overpass-api.de/api/interpreter?data=';
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

// Which road classes to include at a given zoom — fewer when zoomed out so the
// view stays glanceable and the query stays small.
function highwayRegex(z) {
  if (z <= 7) return 'motorway|trunk';
  if (z <= 9) return 'motorway|trunk|primary';
  if (z <= 11) return 'motorway|trunk|primary|secondary';
  return 'motorway|trunk|primary|secondary|tertiary';
}

// Is this natural=water way a real body of water (not a pond/stream/river)?
function isBigWater(el) {
  var g = el.geometry;
  if (!g || g.length < 18) return false;          // small/simple -> skip
  var w = (el.tags && el.tags.water) || '';
  if (/pond|stream|ditch|canal|drain|wastewater|reflecting|river/.test(w)) return false;
  return true;
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
// (0xC0 black for light maps, 0xFF white for dark). cb(err, rleUint8).
function buildRoadsRLE(lat, lon, z, W, H, ink, cb) {
  var cx = lonToX(lon, z), cy = latToY(lat, z);
  var tlx = cx - W / 2, tly = cy - H / 2;
  var west = xToLon(tlx, z), east = xToLon(tlx + W, z);
  var north = yToLat(tly, z), south = yToLat(tly + H, z);
  var bb = south + ',' + west + ',' + north + ',' + east;

  // Major roads + coastline + water polygons. Small ponds/streams/rivers are
  // filtered out at render time (by subtag + size) so only real bodies of
  // water show.
  var q = '[out:json][timeout:20];(' +
    'way["highway"~"^(' + highwayRegex(z) + ')$"](' + bb + ');' +
    'way["natural"="coastline"](' + bb + ');' +
    'way["natural"="water"](' + bb + ');' +
    ');out geom;';

  var xhr = new XMLHttpRequest();
  xhr.open('GET', OVERPASS + encodeURIComponent(q), true);
  xhr.timeout = 25000;
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { cb(new Error('HTTP ' + xhr.status)); return; }
    try {
      var data = JSON.parse(xhr.responseText);
      var els = data.elements || [];
      var buf = new Uint8Array(W * H);  // 0 = transparent
      var water = ink === 0xFF ? 0xD5 : 0xEA;  // gray water fill
      var e, n, g, tags, pts;

      // Pass 1: fill large water bodies.
      for (e = 0; e < els.length; e++) {
        tags = els[e].tags || {};
        if (tags.natural !== 'water' || !isBigWater(els[e])) continue;
        g = els[e].geometry; pts = [];
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
      cb(null, render.encodeRLE(buf));
    } catch (err) { cb(err); }
  };
  xhr.onerror = function () { cb(new Error('overpass network')); };
  xhr.ontimeout = function () { cb(new Error('overpass timeout')); };
  xhr.send();
}

module.exports = { buildRoadsRLE: buildRoadsRLE };
