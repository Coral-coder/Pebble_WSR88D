/* Reliable AppMessage transport: send a small dict, or stream a large byte
 * array in acked chunks (the watch reassembles by sequence number).
 */

var CHUNK = 1000;       // payload bytes per message (well under the inbox)
var MAX_RETRY = 3;

// Send one dict, retrying on transient failure.
function sendDict(dict, done) {
  var tries = 0;
  function attempt() {
    Pebble.sendAppMessage(dict, function () {
      done(null);
    }, function (e) {
      tries++;
      if (tries <= MAX_RETRY) {
        setTimeout(attempt, 120 * tries);
      } else {
        done(e || new Error('send failed'));
      }
    });
  }
  attempt();
}

// Stream an RLE image (Uint8Array) to the watch as IMG_* chunks.
function sendImage(kind, frame, rle, done) {
  var total = rle.length;
  var nchunks = Math.ceil(total / CHUNK) || 1;
  var seq = 0;

  function sendChunk() {
    var start = seq * CHUNK;
    var end = Math.min(start + CHUNK, total);
    var slice = [];
    for (var k = start; k < end; k++) slice.push(rle[k]);

    var msg = {
      IMG_KIND: kind,
      IMG_FRAME: frame,
      IMG_SEQ: seq,
      IMG_NCHUNKS: nchunks,
      IMG_TOTAL: total,
      IMG_DATA: slice
    };
    sendDict(msg, function (err) {
      if (err) { done(err); return; }
      seq++;
      if (seq < nchunks) sendChunk();
      else done(null);
    });
  }
  sendChunk();
}

module.exports = {
  sendDict: sendDict,
  sendImage: sendImage
};
