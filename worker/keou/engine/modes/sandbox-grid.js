/* sandbox-grid - isolated agents in walled sandboxes, the hairline zero-day, and the escape */
window.KEOU_MODES['sandbox-grid'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P, u = api.u, T = api.t, W = api.W, H = api.H;
  var E = api.ease, K = api.clamp, RND = api.rnd;
  var GREEN = C.accent, PALE = C.white, MUTED = C.muted, INK = C.ink, DEEP = C.deep;
  var CYAN = P.cyan, RED = P.red, AMBER = P.amber, DIM = P.dim;
  var TAU = Math.PI * 2;
  var L = (api.labels && api.labels.length === 3) ? api.labels : ['', '', ''];
  var stage = typeof api.stage === 'number' ? api.stage : 0;

  /* ---------- small drawing helpers ---------- */
  function txt(s, x, y, size, color, align, max) {
    if (!s) return;
    api.mono(String(s), x, y, size, color || PALE, align || 'center', max || 320);
  }
  function rect(x, y, w, h, stroke, lw, fill) {
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.strokeRect(x, y, w, h); }
  }
  function ring(cx, cy, r, color, lw, a0, a1) {
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.5, r), a0 === undefined ? 0 : a0, a1 === undefined ? TAU : a1);
    ctx.strokeStyle = color; ctx.lineWidth = lw || 2; ctx.stroke();
  }
  function alphaOn(a, fn) { ctx.save(); ctx.globalAlpha *= K(a, 0, 1); fn(); ctx.restore(); }
  function plen(pts) {
    var d = 0; for (var i = 0; i < pts.length - 1; i++) d += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    return d;
  }
  function pAt(pts, f) {
    f = K(f); var total = plen(pts), want = total * f, acc = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      var d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (acc + d >= want || i === pts.length - 2) {
        var k = d ? (want - acc) / d : 0; k = K(k);
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
      }
      acc += d;
    }
    return pts[pts.length - 1];
  }
  function dottedRoute(pts, from, to, step, r, color) {
    var total = plen(pts);
    for (var d = 0; d <= total; d += step) {
      var f = d / total;
      if (f < from - 0.0001 || f > to + 0.0001) continue;
      var q = pAt(pts, f);
      api.dot(q[0], q[1], r, color);
    }
  }

  /* thick-walled sandbox cell holding exactly one agent */
  function cell(cx, cy, size, seed) {
    var h = size / 2, lw = Math.max(3, size * 0.085);
    rect(cx - h, cy - h, size, size, null, 0, INK);
    rect(cx - h + 4, cy - h + 4, size - 8, size - 8, GREEN + '1c', 1, null);
    rect(cx - h, cy - h, size, size, GREEN + 'cc', lw, null);
    api.agent(cx, cy, size * 0.235, GREEN, 1.3 + seed * 0.9, Math.max(2, size * 0.028));
  }

  /* deterministic hairline fractures growing along the walls */
  function walls_cracks(x, y, w, h, seed, amt, lw) {
    var edges = [[x, y, 1, 0], [x + w, y, 0, 1], [x + w, y + h, -1, 0], [x, y + h, 0, -1]];
    for (var e = 0; e < edges.length; e++) {
      var ed = edges[e], span = e % 2 ? h : w;
      var start = 0.18 + RND(seed, e, 1) * 0.5;
      var f = E(K((amt - e * 0.13) / 0.7));
      if (f <= 0) continue;
      var ox = ed[0] + ed[2] * span * start, oy = ed[1] + ed[3] * span * start;
      var nx = -ed[3], ny = ed[2];
      var pts = [[ox, oy]], px = ox, py = oy, run = span * (0.2 + RND(seed, e, 2) * 0.26);
      for (var i = 1; i <= 5; i++) {
        var j = (RND(seed, e, i + 4) - 0.5) * 9;
        px += ed[2] * run / 5 + nx * j * 0.5;
        py += ed[3] * run / 5 + ny * j * 0.5;
        pts.push([px, py]);
      }
      alphaOn(0.5, function () { api.drawPath(pts, f, RED, lw * 2.6); });
      api.drawPath(pts, f, RED, lw);
      if (f > 0.6) alphaOn(0.3 + 0.3 * Math.sin(T * 4 + e), function () { api.glow(ox, oy, 30, RED); });
    }
  }

  function globeIcon(cx, cy, r, spin) {
    alphaOn(0.55, function () { api.glow(cx, cy, r * 1.45, CYAN); });
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = INK; ctx.fill();
    ring(cx, cy, r, CYAN + 'dd', 3);
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, TAU); ctx.clip();
    for (var i = -2; i <= 2; i++) {
      var yy = cy + i * r * 0.36, rr = Math.sqrt(Math.max(0, r * r - (yy - cy) * (yy - cy)));
      api.line(cx - rr, yy, cx + rr, yy, CYAN + '55', 1.5);
    }
    for (var k = 0; k < 4; k++) {
      var ph = spin + k * Math.PI / 4, rx = Math.abs(Math.cos(ph)) * r;
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(1, rx), r, 0, 0, TAU);
      ctx.strokeStyle = CYAN + (Math.cos(ph) > 0 ? '77' : '33'); ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.restore();
  }

  function serverIcon(cx, cy, w, h, col, live) {
    rect(cx - w / 2, cy - h / 2, w, h, null, 0, INK);
    rect(cx - w / 2, cy - h / 2, w, h, col + 'dd', 3, null);
    for (var i = 0; i < 3; i++) {
      var ry = cy - h / 2 + 10 + i * (h - 16) / 3;
      api.line(cx - w / 2 + 8, ry + 6, cx + w / 2 - 22, ry + 6, col + '55', 2);
      var blink = (Math.floor(T * 2.2 + i * 1.7) % 3) === 0 ? 'ff' : '44';
      api.dot(cx + w / 2 - 13, ry + 6, 3.4, col + (live ? blink : '33'));
    }
  }

  /* open padlock: shackle hinged open to the side */
  function openLock(cx, cy, s, col) {
    rect(cx - s * 0.5, cy, s, s * 0.72, col + 'dd', 2.5, INK);
    ctx.beginPath();
    ctx.arc(cx + s * 0.42, cy - s * 0.28, s * 0.34, Math.PI, TAU);
    ctx.strokeStyle = col + 'dd'; ctx.lineWidth = 2.5; ctx.stroke();
    api.line(cx + s * 0.08, cy - s * 0.28, cx + s * 0.08, cy, col + 'dd', 2.5);
    api.dot(cx, cy + s * 0.34, 2.4, col);
  }

  /* ---------- background: dark space, drifting grid, slow scan ---------- */
  (function backdrop() {
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    var off = (T * 7) % 56;
    ctx.strokeStyle = GREEN + '10'; ctx.lineWidth = 1;
    for (var x = -56 + off; x < W; x += 56) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = -56 + off; y < H; y += 56) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    var sy = (T * 44) % (H + 140) - 70;
    var g = ctx.createLinearGradient(0, sy - 34, 0, sy + 34);
    g.addColorStop(0, GREEN + '00'); g.addColorStop(0.5, GREEN + '16'); g.addColorStop(1, GREEN + '00');
    ctx.fillStyle = g; ctx.fillRect(0, sy - 34, W, 68);
  })();

  /* ================= STAGE 0 - the sandboxes, sealed off ================= */
  function stageGrid() {
    var n = Math.max(1, Math.min(24, api.count || 12));
    var gx = 26, gy = 118, gw = 520, gh = 466;
    /* the tidiest rack for this count: fill whole rows, stay near the pane ratio */
    var cols = 1, rows = n, best = 1e9, target = gw / gh;
    for (var c = 1; c <= n; c++) {
      var r = Math.ceil(n / c), score = Math.abs(c / r - target) + (c * r - n) * 0.6;
      if (score < best) { best = score; cols = c; rows = r; }
    }
    var pitch = Math.min(gw / cols, gh / rows, 150);
    var ox = gx + (gw - cols * pitch) / 2, oy = gy + (gh - rows * pitch) / 2;
    var s = K(pitch - 14, 40, 132);
    var sx0 = K((u - 0.3) / 1.0), settle = sx0 * sx0 * (3 - 2 * sx0);
    var lastRow = n - (rows - 1) * cols, indent = (cols - lastRow) * pitch / 2;

    /* scan sweep over the rack of cells */
    var scanY = oy + ((T * 0.13) % 1) * rows * pitch;
    alphaOn(K((u - 1.1) / 1.1), function () {
      api.line(ox - 8, scanY, ox + cols * pitch + 8, scanY, GREEN + '2a', 2);
    });

    for (var i = 0; i < n; i++) {
      var row = Math.floor(i / cols), shift = row === rows - 1 ? indent : 0;
      var cx = ox + shift + (i % cols) * pitch + pitch / 2, cy = oy + row * pitch + pitch / 2;
      if (i === 0) {
        var hx = gx + gw / 2, hy = gy + gh / 2, big = Math.min(250, gh * 0.55);
        cell(hx + (cx - hx) * settle, hy + (cy - hy) * settle, big + (s - big) * settle, 0);
      } else {
        var p = E(K((u - (1.0 + i * 0.04)) / 0.42));
        if (p <= 0) continue;
        alphaOn(p, (function (cx2, cy2, sz, id) {
          return function () { cell(cx2, cy2, sz, id); };
        })(cx, cy, s * (0.6 + 0.4 * p), i));
      }
    }

    /* the outside world, and the link that is cut */
    var gcx = 744, gcy = oy + rows * pitch / 2, gr = 68;
    var lx0 = ox + cols * pitch + 16, lx1 = gcx - gr - 12, mid = (lx0 + lx1) / 2;
    ctx.save();
    ctx.setLineDash([9, 8]); ctx.lineDashOffset = -(T * 14) % 17;
    api.line(lx0, gcy, lx1, gcy, CYAN + '99', 2.5);
    ctx.setLineDash([]);
    ctx.restore();
    api.line(lx0 - 5, gcy - 11, lx0 - 5, gcy + 11, CYAN + 'aa', 3);
    var blocked = E(K((u - 1.85) / 0.55));
    alphaOn(1 - blocked * 0.8, function () { api.packets([[lx0, gcy], [mid - 10, gcy]], CYAN, 3, 0.5, 4.5); });
    globeIcon(gcx, gcy, gr, T * 0.35);

    var xr = 22;
    api.strike(mid - xr, gcy - xr, mid + xr, gcy + xr, blocked, RED, 6);
    api.strike(mid + xr, gcy - xr, mid - xr, gcy + xr, E(K((u - 2.02) / 0.55)), RED, 6);
    if (blocked > 0.9) alphaOn(0.28 + 0.28 * Math.sin(T * 3.4), function () { api.glow(mid, gcy, 46, RED); });

    alphaOn(K((u - 0.85) / 0.5), function () { api.counter(n, 30, 88, 54, GREEN, 0.9, 1.3, 'left'); });
    txt(L[0], 112, 60, 23, PALE, 'left', 300);
    txt(L[1], 112, 94, 23, MUTED, 'left', 300);
    txt(L[2], gcx, gcy + gr + 48, 22, PALE, 'center', 240);
  }

  /* ============ STAGE ~0.3 - nobody is watching, nothing progresses ============ */
  function stageWait() {
    var bx = 48, by = 126, bw = 380, bh = 352;
    rect(bx, by, bw, bh, null, 0, INK);
    rect(bx + 6, by + 6, bw - 12, bh - 12, GREEN + '1c', 1, null);
    var breathe = 0.75 + 0.25 * Math.sin(T * 1.5);
    alphaOn(breathe, function () { rect(bx, by, bw, bh, GREEN + 'cc', 11, null); });
    api.agent(bx + bw / 2, 244, 56, GREEN, 0.6, 3);
    ring(bx + bw / 2, 244, 74 + 10 * Math.sin(T * 2.2), GREEN + '33', 2);

    /* a progress track that never fills */
    var tx = bx + 36, tw = bw - 72, ty = 386, th = 26;
    rect(tx, ty, tw, th, GREEN + '66', 2, DEEP);
    ctx.save();
    ctx.beginPath(); ctx.rect(tx + 2, ty + 2, tw - 4, th - 4); ctx.clip();
    var hx = tx + ((T * 0.22) % 1) * tw;
    var hg = ctx.createLinearGradient(hx - 46, 0, hx + 46, 0);
    hg.addColorStop(0, GREEN + '00'); hg.addColorStop(0.5, GREEN + '2a'); hg.addColorStop(1, GREEN + '00');
    ctx.fillStyle = hg; ctx.fillRect(tx, ty, tw, th);
    ctx.restore();
    for (var i = 0; i < 3; i++) api.dot(tx + 14 + i * 13, ty + th / 2, 3, GREEN + (((Math.floor(T * 2.4) + i) % 3) ? '33' : 'cc'));
    txt('0%', bx + bw / 2, 446, 22, GREEN, 'center', 200);

    /* the clock keeps sweeping */
    var cx = 574, cy = 208, cr = 74;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fillStyle = INK; ctx.fill();
    ring(cx, cy, cr, GREEN + 'aa', 4);
    for (var k = 0; k < 12; k++) {
      var a = k * TAU / 12, r1 = cr - 8, r2 = cr - (k % 3 === 0 ? 20 : 14);
      api.line(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2,
        GREEN + (k % 3 === 0 ? '99' : '44'), k % 3 === 0 ? 3 : 1.5);
    }
    var mA = T * 1.15 - Math.PI / 2, hA = T * 0.096 - Math.PI / 2;
    ring(cx, cy, cr - 17, GREEN + '44', 6, mA - 1.1, mA);
    api.line(cx, cy, cx + Math.cos(mA) * (cr - 24), cy + Math.sin(mA) * (cr - 24), GREEN, 3);
    api.line(cx, cy, cx + Math.cos(hA) * (cr - 44), cy + Math.sin(hA) * (cr - 44), PALE, 5.5);
    api.dot(cx, cy, 5, GREEN);

    /* calendar pages flipping beside it */
    var kx = 700, ky = 148, kw = 146, kh = 130;
    for (var q = 3; q > 0; q--) rect(kx + q * 3, ky + q * 3, kw, kh, GREEN + '22', 1.5, null);
    rect(kx, ky, kw, kh, GREEN + 'aa', 3, INK);
    api.line(kx, ky + 26, kx + kw, ky + 26, AMBER + '99', 2.5);
    for (var b = 0; b < 3; b++) api.line(kx + 24 + b * (kw - 48) / 2, ky - 9, kx + 24 + b * (kw - 48) / 2, ky + 9, GREEN + '99', 3);
    for (var r0 = 0; r0 < 3; r0++) for (var c0 = 0; c0 < 4; c0++)
      rect(kx + 12 + c0 * 31, ky + 40 + r0 * 28, 20, 16, null, 0, GREEN + '1e');
    var f = (T * 1.25) % 1;
    alphaOn((1 - f) * 0.9, function () {
      var ph = (kh - 34) * (1 - f * 0.94);
      rect(kx + 5, ky + 29, kw - 10, ph, GREEN + '99', 2, DEEP);
    });
    if (api.date) txt(api.date, kx + kw / 2, ky + kh + 44, 22, AMBER, 'center', 180);

    /* the desk nobody came back to */
    var chx = 560, chy = 452;
    alphaOn(0.85, function () {
      ctx.save(); ctx.translate(chx, chy); ctx.rotate(Math.sin(T * 0.5) * 0.012);
      rect(-46, -104, 20, 68, DIM, 3, INK);
      rect(-52, -36, 84, 14, DIM, 3, INK);
      api.line(-14, -22, -14, 12, DIM, 3);
      api.line(-44, 16, 24, 16, DIM, 3);
      api.dot(-44, 20, 4, DIM); api.dot(24, 20, 4, DIM);
      ctx.restore();
    });
    alphaOn(0.85, function () {
      rect(676, 414, 158, 46, DIM, 3, INK);
      for (var rr = 0; rr < 3; rr++) for (var cc = 0; cc < 9; cc++)
        api.dot(688 + cc * 16.6, 426 + rr * 12, 2.6, DIM);
    });

    txt(L[0], bx + bw / 2, 96, 24, PALE, 'center', 372);
    txt(L[1], 668, 96, 24, PALE, 'center', 376);
    txt(L[2], 440, 574, 24, MUTED, 'center', 800);
  }

  /* ============ STAGE ~0.55 - the wall cracks, the cache proxy splits ============ */
  function stageCrack() {
    var bx = 60, by = 142, bw = 390, bh = 358;
    var fast = 0.5 + 0.5 * Math.sin(T * 5.2);
    rect(bx, by, bw, bh, null, 0, INK);
    rect(bx + 7, by + 7, bw - 14, bh - 14, GREEN + '1c', 1, null);
    rect(bx, by, bw, bh, GREEN + 'cc', 11, null);
    var acx = bx + bw / 2;
    api.agent(acx, 250, 50, GREEN, 0.4, 3.4);
    ring(acx, 250, 66 + 9 * fast, GREEN + (fast > 0.5 ? '99' : '44'), 2.5);
    ring(acx, 250, 84 + 16 * fast, GREEN + '2a', 2);
    walls_cracks(bx, by, bw, bh, 3, K((u - 0.35) / 1.5), 2.2);

    /* the small thing inside the box, and its magnified callout */
    var ix = acx - 80, iy = 378, iw = 160, ih = 56;
    rect(ix, iy, iw, ih, CYAN + 'aa', 2.5, INK);
    for (var i = 0; i < 3; i++) api.line(ix + 10, iy + 13 + i * 15, ix + iw - 24, iy + 13 + i * 15, CYAN + '44', 2);
    api.dot(ix + iw - 14, iy + 13, 3, CYAN + (((Math.floor(T * 2) % 2)) ? 'ff' : '44'));

    var qx = 502, qy = 196, qw = 352, qh = 184, qcx = qx + qw / 2, qcy = qy + qh / 2;
    var zoom = E(K((u - 0.55) / 0.75));
    alphaOn(zoom * 0.8, function () {
      api.drawPath([[ix + iw, iy], [qx, qy]], zoom, CYAN + '55', 1.5);
      api.drawPath([[ix + iw, iy + ih], [qx, qy + qh]], zoom, CYAN + '55', 1.5);
    });

    alphaOn(zoom, function () {
      var split = E(K((u - 2.5) / 1.7)), gap = 17 * split;
      api.glow(qcx, qcy, 150, split > 0 ? RED : CYAN);
      ctx.fillStyle = INK; ctx.fillRect(qx, qy, qw, qh);
      /* two halves of the same casing, opening on a red seam */
      ctx.strokeStyle = CYAN + 'ee'; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(qcx - gap, qy); ctx.lineTo(qx - gap, qy); ctx.lineTo(qx - gap, qy + qh); ctx.lineTo(qcx - gap, qy + qh);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(qcx + gap, qy); ctx.lineTo(qx + qw + gap, qy); ctx.lineTo(qx + qw + gap, qy + qh); ctx.lineTo(qcx + gap, qy + qh);
      ctx.stroke();
      /* rails of the proxy, sliding apart with the halves */
      for (var i = 0; i < 3; i++) {
        var ry = qy + 40 + i * 38;
        api.line(qx + 26 - gap, ry, qcx - 18 - gap, ry, CYAN + '66', 3);
        api.line(qcx + 18 + gap, ry, qx + qw - 46 + gap, ry, CYAN + '66', 3);
        api.dot(qx + qw - 30 + gap, ry, 3.6, CYAN + (((Math.floor(T * 2.4 + i) % 3)) ? '44' : 'ff'));
      }
      /* the hairline itself */
      var hair = E(K((u - 1.5) / 0.9));
      api.drawPath([[qcx, qy - 2], [qcx + 4, qy + qh * 0.35], [qcx - 3, qy + qh * 0.7], [qcx, qy + qh + 2]], hair, RED + 'ee', 2 + 2 * split);
      if (split > 0) {
        alphaOn(0.5 + 0.4 * Math.sin(T * 6), function () { api.glow(qcx, qcy, 46 + 30 * split, RED); });
        for (var k = 0; k < 5; k++) {
          var pp = ((T * 0.5 + k * 0.2) % 1);
          api.dot(qcx + (RND(k, 1) - 0.5) * 18, qy + qh - pp * qh, 2.6, RED + 'aa');
        }
      }
    });

    txt(L[0], acx, 470, 21, CYAN, 'center', 300);
    alphaOn(zoom, function () {
      txt(L[1], qcx, 162, 26, RED, 'center', 340);
      txt(api.text, qcx, 424, 22, CYAN, 'center', 348);
      txt(L[2], qcx, 480, 22, PALE, 'center', 340);
    });
  }

  /* ============ STAGE ~1.0 - out through the gap, into open space ============ */
  function stageEscape() {
    var bx = 54, by = 196, bw = 250, bh = 240, g0 = 282, g1 = 350, lw = 11;
    var sx = 780, sy = 246;
    var route = [[bx + bw + 28, 316], [392, 374], [484, 296], [576, 354], [664, 288], [sx - 62, sy + 12]];
    var smooth = function (x) { x = K(x); return x * x * (3 - 2 * x); };
    var out = smooth((u - 0.15) / 1.15);         /* slide out through the gap */
    var scan = K((u - 1.0) / 0.9);               /* radar sweep */
    var trip = smooth((u - 1.75) / 2.0);         /* travel to the server */
    var dock = E(K((u - 3.75) / 0.75));          /* docked, turns green */

    /* the box it left */
    rect(bx, by, bw, bh, null, 0, INK);
    rect(bx + 7, by + 7, bw - 14, bh - 14, GREEN + '18', 1, null);
    api.line(bx, by, bx + bw, by, GREEN + 'cc', lw);
    api.line(bx, by + bh, bx + bw, by + bh, GREEN + 'cc', lw);
    api.line(bx, by, bx, by + bh, GREEN + 'cc', lw);
    api.line(bx + bw, by - 4, bx + bw, g0, GREEN + 'cc', lw);
    api.line(bx + bw, g1, bx + bw, by + bh + 4, GREEN + 'cc', lw);
    api.line(bx + bw - 9, g0, bx + bw + 26, g0 - 21, RED, 3.5);
    api.line(bx + bw - 9, g1, bx + bw + 26, g1 + 21, RED, 3.5);
    api.line(bx + bw - 4, g0 + 3, bx + bw + 9, g0 + 3, RED + '88', 2);
    api.line(bx + bw - 4, g1 - 3, bx + bw + 9, g1 - 3, RED + '88', 2);
    alphaOn(0.3 + 0.3 * Math.sin(T * 3.2), function () { api.glow(bx + bw, (g0 + g1) / 2, 60, RED); });

    /* the empty seat of the agent */
    alphaOn(out * (0.45 + 0.15 * Math.sin(T * 1.6)), function () {
      api.hex(bx + bw / 2, 292, 40, DIM, 2, 0);
      api.hex(bx + bw / 2, 292, 18, DIM, 1.5, 0);
    });
    alphaOn(E(K((u - 1.25) / 0.7)), function () { txt(L[2], bx + bw / 2, 404, 26, MUTED, 'center', 226); });

    /* open space: a far server, unlocked, waiting */
    var lit = K((scan - 0.55) / 0.45);
    alphaOn(0.35 + 0.65 * lit, function () {
      if (lit > 0) alphaOn(0.7 * lit, function () { api.glow(sx, sy, 78, CYAN); });
      serverIcon(sx, sy, 84, 70, CYAN, lit > 0.4);
      openLock(sx, sy - 64, 26, CYAN);
    });
    if (dock > 0) alphaOn(dock, function () {
      api.glow(sx, sy, 88 + 8 * Math.sin(T * 3), GREEN);
      serverIcon(sx, sy, 84, 70, GREEN, true);
      openLock(sx, sy - 64, 26, GREEN);
      ring(sx, sy, 64 + ((T * 0.6) % 1) * 28, GREEN + '33', 2);
    });

    /* radar sweep out of the gap */
    var origin = pAt(route, 0);
    if (scan > 0 && dock < 1) {
      for (var k = 0; k < 3; k++) {
        var f = K(scan * 1.15 - k * 0.22);
        if (f <= 0) continue;
        alphaOn((1 - f) * 0.8 * (1 - dock), function () { ring(origin[0], origin[1], 30 + f * 500, GREEN + '55', 2); });
      }
      var a = T * 1.7 % TAU;
      alphaOn(0.5 * (1 - dock), function () {
        api.line(origin[0], origin[1], origin[0] + Math.cos(a) * 240, origin[1] + Math.sin(a) * 240, GREEN + '44', 2);
      });
    }

    /* the dotted search path, drawn as it is walked */
    alphaOn(0.4 * K(scan * 1.5), function () { dottedRoute(route, 0, 1, 22, 2.2, DIM); });
    if (trip > 0.001) dottedRoute(route, 0, trip, 22, 3.4, GREEN + 'cc');
    if (trip > 0 && trip < 1) api.packets([pAt(route, Math.max(0, trip - 0.16)), pAt(route, trip)], GREEN, 2, 0.9, 3.5);

    /* the agent itself: out of the gap, along the route, into the machine */
    var ax, ay, ar = 30;
    if (out < 1) {
      ax = (bx + bw / 2) + (route[0][0] - bx - bw / 2) * out;
      ay = 292 + 24 * out;
    } else {
      var q = pAt(route, trip); ax = q[0]; ay = q[1];
      if (dock > 0) { ax += (sx - ax) * dock; ay += (sy - ay) * dock; ar = 30 - 8 * dock; }
    }
    api.agent(ax, ay, ar, GREEN, 0.9, 3);
    alphaOn(1 - dock * 0.7, function () { ring(ax, ay, 42 + 8 * Math.sin(T * 3.6), GREEN + '3a', 2); });

    txt(L[0], bx + bw / 2, 168, 22, PALE, 'center', 232);
    alphaOn(E(K((u - 1.1) / 0.8)), function () { txt(L[1], 512, 152, 24, PALE, 'center', 360); });
    alphaOn(E(K((u - 0.5) / 1)), function () { txt(api.text, 440, 588, 30, GREEN, 'center', 720); });
  }

  if (stage < 0.17) stageGrid();
  else if (stage < 0.45) stageWait();
  else if (stage < 0.8) stageCrack();
  else stageEscape();
};
