/* AppMessage transport: a retrying dict send, plus a chunked text sender that
 * mirrors the watch's reassembly (TXT_SEQ/TXT_NCHUNKS/TXT_DATA). */

var TXT_CHUNK = 240;   // chars per message (UTF-8 safe-ish, under the inbox)
var MAX_RETRY = 3;

function sendDict(dict, done) {
  var tries = 0;
  function attempt() {
    Pebble.sendAppMessage(dict, function () { done(null); }, function (e) {
      tries++;
      if (tries <= MAX_RETRY) setTimeout(attempt, 120 * tries);
      else done(e || new Error('send failed'));
    });
  }
  attempt();
}

// Send a (title, body) text product to the watch.
function sendText(title, body, done) {
  body = body || '';
  // Split on a char boundary; keep ASCII to avoid multi-byte chunk splits.
  var chunks = [];
  for (var i = 0; i < body.length; i += TXT_CHUNK) {
    chunks.push(body.substr(i, TXT_CHUNK));
  }
  if (!chunks.length) chunks.push('');
  sendDict({ TXT_TITLE: title || '' }, function () {
    var seq = 0;
    function next() {
      sendDict({ TXT_SEQ: seq, TXT_NCHUNKS: chunks.length, TXT_DATA: chunks[seq] },
        function (err) {
          if (err) { done(err); return; }
          seq++;
          if (seq < chunks.length) next(); else done(null);
        });
    }
    next();
  });
}

module.exports = { sendDict: sendDict, sendText: sendText };
