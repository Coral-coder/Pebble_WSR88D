#include "scene.h"
#include "wsr88d.h"
#include "settings.h"

#define ANIM_FRAME_MS 280   // dwell per frame while looping
#define ANIM_HOLD_MS  900   // extra dwell on the newest frame at the end

// Cache the base map AND the newest radar frame across reloads. Persistent
// storage is only 4KB total: the map is stored losslessly when it fits (else
// as a half-res 1-bit mask), the radar best-effort in the leftover budget.
// Flash writes are kept OUT of the AppMessage handler (synchronous flash
// writes there made the app go "not responding") via a short timer, and ALSO
// forced on unload — a watchface is unloaded constantly (notifications,
// wrist-down, menu, quick-launch), so a long deferral meant the cache was
// usually never written and every reload came up blank.
#define PERSIST_CHUNK       256
#define PK_FMT_KEY          199   // stored map format (see PK_FMT_*)
#define PK_DATA_LEN         200   // stored map length in bytes
#define PK_DATA_CHUNK0      210   // first map chunk key (uses up to 16 keys)
#define PK_DATA_MAX         3584  // budget for the map (persist total is 4KB)
#define PK_MASK_MAX         1200  // half-res mask is always well under this
#define PK_FMT_NONE         0
#define PK_FMT_MASK         1     // half-res 1-bit ink mask (lossy fallback)
#define PK_FMT_RAW          2     // the exact base RLE (lossless, full quality)
// Newest radar frame, cached best-effort in whatever budget the map left over.
// Light-precip frames RLE-compress to well under this; a stormy frame that
// doesn't fit simply isn't persisted (the phone re-pushes it on launch anyway).
#define RK_LEN              240   // stored radar length in bytes
#define RK_CHUNK0           241   // first radar chunk key (uses up to 6 keys)
#define RK_NKEYS            6
#define RK_MAX              (RK_NKEYS * PERSIST_CHUNK)
// Write the cache promptly (just off the AppMessage handler, to avoid the
// synchronous-flash "not responding" stall) AND again on unload, so a map is
// cached even if the watchface is open for under a second.
#define PERSIST_DELAY_MS    300

static void persist_clear(void) {
  persist_delete(PK_FMT_KEY);
  persist_delete(PK_DATA_LEN);
  for (int k = 0; k < 16; k++) persist_delete(PK_DATA_CHUNK0 + k);
}

static void radar_persist_clear(void) {
  persist_delete(RK_LEN);
  for (int k = 0; k < RK_NKEYS; k++) persist_delete(RK_CHUNK0 + k);
}

// Write len bytes across chunk keys starting at chunk0. Returns false (without
// clearing) if any chunk write is short — e.g. the 4KB persist budget ran out.
static bool persist_write_chunks(int chunk0, const uint8_t *buf, uint32_t len) {
  uint32_t off = 0; int idx = 0;
  while (off < len) {
    uint32_t n = len - off; if (n > PERSIST_CHUNK) n = PERSIST_CHUNK;
    if (persist_write_data(chunk0 + idx, buf + off, n) < (int)n) return false;
    off += n; idx++;
  }
  return true;
}

// Read a chunked blob whose byte length is stored at len_key. NULL on any miss.
static uint8_t *persist_read_chunks(int len_key, int chunk0, uint32_t cap,
                                    uint32_t *out) {
  *out = 0;
  if (!persist_exists(len_key)) return NULL;
  int32_t len = persist_read_int(len_key);
  if (len <= 0 || (uint32_t)len > cap) return NULL;
  uint8_t *buf = malloc(len);
  if (!buf) return NULL;
  uint32_t off = 0; int idx = 0;
  while (off < (uint32_t)len) {
    uint32_t n = (uint32_t)len - off; if (n > PERSIST_CHUNK) n = PERSIST_CHUNK;
    if (persist_read_data(chunk0 + idx, buf + off, n) < (int)n) { free(buf); return NULL; }
    off += n; idx++;
  }
  *out = (uint32_t)len;
  return buf;
}

// Read the stored map blob (raw RLE or mask). *fmt/*out describe it.
static uint8_t *persist_get(int *fmt, uint32_t *out) {
  *fmt = PK_FMT_NONE; *out = 0;
  if (!persist_exists(PK_FMT_KEY)) return NULL;
  int f = persist_read_int(PK_FMT_KEY);
  if (f != PK_FMT_MASK && f != PK_FMT_RAW) return NULL;
  uint8_t *buf = persist_read_chunks(PK_DATA_LEN, PK_DATA_CHUNK0, PK_DATA_MAX, out);
  if (buf) *fmt = f;
  return buf;
}

static Layer *s_layer;
static int s_w, s_h;
static int s_ox, s_oy;   // layer origin on screen (framebuffer is full-screen)

static uint8_t *s_base;          // base map outline RLE (owned)
static uint32_t s_base_len;

static uint8_t *s_frames[WSR_MAX_FRAMES];  // chronological: [0]=oldest
static uint32_t s_frame_len[WSR_MAX_FRAMES];
static uint8_t s_frame_count;    // frames currently loaded

static int8_t s_display_frame;   // frame index being drawn (-1 = none)
static bool s_animating;
static bool s_invert;            // black background when true
static AppTimer *s_anim_timer;
static AppTimer *s_persist_timer;
static bool s_base_dirty;        // base changed but not yet written to flash
static bool s_radar_dirty;       // newest radar changed but not yet written
static uint8_t s_incoming_max;   // frames received in the current batch

// --- framebuffer pixel helpers -------------------------------------------

// Set one pixel on the captured framebuffer to a raw GColor8 byte. Handles
// the 8-bit color framebuffer (emery/basalt/chalk) and the 1-bit framebuffer
// (diorite) by thresholding on luminance.
static inline void fb_set(GBitmapDataRowInfo *row, int x, uint8_t color,
                          bool one_bit) {
  if (x < row->min_x || x > row->max_x) return;
  if (one_bit) {
    GColor c = (GColor){ .argb = color };
    // crude luminance: treat anything not near-black as "on" (white)
    bool on = (c.r + c.g + c.b) >= 4;  // r/g/b are 0..3
    uint8_t *byte = &row->data[x >> 3];
    uint8_t mask = 1 << (x & 7);
    if (on) *byte |= mask; else *byte &= ~mask;
  } else {
    row->data[x] = color;
  }
}

// Walk an RLE stream and paint non-transparent pixels onto the framebuffer.
static void apply_rle(GBitmap *fb, const uint8_t *rle, uint32_t len,
                      bool one_bit) {
  if (!rle || len < 3) return;
  const uint32_t total = (uint32_t)s_w * (uint32_t)s_h;
  uint32_t p = 0;     // linear pixel index
  uint32_t i = 0;     // byte index into rle
  int cur_y = -1;
  GBitmapDataRowInfo row = (GBitmapDataRowInfo){0};

  while (i + 3 <= len && p < total) {
    uint16_t count = (uint16_t)rle[i] | ((uint16_t)rle[i + 1] << 8);
    uint8_t color = rle[i + 2];
    i += 3;

    if (color == WSR_TRANSPARENT) {
      p += count;
      continue;
    }
    while (count > 0 && p < total) {
      int x = (int)(p % s_w);
      int y = (int)(p / s_w);
      int fy = s_oy + y;                 // framebuffer is full-screen
      if (fy != cur_y) {
        row = gbitmap_get_data_row_info(fb, fy);
        cur_y = fy;
      }
      // paint the rest of this run that lies on row y
      int run = s_w - x;
      if ((uint32_t)run > count) run = count;
      for (int k = 0; k < run; k++) {
        fb_set(&row, s_ox + x + k, color, one_bit);
      }
      p += run;
      count -= run;
    }
  }
}

static void scene_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);

  // Background: white (paper-map look) or black when inverted.
  graphics_context_set_fill_color(ctx, s_invert ? GColorBlack : GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  if (!s_base && s_frame_count == 0) {
    return;  // nothing loaded yet; main.c shows a status line
  }

  GBitmap *fb = graphics_capture_frame_buffer(ctx);
  if (!fb) return;
  bool one_bit = gbitmap_get_format(fb) == GBitmapFormat1Bit;

  apply_rle(fb, s_base, s_base_len, one_bit);
  if (s_frame_count > 0 && s_display_frame >= 0 &&
      s_display_frame < s_frame_count) {
    apply_rle(fb, s_frames[s_display_frame], s_frame_len[s_display_frame],
              one_bit);
  }

  graphics_release_frame_buffer(ctx, fb);
}

// --- animation ------------------------------------------------------------

static void anim_tick(void *ctx) {
  s_anim_timer = NULL;
  if (!s_animating) return;

  if (s_display_frame >= s_frame_count - 1) {
    // reached newest frame: hold, then stop
    s_display_frame = s_frame_count - 1;
    s_animating = false;
    layer_mark_dirty(s_layer);
    return;
  }
  s_display_frame++;
  layer_mark_dirty(s_layer);
  s_anim_timer = app_timer_register(ANIM_FRAME_MS, anim_tick, NULL);
}

void scene_play_loop(void) {
  if (s_frame_count < 2) return;
  if (s_anim_timer) {
    app_timer_cancel(s_anim_timer);
    s_anim_timer = NULL;
  }
  s_animating = true;
  s_display_frame = 0;  // start at the oldest frame
  layer_mark_dirty(s_layer);
  s_anim_timer = app_timer_register(ANIM_FRAME_MS, anim_tick, NULL);
}

// --- data ingestion -------------------------------------------------------

static void free_frames(void) {
  for (int i = 0; i < WSR_MAX_FRAMES; i++) {
    if (s_frames[i]) { free(s_frames[i]); s_frames[i] = NULL; }
    s_frame_len[i] = 0;
  }
  s_frame_count = 0;
  s_display_frame = -1;
}

// Cache the base map. Prefer storing the EXACT base RLE (lossless, full
// quality) when it fits the persist budget; only the densest maps fall back to
// the compact half-res 1-bit ink mask. Either way the map is never lost.
static void persist_base(void) {
  if (!s_base || !s_base_len) return;

  // 1) Lossless: store the base RLE verbatim if it fits (and actually wrote).
  if (s_base_len <= PK_DATA_MAX &&
      persist_write_chunks(PK_DATA_CHUNK0, s_base, s_base_len)) {
    persist_write_int(PK_DATA_LEN, (int32_t)s_base_len);
    persist_write_int(PK_FMT_KEY, PK_FMT_RAW);
    return;
  }

  // 2) Fallback: a half-res 1-bit ink mask (small, but blockier on rebuild).
  int hw = (s_w + 1) / 2, hh = (s_h + 1) / 2;
  uint32_t mb = ((uint32_t)hw * hh + 7) / 8;
  if (mb == 0 || mb > PK_MASK_MAX) { persist_clear(); return; }
  uint8_t *mask = calloc(mb, 1);
  if (!mask) { persist_clear(); return; }
  uint8_t bg = s_invert ? 0xC0 : 0xFF;
  uint32_t total = (uint32_t)s_w * s_h, p = 0, i = 0;
  int x = 0, y = 0;
  while (i + 3 <= s_base_len && p < total) {
    uint16_t cnt = (uint16_t)s_base[i] | ((uint16_t)s_base[i + 1] << 8);
    uint8_t col = s_base[i + 2]; i += 3;
    if (col != WSR_TRANSPARENT && col != bg) {
      for (uint16_t k = 0; k < cnt && p < total; k++, p++) {
        uint32_t b = (uint32_t)(y >> 1) * hw + (x >> 1);
        mask[b >> 3] |= (1 << (b & 7));
        if (++x >= s_w) { x = 0; y++; }
      }
    } else {
      uint32_t adv = cnt; if (p + adv > total) adv = total - p;
      p += adv; uint32_t nx = (uint32_t)x + adv; y += nx / s_w; x = nx % s_w;
    }
  }
  if (persist_write_chunks(PK_DATA_CHUNK0, mask, mb)) {
    persist_write_int(PK_DATA_LEN, (int32_t)mb);
    persist_write_int(PK_FMT_KEY, PK_FMT_MASK);
  } else {
    persist_clear();
  }
  free(mask);
}

// Cache the newest radar frame, best-effort: only if it fits the small radar
// keyspace AND the persist budget has room after the map. A failed write just
// clears the radar cache — the phone re-pushes the frame on launch regardless.
static void persist_radar(void) {
  if (s_frame_count == 0) { radar_persist_clear(); return; }
  uint8_t *rle = s_frames[s_frame_count - 1];
  uint32_t len = s_frame_len[s_frame_count - 1];
  if (!rle || len == 0 || len > RK_MAX) { radar_persist_clear(); return; }
  if (persist_write_chunks(RK_CHUNK0, rle, len)) {
    persist_write_int(RK_LEN, (int32_t)len);
  } else {
    radar_persist_clear();
  }
}

// Expand a persisted half-res mask into a full-res base RLE (ink on transparent).
static uint8_t *rle_from_mask(const uint8_t *mask, uint8_t ink, uint32_t *out_len) {
  int hw = (s_w + 1) / 2;
  uint32_t total = (uint32_t)s_w * s_h, p;
  int x = 0, y = 0;
  uint32_t runs = 0; uint8_t prev = 0; bool started = false;
  for (p = 0; p < total; p++) {
    uint32_t b = (uint32_t)(y >> 1) * hw + (x >> 1);
    uint8_t col = ((mask[b >> 3] >> (b & 7)) & 1) ? ink : WSR_TRANSPARENT;
    if (!started || col != prev) { runs++; prev = col; started = true; }
    if (++x >= s_w) { x = 0; y++; }
  }
  if (runs == 0 || runs > 30000) return NULL;
  uint8_t *buf = malloc(runs * 3);
  if (!buf) return NULL;
  uint32_t bi = 0, rc = 0; prev = 0; started = false; x = 0; y = 0;
  for (p = 0; p < total; p++) {
    uint32_t b = (uint32_t)(y >> 1) * hw + (x >> 1);
    uint8_t col = ((mask[b >> 3] >> (b & 7)) & 1) ? ink : WSR_TRANSPARENT;
    if (!started) { prev = col; rc = 1; started = true; }
    else if (col == prev) { rc++; }
    else {
      buf[bi++] = rc & 0xff; buf[bi++] = (rc >> 8) & 0xff; buf[bi++] = prev;
      prev = col; rc = 1;
    }
    if (++x >= s_w) { x = 0; y++; }
  }
  buf[bi++] = rc & 0xff; buf[bi++] = (rc >> 8) & 0xff; buf[bi++] = prev;
  *out_len = bi;
  return buf;
}

static void persist_timer_cb(void *ctx) {
  s_persist_timer = NULL;
  if (s_base_dirty) { persist_base(); s_base_dirty = false; }
  if (s_radar_dirty) { persist_radar(); s_radar_dirty = false; }
}

static void schedule_persist(void) {
  // Persist shortly, off the AppMessage handler (synchronous flash writes here
  // stalled the app). The unload path is the backstop if we exit before this.
  if (s_persist_timer) app_timer_cancel(s_persist_timer);
  s_persist_timer = app_timer_register(PERSIST_DELAY_MS, persist_timer_cb, NULL);
}

void scene_set_base(uint8_t *rle, uint32_t len) {
  // Only replace the map when a complete new one arrives; never with nothing.
  if (!rle || len < 3) { if (rle) free(rle); return; }
  // Refuse a blank/all-transparent base: never wipe a good map with an empty
  // one. If the incoming map has no ink at all, keep what we already have.
  bool has_ink = false;
  for (uint32_t i = 0; i + 3 <= len; i += 3) {
    if (rle[i + 2] != WSR_TRANSPARENT) { has_ink = true; break; }
  }
  if (!has_ink) { free(rle); return; }
  // Identical to what we already show (e.g. the phone's relaunch re-push of an
  // unchanged map): nothing to redraw or rewrite to flash.
  if (s_base && len == s_base_len && memcmp(rle, s_base, len) == 0) {
    free(rle);
    return;
  }
  if (s_base) free(s_base);
  s_base = rle;
  s_base_len = len;
  s_base_dirty = true;
  if (s_layer) layer_mark_dirty(s_layer);
  schedule_persist();
}

void scene_begin_batch(uint8_t nframes) {
  if (s_anim_timer) { app_timer_cancel(s_anim_timer); s_anim_timer = NULL; }
  s_animating = false;
  // CRUCIAL: keep the current frames on screen while the new batch streams in.
  // Freeing them here blanked the radar for the whole transfer (tens of
  // seconds); instead frames are replaced in place as they arrive and any
  // leftovers beyond the new batch are trimmed at end_batch.
  if (s_display_frame >= s_frame_count) {
    s_display_frame = s_frame_count > 0 ? s_frame_count - 1 : -1;
  }
  s_incoming_max = 0;
  (void)nframes;
}

void scene_set_frame(uint8_t idx, uint8_t *rle, uint32_t len) {
  if (idx >= WSR_MAX_FRAMES) { free(rle); return; }
  if (s_frames[idx]) free(s_frames[idx]);
  s_frames[idx] = rle;
  s_frame_len[idx] = len;
  if (idx + 1 > s_frame_count) s_frame_count = idx + 1;
  if (idx + 1 > s_incoming_max) s_incoming_max = idx + 1;
}

void scene_end_batch(void) {
  // Trim stale frames beyond what this batch actually delivered — but if the
  // batch delivered nothing, keep everything (never trade frames for nothing).
  if (s_incoming_max > 0) {
    for (int i = s_incoming_max; i < WSR_MAX_FRAMES; i++) {
      if (s_frames[i]) { free(s_frames[i]); s_frames[i] = NULL; }
      s_frame_len[i] = 0;
    }
    s_frame_count = s_incoming_max;
    s_radar_dirty = true;
    schedule_persist();
  }
  s_incoming_max = 0;
  s_display_frame = s_frame_count > 0 ? s_frame_count - 1 : -1;  // newest
  if (s_layer) layer_mark_dirty(s_layer);
}

bool scene_has_frames(void) {
  return s_frame_count > 0;
}

void scene_set_invert(bool invert) {
  s_invert = invert;
  if (s_layer) layer_mark_dirty(s_layer);
}

void scene_get_dims(int *w, int *h) {
  if (w) *w = s_w;
  if (h) *h = s_h;
}

// --- lifecycle ------------------------------------------------------------

Layer *scene_create_layer(GRect frame) {
  s_layer = layer_create(frame);
  s_w = frame.size.w;
  s_h = frame.size.h;
  s_ox = frame.origin.x;   // scene layer is a direct child of the root layer,
  s_oy = frame.origin.y;   // so its frame origin is its screen position
  s_display_frame = -1;
  s_invert = settings_get()->invert;   // cached ink/bg must match the style

  // Restore the cached map immediately so a reload never shows a blank screen.
  int fmt = PK_FMT_NONE; uint32_t dlen = 0;
  uint8_t *data = persist_get(&fmt, &dlen);
  if (data) {
    if (fmt == PK_FMT_RAW) {
      // The exact base RLE — use it directly (full quality, no rebuild).
      s_base = data; s_base_len = dlen;
    } else {  // PK_FMT_MASK: expand the half-res mask back to a full-res RLE.
      uint32_t blen = 0;
      uint8_t *b = rle_from_mask(data, s_invert ? 0xFF : 0xC0, &blen);
      if (b) { s_base = b; s_base_len = blen; }
      free(data);
    }
  }

  // Restore the cached newest radar frame too, so the last scan is on screen
  // from the very first draw — even before (or without) the phone.
  uint32_t rlen = 0;
  uint8_t *radar = persist_read_chunks(RK_LEN, RK_CHUNK0, RK_MAX, &rlen);
  if (radar) {
    s_frames[0] = radar;
    s_frame_len[0] = rlen;
    s_frame_count = 1;
    s_display_frame = 0;
  }

  layer_set_update_proc(s_layer, scene_update);
  return s_layer;
}

void scene_destroy(void) {
  if (s_persist_timer) { app_timer_cancel(s_persist_timer); s_persist_timer = NULL; }
  // Guarantee the latest map + radar are cached before we exit, so the next
  // launch redraws them instantly instead of showing a blank screen. (Safe
  // here: this is the unload path, not the AppMessage handler.)
  if (s_base_dirty) { persist_base(); s_base_dirty = false; }
  if (s_radar_dirty) { persist_radar(); s_radar_dirty = false; }
  if (s_anim_timer) { app_timer_cancel(s_anim_timer); s_anim_timer = NULL; }
  free_frames();
  if (s_base) { free(s_base); s_base = NULL; }
  if (s_layer) { layer_destroy(s_layer); s_layer = NULL; }
}
