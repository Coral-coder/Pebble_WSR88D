#include "comm.h"
#include "app.h"
#include "wx.h"

// Text product reassembly. The phone sends TXT_TITLE, then the body as
// TXT_SEQ/TXT_NCHUNKS/TXT_DATA string chunks (seq 0 first).
static char s_title[WX_TITLE_LEN + 4];
static char s_text[WX_TEXT_MAX + 1];
static uint32_t s_text_off;
static uint16_t s_text_next_seq;
static uint16_t s_text_nchunks;

static void text_reset(void) {
  s_text_off = 0; s_text_next_seq = 0; s_text_nchunks = 0; s_text[0] = '\0';
}

static void handle_text_chunk(DictionaryIterator *it) {
  Tuple *t_seq = dict_find(it, MESSAGE_KEY_TXT_SEQ);
  Tuple *t_n = dict_find(it, MESSAGE_KEY_TXT_NCHUNKS);
  Tuple *t_data = dict_find(it, MESSAGE_KEY_TXT_DATA);
  if (!t_seq || !t_n || !t_data) return;

  uint16_t seq = (uint16_t)t_seq->value->int32;
  uint16_t nchunks = (uint16_t)t_n->value->int32;
  if (seq == 0) { text_reset(); s_text_nchunks = nchunks; }
  if (seq != s_text_next_seq) { text_reset(); return; }  // lost a chunk

  const char *chunk = t_data->value->cstring;
  uint32_t len = chunk ? strlen(chunk) : 0;
  if (s_text_off + len > WX_TEXT_MAX) len = WX_TEXT_MAX - s_text_off;
  if (len) { memcpy(s_text + s_text_off, chunk, len); s_text_off += len; }
  s_text[s_text_off] = '\0';
  s_text_next_seq++;

  if (s_text_next_seq >= s_text_nchunks) {
    app_set_text(s_title, s_text);
    text_reset();
  }
}

static void inbox_received(DictionaryIterator *it, void *context) {
  Tuple *t;

  if ((t = dict_find(it, MESSAGE_KEY_PCOUNT))) {
    app_set_product_count((uint8_t)t->value->int32);
    return;
  }
  if ((t = dict_find(it, MESSAGE_KEY_PINDEX))) {
    Tuple *t_title = dict_find(it, MESSAGE_KEY_PTITLE);
    Tuple *t_kind = dict_find(it, MESSAGE_KEY_PKIND);
    app_set_product((uint8_t)t->value->int32,
                    t_title ? t_title->value->cstring : "",
                    t_kind ? (uint8_t)t_kind->value->int32 : WX_KIND_TEXT);
    return;
  }
  if ((t = dict_find(it, MESSAGE_KEY_TXT_TITLE))) {
    strncpy(s_title, t->value->cstring, sizeof(s_title) - 1);
    s_title[sizeof(s_title) - 1] = '\0';
    return;
  }
  if (dict_find(it, MESSAGE_KEY_TXT_DATA)) { handle_text_chunk(it); return; }
  if ((t = dict_find(it, MESSAGE_KEY_ERR))) { app_set_status(t->value->cstring); return; }
  if ((t = dict_find(it, MESSAGE_KEY_STATUS))) { app_set_status(t->value->cstring); return; }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
  text_reset();
}

void comm_request(uint8_t reason, uint8_t pidx) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  int w = 0, h = 0;
  app_get_dims(&w, &h);
  dict_write_uint8(out, MESSAGE_KEY_REQUEST, reason);
  dict_write_uint8(out, MESSAGE_KEY_PIDX, pidx);
  dict_write_uint16(out, MESSAGE_KEY_SCR_W, (uint16_t)w);
  dict_write_uint16(out, MESSAGE_KEY_SCR_H, (uint16_t)h);
  app_message_outbox_send();
}

void comm_init(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_open(2048, 128);
}

void comm_deinit(void) {
  text_reset();
}
