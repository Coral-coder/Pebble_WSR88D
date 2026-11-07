#include "comm.h"
#include "scene.h"
#include "settings.h"
#include "wsr88d.h"

// Reassembly state for the image currently streaming in.
static uint8_t *s_rx_buf;
static uint32_t s_rx_total;
static uint32_t s_rx_off;
static uint16_t s_rx_nchunks;
static uint16_t s_rx_next_seq;
static uint8_t s_rx_kind;
static uint8_t s_rx_frame;

static void rx_reset(void) {
  if (s_rx_buf) { free(s_rx_buf); s_rx_buf = NULL; }
  s_rx_total = s_rx_off = 0;
  s_rx_nchunks = s_rx_next_seq = 0;
}

static void handle_settings(DictionaryIterator *it) {
  Settings *s = settings_get();
  Tuple *t;
  bool changed = false;

  if ((t = dict_find(it, MESSAGE_KEY_SET_UPDATE_MIN))) {
    s->update_min = (uint16_t)t->value->int32; changed = true;
  }
  if ((t = dict_find(it, MESSAGE_KEY_SET_ANIMATE))) {
    s->animate = (uint8_t)t->value->int32; changed = true;
  }
  if ((t = dict_find(it, MESSAGE_KEY_SET_FRAMES))) {
    s->frames = (uint8_t)t->value->int32; changed = true;
  }
  if ((t = dict_find(it, MESSAGE_KEY_SET_UNITS))) {
    s->units = (uint8_t)t->value->int32; changed = true;
  }
  if ((t = dict_find(it, MESSAGE_KEY_SET_RANGE))) {
    s->range_idx = (uint8_t)t->value->int32; changed = true;
  }
  if ((t = dict_find(it, MESSAGE_KEY_SET_SCHEME))) {
    s->scheme_idx = (uint8_t)t->value->int32; changed = true;
  }
  if ((t = dict_find(it, MESSAGE_KEY_SET_INVERT))) {
    s->invert = (uint8_t)t->value->int32; changed = true;
  }

  if (changed) {
    if (s->frames < 1) s->frames = 1;
    if (s->frames > WSR_MAX_FRAMES) s->frames = WSR_MAX_FRAMES;
    settings_save();
    app_settings_changed();
  }
}

static void handle_image_chunk(DictionaryIterator *it) {
  Tuple *t_kind = dict_find(it, MESSAGE_KEY_IMG_KIND);
  Tuple *t_seq = dict_find(it, MESSAGE_KEY_IMG_SEQ);
  Tuple *t_n = dict_find(it, MESSAGE_KEY_IMG_NCHUNKS);
  Tuple *t_total = dict_find(it, MESSAGE_KEY_IMG_TOTAL);
  Tuple *t_data = dict_find(it, MESSAGE_KEY_IMG_DATA);
  if (!t_kind || !t_seq || !t_n || !t_total || !t_data) return;

  uint16_t seq = (uint16_t)t_seq->value->int32;
  uint16_t nchunks = (uint16_t)t_n->value->int32;
  uint32_t total = (uint32_t)t_total->value->int32;
  uint8_t kind = (uint8_t)t_kind->value->int32;
  Tuple *t_frame = dict_find(it, MESSAGE_KEY_IMG_FRAME);
  uint8_t frame = t_frame ? (uint8_t)t_frame->value->int32 : 0;

  if (seq == 0) {
    // Start of a new image.
    rx_reset();
    if (total == 0 || total > 200000) return;  // sanity guard
    s_rx_buf = malloc(total);
    if (!s_rx_buf) { app_set_status("low memory"); return; }
    s_rx_total = total;
    s_rx_nchunks = nchunks;
    s_rx_kind = kind;
    s_rx_frame = frame;
    s_rx_next_seq = 0;
  }

  if (!s_rx_buf || seq != s_rx_next_seq) {
    // Out of order / lost a chunk: abandon this image, let the next one retry.
    rx_reset();
    return;
  }

  uint16_t len = t_data->length;
  if (s_rx_off + len > s_rx_total) { rx_reset(); return; }
  memcpy(s_rx_buf + s_rx_off, t_data->value->data, len);
  s_rx_off += len;
  s_rx_next_seq++;

  if (s_rx_next_seq >= s_rx_nchunks) {
    // Image complete — hand the buffer to the scene (ownership transfers).
    uint8_t *buf = s_rx_buf;
    uint32_t got = s_rx_off;
    s_rx_buf = NULL;  // detach before reset so we don't free it
    uint8_t kind_done = s_rx_kind;
    uint8_t frame_done = s_rx_frame;
    rx_reset();

    if (kind_done == IMG_KIND_BASE) {
      scene_set_base(buf, got);
    } else {
      scene_set_frame(frame_done, buf, got);
    }
  }
}

static void inbox_received(DictionaryIterator *it, void *context) {
  // Settings updates arrive in their own message.
  if (dict_find(it, MESSAGE_KEY_SET_UPDATE_MIN) ||
      dict_find(it, MESSAGE_KEY_SET_ANIMATE) ||
      dict_find(it, MESSAGE_KEY_SET_FRAMES) ||
      dict_find(it, MESSAGE_KEY_SET_UNITS) ||
      dict_find(it, MESSAGE_KEY_SET_RANGE) ||
      dict_find(it, MESSAGE_KEY_SET_SCHEME) ||
      dict_find(it, MESSAGE_KEY_SET_INVERT)) {
    handle_settings(it);
    return;
  }

  // Weather strings arrive together in their own message.
  Tuple *t_wx = dict_find(it, MESSAGE_KEY_WX_NOW);
  if (t_wx) {
    Tuple *t_hl = dict_find(it, MESSAGE_KEY_WX_HILO);
    Tuple *t_pp = dict_find(it, MESSAGE_KEY_WX_POP);
    app_set_weather(t_wx->value->cstring,
                    t_hl ? t_hl->value->cstring : "",
                    t_pp ? t_pp->value->cstring : "");
    return;
  }

  Tuple *t_err = dict_find(it, MESSAGE_KEY_ERR);
  if (t_err) { app_set_status(t_err->value->cstring); return; }

  Tuple *t_batch = dict_find(it, MESSAGE_KEY_BATCH);
  if (t_batch) {
    if (t_batch->value->int32 == 1) {
      Tuple *t_n = dict_find(it, MESSAGE_KEY_NFRAMES);
      scene_begin_batch(t_n ? (uint8_t)t_n->value->int32 : 0);
      app_set_status("Receiving radar...");
    } else {
      scene_end_batch();
      Tuple *t_scan = dict_find(it, MESSAGE_KEY_STATUS);
      if (t_scan) app_set_scan_label(t_scan->value->cstring);
      app_set_status(NULL);  // clear transient status
    }
    return;
  }

  Tuple *t_status = dict_find(it, MESSAGE_KEY_STATUS);
  if (t_status && !dict_find(it, MESSAGE_KEY_IMG_KIND)) {
    app_set_status(t_status->value->cstring);
    return;
  }

  if (dict_find(it, MESSAGE_KEY_IMG_KIND)) {
    handle_image_chunk(it);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
  rx_reset();
}

void comm_request(uint8_t reason) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  int w = 0, h = 0;
  scene_get_dims(&w, &h);
  dict_write_uint8(out, MESSAGE_KEY_REQUEST, reason);
  dict_write_uint16(out, MESSAGE_KEY_SCR_W, (uint16_t)w);
  dict_write_uint16(out, MESSAGE_KEY_SCR_H, (uint16_t)h);
  app_message_outbox_send();
}

void comm_init(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  // Inbox holds one chunk (~1KB payload) plus key overhead; outbox is tiny.
  app_message_open(2048, 128);
}

void comm_deinit(void) {
  rx_reset();
}
