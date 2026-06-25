/* Turn RGBA viewports into the compact RLE pixel streams the watch consumes.
 *
 * - Base map: edge-detect the source tiles into black line-art on a
 *   transparent (white-on-watch) background. Source colours are irrelevant,
 *   so any tile style works; the detail level just moves the edge threshold.
 * - Radar: quantize each pixel to a Pebble GColor8 byte, transparent where
 *   the source tile is transparent (no precipitation).
 */

var TRANSPARENT = 0x00;

// Pack 8-bit RGB into a Pebble GColor8 argb byte (2 bits/channel, opaque).
function toGColor(r, g, b) {
  var r2 = (r * 3 + 127) / 255 | 0;
  var g2 = (g * 3 + 127) / 255 | 0;
  var b2 = (b * 3 + 127) / 255 | 0;
  return 0xC0 | (r2 << 4) | (g2 << 2) | b2;  // 0xC0 = opaque alpha
}

// Edge thresholds per map-detail level (0 minimal .. 2 detailed).
var EDGE_THRESHOLD = [44, 26, 14];

function mapEdgesToRLE(rgba, W, H, detail) {
  var thr = EDGE_THRESHOLD[detail] !== undefined ? EDGE_THRESHOLD[detail] : 26;

  // Grayscale; pixels with no tile data (alpha 0) become white so missing
  // tiles don't generate spurious edges.
  var gray = new Uint8Array(W * H);
  for (var i = 0, p = 0; p < W * H; p++, i += 4) {
    if (rgba[i + 3] < 128) { gray[p] = 255; continue; }
    gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }

  var colors = new Uint8Array(W * H);  // 0 = transparent
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var idx = y * W + x;
      var c = gray[idx];
      var gx = x + 1 < W ? Math.abs(gray[idx + 1] - c) : 0;
      var gy = y + 1 < H ? Math.abs(gray[idx + W] - c) : 0;
      if (gx + gy >= thr) colors[idx] = 0xC0;  // black line
    }
  }
  return encodeRLE(colors);
}

function radarToRLE(rgba, W, H, alphaMin) {
  var colors = new Uint8Array(W * H);
  for (var p = 0, i = 0; p < W * H; p++, i += 4) {
    if (rgba[i + 3] < alphaMin) continue;  // transparent: no precip
    colors[p] = toGColor(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  return encodeRLE(colors);
}

// Run-length encode a per-pixel color array into [countLo,countHi,color]*.
function encodeRLE(colors) {
  var out = [];
  var n = colors.length;
  var i = 0;
  while (i < n) {
    var c = colors[i];
    var run = 1;
    while (i + run < n && colors[i + run] === c && run < 65535) run++;
    out.push(run & 0xff, (run >> 8) & 0xff, c);
    i += run;
  }
  return Uint8Array.from(out);
}

module.exports = {
  mapEdgesToRLE: mapEdgesToRLE,
  radarToRLE: radarToRLE,
  TRANSPARENT: TRANSPARENT
};
