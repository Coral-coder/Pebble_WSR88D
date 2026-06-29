#pragma once
#include <pebble.h>

// UI entry points called by comm.c as data arrives from the phone.
void app_set_status(const char *text);                 // transient status line
void app_set_product_count(uint8_t n);                 // (re)build the menu
void app_set_product(uint8_t idx, const char *title, uint8_t kind);
void app_set_text(const char *title, const char *body);// text product ready
void app_get_dims(int *w, int *h);                     // selected detail area
