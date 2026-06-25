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
static TextLayer *s_bottom_layer;

static char s_time_buf[8];
static char s_date_buf[20];
static char s_batt_buf[8];
static char s_scan_buf[40];     // persistent bottom text (scan time + range)
static char s_status_buf[40];   // transient status overriding scan text
static bool s_status_active;

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

void app_settings_changed(void) {
  // A config change should pull fresh data immediately.
  s_mins_since_refresh = 9999;
  comm_request(REQ_REFRESH);
}

// --- header (clock / date / battery) --------------------------------------

static void header_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  // Battery icon, top-right, to the left of the percentage text.
  int iw = 22, ih = 11;
  int ix = b.size.w - 40 - iw + 4;  // sits left of the % text column
  int iy = 6;
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

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  int header_h = b.size.h >= 200 ? 52 : 40;
  bool big = header_h >= 52;

  // Map + radar fills everything below the header.
  s_scene_layer = scene_create_layer(
      GRect(0, header_h, b.size.w, b.size.h - header_h));
  layer_add_child(root, s_scene_layer);

  // Header bar.
  s_header_layer = layer_create(GRect(0, 0, b.size.w, header_h));
  layer_set_update_proc(s_header_layer, header_update);
  layer_add_child(root, s_header_layer);

  s_time_layer = text_layer_create(GRect(4, big ? 1 : 0, b.size.w - 76,
                                         big ? 38 : 30));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, GColorWhite);
  text_layer_set_font(s_time_layer, fonts_get_system_font(
      big ? FONT_KEY_LECO_36_BOLD_NUMBERS : FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(s_header_layer, text_layer_get_layer(s_time_layer));

  s_date_layer = text_layer_create(GRect(4, header_h - 18, b.size.w - 76, 16));
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, GColorWhite);
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(s_header_layer, text_layer_get_layer(s_date_layer));

  s_batt_layer = text_layer_create(GRect(b.size.w - 40, header_h - 18, 38, 16));
  text_layer_set_background_color(s_batt_layer, GColorClear);
  text_layer_set_text_color(s_batt_layer, GColorWhite);
  text_layer_set_text_alignment(s_batt_layer, GTextAlignmentRight);
  text_layer_set_font(s_batt_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(s_header_layer, text_layer_get_layer(s_batt_layer));

  // Bottom status strip (scan time / range / messages) over the map.
  s_bottom_layer = text_layer_create(GRect(0, b.size.h - 18, b.size.w, 18));
  text_layer_set_background_color(s_bottom_layer, GColorBlack);
  text_layer_set_text_color(s_bottom_layer, GColorWhite);
  text_layer_set_text_alignment(s_bottom_layer, GTextAlignmentCenter);
  text_layer_set_font(s_bottom_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(root, text_layer_get_layer(s_bottom_layer));

  app_set_status("Locating...");

  // Seed the UI with the current time and battery state.
  time_t now = time(NULL);
  update_clock(localtime(&now));
  battery_handler(battery_state_service_peek());
}

static void window_unload(Window *window) {
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_date_layer);
  text_layer_destroy(s_batt_layer);
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
