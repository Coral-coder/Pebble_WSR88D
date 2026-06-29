#pragma once
#include <pebble.h>

// KSC Weather — standalone watchapp. The phone (PebbleKit JS) holds a registry
// of weather products (forecast, advisories, observations, NASA KSC charts).
// The watch shows a menu of products and, on selection, requests the latest
// content: a TEXT product arrives as chunked strings shown in a scroll view; an
// IMAGE product arrives as the same RLE pixel stream the radar watchface uses.

#define WX_MAX_PRODUCTS   16
#define WX_TITLE_LEN      28
#define WX_TEXT_MAX       3000   // reassembled body cap (bytes)

// Watch -> phone request reasons (MESSAGE_KEY_REQUEST).
#define WXREQ_LIST        1      // send the product list (titles + kinds)
#define WXREQ_PRODUCT     2      // send content for product MESSAGE_KEY_PIDX

// Product kinds (MESSAGE_KEY_PKIND, and IMG/TXT routing).
#define WX_KIND_TEXT      0
#define WX_KIND_IMAGE     1

// RLE pixel stream (image products) — identical format to the watchface.
#define WX_TRANSPARENT    0x00
