#pragma once
#include <pebble.h>

// Creates the map/radar layer that fills `frame`. The layer owns all radar
// state and renders base map + the current radar frame on every update.
Layer *scene_create_layer(GRect frame);
void scene_destroy(void);

// The pixel dimensions the phone should render to (== the layer's size).
void scene_get_dims(int *w, int *h);

// Ownership of `rle` (malloc'd) transfers to the scene. Passing NULL clears.
void scene_set_base(uint8_t *rle, uint32_t len);

// Batch lifecycle for a radar refresh.
void scene_begin_batch(uint8_t nframes);
void scene_set_frame(uint8_t idx, uint8_t *rle, uint32_t len);
void scene_end_batch(void);  // settle on newest frame and redraw

bool scene_has_frames(void);

// Invert the base layer (white background -> black). The map ink color is
// chosen on the phone, so the background fill is all the watch must flip.
void scene_set_invert(bool invert);

// Tap handler: play the loop once (oldest -> newest). No-op if disabled or
// only one frame is loaded.
void scene_play_loop(void);
