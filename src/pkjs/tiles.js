/* Web Mercator slippy-tile math + PNG tile fetching/compositing.
 *
 * Map tiles (CARTO) and radar tiles (RainViewer) share the identical z/x/y
 * grid, so a single tile plan positions both layers pixel-for-pixel.
 */
var UPNG = require('./vendor/UPNG.js');

var TILE = 256;

function lonToTileX(lon, z) {
  return (lon + 180) / 360 * Math.pow(2, z);
}

function latToTileY(lat, z) {
  var r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 *
         Math.pow(2, z);
}

// Returns the list of tiles intersecting a W x H viewport centred on lat/lon,
// each with the pixel offset (ox,oy) of the tile's top-left corner within the
// viewport (may be negative).
function planTiles(lat, lon, z, W, H) {
  var cx = lonToTileX(lon, z) * TILE;   // centre, global pixels
  var cy = latToTileY(lat, z) * TILE;
  var tlx = cx - W / 2;                 // viewport top-left, global pixels
  var tly = cy - H / 2;

  var n = Math.pow(2, z);
  var x0 = Math.floor(tlx / TILE);
  var x1 = Math.floor((tlx + W - 1) / TILE);
  var y0 = Math.floor(tly / TILE);
  var y1 = Math.floor((tly + H - 1) / TILE);

  var tiles = [];
  for (var ty = y0; ty <= y1; ty++) {
    for (var tx = x0; tx <= x1; tx++) {
      tiles.push({
        tx: ((tx % n) + n) % n,           // wrap longitude
        ty: ty,                           // latitude is clamped by caller/zoom
        ox: Math.round(tx * TILE - tlx),
        oy: Math.round(ty * TILE - tly)
      });
    }
  }
  return tiles;
}

function fetchPng(url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300 || !xhr.response) {
      cb(new Error('HTTP ' + xhr.status));
      return;
    }
    try {
      var img = UPNG.decode(xhr.response);
      var rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);
      cb(null, { w: img.width, h: img.height, rgba: rgba });
    } catch (e) {
      cb(e);
    }
  };
  xhr.onerror = function () { cb(new Error('network')); };
  xhr.ontimeout = function () { cb(new Error('timeout')); };
  xhr.send();
}

// Run an async iterator over items one at a time (bounded memory/concurrency).
function series(items, iter, done) {
  var i = 0;
  function next(err) {
    if (err) { done(err); return; }
    if (i >= items.length) { done(null); return; }
    var item = items[i++];
    iter(item, next);
  }
  next(null);
}

// Blit a decoded tile's RGBA into the viewport RGBA buffer at (ox,oy).
function blit(dst, W, H, tile, ox, oy) {
  var tw = tile.w, th = tile.h, src = tile.rgba;
  for (var y = 0; y < th; y++) {
    var dy = oy + y;
    if (dy < 0 || dy >= H) continue;
    var srow = y * tw * 4;
    var drow = dy * W * 4;
    for (var x = 0; x < tw; x++) {
      var dx = ox + x;
      if (dx < 0 || dx >= W) continue;
      var si = srow + x * 4;
      var di = drow + dx * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

// Build a W x H RGBA viewport for a layer. urlFn(tx,ty,z) -> tile URL.
// Missing/failed tiles are left transparent so one bad tile can't abort a pull.
function buildViewport(lat, lon, z, W, H, urlFn, cb) {
  var tiles = planTiles(lat, lon, z, W, H);
  var view = new Uint8Array(W * H * 4);  // zero = transparent
  var ok = 0;
  series(tiles, function (t, next) {
    fetchPng(urlFn(t.tx, t.ty, z), function (err, tile) {
      if (!err && tile) { blit(view, W, H, tile, t.ox, t.oy); ok++; }
      next(null);  // tolerate individual tile failures
    });
  }, function () {
    cb(null, view, ok);  // ok = number of tiles successfully fetched
  });
}

module.exports = {
  planTiles: planTiles,
  fetchPng: fetchPng,
  buildViewport: buildViewport,
  series: series
};
