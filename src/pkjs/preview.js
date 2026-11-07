/* Clay customFn: a LIVE preview of the watchface in the settings page. The
 * config webview can fetch + draw on its own, so the preview re-renders as you
 * change settings — before saving. It draws the same map (bold OSM roads via
 * Overpass, or raster tiles) + radar (RainViewer) the watch shows, in the same
 * Web-Mercator projection.
 *
 * Self-contained (serialized via toSource): uses document, XMLHttpRequest,
 * Image, canvas, setTimeout, and the ClayConfig instance (this). The phone's
 * last location + weather arrive via clayConfig.meta.userData. Everything is
 * wrapped in try/catch so it can never break the settings page.
 */
module.exports = function (minified) {
  var clayConfig = this;
  var TILE = 256, Wd = 200, Ht = 228, HDR = 64, MAPH = Ht - HDR;
  var seq = 0, timer = null, main = null, mapc = null;
  var roads = { key: null, els: null };
  var rindex = { done: false, host: null, path: null };

  function lonToX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z) * TILE; }
  function latToY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * TILE;
  }

  function gi(k) {
    try { var it = clayConfig.getItemByMessageKey(k); return it ? it.get() : undefined; }
    catch (e) { return undefined; }
  }
  function intg(k, d) { var v = parseInt(gi(k), 10); return isNaN(v) ? d : v; }
  function boolg(k, d) {
    var v = gi(k);
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return d;
  }
  function ud() { try { return (clayConfig.meta && clayConfig.meta.userData) || {}; } catch (e) { return {}; } }

  function cfg() {
    return {
      style: intg('MAP_STYLE', 1), scheme: intg('SET_SCHEME', 2),
      zoom: Math.max(3, Math.min(11, intg('ZOOM', 6))),
      units: intg('SET_UNITS', 0),
      smooth: boolg('RADAR_SMOOTH', true) ? 1 : 0,
      snow: boolg('RADAR_SNOW', true) ? 1 : 0,
      detail: Math.max(1, Math.min(5, intg('DETAIL', 3))),
      key: (gi('STADIA_KEY') || '').replace(/\s/g, ''),
      murl: gi('MAP_URL') || '',
      locMode: intg('LOC_MODE', 0),
      lat: parseFloat(gi('LOC_LAT')), lon: parseFloat(gi('LOC_LON'))
    };
  }
  function loc(c) {
    if (c.locMode === 1 && isFinite(c.lat) && isFinite(c.lon)) return { lat: c.lat, lon: c.lon };
    var u = ud();
    if (isFinite(u.lat) && isFinite(u.lon)) return { lat: u.lat, lon: u.lon };
    return { lat: 39.5, lon: -98.35 };
  }
  function highwayRegex(detail) {
    var cc = ['motorway', 'trunk'];
    if (detail >= 2) cc.push('primary');
    if (detail >= 3) cc.push('secondary');
    if (detail >= 4) cc.push('tertiary');
    if (detail >= 5) cc.push('residential', 'unclassified');
    return cc.join('|');
  }
  function waterMin(detail) { var m = 50 - detail * 9; return m < 8 ? 8 : m; }

  function getJSON(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true); x.timeout = 25000;
    x.onload = function () { try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); } };
    x.onerror = function () { cb(new Error('net')); };
    x.ontimeout = function () { cb(new Error('timeout')); };
    x.send();
  }
  function loadImg(url, cb) {
    try { var im = new Image(); im.onload = function () { cb(null, im); };
      im.onerror = function () { cb(new Error('img')); }; im.src = url; }
    catch (e) { cb(e); }
  }

  function paint(c, lc) {
    try {
      var ctx = main.getContext('2d');
      ctx.drawImage(mapc, 0, HDR);
      // header
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, Wd, HDR);
      ctx.fillStyle = '#fff';
      var now = new Date(); function p2(n) { return (n < 10 ? '0' : '') + n; }
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText(p2(now.getHours()) + ':' + p2(now.getMinutes()), 6, 38);
      var dn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var mn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      ctx.font = '14px sans-serif';
      ctx.fillText(dn[now.getDay()] + ' ' + mn[now.getMonth()] + ' ' + now.getDate(), 6, HDR - 6);
      ctx.textAlign = 'right';
      var wx = ud().wx || [];
      ctx.fillText('88%', Wd - 4, 16);
      ctx.fillText(wx[0] || '', Wd - 4, 32);
      ctx.fillText(wx[1] || '', Wd - 4, 46);
      ctx.fillText(wx[2] || '', Wd - 4, 60);
      ctx.textAlign = 'left';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(Wd - 66, 5, 20, 11);
      ctx.fillRect(Wd - 46, 8, 2, 5); ctx.fillRect(Wd - 64, 7, 15, 7);
      // footer (computed range)
      var mpp = 156543.03 * Math.cos(lc.lat * Math.PI / 180) / Math.pow(2, c.zoom);
      var half = (Wd / 2) * mpp;
      var rng = c.units === 1 ? Math.round(half / 1000) + 'km' : Math.round(half / 1609.34) + 'mi';
      ctx.fillStyle = '#000'; ctx.fillRect(0, Ht - 18, Wd, 18);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.fillText('radar  ·  ' + rng, Wd / 2, Ht - 5); ctx.textAlign = 'left';
    } catch (e) {}
  }

  function drawVector(mctx, c, lc, z, tok, done) {
    var ink = c.style === 5 ? '#ffffff' : '#000000';
    function wpolys(els, minN) {
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i], tg = el.tags || {};
        if (tg.natural !== 'water') continue;
        if (el.type === 'way' && el.geometry && el.geometry.length >= minN) out.push(el.geometry);
        else if (el.type === 'relation' && el.members) {
          for (var m = 0; m < el.members.length; m++) {
            var mm = el.members[m];
            if (mm.type === 'way' && (mm.role === 'outer' || !mm.role) &&
                mm.geometry && mm.geometry.length >= minN) out.push(mm.geometry);
          }
        }
      }
      return out;
    }
    function render2() {
      if (tok !== seq) return;
      var cx = lonToX(lc.lon, z), cy = latToY(lc.lat, z), tlx = cx - Wd / 2, tly = cy - MAPH / 2;
      var els = roads.els || [], e, n, g, tags;
      // water fills (ways + relation outers)
      mctx.fillStyle = c.style === 5 ? '#555555' : '#c8c8c8';
      var polys = wpolys(els, waterMin(c.detail));
      for (e = 0; e < polys.length; e++) {
        g = polys[e]; mctx.beginPath();
        for (n = 0; n < g.length; n++) {
          var wx = lonToX(g[n].lon, z) - tlx, wy = latToY(g[n].lat, z) - tly;
          if (n === 0) mctx.moveTo(wx, wy); else mctx.lineTo(wx, wy);
        }
        mctx.closePath(); mctx.fill();
      }
      // roads + coastline, thin
      mctx.strokeStyle = ink; mctx.lineCap = 'round';
      for (e = 0; e < els.length; e++) {
        tags = els[e].tags || {};
        if (tags.natural === 'water') continue;
        g = els[e].geometry; if (!g || g.length < 2) continue;
        mctx.lineWidth = (tags.highway === 'motorway' || tags.highway === 'trunk') ? 2 : 1;
        mctx.beginPath();
        for (n = 0; n < g.length; n++) {
          var sx = lonToX(g[n].lon, z) - tlx, sy = latToY(g[n].lat, z) - tly;
          if (n === 0) mctx.moveTo(sx, sy); else mctx.lineTo(sx, sy);
        }
        mctx.stroke();
      }
      done();
    }
    var key = lc.lat.toFixed(3) + ',' + lc.lon.toFixed(3) + ',' + z + ',' + c.detail;
    if (roads.key === key && roads.els) { render2(); return; }
    var cx = lonToX(lc.lon, z), cy = latToY(lc.lat, z), tlx = cx - Wd / 2, tly = cy - MAPH / 2;
    function xToLon(px) { return px / TILE / Math.pow(2, z) * 360 - 180; }
    function yToLat(px) { var nn = Math.PI - 2 * Math.PI * (px / TILE) / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(nn) - Math.exp(-nn))); }
    var bb = yToLat(tly + MAPH) + ',' + xToLon(tlx) + ',' + yToLat(tly) + ',' + xToLon(tlx + Wd);
    var q = '[out:json][timeout:25];(' +
      'way["highway"~"^(' + highwayRegex(c.detail) + ')$"](' + bb + ');' +
      'way["natural"="coastline"](' + bb + ');' +
      'way["natural"="water"](' + bb + ');' +
      'relation["natural"="water"](' + bb + ');' +
      ');out geom;';
    getJSON('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), function (err, data) {
      if (tok !== seq) return;
      roads.key = key; roads.els = (err || !data) ? [] : (data.elements || []);
      render2();
    });
  }

  function tileList(lc, z, srcZoom) {
    var f = Math.pow(2, z - srcZoom);
    var cx = lonToX(lc.lon, z), cy = latToY(lc.lat, z), tlx = cx - Wd / 2, tly = cy - MAPH / 2;
    var n = Math.pow(2, srcZoom);
    var tx0 = Math.floor(tlx / f / TILE), tx1 = Math.floor((tlx + Wd - 1) / f / TILE);
    var ty0 = Math.floor(tly / f / TILE), ty1 = Math.floor((tly + MAPH - 1) / f / TILE);
    var out = [];
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) {
      out.push({ x: ((tx % n) + n) % n, y: ty,
        dx: tx * TILE * f - tlx, dy: ty * TILE * f - tly, ds: TILE * f });
    }
    return out;
  }

  function drawRaster(mctx, c, lc, z, tok, done) {
    var url, labels = c.detail >= 2;
    if (c.style === 4 && c.key) url = 'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}.png?api_key=' + encodeURIComponent(c.key);
    else if (c.style === 9 && c.murl.indexOf('{z}') >= 0) url = c.murl;
    else url = 'https://a.basemaps.cartocdn.com/rastertiles/voyager' + (labels ? '' : '_nolabels') + '/{z}/{x}/{y}.png';
    var list = tileList(lc, z, z), left = list.length;
    if (!left) { done(); return; }
    list.forEach(function (t) {
      loadImg(url.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y), function (err, im) {
        if (tok === seq && !err) { try { mctx.drawImage(im, t.dx, t.dy, t.ds, t.ds); } catch (e) {} paint(c, lc); }
        if (--left === 0) done();
      });
    });
  }

  function drawRadar(mctx, c, lc, z, tok) {
    function go() {
      if (tok !== seq || !rindex.path) return;
      var zr = Math.min(z, 7);
      var list = tileList(lc, z, zr);
      list.forEach(function (t) {
        var u = rindex.host + rindex.path + '/256/' + zr + '/' + t.x + '/' + t.y + '/' +
                c.scheme + '/' + c.smooth + '_' + c.snow + '.png';
        loadImg(u, function (err, im) {
          if (tok === seq && !err) { try { mctx.drawImage(im, t.dx, t.dy, t.ds, t.ds); } catch (e) {} paint(c, lc); }
        });
      });
    }
    if (rindex.done) { go(); return; }
    getJSON('https://api.rainviewer.com/public/weather-maps.json', function (err, j) {
      rindex.done = true;
      if (!err && j && j.radar && j.radar.past && j.radar.past.length) {
        rindex.host = j.host; rindex.path = j.radar.past[j.radar.past.length - 1].path;
      }
      if (tok === seq) go();
    });
  }

  function render() {
    try {
      if (!main || !mapc) return;
      var c = cfg(), lc = loc(c), z = c.zoom, tok = ++seq;
      var mctx = mapc.getContext('2d');
      mctx.fillStyle = (c.style === 5) ? '#000000' : '#ffffff';
      mctx.fillRect(0, 0, Wd, MAPH);
      paint(c, lc);
      var afterMap = function () { if (tok === seq) { paint(c, lc); drawRadar(mctx, c, lc, z, tok); } };
      if (c.style === 1 || c.style === 5) drawVector(mctx, c, lc, z, tok, afterMap);
      else drawRaster(mctx, c, lc, z, tok, afterMap);
    } catch (e) {}
  }

  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(render, 250); }

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    try {
      if (typeof document === 'undefined') return;
      var doc = document;

      // Sticky bar pinned to the top: preview on the left, Save on the right.
      // The options scroll underneath, so a change is always visible.
      var holder = doc.createElement('div');
      holder.style.cssText = 'position:sticky;top:0;z-index:50;background:#1b1b1d;' +
        'display:flex;align-items:center;justify-content:center;gap:16px;' +
        'padding:10px;border-bottom:1px solid #333;';

      main = doc.createElement('canvas'); main.width = Wd; main.height = Ht;
      main.style.cssText = 'width:150px;height:171px;border:3px solid #444;border-radius:14px;background:#000;flex:0 0 auto;';

      var col = doc.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;';
      var cap = doc.createElement('div');
      cap.textContent = 'LIVE PREVIEW';
      cap.style.cssText = 'color:#888;font:600 11px sans-serif;letter-spacing:.1em;';
      var saveBtn = doc.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'padding:12px 26px;border:0;border-radius:9px;' +
        'background:#1f8f4f;color:#fff;font:700 15px sans-serif;cursor:pointer;';
      saveBtn.onclick = function () {
        try {
          var rs = doc.querySelector('input[type="submit"], button[type="submit"]');
          if (rs) rs.click();
        } catch (e) {}
      };
      col.appendChild(cap); col.appendChild(saveBtn);
      holder.appendChild(main); holder.appendChild(col);

      var root = (clayConfig.$rootContainer &&
        (clayConfig.$rootContainer[0] ||
         (clayConfig.$rootContainer.get && clayConfig.$rootContainer.get(0)))) || doc.body;
      if (root && root.insertBefore) root.insertBefore(holder, root.firstChild);
      else if (root && root.appendChild) root.appendChild(holder);

      // Hide Clay's bottom Save button — the sticky one replaces it.
      try {
        var orig = doc.querySelector('input[type="submit"], button[type="submit"]');
        if (orig) {
          var wrap = (orig.parentNode && orig.parentNode !== holder) ? orig.parentNode : orig;
          if (wrap !== holder) wrap.style.display = 'none';
        }
      } catch (e) {}

      mapc = doc.createElement('canvas'); mapc.width = Wd; mapc.height = MAPH;

      ['MAP_STYLE', 'SET_SCHEME', 'ZOOM', 'SET_UNITS', 'RADAR_SMOOTH', 'RADAR_SNOW',
       'DETAIL', 'STADIA_KEY', 'MAP_URL', 'LOC_MODE', 'LOC_LAT', 'LOC_LON']
        .forEach(function (k) {
          try { var it = clayConfig.getItemByMessageKey(k); if (it && it.on) it.on('change', schedule); }
          catch (e) {}
        });

      render();

      // "Update available" banner with a one-tap install link.
      try {
        var u = ud();
        if (u && u.repo) {
          var ux = new XMLHttpRequest();
          ux.open('GET', 'https://api.github.com/repos/' + u.repo + '/releases/latest', true);
          ux.onload = function () {
            try {
              var r = JSON.parse(ux.responseText);
              var m = /(\d+)/.exec(r.tag_name || '');
              var latest = m ? parseInt(m[1], 10) : 0;
              if (latest <= (u.build || 0)) return;
              var pbw = '', as = r.assets || [];
              for (var i = 0; i < as.length; i++) {
                if (/\.pbw$/i.test(as[i].name)) { pbw = as[i].browser_download_url; break; }
              }
              var bn = doc.createElement('div');
              bn.style.cssText = 'margin:12px;padding:12px;border-radius:10px;' +
                'background:#1f6f3f;color:#fff;font:600 13px sans-serif;text-align:center;';
              bn.appendChild(doc.createTextNode('Update available — Build ' + latest));
              var a = doc.createElement('a');
              a.href = pbw || ('https://github.com/' + u.repo + '/releases/latest');
              a.textContent = 'Tap to install';
              a.style.cssText = 'display:block;margin-top:6px;color:#fff;';
              bn.appendChild(a);
              // Place the banner just below the sticky preview bar.
              if (root && root.insertBefore) root.insertBefore(bn, holder.nextSibling);
              else if (root && root.appendChild) root.appendChild(bn);
            } catch (e) {}
          };
          ux.send();
        }
      } catch (e) {}
    } catch (e) {}
  });
};
