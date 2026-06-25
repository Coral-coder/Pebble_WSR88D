#include "settings.h"
#include "wsr88d.h"

#define SETTINGS_KEY 1

static Settings s_settings;

// Approximate viewing radius shown in the status bar. These are rough values
// for a mid-latitude location at RainViewer zoom 5/6/7 and only drive the
// label; the JS side owns the real geometry.
static const int s_range_mi[3] = { 220, 110, 55 };  // wide / regional / local
static const int s_range_km[3] = { 350, 175, 90 };

void settings_load(void) {
  // Defaults first, then overlay any persisted value.
  s_settings = (Settings){
    .update_min = DEF_UPDATE_MIN,
    .animate = DEF_ANIMATE,
    .frames = DEF_FRAMES,
    .units = DEF_UNITS,
    .range_idx = DEF_RANGE,
    .scheme_idx = DEF_SCHEME,
  };
  if (persist_exists(SETTINGS_KEY)) {
    persist_read_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
  }
  if (s_settings.frames < 1) s_settings.frames = 1;
  if (s_settings.frames > WSR_MAX_FRAMES) s_settings.frames = WSR_MAX_FRAMES;
  if (s_settings.range_idx > 2) s_settings.range_idx = DEF_RANGE;
  if (s_settings.update_min < 1) s_settings.update_min = DEF_UPDATE_MIN;
}

void settings_save(void) {
  persist_write_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
}

Settings *settings_get(void) {
  return &s_settings;
}

int settings_range_value(void) {
  uint8_t i = s_settings.range_idx <= 2 ? s_settings.range_idx : DEF_RANGE;
  return s_settings.units == 1 ? s_range_km[i] : s_range_mi[i];
}

const char *settings_units_suffix(void) {
  return s_settings.units == 1 ? "km" : "mi";
}
