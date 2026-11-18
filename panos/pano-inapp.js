/* pano-inapp.js — WRI 360 links open INSIDE the app, not in a new tab (2026-11-13, Cody).
 *
 * Load this once on a viewer page (response viewers, Field App). A tap on any link to the
 * WRI 360 viewer (…/wri-incident-panos/panos/pano.html or …/wri-panos/panos/pano.html), e.g.
 * "Open 360° viewer" in a map popup, opens that same viewer page in a full-screen panel over
 * the app with a Back button. The viewer page itself is unchanged (labels, tiles, heading).
 *
 *  - Ctrl / Cmd / Shift / middle click still opens a new tab, and the panel has an
 *    "Own tab" link, so nothing is taken away.
 *  - The panel's height is PINNED in pixels: on iPhone the address bar slides during a drag
 *    and a viewport-unit height would resize the sphere mid-gesture (the 2026-09-27 drift bug).
 *  - No history entries are added (the host app owns the URL); Back button or Esc closes.
 *  - Set window.WRI_PANO_INAPP_OFF = true before a click to switch it off.
 *
 * 3D site models (2026-11-13, Cody): a link to the drone server's 3D page
 * (https://drone.whitewaterrescue.com/3d?m=…) opens in the same panel. That page asks the app around
 * it for a sign-in ('wri-3d-ready'); this script answers, to the drone server's origin only (the panel it opened,
 * or the 3D Model widget on the viewer's toolbar), with the app's own ArcGIS sign-in (exb_auth) and the picked incident, the
 * same hand-over the Drone Video panel does. With no ArcGIS sign-in the page asks for the incident PIN.
 *
 * Dashboards (2026-11-17, Cody): on the RESPONSE VIEWERS only (page path …-viewer/), the dashboard row's links
 * (Ops, Resource Manager, Planning via wri-field-app/apps/, Logistics, Safety) open in the same panel, so the viewer
 * stays put; the panel's "Open in new tab" is the same banner-free link. The Apps Script apps inside the wrapper post
 * to window.top, which is now this page: their 'wri-apps-*' messages are relayed down to the wrapper frame, and the Ops
 * Live Map's 'wri-agol-token-request' is answered here with the viewer's ArcGIS sign-in — both only for frames
 * inside the open panel.
 */
(function () {
  'use strict';
  if (window.__wriPanoInApp) return;
  window.__wriPanoInApp = '2026-11-17b';
  var RX = /^https:\/\/whitewaterrescue\.github\.io\/(wri-incident-panos|wri-panos)\/panos\/pano\.html(\?|#|$)/i;
  var DRONE = 'https://drone.whitewaterrescue.com';
  var RX3D = /^https:\/\/drone\.whitewaterrescue\.com\/3d(\?|#|$)/i;
  var RXDASH = /^https:\/\/whitewaterrescue\.github\.io\/(wri-field-app\/apps\/|wri-logistics\/|wri-safety\/)/i;
  var IS_VIEWER = location.hostname === 'whitewaterrescue.github.io' && /^\/[^/]+-viewer\//i.test(location.pathname);
  var box = null, frame = null, lastFocus = null, pinT = null, pinW = 0, isDash = false;

  function css() {
    if (document.getElementById('wri-pano-inapp-css')) return;
    var s = document.createElement('style');
    s.id = 'wri-pano-inapp-css';
    s.textContent =
      '#wri-pano-inapp{position:fixed;left:0;right:0;top:0;height:100%;z-index:2147483000;background:#000;color:#fff;' +
        'display:flex;flex-direction:column;font:14px/1.3 Arial,Helvetica,sans-serif}' +
      '#wri-pano-inapp .wpi-hd{flex:none;display:flex;align-items:center;gap:10px;padding:8px 10px;' +
        'padding-top:calc(8px + env(safe-area-inset-top));background:#111}' +
      '#wri-pano-inapp .wpi-hd button,#wri-pano-inapp .wpi-hd a{flex:none;background:#222;border:1px solid #444;color:#fff;' +
        'border-radius:8px;padding:9px 12px;font:700 14px Arial,Helvetica,sans-serif;cursor:pointer;text-decoration:none}' +
      '#wri-pano-inapp .wpi-hd a{font-weight:400;font-size:12.5px;padding:9px 10px}' +
      '#wri-pano-inapp .wpi-t{flex:1;min-width:0;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#wri-pano-inapp .wpi-st{flex:1;min-height:0;position:relative}' +
      '#wri-pano-inapp .wpi-ld{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#bbb}' +
      '#wri-pano-inapp iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent}';
    document.head.appendChild(s);
  }
  function pin(now) {
    if (!box) return;
    var vv = window.visualViewport;
    var w = Math.round(vv ? vv.width : window.innerWidth), h = Math.round(vv ? vv.height : window.innerHeight);
    var apply = function () { if (box) { pinW = w; box.style.height = h + 'px'; } };
    clearTimeout(pinT);
    if (now || w !== pinW) apply(); else pinT = setTimeout(apply, 400);   // same width = the address bar moving: wait it out
  }
  function onResize() { pin(false); }
  function onKey(e) { if (e.key === 'Escape' && box) { e.stopPropagation(); close(); } }

  // the app's own ArcGIS sign-in + picked incident, for the 3D page (same as panels/drone-live)
  function exbToken() {
    var raw = null;
    try { raw = localStorage.getItem('exb_auth') || sessionStorage.getItem('exb_auth'); } catch (e) { return null; }
    try {
      var a = JSON.parse(raw || 'null');
      if (!a || !a.token) return null;
      var exp = Number(a.expires);
      return isFinite(exp) && exp < Date.now() ? null : a.token;
    } catch (e) { return null; }
  }
  // the incident this app is on: the viewer's / map's incident picker (incident-scope), else the incident the
  // phone picked at the Field App's gate (localStorage wri_incident_choice, same origin)
  function pickedIncident() {
    try { var w = window.top && window.top.__wriIncident; if (w && w.incident_id) return String(w.incident_id); } catch (e) {}
    try {
      var c = JSON.parse(localStorage.getItem('wri_incident_choice') || 'null');
      if (c && c.id && (!c.expires || Number(c.expires) > Date.now() || Date.parse(c.expires) > Date.now())) return String(c.id);
    } catch (e) {}
    return '';
  }
  // the app switched incident: every 3D frame on the page follows (Cody 2026-11-17)
  window.addEventListener('wri-incident-change', function () {
    var inc = pickedIncident();
    Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) {
      try { if (f.contentWindow && RX3D.test(f.src || '')) f.contentWindow.postMessage({ type: 'wri-3d-incident', incident: inc }, DRONE); } catch (e) {}
    });
  });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.origin !== DRONE || !d || d.type !== 'wri-3d-ready' || !e.source) return;   // any drone-server frame on this page: the panel above, or the toolbar's 3D Model widget
    try { e.source.postMessage({ type: 'wri-3d-auth', agol_token: exbToken(), incident: pickedIncident() }, DRONE); } catch (err) {}
  });

  // a frame somewhere inside the open dashboard panel (the wrapper, Google's frames, the app's own frame)
  function inPanel(src) {
    if (!box || !isDash || !frame || !src) return false;
    var top = frame.contentWindow;
    for (var w = src, i = 0; w && i < 8; i++) {
      if (w === top) return true;
      var p = null;
      try { p = w.parent; } catch (e) { return false; }
      if (!p || p === w) return false;
      w = p;
    }
    return false;
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !IS_VIEWER || !e.source) return;
    var g = false;
    try { g = /\.googleusercontent\.com$/.test(new URL(e.origin).hostname); } catch (x) {}
    if (!g || !inPanel(e.source)) return;
    if (d.type === 'wri-agol-token-request') {          // same answer the wrapper gives (wri-field-app/apps/)
      var raw = null;
      try { raw = localStorage.getItem('exb_auth') || sessionStorage.getItem('exb_auth'); } catch (x) {}
      try {
        var a = JSON.parse(raw || 'null');
        if (!a || !a.token) return;
        e.source.postMessage({ type: 'wri-agol-token', token: a.token, username: a.email || '',
          expiresAt: new Date(a.expires).getTime() || Date.now() + 1200000 }, e.origin);
      } catch (x) {}
    } else if (/^wri-apps-/.test(String(d.type || ''))) {
      try { frame.contentWindow.postMessage({ type: 'wri-apps-relay', data: d, origin: e.origin }, location.origin); } catch (x) {}
    }
  });

  function open(url, label) {
    close();
    css();
    var is3d = RX3D.test(url);
    isDash = !is3d && RXDASH.test(url);
    var title = is3d ? '3D site model' : isDash ? (label || 'Dashboard') : '360° view';
    if (!isDash) try { title = new URL(url).searchParams.get('title') || title; } catch (e) {}
    lastFocus = document.activeElement;
    box = document.createElement('div');
    box.id = 'wri-pano-inapp';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    var hd = document.createElement('div'); hd.className = 'wpi-hd';
    var back = document.createElement('button'); back.type = 'button'; back.className = 'wpi-back';
    back.textContent = isDash ? '← Back to map' : '← Back'; back.onclick = close;
    var t = document.createElement('div'); t.className = 'wpi-t'; t.textContent = title;
    var own = document.createElement('a'); own.className = 'wpi-own'; own.href = url; own.target = '_blank'; own.rel = 'noopener';
    own.textContent = isDash ? 'Open in new tab ↗' : 'Own tab ↗';
    if (isDash) own.addEventListener('click', function () { setTimeout(close, 0); });   // the tab takes over; the map comes back
    hd.appendChild(back); hd.appendChild(t); hd.appendChild(own);
    var st = document.createElement('div'); st.className = 'wpi-st';
    var ld = document.createElement('div'); ld.className = 'wpi-ld';
    ld.textContent = is3d ? 'Loading 3D model…' : isDash ? 'Loading ' + title + '…' : 'Loading 360° view…';
    frame = document.createElement('iframe');
    frame.title = title;
    // dashboards: the same permissions the wrapper gives the apps (print/PDF popups, sign-in popup, camera, clipboard)
    frame.setAttribute('allow', isDash ? 'geolocation; camera; microphone; clipboard-read; clipboard-write; fullscreen; web-share; autoplay'
      : 'fullscreen; accelerometer; gyroscope');
    if (isDash) frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    if (isDash) st.style.background = '#fff';
    frame.setAttribute('allowfullscreen', '');
    frame.addEventListener('load', function () { ld.style.display = 'none'; });
    frame.src = url;
    st.appendChild(ld); st.appendChild(frame);
    box.appendChild(hd); box.appendChild(st);
    document.body.appendChild(box);
    pin(true);
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
    try { back.focus({ preventScroll: true }); } catch (e) {}
  }
  function close() {
    if (!box) return;
    window.removeEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(pinT);
    try { frame.src = 'about:blank'; } catch (e) {}     // frees the WebGL sphere
    box.remove(); box = frame = null; pinW = 0; isDash = false;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch (e) {}
    lastFocus = null;
  }

  // Capture phase on window: runs before the map popup's own handlers, and sees links that
  // sit inside a web component's shadow root (composedPath).
  window.addEventListener('click', function (e) {
    if (window.WRI_PANO_INAPP_OFF || e.defaultPrevented || e.button) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;      // "open in a new tab" on purpose
    var a = null, path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.tagName === 'A' && n.href) { a = n; break; }
    }
    if (!a && e.target && e.target.closest) a = e.target.closest('a[href]');
    var dash = IS_VIEWER && a && RXDASH.test(a.href);
    if (!a || !(RX.test(a.href) || RX3D.test(a.href) || dash)) return;
    if (box && box.contains(a)) return;                                // the panel's own "Own tab" link
    e.preventDefault();
    e.stopImmediatePropagation();
    open(a.href, dash ? String(a.textContent || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim() : '');
  }, true);

  window.WRIPanoInApp = { open: open, close: close, isOpen: function () { return !!box; } };
})();
