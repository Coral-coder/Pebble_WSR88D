#include <pebble.h>
#include "wsr88d.h"
#include "settings.h"
#include "scene.h"
#include "comm.h"

static Window *s_window;
static Layer *s_scene_layer;
static Layer *s_header_layer;
static TextLayer *s_time_layer;
static TextLayer *s_date_layer;
static TextLayer *s_batt_layer;
static TextLayer *s_wx_now_layer;   // current temp + condition
static TextLayer *s_wx_hilo_layer;  // daily high / low
static TextLayer *s_wx_pop_layer;   // chance of rain
static TextLayer *s_bottom_layer;

static char s_time_buf[8];
static char s_date_buf[20];
static char s_batt_buf[8];
static char s_wx_now_buf[20];
static char s_wx_hilo_buf[20];
static char s_wx_pop_buf[20];
static char s_scan_buf[40];     // persistent bottom text (scan time + range)
static char s_status_buf[40];   // transient status overriding scan text
static bool s_status_active;

// Battery icon geometry, shared between the header paint and battery layout.
#define BATT_ICON_W 22
#define BATT_ICON_H 11

static uint8_t s_batt_pct = 100;
static bool s_batt_charging;
static int s_mins_since_refresh = 9999;  // force a refresh on first tick

// --- bottom status strip --------------------------------------------------

static void refresh_bottom_text(void) {
  if (!s_bottom_layer) return;
  text_layer_set_text(s_bottom_layer,
                      s_status_active ? s_status_buf : s_scan_buf);
}

void app_set_status(const char *text) {
  if (!text) {
    s_status_active = false;
  } else {
    strncpy(s_status_buf, text, sizeof(s_status_buf) - 1);
    s_status_buf[sizeof(s_status_buf) - 1] = '\0';
    s_status_active = true;
  }
  refresh_bottom_text();
}

void app_set_scan_label(const char *text) {
  strncpy(s_scan_buf, text, sizeof(s_scan_buf) - 1);
  s_scan_buf[sizeof(s_scan_buf) - 1] = '\0';
  s_mins_since_refresh = 0;  // a fresh pull just landed
  refresh_bottom_text();
}

void app_set_weather(const char *now, const char *hilo, const char *pop) {
  strncpy(s_wx_now_buf, now, sizeof(s_wx_now_buf) - 1);
  s_wx_now_buf[sizeof(s_wx_now_buf) - 1] = '\0';
  strncpy(s_wx_hilo_buf, hilo, sizeof(s_wx_hilo_buf) - 1);
  s_wx_hilo_buf[sizeof(s_wx_hilo_buf) - 1] = '\0';
  strncpy(s_wx_pop_buf, pop, sizeof(s_wx_pop_buf) - 1);
  s_wx_pop_buf[sizeof(s_wx_pop_buf) - 1] = '\0';
  if (s_wx_now_layer) text_layer_set_text(s_wx_now_layer, s_wx_now_buf);
  if (s_wx_hilo_layer) text_layer_set_text(s_wx_hilo_layer, s_wx_hilo_buf);
  if (s_wx_pop_layer) text_layer_set_text(s_wx_pop_layer, s_wx_pop_buf);
}

void app_settings_changed(void) {
  // Apply anything the watch renders locally, then pull fresh data.
  scene_set_invert(settings_get()->invert);
  s_mins_since_refresh = 9999;
  comm_request(REQ_REFRESH);
}

// --- header (clock / date / battery) --------------------------------------

static void header_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  // Battery icon, sitting immediately to the left of the "85%" text so the
  // icon and percentage read as one group in the top-right.
  int iw = BATT_ICON_W, ih = BATT_ICON_H;
  int ix = b.size.w - 40 - iw - 2;   // % text occupies the rightmost ~40px
  int iy = 4;
  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_draw_rect(ctx, GRect(ix, iy, iw, ih));
  graphics_fill_rect(ctx, GRect(ix + iw, iy + 3, 2, ih - 6), 0, GCornerNone);
  int fillw = (s_batt_pct * (iw - 4)) / 100;
  if (fillw < 0) fillw = 0;
  GColor fill = s_batt_charging ? GColorGreen :
                (s_batt_pct <= 20 ? GColorRed : GColorWhite);
  graphics_context_set_fill_color(ctx, fill);
  graphics_fill_rect(ctx, GRect(ix + 2, iy + 2, fillw, ih - 4), 0, GCornerNone);
}

static void update_clock(struct tm *t) {
  if (clock_is_24h_style()) {
    strftime(s_time_buf, sizeof(s_time_buf), "%H:%M", t);
  } else {
    strftime(s_time_buf, sizeof(s_time_buf), "%I:%M", t);
    if (s_time_buf[0] == '0') memmove(s_time_buf, s_time_buf + 1, strlen(s_time_buf));
  }
  text_layer_set_text(s_time_layer, s_time_buf);

  strftime(s_date_buf, sizeof(s_date_buf), "%a %b %e", t);
  text_layer_set_text(s_date_layer, s_date_buf);
}

static void battery_handler(BatteryChargeState state) {
  s_batt_pct = state.charge_percent;
  s_batt_charging = state.is_charging || state.is_plugged;
  snprintf(s_batt_buf, sizeof(s_batt_buf), "%d%%", s_batt_pct);
  text_layer_set_text(s_batt_layer, s_batt_buf);
  if (s_header_layer) layer_mark_dirty(s_header_layer);
}

static void tick_handler(struct tm *t, TimeUnits units_changed) {
  update_clock(t);

  s_mins_since_refresh++;
  Settings *s = settings_get();
  if (s_mins_since_refresh >= s->update_min) {
    comm_request(REQ_REFRESH);
    s_mins_since_refresh = 0;  // reset; real success resets again via scan label
  }
}

static void tap_handler(AccelAxisType axis, int32_t direction) {
  Settings *s = settings_get();
  if (!scene_has_frames()) {
    comm_request(REQ_REFRESH);
    return;
  }
  if (s->animate) {
    scene_play_loop();
  }
}

// --- window ---------------------------------------------------------------

// Right-aligned weather row in the top-right column under the battery.
static TextLayer *make_wx_row(Layer *parent, int x, int y, int w) {
  TextLayer *tl = text_layer_create(GRect(x, y, w, 16));
  text_layer_set_background_color(tl, GColorClear);
  text_layer_set_text_color(tl, GColorWhite);
  text_layer_set_text_alignment(tl, GTextAlignmentRight);
  text_layer_set_font(tl, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(parent, text_layer_get_layer(tl));
  return tl;
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  // Tall header on the big emery screen so the weather column fits under the
  // battery; a compact header (time/date/battery only) on smaller watches.
  bool big = b.size.h >= 200;
  int header_h = big ? 64 : 40;
  int tw = big ? b.size.w - 90 : b.size.w - 44;  // clock width (room at right)

  // Map + radar fills everything below the header.
  s_scene_layer = scene_create_layer(
      GRect(0, header_h, b.size.w, b.size.h - header_h));
  layer_add_child(root, s_scene_layer);

  // Header bar.
  s_header_layer = layer_create(GRect(0, 0, b.size.w, header_h));
  layer_set_update_proc(s_header_layer, header_update);
  layer_add_child(root, s_header_layer);

  // Clock — large (LECO numbers), ~25% bigger than before on emery.
  s_time_layer = text_layer_create(GRect(4, big ? 0 : 0, tw, big ? 44 : 30));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, GColorWhite);
  text_layer_set_font(s_time_layer, fonts_get_system_font(
      big ? FONT_KEY_LECO_42_NUMBERS : FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(s_header_layer, text_layer_get_layer(s_time_layer));

  s_date_layer = text_layer_create(GRect(4, header_h - (big ? 20 : 18), tw,
                                         big ? 20 : 16));
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, GColorWhite);
  text_layer_set_font(s_date_layer, fonts_get_system_font(
      big ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14));
  layer_add_child(s_header_layer, text_layer_get_layer(s_date_layer));

  // Battery percentage (icon drawn by header_update immediately to its left).
  s_batt_layer = text_layer_create(GRect(b.size.w - 40, 2, 38, 16));
  text_layer_set_background_color(s_batt_layer, GColorClear);
  text_layer_set_text_color(s_batt_layer, GColorWhite);
  text_layer_set_text_alignment(s_batt_layer, GTextAlignmentRight);
  text_layer_set_font(s_batt_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(s_header_layer, text_layer_get_layer(s_batt_layer));

  // Weather column under the battery (emery only — no room on small screens).
  if (big) {
    int rx = b.size.w - 86, rw = 84;
    s_wx_now_layer = make_wx_row(s_header_layer, rx, 19, rw);   // temp + sky
    s_wx_hilo_layer = make_wx_row(s_header_layer, rx, 33, rw);  // high / low
    s_wx_pop_layer = make_wx_row(s_header_layer, rx, 47, rw);   // chance of rain
  }

  // Bottom status strip (scan time / range / messages) over the map.
  s_bottom_layer = text_layer_create(GRect(0, b.size.h - 18, b.size.w, 18));
  text_layer_set_background_color(s_bottom_layer, GColorBlack);
  text_layer_set_text_color(s_bottom_layer, GColorWhite);
  text_layer_set_text_alignment(s_bottom_layer, GTextAlignmentCenter);
  text_layer_set_font(s_bottom_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(root, text_layer_get_layer(s_bottom_layer));

  app_set_status("Locating...");
  scene_set_invert(settings_get()->invert);

  // Seed the UI with the current time and battery state.
  time_t now = time(NULL);
  update_clock(localtime(&now));
  battery_handler(battery_state_service_peek());
}

static void window_unload(Window *window) {
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_date_layer);
  text_layer_destroy(s_batt_layer);
  if (s_wx_now_layer) text_layer_destroy(s_wx_now_layer);
  if (s_wx_hilo_layer) text_layer_destroy(s_wx_hilo_layer);
  if (s_wx_pop_layer) text_layer_destroy(s_wx_pop_layer);
  text_layer_destroy(s_bottom_layer);
  layer_destroy(s_header_layer);
  scene_destroy();
}

static void init(void) {
  settings_load();

  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  comm_init();
  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  battery_state_service_subscribe(battery_handler);
  accel_tap_service_subscribe(tap_handler);

  // Kick off the first pull once the window is up and AppMessage is open.
  comm_request(REQ_HELLO);
}

static void deinit(void) {
  accel_tap_service_unsubscribe();
  battery_state_service_unsubscribe();
  tick_timer_service_unsubscribe();
  comm_deinit();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
