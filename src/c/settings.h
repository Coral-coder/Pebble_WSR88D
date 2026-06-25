#pragma once
#include <pebble.h>

typedef struct {
  uint16_t update_min;  // minutes between automatic refreshes
  uint8_t animate;      // 1 = tap animates the loop
  uint8_t frames;       // number of frames to load for the loop (1..10)
  uint8_t units;        // 0 = miles, 1 = km
  uint8_t range_idx;    // 0 = wide, 1 = regional, 2 = local
  uint8_t scheme_idx;   // RainViewer color scheme id (for the legend label)
  uint8_t invert;       // 0 = black ink on white, 1 = inverted (white on black)
} Settings;

void settings_load(void);
void settings_save(void);
Settings *settings_get(void);

// Approximate viewing radius (in the user's units) for the current range_idx.
int settings_range_value(void);
const char *settings_units_suffix(void);
