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

  // Major roads + the main coastline only. Small water bodies (natural=water)
  // and rivers are intentionally excluded: they add clutter and slow the query.
  var q = '[out:json][timeout:20];(' +
    'way["highway"~"^(' + highwayRegex(z) + ')$"](' + bb + ');' +
    'way["natural"="coastline"](' + bb + ');' +
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
      for (var e = 0; e < els.length; e++) {
        var g = els[e].geometry;
        if (!g || g.length < 2) continue;
        var tags = els[e].tags || {};
        var t = (tags.highway === 'motorway' || tags.highway === 'trunk') ? 3 : 2;
        var prevX = null, prevY = null;
        for (var n = 0; n < g.length; n++) {
          var sx = Math.round(lonToX(g[n].lon, z) - tlx);
          var sy = Math.round(latToY(g[n].lat, z) - tly);
          if (prevX !== null) drawSeg(buf, W, H, prevX, prevY, sx, sy, ink, t);
          prevX = sx; prevY = sy;
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
