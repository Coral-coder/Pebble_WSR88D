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

// Keep map lines 1px (0 = no thickening). The gray AA feather below makes the
// thin lines smooth and easy to see without making them physically thicker.
var LINE_GROW = 0;

// Edge components smaller than this many pixels are treated as noise and
// dropped (de-speckles the map without removing real lines).
var MIN_EDGE_COMPONENT = 5;

// ink: the GColor8 byte for map lines (0xC0 black normally, 0xFF white when
// the map is inverted so lines show on the black background).
function mapEdgesToRLE(rgba, W, H, detail, ink) {
  var thr = EDGE_THRESHOLD[detail] !== undefined ? EDGE_THRESHOLD[detail] : 26;
  var strong = ink || 0xC0;
  // Antialiasing feather shade (one step from the line toward the background):
  // light gray on white, dark gray on black (inverted).
  var halo = strong === 0xFF ? 0xD5 : 0xEA;
  var N = W * H;

  // Grayscale; pixels with no tile data (alpha 0) become white so missing
  // tiles don't generate spurious edges.
  var gray = new Uint8Array(N);
  for (var i = 0, p = 0; p < N; p++, i += 4) {
    if (rgba[i + 3] < 128) { gray[p] = 255; continue; }
    gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }

  // 1) Edge detection (sharp 1px edges).
  var edge = new Uint8Array(N);
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var idx = y * W + x;
      var c = gray[idx];
      var gx = x + 1 < W ? Math.abs(gray[idx + 1] - c) : 0;
      var gy = y + 1 < H ? Math.abs(gray[idx + W] - c) : 0;
      if (gx + gy >= thr) edge[idx] = 1;
    }
  }

  // 2) Drop small connected components (8-connected): scattered noise blobs
  //    are tiny, real features (coastlines, borders, roads) are long, so this
  //    cleans the roughness while keeping the lines.
  var clean = new Uint8Array(N);
  var visited = new Uint8Array(N);
  var stack = [];
  var comp = [];
  for (var start = 0; start < N; start++) {
    if (!edge[start] || visited[start]) continue;
    stack.length = 0; comp.length = 0;
    stack.push(start); visited[start] = 1;
    while (stack.length) {
      var q = stack.pop();
      comp.push(q);
      var qx = q % W, qy = (q / W) | 0;
      for (var ddy = -1; ddy <= 1; ddy++) {
        var qny = qy + ddy; if (qny < 0 || qny >= H) continue;
        for (var ddx = -1; ddx <= 1; ddx++) {
          var qnx = qx + ddx; if (qnx < 0 || qnx >= W) continue;
          var nk = qny * W + qnx;
          if (edge[nk] && !visited[nk]) { visited[nk] = 1; stack.push(nk); }
        }
      }
    }
    if (comp.length >= MIN_EDGE_COMPONENT) {
      for (var ci = 0; ci < comp.length; ci++) clean[comp[ci]] = 1;
    }
  }

  // 3) Render a 2px core (grow +x/+y), then a 1px gray feather around it
  //    for an antialiased look.
  var colors = new Uint8Array(N);  // 0 = transparent
  var g = LINE_GROW;
  for (var cy = 0; cy < H; cy++) {
    for (var cx = 0; cx < W; cx++) {
      if (!clean[cy * W + cx]) continue;
      var y1 = cy + g >= H ? H - 1 : cy + g;
      var x1 = cx + g >= W ? W - 1 : cx + g;
      for (var yy = cy; yy <= y1; yy++) {
        for (var xx = cx; xx <= x1; xx++) colors[yy * W + xx] = strong;
      }
    }
  }
  for (var hy = 0; hy < H; hy++) {
    for (var hx = 0; hx < W; hx++) {
      if (colors[hy * W + hx] !== strong) continue;
      for (var fy = -1; fy <= 1; fy++) {
        var ny2 = hy + fy; if (ny2 < 0 || ny2 >= H) continue;
        for (var fx = -1; fx <= 1; fx++) {
          var nx2 = hx + fx; if (nx2 < 0 || nx2 >= W) continue;
          var fk = ny2 * W + nx2;
          if (colors[fk] === 0) colors[fk] = halo;
        }
      }
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
