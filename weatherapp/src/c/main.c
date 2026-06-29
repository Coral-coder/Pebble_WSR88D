#include <pebble.h>
#include "wx.h"
#include "app.h"
#include "comm.h"

// KSC Weather — a menu of weather products; selecting one fetches the latest
// content from the phone and shows it in a scrollable detail window. No clock:
// this is an app, not a watchface.

static Window *s_menu_window;
static MenuLayer *s_menu;

static char s_titles[WX_MAX_PRODUCTS][WX_TITLE_LEN + 1];
static uint8_t s_kinds[WX_MAX_PRODUCTS];
static uint8_t s_count;          // products known so far
static int s_selected = -1;      // product whose detail is open

// Detail window (scrollable text).
static Window *s_detail_window;
static ScrollLayer *s_scroll;
static TextLayer *s_body;
static char s_body_buf[WX_TEXT_MAX + WX_TITLE_LEN + 8];

// --- detail window --------------------------------------------------------

static void detail_set_text(const char *s) {
  if (!s_body) return;
  text_layer_set_text(s_body, s);
  GRect b = layer_get_bounds(scroll_layer_get_layer(s_scroll));
  GSize used = graphics_text_layout_get_content_size(
      s, fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GRect(0, 0, b.size.w - 6, 2000), GTextOverflowModeWordWrap,
      GTextAlignmentLeft);
  layer_set_frame(text_layer_get_layer(s_body),
                  GRect(3, 2, b.size.w - 6, used.h + 12));
  scroll_layer_set_content_size(s_scroll, GSize(b.size.w, used.h + 18));
  scroll_layer_set_content_offset(s_scroll, GPoint(0, 0), false);
}

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_scroll = scroll_layer_create(b);
  scroll_layer_set_click_config_onto_window(s_scroll, window);
  scroll_layer_set_shadow_hidden(s_scroll, false);

  s_body = text_layer_create(GRect(3, 2, b.size.w - 6, b.size.h));
  text_layer_set_font(s_body, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text(s_body, "Loading...");
  scroll_layer_add_child(s_scroll, text_layer_get_layer(s_body));
  layer_add_child(root, scroll_layer_get_layer(s_scroll));
}

static void detail_window_unload(Window *window) {
  text_layer_destroy(s_body); s_body = NULL;
  scroll_layer_destroy(s_scroll); s_scroll = NULL;
  s_detail_window = NULL;
  s_selected = -1;
}

static void open_detail(int idx) {
  s_selected = idx;
  s_detail_window = window_create();
  window_set_window_handlers(s_detail_window, (WindowHandlers){
    .load = detail_window_load,
    .unload = detail_window_unload,
  });
  window_stack_push(s_detail_window, true);
  comm_request(WXREQ_PRODUCT, (uint8_t)idx);   // fetch latest on open
}

// --- menu -----------------------------------------------------------------

static uint16_t menu_num_rows(MenuLayer *m, uint16_t section, void *ctx) {
  return s_count ? s_count : 1;
}

static void menu_draw_row(GContext *ctx, const Layer *cell, MenuIndex *ci, void *c) {
  if (!s_count) {
    menu_cell_basic_draw(ctx, cell, "Loading products...", NULL, NULL);
    return;
  }
  const char *sub = s_kinds[ci->row] == WX_KIND_IMAGE ? "chart" : "text";
  menu_cell_basic_draw(ctx, cell, s_titles[ci->row], sub, NULL);
}

static int16_t menu_row_height(MenuLayer *m, MenuIndex *ci, void *ctx) {
  return 44;
}

static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_count && ci->row < s_count) open_detail(ci->row);
}

static void menu_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_menu = menu_layer_create(b);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_num_rows,
    .draw_row = menu_draw_row,
    .get_cell_height = menu_row_height,
    .select_click = menu_select,
  });
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));
}

static void menu_window_unload(Window *window) {
  menu_layer_destroy(s_menu); s_menu = NULL;
}

// --- app.h callbacks ------------------------------------------------------

void app_set_status(const char *text) {
  if (s_detail_window && s_body && s_selected >= 0) detail_set_text(text);
}

void app_set_product_count(uint8_t n) {
  if (n > WX_MAX_PRODUCTS) n = WX_MAX_PRODUCTS;
  s_count = n;
  for (uint8_t i = 0; i < n; i++) { s_titles[i][0] = '\0'; s_kinds[i] = WX_KIND_TEXT; }
  if (s_menu) menu_layer_reload_data(s_menu);
}

void app_set_product(uint8_t idx, const char *title, uint8_t kind) {
  if (idx >= WX_MAX_PRODUCTS) return;
  if (idx + 1 > s_count) s_count = idx + 1;
  strncpy(s_titles[idx], title, WX_TITLE_LEN);
  s_titles[idx][WX_TITLE_LEN] = '\0';
  s_kinds[idx] = kind;
  if (s_menu) menu_layer_reload_data(s_menu);
}

void app_set_text(const char *title, const char *body) {
  if (!s_detail_window) return;
  // Title as a heading line, then the body.
  int n = snprintf(s_body_buf, sizeof(s_body_buf), "%s\n\n%s",
                   title ? title : "", body ? body : "");
  if (n < 0) s_body_buf[0] = '\0';
  detail_set_text(s_body_buf);
}

void app_get_dims(int *w, int *h) {
  // Detail content area (used by future image products).
  if (w) *w = s_detail_window ? layer_get_bounds(window_get_root_layer(s_detail_window)).size.w : 200;
  if (h) *h = s_detail_window ? layer_get_bounds(window_get_root_layer(s_detail_window)).size.h : 200;
}

// --- lifecycle ------------------------------------------------------------

static void init(void) {
  s_count = 0;
  s_menu_window = window_create();
  window_set_window_handlers(s_menu_window, (WindowHandlers){
    .load = menu_window_load,
    .unload = menu_window_unload,
  });
  window_stack_push(s_menu_window, true);

  comm_init();
  comm_request(WXREQ_LIST, 0);   // ask the phone for the product list
}

static void deinit(void) {
  comm_deinit();
  if (s_menu_window) window_destroy(s_menu_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
