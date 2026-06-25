#include "scene.h"
#include "wsr88d.h"

#define ANIM_FRAME_MS 280   // dwell per frame while looping
#define ANIM_HOLD_MS  900   // extra dwell on the newest frame at the end

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
static AppTimer *s_anim_timer;

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

  // White background (paper map look).
  graphics_context_set_fill_color(ctx, GColorWhite);
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

void scene_set_base(uint8_t *rle, uint32_t len) {
  if (s_base) free(s_base);
  s_base = rle;
  s_base_len = len;
  if (s_layer) layer_mark_dirty(s_layer);
}

void scene_begin_batch(uint8_t nframes) {
  if (s_anim_timer) { app_timer_cancel(s_anim_timer); s_anim_timer = NULL; }
  s_animating = false;
  free_frames();
  if (nframes > WSR_MAX_FRAMES) nframes = WSR_MAX_FRAMES;
  // s_frame_count is incremented as frames actually arrive
  (void)nframes;
}

void scene_set_frame(uint8_t idx, uint8_t *rle, uint32_t len) {
  if (idx >= WSR_MAX_FRAMES) { free(rle); return; }
  if (s_frames[idx]) free(s_frames[idx]);
  s_frames[idx] = rle;
  s_frame_len[idx] = len;
  if (idx + 1 > s_frame_count) s_frame_count = idx + 1;
}

void scene_end_batch(void) {
  s_display_frame = s_frame_count > 0 ? s_frame_count - 1 : -1;  // newest
  if (s_layer) layer_mark_dirty(s_layer);
}

bool scene_has_frames(void) {
  return s_frame_count > 0;
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
  layer_set_update_proc(s_layer, scene_update);
  return s_layer;
}

void scene_destroy(void) {
  if (s_anim_timer) { app_timer_cancel(s_anim_timer); s_anim_timer = NULL; }
  free_frames();
  if (s_base) { free(s_base); s_base = NULL; }
  if (s_layer) { layer_destroy(s_layer); s_layer = NULL; }
}
