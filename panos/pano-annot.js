/*!
 * WRI 360 sphere annotations — shared renderer.
 *
 * THE ONLY COPY. Published to wri-incident-panos/panos/pano-annot.js and loaded by URL from all
 * three consumers (every WRI Pages repo is the same origin, so there is no CORS and no reason to
 * duplicate it):
 *
 *   wri-incident-panos/panos/pano.html   incident + drill spheres   read-only
 *   wri-panos/panos/pano.html            Snake / Spokane / St.George read-only
 *   wri-field-app/panels/pano-annotator/ the editor                  read + draw
 *
 * Do not fork this file. pano.html already exists as three hand-synced copies and this codebase
 * has been bitten by a hand-synced engine before (spill trace, four copies).
 *
 * COORDINATE FRAME: Pannellum yaw/pitch in degrees, image frame. Yaw is NOT a compass bearing --
 * pano.html sets compass:false and maps ?heading= to yaw as an offset from image centre. These
 * annotations are tied to the image, not to the ground.
 *
 * Deploy with AGOL Pano viewer/deploy_pano_viewer.py, which stamps ?v= on every consumer.
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var D = Math.PI / 180;

  /* ------------------------------------------------------------------ config */

  // Source table: everything, needs an org token. View: only public_ok = 1, no token.
  var SOURCE_URL = 'https://services6.arcgis.com/Ji79lWGR5B33LhY7/arcgis/rest/services/WRI_Pano_Annotations/FeatureServer/0';
  var VIEW_URL   = 'https://services6.arcgis.com/Ji79lWGR5B33LhY7/arcgis/rest/services/WRI_Pano_Annotations_pub/FeatureServer/0';
  var ORG_ID     = 'Ji79lWGR5B33LhY7';
  var OUT_FIELDS = 'OBJECTID,pano_key,annot_json,public_ok,pano_name,updated_by,updated_at';

  // On-imagery colours are cartography, not UI tokens, and deliberately do not follow the theme
  // (same rule as the GRP photo annotator).
  var STYLE = {
    point: { color: '#ffd21e', casing: 'rgba(0,0,0,0.60)' },
    line:  { color: '#4da3ff', casing: 'rgba(0,0,0,0.60)' },
    area:  { color: '#00e0b8', casing: 'rgba(0,0,0,0.60)', fill: 'rgba(0,224,184,0.16)' }
  };

  var MAX_SEG_DEG = 3;     // densification step: an edge is sampled every ~3 deg of arc
  var MAX_SAMPLES = 160;   // hard cap per edge, so a pathological shape cannot hang a frame
  var NEAR_Z      = 0.02;  // <= this is behind/beside the camera (~89 deg off axis)

  /* -------------------------------------------------------------- pano_key */

  /**
   * A sphere's identity: `<set>:<id>`, e.g. `grp:0045`, `inc:9e1f2a...`, `grp:StGeorge_01.JPG`.
   *
   * DELIBERATELY host-independent. WRI 360 imagery sits on public GitHub Pages today, but the
   * plan is to be able to move it behind a paid login later -- and a key that embedded the repo
   * name or the URL path (`wri-panos:tiles/0045`) would change the moment the imagery moved,
   * orphaning every label ever drawn. So we keep only the TILE ID, and resolve the set through an
   * alias table: a new host is one entry below, not a migration of the annotation table.
   *
   * The set prefix still matters -- wri-panos issues zero-padded numeric ids and the incident
   * worker issues GlobalIDs, and without a namespace a pruned-then-reissued id could inherit
   * another sphere's labels.
   */
  var SET_ALIAS = {
    'whitewaterrescue.github.io/wri-panos': 'grp',            // permanent GRP / St. George spheres
    'whitewaterrescue.github.io/wri-incident-panos': 'inc'    // disposable incident + drill spheres
  };

  function panoKey(href) {
    try {
      var u = new URL(href, global.location && global.location.href);
      var what = u.searchParams.get('tiles') || u.searchParams.get('img');
      if (!what) return null;
      // Keep the id only -- `tiles/0045` and a future `/spheres/0045/` are the same sphere.
      var id = String(what).replace(/\/+$/, '').split('/').pop();
      if (!id) return null;
      var parts = u.pathname.split('/').filter(Boolean);
      var i = parts.indexOf('panos');
      var seg = i > 0 ? parts[i - 1] : (parts[0] || 'local');
      var set = SET_ALIAS[u.host + '/' + seg] || seg;
      return set + ':' + id;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ projection */

  /**
   * Sphere -> screen, mirrored verbatim from Pannellum 2.5.6's own hotspot positioner so our
   * overlay lands pixel-identical to a native hotspot (which is how live_check_annot.js tests it).
   *
   * Returns canvas-relative pixels plus z = cos(angle off the view axis); z <= 0 is behind you.
   */
  function project(cam, yaw, pitch) {
    var sinV = Math.sin(pitch * D), cosV = Math.cos(pitch * D);
    var sinC = Math.sin(cam.pitch * D), cosC = Math.cos(cam.pitch * D);
    var dy = (cam.yaw - yaw) * D;
    var cosDy = Math.cos(dy), sinDy = Math.sin(dy);

    var z = sinV * sinC + cosV * cosDy * cosC;
    var k = Math.tan(cam.hfov * D / 2);
    var x = -cam.w / k * sinDy * cosV / z / 2;
    var y = -cam.w / k * (sinV * cosC - cosV * cosDy * sinC) / z / 2;

    if (cam.roll) {                                   // pano.html never sets roll; kept for parity
      var sr = Math.sin(cam.roll * D), cr = Math.cos(cam.roll * D);
      var rx = x * cr - y * sr;
      y = x * sr + y * cr;
      x = rx;
    }
    return { x: x + cam.w / 2, y: y + cam.h / 2, z: z };
  }

  /** Camera state in the exact terms project() needs. Canvas client size, as Pannellum uses. */
  function camOf(viewer) {
    var cv = viewer.getRenderer().getCanvas();
    var cfg = viewer.getConfig();
    return {
      yaw: viewer.getYaw(), pitch: viewer.getPitch(), hfov: viewer.getHfov(),
      roll: cfg.roll || 0, w: cv.clientWidth, h: cv.clientHeight
    };
  }

  /**
   * Screen -> sphere. Pannellum's mouseEventToCoords wants only clientX/clientY and measures
   * against the CONTAINER rect, so a synthetic object works for touch and for tests.
   * Returns [yaw, pitch] (note Pannellum hands back [pitch, yaw]).
   */
  function unproject(viewer, clientX, clientY) {
    var pc = viewer.mouseEventToCoords({ clientX: clientX, clientY: clientY });
    return [pc[1], pc[0]];
  }

  /* -------------------------------------------------------- sphere geometry */

  function toVec(yaw, pitch) {
    var cp = Math.cos(pitch * D);
    return [cp * Math.sin(yaw * D), Math.sin(pitch * D), cp * Math.cos(yaw * D)];
  }

  function fromVec(v) {
    var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [Math.atan2(v[0] / n, v[2] / n) / D, Math.asin(Math.max(-1, Math.min(1, v[1] / n))) / D];
  }

  /**
   * Great-circle samples from a to b inclusive of a, exclusive of b.
   *
   * Sampling in 3D rather than lerping yaw/pitch is what makes a long edge curve the way the
   * imagery does, and it removes the 180 deg seam as a special case entirely: slerp takes the
   * short way round without anyone having to think about wrap.
   */
  function densify(a, b) {
    var va = toVec(a[0], a[1]), vb = toVec(b[0], b[1]);
    var dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
    var ang = Math.acos(dot);
    var n = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(ang / D / MAX_SEG_DEG)));
    var out = [];
    if (ang < 1e-6) return [a.slice()];
    var s = Math.sin(ang);
    for (var i = 0; i < n; i++) {
      var t = i / n;
      var k0 = Math.sin((1 - t) * ang) / s, k1 = Math.sin(t * ang) / s;
      out.push(fromVec([va[0] * k0 + vb[0] * k1, va[1] * k0 + vb[1] * k1, va[2] * k0 + vb[2] * k1]));
    }
    return out;
  }

  /** Every vertex of a shape, densified, closed for an area. */
  function samples(shape) {
    var pts = shape.pts || [];
    if (pts.length < 2) return pts.slice();
    var ring = shape.kind === 'area' ? pts.concat([pts[0]]) : pts;
    var out = [];
    for (var i = 0; i < ring.length - 1; i++) out = out.concat(densify(ring[i], ring[i + 1]));
    out.push(ring[ring.length - 1].slice());
    return out;
  }

  /**
   * Project a sample list into runs of consecutive on-sphere-in-front points. A shape wrapping
   * behind the viewer comes back as several runs instead of one polyline shooting to infinity.
   */
  function runsOf(cam, pts) {
    var lim = 20 * Math.max(cam.w, cam.h);
    var runs = [], cur = [];
    for (var i = 0; i < pts.length; i++) {
      var p = project(cam, pts[i][0], pts[i][1]);
      if (p.z > NEAR_Z && Math.abs(p.x) < lim && Math.abs(p.y) < lim) {
        cur.push(p);
      } else if (cur.length) {
        runs.push(cur); cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  function pathD(run) {
    var d = 'M' + run[0].x.toFixed(1) + ' ' + run[0].y.toFixed(1);
    for (var i = 1; i < run.length; i++) d += 'L' + run[i].x.toFixed(1) + ' ' + run[i].y.toFixed(1);
    return d;
  }

  /* ------------------------------------------------------------- the overlay */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(n) { return global.document.createElementNS(SVG_NS, n); }

  /**
   * Draws a shape list over a live Pannellum viewer and keeps it registered as the user looks
   * around. Read-only by itself; the annotator panel adds handles and hit-testing on top.
   */
  function Overlay(viewer, opts) {
    opts = opts || {};
    var doc = global.document;
    var host = viewer.getContainer();

    var root = doc.createElement('div');
    root.className = 'wri-annot';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:absolute;top:0;right:0;bottom:0;left:0;' +
      'pointer-events:none;z-index:4;overflow:hidden';

    var svg = svgEl('svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible';
    root.appendChild(svg);

    var labels = doc.createElement('div');
    labels.className = 'wri-annot-labels';
    labels.style.cssText = 'position:absolute;top:0;right:0;bottom:0;left:0';
    root.appendChild(labels);
    host.appendChild(root);

    var shapes = [];
    var visible = true;
    var dirty = true;
    var last = { yaw: NaN, pitch: NaN, hfov: NaN, w: 0, h: 0 };
    var raf = 0;
    var self = {};

    // The editor draws its own handles into this group, above the geometry.
    var gGeom = svgEl('g'); svg.appendChild(gGeom);
    var gEdit = svgEl('g'); svg.appendChild(gEdit);

    function labelEl(text) {
      var el = doc.createElement('div');
      el.className = 'wri-annot-label';
      el.style.cssText =
        'position:absolute;left:0;top:0;max-width:220px;padding:3px 7px;border-radius:3px;' +
        'background:rgba(13,15,18,0.78);color:#e8eaed;font:600 12px/1.3 ui-monospace,' +
        '"SF Mono",Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;box-shadow:0 1px 6px rgba(0,0,0,0.5);' +
        '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)';
      el.textContent = text;                       // labels are user text: never innerHTML
      return el;
    }

    function drawShape(s, cam) {
      var st = STYLE[s.kind] || STYLE.line;
      var anchor = null;

      if (s.kind === 'point') {
        var p = project(cam, s.pts[0][0], s.pts[0][1]);
        if (p.z <= NEAR_Z) return null;
        var ring = svgEl('circle');
        ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y); ring.setAttribute('r', 8);
        ring.setAttribute('fill', st.casing);
        var dot = svgEl('circle');
        dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.setAttribute('r', 5);
        dot.setAttribute('fill', st.color);
        gGeom.appendChild(ring); gGeom.appendChild(dot);
        anchor = p;
      } else {
        var runs = runsOf(cam, samples(s));
        if (!runs.length) return null;
        var whole = s.kind === 'area' && runs.length === 1;
        if (whole) {
          var fill = svgEl('path');
          fill.setAttribute('d', pathD(runs[0]) + 'Z');
          fill.setAttribute('fill', st.fill);
          fill.setAttribute('stroke', 'none');
          gGeom.appendChild(fill);
        }
        for (var i = 0; i < runs.length; i++) {
          if (runs[i].length < 2) continue;
          var d = pathD(runs[i]) + (whole ? 'Z' : '');
          var casing = svgEl('path');
          casing.setAttribute('d', d);
          casing.setAttribute('fill', 'none');
          casing.setAttribute('stroke', st.casing);
          casing.setAttribute('stroke-width', 7);
          casing.setAttribute('stroke-linecap', 'round');
          casing.setAttribute('stroke-linejoin', 'round');
          var line = svgEl('path');
          line.setAttribute('d', d);
          line.setAttribute('fill', 'none');
          line.setAttribute('stroke', st.color);
          line.setAttribute('stroke-width', 3.5);
          line.setAttribute('stroke-linecap', 'round');
          line.setAttribute('stroke-linejoin', 'round');
          gGeom.appendChild(casing); gGeom.appendChild(line);
        }
        anchor = anchorOf(runs);
      }
      return anchor;
    }

    /** Label anchor: the middle of the longest visible run, or the centroid for a closed area. */
    function anchorOf(runs) {
      var best = runs[0];
      for (var i = 1; i < runs.length; i++) if (runs[i].length > best.length) best = runs[i];
      if (best.length > 2) {
        var sx = 0, sy = 0;
        for (var j = 0; j < best.length; j++) { sx += best[j].x; sy += best[j].y; }
        return { x: sx / best.length, y: sy / best.length, z: 1 };
      }
      return best[Math.floor(best.length / 2)];
    }

    function render() {
      while (gGeom.firstChild) gGeom.removeChild(gGeom.firstChild);
      labels.textContent = '';
      if (!visible) return;

      var cam = camOf(viewer);
      for (var i = 0; i < shapes.length; i++) {
        var s = shapes[i];
        if (!s || !s.pts || !s.pts.length) continue;
        var a = null;
        try { a = drawShape(s, cam); } catch (e) { a = null; }
        if (!a || !s.label) continue;
        // Keep labels near the viewport; a label chasing a point 8 screens away is just noise.
        if (a.x < -cam.w || a.x > 2 * cam.w || a.y < -cam.h || a.y > 2 * cam.h) continue;
        var el = labelEl(s.label);
        // Centre with a percentage translate rather than measuring: reading offsetWidth here
        // would force a synchronous layout for every label on every frame the camera moves.
        el.style.transform = s.kind === 'point'
          ? 'translate(' + (a.x + 12) + 'px,' + a.y + 'px) translate(0,-50%)'
          : 'translate(' + a.x + 'px,' + (a.y - 10) + 'px) translate(-50%,-100%)';
        labels.appendChild(el);
      }
      if (opts.onRender) opts.onRender(cam, gEdit);
    }

    function tick() {
      raf = global.requestAnimationFrame(tick);
      var cv;
      try { cv = camOf(viewer); } catch (e) { return; }      // viewer torn down mid-frame
      if (!dirty && cv.yaw === last.yaw && cv.pitch === last.pitch && cv.hfov === last.hfov &&
          cv.w === last.w && cv.h === last.h) return;
      last = cv; dirty = false;
      render();
    }

    self.setShapes = function (list) { shapes = list || []; dirty = true; return self; };
    self.getShapes = function () { return shapes; };
    self.setVisible = function (v) { visible = !!v; dirty = true; return self; };
    self.isVisible = function () { return visible; };
    self.invalidate = function () { dirty = true; return self; };
    self.cam = function () { return camOf(viewer); };
    self.editLayer = gEdit;
    self.root = root;
    self.start = function () { if (!raf) raf = global.requestAnimationFrame(tick); return self; };
    self.stop = function () { if (raf) global.cancelAnimationFrame(raf); raf = 0; return self; };
    self.destroy = function () {
      self.stop();
      if (root.parentNode) root.parentNode.removeChild(root);
    };

    /**
     * Nearest shape (and vertex) to a screen point, in screen pixels so tolerance means the same
     * thing at every zoom. Vertices win over segments, and the topmost shape wins, matching the
     * GRP annotator's rules.
     */
    self.hitTest = function (clientX, clientY, tol) {
      var rect = host.getBoundingClientRect();
      var sp = { x: clientX - rect.left, y: clientY - rect.top };
      var cam = camOf(viewer);
      tol = tol || 20;
      for (var i = shapes.length - 1; i >= 0; i--) {
        var s = shapes[i], pj = [], k;
        for (k = 0; k < s.pts.length; k++) {
          var p = project(cam, s.pts[k][0], s.pts[k][1]);
          pj.push(p.z > NEAR_Z ? p : null);
        }
        for (k = 0; k < pj.length; k++) {
          if (pj[k] && Math.hypot(sp.x - pj[k].x, sp.y - pj[k].y) <= tol) {
            return { shape: s, index: i, vertex: k };
          }
        }
        if (s.kind === 'point') continue;
        var ring = s.kind === 'area' ? pj.concat([pj[0]]) : pj;
        for (k = 0; k < ring.length - 1; k++) {
          if (ring[k] && ring[k + 1] && distToSeg(sp, ring[k], ring[k + 1]) <= tol) {
            return { shape: s, index: i, vertex: null };
          }
        }
      }
      return null;
    };

    self.project = function (yaw, pitch) { return project(camOf(viewer), yaw, pitch); };
    self.unproject = function (clientX, clientY) { return unproject(viewer, clientX, clientY); };

    return self.start();
  }

  function distToSeg(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y;
    var len = vx * vx + vy * vy;
    var t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len)) : 0;
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }

  /* ------------------------------------------------------------------- AGOL */

  /**
   * The Field App's ExB session, same origin (every WRI Pages repo is whitewaterrescue.github.io).
   * Read fresh every time and never written -- jimu rotates the record on its own schedule.
   * `expires` is an ISO string in current builds, a number in older ones, and absent when the
   * session came from a JS API credential, so absence is NOT a rejection.
   */
  function readExbAuth() {
    try {
      var raw = global.localStorage.getItem('exb_auth') ||
                global.sessionStorage.getItem('exb_auth');
      if (!raw) return null;
      var a = JSON.parse(raw);
      if (!a || !a.token) return null;
      var exp = (a.expires !== null && a.expires !== undefined && a.expires !== '')
        ? new Date(a.expires).getTime() : NaN;
      if (isFinite(exp) && exp - Date.now() < 2 * 60000) return null;
      return { token: a.token, username: a.email || a.username || '' };
    } catch (e) {
      return null;
    }
  }

  function post(url, body, timeoutMs) {
    var ctl = global.AbortController ? new global.AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 20000) : 0;
    var form = new global.URLSearchParams();
    Object.keys(body).forEach(function (k) {
      if (body[k] !== undefined && body[k] !== null) form.append(k, body[k]);
    });
    form.append('f', 'json');
    return global.fetch(url, {
      method: 'POST', body: form, signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.json(); }).then(function (j) {
      // AGOL answers HTTP 200 with an error body; make that a real rejection.
      if (j && j.error) throw new Error('AGOL ' + j.error.code + ': ' + (j.error.message || ''));
      return j;
    }).finally(function () { if (t) clearTimeout(t); });
  }

  function sqlQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

  function parseRow(feat) {
    if (!feat) return null;
    var at = feat.attributes || {};
    var shapes = [];
    try {
      var j = JSON.parse(at.annot_json || '{}');
      shapes = Array.isArray(j.shapes) ? j.shapes.filter(validShape) : [];
    } catch (e) {
      shapes = [];
    }
    return {
      oid: at.OBJECTID, panoKey: at.pano_key, shapes: shapes,
      publicOk: Number(at.public_ok) === 1, panoName: at.pano_name || '',
      updatedBy: at.updated_by || '', updatedAt: at.updated_at || null
    };
  }

  function validShape(s) {
    if (!s || ['point', 'line', 'area'].indexOf(s.kind) < 0) return false;
    if (!Array.isArray(s.pts) || !s.pts.length) return false;
    var need = s.kind === 'point' ? 1 : (s.kind === 'area' ? 3 : 2);
    if (s.pts.length < need) return false;
    return s.pts.every(function (p) {
      return Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]) &&
             Math.abs(p[1]) <= 90;
    });
  }

  /**
   * Annotations for one sphere.
   *
   * With a WRI-org token we read the source table and see everything. Without one -- the public
   * gateway, a shared link, a TV kiosk -- we read the public view, which is filtered
   * `public_ok = 1` server side. A token that AGOL rejects falls back to the public read rather
   * than failing the sphere, so a stale session can never blank the labels a viewer is entitled to.
   */
  function fetchAnnotations(key, opts) {
    opts = opts || {};
    var auth = opts.token ? { token: opts.token } : readExbAuth();
    var where = 'pano_key = ' + sqlQuote(key);
    var body = { where: where, outFields: OUT_FIELDS, returnGeometry: 'false',
                 resultRecordCount: 1 };

    function publicRead() {
      return post((opts.viewUrl || VIEW_URL) + '/query', body)
        .then(function (j) {
          var r = parseRow((j.features || [])[0]);
          if (r) r.source = 'public';
          return r;
        });
    }

    if (!auth) return publicRead();
    var privBody = {};
    Object.keys(body).forEach(function (k) { privBody[k] = body[k]; });
    privBody.token = auth.token;
    return post((opts.sourceUrl || SOURCE_URL) + '/query', privBody)
      .then(function (j) {
        var r = parseRow((j.features || [])[0]);
        if (r) r.source = 'org';
        return r;
      })
      .catch(function () { return publicRead(); });
  }

  /* ---------------------------------------------------------------- exports */

  global.WRIPanoAnnot = {
    VERSION: VERSION,
    SOURCE_URL: SOURCE_URL,
    VIEW_URL: VIEW_URL,
    ORG_ID: ORG_ID,
    STYLE: STYLE,
    SET_ALIAS: SET_ALIAS,
    panoKey: panoKey,
    project: project,
    camOf: camOf,
    unproject: unproject,
    toVec: toVec,
    fromVec: fromVec,
    densify: densify,
    samples: samples,
    distToSeg: distToSeg,
    validShape: validShape,
    Overlay: Overlay,
    readExbAuth: readExbAuth,
    post: post,
    sqlQuote: sqlQuote,
    fetchAnnotations: fetchAnnotations
  };
})(window);
