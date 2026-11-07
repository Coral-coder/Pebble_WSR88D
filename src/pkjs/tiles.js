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

// Build a W x H RGBA viewport centred on lat/lon, displayed at zoom zDisplay,
// using tiles fetched at zSrc (<= zDisplay). When zSrc < zDisplay the source
// tiles are nearest-neighbour upscaled by 2^(zDisplay-zSrc) — this lets the
// radar (RainViewer caps at zoom 7) follow the map past zoom 7. With
// zSrc == zDisplay it is a straight 1:1 composite. urlFn(tx,ty,z) -> URL.
// Missing/failed tiles stay transparent so one bad tile can't abort a pull.
function buildViewport(lat, lon, zDisplay, zSrc, W, H, urlFn, cb) {
  var f = Math.pow(2, zDisplay - zSrc);        // source px = display px / f
  var cxd = lonToTileX(lon, zDisplay) * TILE;
  var cyd = latToTileY(lat, zDisplay) * TILE;
  var tlxd = cxd - W / 2;                       // display top-left, global px
  var tlyd = cyd - H / 2;

  var n = Math.pow(2, zSrc);
  var tx0 = Math.floor(tlxd / f / TILE);
  var tx1 = Math.floor((tlxd + W - 1) / f / TILE);
  var ty0 = Math.floor(tlyd / f / TILE);
  var ty1 = Math.floor((tlyd + H - 1) / f / TILE);

  var need = [];
  for (var ty = ty0; ty <= ty1; ty++) {
    for (var tx = tx0; tx <= tx1; tx++) need.push({ tx: tx, ty: ty });
  }

  var store = {};
  var ok = 0;
  series(need, function (t, next) {
    var wx = ((t.tx % n) + n) % n;              // wrap longitude for the URL
    fetchPng(urlFn(wx, t.ty, zSrc), function (err, tile) {
      if (!err && tile) { store[t.tx + '_' + t.ty] = tile; ok++; }
      next(null);
    });
  }, function () {
    var view = new Uint8Array(W * H * 4);       // zero = transparent
    for (var y = 0; y < H; y++) {
      var sgy = (tlyd + y) / f;                  // source global y
      var sty = Math.floor(sgy / TILE);
      var py = Math.floor(sgy) - sty * TILE;
      var drow = y * W * 4;
      for (var x = 0; x < W; x++) {
        var sgx = (tlxd + x) / f;
        var stx = Math.floor(sgx / TILE);
        var px = Math.floor(sgx) - stx * TILE;
        var tile = store[stx + '_' + sty];
        if (!tile || px < 0 || px >= tile.w || py < 0 || py >= tile.h) continue;
        var si = (py * tile.w + px) * 4;
        var di = drow + x * 4;
        view[di] = tile.rgba[si];
        view[di + 1] = tile.rgba[si + 1];
        view[di + 2] = tile.rgba[si + 2];
        view[di + 3] = tile.rgba[si + 3];
      }
    }
    cb(null, view, ok);
  });
}

module.exports = {
  planTiles: planTiles,
  fetchPng: fetchPng,
  buildViewport: buildViewport,
  series: series
};
