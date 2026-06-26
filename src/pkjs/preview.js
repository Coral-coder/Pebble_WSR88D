/* Clay customFn: draws a schematic preview of the watchface at the top of the
 * settings page and updates it live as the map style / scheme / units change.
 *
 * This runs inside the config webview (serialized via toSource), so it must be
 * self-contained and use only `document` + the ClayConfig instance (`this`).
 * Everything is wrapped in try/catch so a failure can never break the page.
 */
module.exports = function (minified) {
  var clayConfig = this;

  function val(key, dflt) {
    try {
      var it = clayConfig.getItemByMessageKey(key);
      if (!it) return dflt;
      var v = parseInt(it.get(), 10);
      return isNaN(v) ? dflt : v;
    } catch (e) { return dflt; }
  }

  function draw(ctx) {
    try {
      var style = val('MAP_STYLE', 0);
      var units = val('SET_UNITS', 0);
      var dark = style >= 2, hc = (style === 1 || style === 3);
      var W = 200, H = 228, HDR = 64, FOOT = 18;
      var bg = dark ? (hc ? '#000000' : '#15171a') : (hc ? '#ffffff' : '#f3efe6');
      var ink = dark ? '#ffffff' : (hc ? '#000000' : '#7a7e82');

      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      // mock roads / coastline
      ctx.strokeStyle = ink; ctx.lineWidth = hc ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(8, HDR + 24); ctx.lineTo(120, HDR + 54); ctx.lineTo(150, H - 28);
      ctx.moveTo(60, HDR + 8); ctx.lineTo(86, H - 22);
      ctx.moveTo(0, HDR + 86); ctx.lineTo(W, HDR + 100);
      ctx.stroke();

      // mock radar cells
      function blob(x, y, r, c) {
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
      blob(72, 150, 16, 'rgba(40,170,60,0.9)');
      blob(72, 150, 9, 'rgba(230,200,40,0.95)');
      blob(132, 172, 20, 'rgba(40,170,60,0.85)');
      blob(132, 172, 12, 'rgba(230,200,40,0.95)');
      blob(132, 172, 5, 'rgba(220,40,40,0.95)');

      // header bar
      ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, HDR);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif'; ctx.fillText('12:34', 6, 38);
      ctx.font = '14px sans-serif'; ctx.fillText('Fri Jun 26', 6, 58);
      ctx.textAlign = 'right';
      ctx.fillText('88%', W - 4, 16);
      ctx.fillText('72° Clear', W - 4, 32);
      ctx.fillText('H86 L72', W - 4, 46);
      ctx.fillText('Rain 14%', W - 4, 60);
      ctx.textAlign = 'left';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.strokeRect(W - 66, 5, 20, 11);
      ctx.fillRect(W - 46, 8, 2, 5);
      ctx.fillRect(W - 64, 7, 15, 7);

      // footer strip
      ctx.fillStyle = '#000000'; ctx.fillRect(0, H - FOOT, W, FOOT);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
      ctx.fillText('12:30    ' + (units === 1 ? '180km' : '110mi'), W / 2, H - 5);
      ctx.textAlign = 'left';
    } catch (e) {}
  }

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    try {
      if (typeof document === 'undefined') return;
      var doc = document;
      var holder = doc.createElement('div');
      holder.style.cssText = 'text-align:center;padding:16px 0 6px;';
      var cap = doc.createElement('div');
      cap.textContent = 'PREVIEW';
      cap.style.cssText =
        'color:#888;font:600 12px sans-serif;letter-spacing:.1em;margin-bottom:8px;';
      var canvas = doc.createElement('canvas');
      canvas.width = 200; canvas.height = 228;
      canvas.style.cssText =
        'width:160px;height:183px;border:3px solid #444;border-radius:14px;';
      holder.appendChild(cap); holder.appendChild(canvas);

      var root = (clayConfig.$rootContainer &&
        (clayConfig.$rootContainer[0] ||
         (clayConfig.$rootContainer.get && clayConfig.$rootContainer.get(0)))) ||
        doc.body;
      if (root && root.insertBefore) root.insertBefore(holder, root.firstChild);
      else if (root && root.appendChild) root.appendChild(holder);

      var ctx = canvas.getContext('2d');
      var redraw = function () { draw(ctx); };
      redraw();

      ['MAP_STYLE', 'SET_SCHEME', 'SET_UNITS'].forEach(function (k) {
        try {
          var it = clayConfig.getItemByMessageKey(k);
          if (it && it.on) it.on('change', redraw);
        } catch (e) {}
      });
    } catch (e) {}
  });
};
