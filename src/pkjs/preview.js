/* Clay customFn: renders a PIXEL-EXACT preview of the watchface in the
 * settings page by decoding the exact RLE buffers the phone last sent to the
 * watch (stashed in localStorage as 'wsr-preview'). The map + radar are the
 * literal GColor pixels the watch draws; the header/footer text is overlaid to
 * match the watch layout.
 *
 * Runs inside the config webview (serialized via toSource): self-contained,
 * uses only `document` + localStorage + the ClayConfig instance. Everything is
 * wrapped in try/catch so it can never break the settings page.
 *
 * Note: this reflects the currently-applied settings (the last render). After
 * changing a setting, Save and reopen settings to see it update.
 */
module.exports = function (minified) {
  var clayConfig = this;

  // GColor8 byte -> [r,g,b], or null when transparent (alpha bits 0).
  function gcolor(b) {
    if (((b >> 6) & 3) === 0) return null;
    return [((b >> 4) & 3) * 85, ((b >> 2) & 3) * 85, (b & 3) * 85];
  }

  function placeholder(ctx) {
    try {
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 200, 228);
      ctx.fillStyle = '#aaa'; ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Open the watchface once,', 100, 108);
      ctx.fillText('then reopen settings', 100, 126);
      ctx.fillText('to see the live preview.', 100, 144);
      ctx.textAlign = 'left';
    } catch (e) {}
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function drawExact(canvas) {
    var ctx = canvas.getContext('2d');
    try {
      var raw = localStorage.getItem('wsr-preview');
      if (!raw) { placeholder(ctx); return; }
      var pv = JSON.parse(raw);
      var W = pv.w, H = pv.h;
      var CW = canvas.width, CH = canvas.height;
      var HDR = CH - H; if (HDR < 0) HDR = 0;

      // Decode base map + radar RLE into the map-area ImageData.
      var img = ctx.createImageData(W, H);
      var d = img.data;
      function fillRLE(arr, skipClear) {
        if (!arr) return;
        var p = 0, i = 0, N = W * H;
        while (i + 3 <= arr.length && p < N) {
          var cnt = arr[i] | (arr[i + 1] << 8), col = arr[i + 2]; i += 3;
          var rgb = gcolor(col);
          for (var j = 0; j < cnt && p < N; j++, p++) {
            if (rgb === null) { if (skipClear) continue; }
            var o = p * 4;
            if (rgb) { d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255; }
          }
        }
      }
      fillRLE(pv.base, false);
      fillRLE(pv.radar, true);
      ctx.putImageData(img, 0, HDR);

      // Header (black bar) with clock, date, battery, weather.
      ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, CW, HDR);
      ctx.fillStyle = '#ffffff';
      var now = new Date();
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText(pad(now.getHours()) + ':' + pad(now.getMinutes()), 6, 38);
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
                  'Sep', 'Oct', 'Nov', 'Dec'];
      ctx.font = '14px sans-serif';
      ctx.fillText(days[now.getDay()] + ' ' + mons[now.getMonth()] + ' ' +
                   now.getDate(), 6, HDR - 6);
      ctx.textAlign = 'right';
      ctx.fillText('88%', CW - 4, 16);
      if (pv.wx) {
        ctx.fillText(pv.wx[0] || '', CW - 4, 32);
        ctx.fillText(pv.wx[1] || '', CW - 4, 46);
        ctx.fillText(pv.wx[2] || '', CW - 4, 60);
      }
      ctx.textAlign = 'left';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.strokeRect(CW - 66, 5, 20, 11);
      ctx.fillRect(CW - 46, 8, 2, 5);
      ctx.fillRect(CW - 64, 7, 15, 7);

      // Footer strip (over the bottom of the map) with scan time + range.
      var FOOT = 18;
      ctx.fillStyle = '#000000'; ctx.fillRect(0, CH - FOOT, CW, FOOT);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
      ctx.fillText(pv.scan || '', CW / 2, CH - 5);
      ctx.textAlign = 'left';
    } catch (e) {
      try { placeholder(ctx); } catch (_) {}
    }
  }

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    try {
      if (typeof document === 'undefined') return;
      var doc = document;
      var holder = doc.createElement('div');
      holder.style.cssText = 'text-align:center;padding:16px 0 6px;';
      var cap = doc.createElement('div');
      cap.textContent = 'PREVIEW (current settings)';
      cap.style.cssText =
        'color:#888;font:600 12px sans-serif;letter-spacing:.08em;margin-bottom:8px;';
      var canvas = doc.createElement('canvas');
      canvas.width = 200; canvas.height = 228;
      canvas.style.cssText =
        'width:160px;height:183px;border:3px solid #444;border-radius:14px;background:#000;';
      holder.appendChild(cap); holder.appendChild(canvas);

      var root = (clayConfig.$rootContainer &&
        (clayConfig.$rootContainer[0] ||
         (clayConfig.$rootContainer.get && clayConfig.$rootContainer.get(0)))) ||
        doc.body;
      if (root && root.insertBefore) root.insertBefore(holder, root.firstChild);
      else if (root && root.appendChild) root.appendChild(holder);

      drawExact(canvas);
    } catch (e) {}
  });
};
