#pragma once
#include <pebble.h>

void comm_init(void);
void comm_deinit(void);

// Ask the phone for a fresh radar pull. `reason` is REQ_REFRESH or REQ_HELLO.
void comm_request(uint8_t reason);
