#pragma once
#include <pebble.h>

void comm_init(void);
void comm_deinit(void);
// reason: WXREQ_LIST or WXREQ_PRODUCT; pidx is the product index (for PRODUCT).
void comm_request(uint8_t reason, uint8_t pidx);
