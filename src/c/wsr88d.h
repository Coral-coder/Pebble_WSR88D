#pragma once
#include <pebble.h>

// ---------------------------------------------------------------------------
// WSR-88D Radar — shared definitions
//
// The phone (PebbleKit JS) does all image work: it downloads map + radar PNG
// tiles, decodes them, thresholds the map to a black/white road outline,
// quantizes the radar to Pebble's color space, and ships compact run-length
// encoded (RLE) pixel streams to the watch. The watch is a thin, fast
// compositor that paints those streams to the framebuffer.
//
// RLE stream format (produced by src/pkjs/render.js, consumed by scene.c):
//   A flat byte array of records, row-major over a MAP_W x MAP_H image:
//     [count_lo, count_hi, color]  (count is uint16 little-endian)
//   `color` is a raw GColor8 argb byte. color == 0x00 means TRANSPARENT
//   (skip these pixels, leaving whatever is underneath). The sum of all
//   `count` values equals MAP_W * MAP_H exactly.
// ---------------------------------------------------------------------------

#define WSR_MAX_FRAMES 10
#define WSR_TRANSPARENT 0x00

// Image kinds for IMG_KIND.
#define IMG_KIND_BASE  0   // base map outline (drawn once per location)
#define IMG_KIND_RADAR 1   // a single radar frame

// REQUEST reasons (watch -> JS).
#define REQ_REFRESH 1      // fetch everything fresh
#define REQ_HELLO   2      // handshake: JS should reply with current data

// Default settings (mirrored in src/pkjs/config.js).
#define DEF_UPDATE_MIN 10
#define DEF_ANIMATE    1
#define DEF_FRAMES     10
#define DEF_UNITS      0   // 0 = miles, 1 = km
#define DEF_RANGE      1   // index into range table (0 wide .. 2 local)
#define DEF_SCHEME     2   // RainViewer "Original" scheme

// App-level hooks implemented in main.c, called by comm.c.
void app_set_status(const char *text);
void app_set_scan_label(const char *text);
void app_settings_changed(void);
