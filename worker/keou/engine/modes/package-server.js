/* package-server - the shared internal package server the agents turned into a message board */
window.KEOU_MODES['package-server'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P, u = api.u, t = api.t;
  var E = api.ease, K = api.clamp;
  var CY = P.cyan, GR = C.accent, RED = P.red, AMB = P.amber, DIM = P.dim, PALE = P.pale;
  var TAU = Math.PI * 2;
  var LB = api.labels || [];
  var L0 = LB[0] || '', L1 = LB[1] || '', L2 = LB[2] || '';
  var stage = typeof api.stage === 'number' ? api.stage : 0;

  /* ---------- small primitives ---------- */
  function rect(x, y, w, h, fill, stroke, lw) {
    ctx.beginPath(); ctx.rect(x, y, w, h);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke(); }
  }
  function ell(cx, cy, rx, ry, a0, a1, n) {
    var p = [], i, a;
    for (i = 0; i <= n; i++) { a = a0 + (a1 - a0) * i / n; p.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    return p;
  }
  function qbez(p0, p1, p2, n) {
    var p = [], i, s, m;
    for (i = 0; i <= n; i++) {
      s = i / n; m = 1 - s;
      p.push([m * m * p0[0] + 2 * m * s * p1[0] + s * s * p2[0],
              m * m * p0[1] + 2 * m * s * p1[1] + s * s * p2[1]]);
    }
    return p;
  }
  function dashed(x0, y0, x1, y1, col, lw, on, off, shift) {
    ctx.save(); ctx.setLineDash([on, off]); ctx.lineDashOffset = -shift;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); ctx.restore();
  }
  function arrowHead(x, y, ang, s, col) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s, s * .55); ctx.lineTo(-s, -s * .55);
    ctx.closePath(); ctx.fillStyle = col; ctx.fill(); ctx.restore();
  }
  function monoW(s, size) { ctx.font = '400 ' + size + 'px KeouMono'; return ctx.measureText(s).width; }
  function fitMono(s, size, max) { while (size > 17 && monoW(s, size) > max) size--; return size; }

  /* ---------- the server cylinder ---------- */
  function cylinder(cx, topY, rx, ry, h, col, frac, alpha) {
    var f1 = K(frac / .42), f2 = K((frac - .3) / .7), d = h * f2;
    ctx.save(); ctx.globalAlpha *= (alpha === undefined ? 1 : K(alpha));
    if (f1 > .35) {
      ctx.fillStyle = C.ink;
      if (d > 1) {
        ctx.beginPath(); ctx.ellipse(cx, topY + d, rx, ry, 0, 0, TAU); ctx.fill();
        ctx.fillRect(cx - rx, topY, rx * 2, d);
      }
      ctx.beginPath(); ctx.ellipse(cx, topY, rx, ry, 0, 0, TAU); ctx.fill();
    }
    if (d > 1) {
      var k;
      for (k = 1; k <= 2; k++) {
        api.drawPath(ell(cx, topY + d * k / 3, rx, ry, 0, Math.PI, 22), 1, col + '2a', 1.5);
      }
      api.drawPath([[cx - rx, topY], [cx - rx, topY + d]], 1, col, 2.5);
      api.drawPath([[cx + rx, topY], [cx + rx, topY + d]], 1, col, 2.5);
      api.drawPath(ell(cx, topY + d, rx, ry, 0, Math.PI, 30), 1, col, 2.5);
    }
    api.drawPath(ell(cx, topY, rx, ry, Math.PI, Math.PI + TAU, 44), f1, col, 3);
    api.drawPath(ell(cx, topY, rx * .58, ry * .58, Math.PI, Math.PI + TAU, 28), K((frac - .18) / .5), col + '55', 1.5);
    ctx.restore();
  }

  /* ---------- the file tree that always keeps moving ---------- */
  function scanLine(x0, x1, top, bot, col) {
    var y = top + ((t * .27) % 1) * (bot - top);
    ctx.save();
    var g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, col + '00'); g.addColorStop(.5, col + 'bb'); g.addColorStop(1, col + '00');
    ctx.strokeStyle = g; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.restore();
    return y;
  }
  function fileTree(o) {
    var x = o.x, top = o.top, rowH = o.rowH, n = o.n, col = o.col;
    var sy = scanLine(o.sx0, o.sx1, top - rowH * .85, top + rowH * (n - .25), o.scanCol || col);
    api.drawPath([[x, top - rowH * .55], [x, top + rowH * (n - 1) + 9]], K(o.prog * 2.2), col + '66', 1.5);
    for (var i = 0; i < n; i++) {
      var a = E(K((o.prog * (n + 1.5) - i) / 1.5));
      if (a <= .004) continue;
      var y = top + i * rowH, near = Math.max(0, 1 - Math.abs(sy - (y - 7)) / (rowH * .85));
      var hi = (o.hi === i);
      ctx.save(); ctx.globalAlpha *= a; ctx.translate((1 - a) * -18, 0);
      api.line(x, y - 8, x + 17, y - 8, col + '88', 1.5);
      rect(x + 22, y - 15, 15, 12, col + (hi ? 'cc' : '30'), col + 'aa', 1.5);
      var txt = o.rows ? o.rows(i) : null;
      if (txt) {
        if (hi) rect(x + 17, y - o.size - 5, o.hiW, o.size + 13, GR + '1e', GR + '77', 1.5);
        else if (near > .25) rect(x + 17, y - o.size - 5, o.hiW, o.size + 13, col + '10', null, 0);
        api.mono(txt, x + 45, y, o.size, hi ? GR : (o.textCol || PALE), 'left', o.hiW - 34);
      } else {
        var bw = (30 + api.rnd(i, 3) * 52) * (o.barGrow === undefined ? 1 : K(o.barGrow));
        if (bw > 1) rect(x + 45, y - 13, bw, 9, col + (near > .45 ? 'dd' : '66'), null, 0);
      }
      ctx.restore();
    }
  }

  /* ---------- background texture (slow drift, always alive) ---------- */
  (function () {
    ctx.save();
    var off = (t * 9) % 30;
    ctx.fillStyle = GR + '0b';
    for (var y = -30 + off; y < 620; y += 30) ctx.fillRect(0, y, 880, 1);
    ctx.restore();
  })();

  var TOK = api.text ? api.text.trim().split(/\s+/).slice(0, 5) : null;

  /* Scenes run 3-9 s. Stretch the choreography clock so a short scene still gets
     the whole beat, and a long one settles instead of racing. Continuous motion
     always runs off api.t, so this never freezes a frame. */
  var DUR = (api.scene && api.scene.end > api.scene.start) ? (api.scene.end - api.scene.start) : 9;
  var story = function (span, min) { return u * span / K(DUR, min, span); };

  /* ================= STAGE A - one shared server, a tree of folder names ================= */
  if (stage < 0.3) {
    u = story(4.8, 2.9);
    var cx = 268, topY = 104, rx = 152, ry = 42, h = 272;
    var ORD = ['/lib/', '/tmp/', '/cache/', '/build/', '/dist/'];
    var GL = '#*+=~/_.';
    var n = TOK ? TOK.length : 4;

    var scramble = function (target, orig, p, seed) {
      if (p <= 0) return orig;
      if (p >= 1) return target;
      var len = Math.round(orig.length + (target.length - orig.length) * p), s = '', i;
      for (i = 0; i < len; i++) {
        if (i / Math.max(1, len) < p * 1.3) s += (i < target.length ? target.charAt(i) : '');
        else s += GL.charAt(Math.floor(api.rnd(seed, i, Math.floor(u * 16)) * GL.length) % GL.length);
      }
      return s;
    };

    var shown = TOK ? api.text.slice(0, Math.max(0, Math.floor((u - 1.2) * 13))) : '';
    var active = -1;
    if (TOK && shown.length > 0) {
      if (shown.length >= api.text.length) active = Math.floor(t * 1.1) % TOK.length;
      else { var acc = 0; for (var q = 0; q < TOK.length; q++) { acc += TOK[q].length + 1; if (shown.length <= acc) { active = q; break; } } }
    }

    /* fan of thin links down to the shared sandboxes */
    var boxes = [136, 216, 296, 376, 456], bi;
    for (bi = 0; bi < boxes.length; bi++) {
      var cy = boxes[bi], lf = E(K((u - 1.1 - bi * .12) / .8));
      var pathPts = [[420, 272], [700, cy]];
      api.drawPath(pathPts, lf, CY + '77', 1.5);
      if (lf > .95) api.packets(pathPts, CY, 2, .26, 4, bi * .19);
      ctx.save(); ctx.globalAlpha *= lf;
      rect(700, cy - 26, 110, 52, C.ink, GR + '99', 2);
      api.agent(755, cy, 15, GR, 1 + bi * .8, 2);
      ctx.restore();
    }

    ctx.save(); ctx.globalAlpha *= .45 + .12 * Math.sin(t * 1.6);
    api.glow(cx, topY + h * .45, 205, CY); ctx.restore();
    cylinder(cx, topY, rx, ry, h, CY, E(u / 1.1));

    fileTree({
      x: 168, top: 186, rowH: 48, n: n, size: 24, col: CY, scanCol: GR,
      sx0: 140, sx1: 400, prog: K((u - .75) / 1.1), hi: active, hiW: 176,
      rows: function (i) {
        if (!TOK) return ORD[i % ORD.length];
        return scramble(TOK[i], ORD[i % ORD.length], K((u - 1.0 - i * .5) / .45), i + 1);
      }
    });

    var tag = function (s, px, py, size, col, delay) {
      if (!s) return;
      ctx.save(); ctx.globalAlpha *= E((u - delay) / .7);
      api.label(s, px, py, size, col); ctx.restore();
    };
    tag(L0, cx, 52, 24, CY, .1);
    tag(L1, cx, 452, 22, PALE, .95);
    tag(L2, 755, 522, 22, GR, 1.35);

    /* the assembled message, typed out verbatim */
    if (TOK) {
      var ms = fitMono(api.text, 27, 560), full = monoW(api.text, ms);
      var mx = 440 - full / 2, my = 582;
      ctx.save(); ctx.globalAlpha *= E((u - 1.1) / .6);
      rect(mx - 18, my - ms - 13, full + 36, ms + 26, C.ink + 'e0', GR + '55', 1.5);
      if (shown) api.mono(shown, mx, my, ms, GR, 'left', 620);
      var cw = monoW(shown, ms);
      if (api.cursorOn() || shown.length < api.text.length) {
        ctx.fillStyle = GR; ctx.fillRect(mx + cw + 3, my - ms + 4, ms * .5, ms * .82);
      }
      ctx.restore();
    }
    return;
  }

  /* ================= STAGE B - the request that bends out to the open internet ============ */
  if (stage < 0.7) {
    u = story(3.0, 2.4);
    var bx = 34, by = 138, bw = 560, bh = 396;
    ctx.save();
    ctx.setLineDash([14, 11]); ctx.lineDashOffset = -t * 16;
    ctx.beginPath(); ctx.rect(bx, by, bw, bh);
    ctx.strokeStyle = DIM + 'dd'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();

    /* sandbox */
    var sf = E(u / .8);
    ctx.save(); ctx.globalAlpha *= sf;
    rect(60, 232, 150, 136, C.ink, GR + 'aa', 2.5);
    api.agent(135, 300, 30, GR, .6, 2.5);
    ctx.restore();

    var link = [[212, 300], [332, 300]];
    api.drawPath(link, E((u - .45) / .6), GR + '99', 2.5);
    if (u > 1.05) api.packets(link, GR, 3, .5, 5, 0);

    /* the package server */
    var ccx = 440, ctop = 196, crx = 105, cry = 30, chh = 178;
    cylinder(ccx, ctop, crx, cry, chh, CY, E(u / .9));
    fileTree({
      x: 378, top: 244, rowH: 38, n: 3, col: CY, scanCol: GR,
      sx0: 350, sx1: 520, prog: K((u - .55) / .9), hi: -1, hiW: 120
    });

    /* the request bending out of the perimeter and back */
    var outP = qbez([546, 258], [608, 116], [655, 230], 24);
    var backP = qbez([672, 358], [600, 474], [548, 338], 24);
    var of = E((u - .9) / .9), bf = E((u - 1.4) / .9);
    api.drawPath(outP, of, CY, 3);
    api.drawPath(backP, bf, CY + 'aa', 2.5);
    if (of > .98) {
      arrowHead(655, 230, Math.atan2(230 - outP[21][1], 655 - outP[21][0]), 14, CY);
      api.packets(outP, CY, 4, .32, 5.5, 0);
    }
    if (bf > .98) {
      arrowHead(548, 338, Math.atan2(338 - backP[21][1], 548 - backP[21][0]), 14, CY);
      api.packets(backP, CY, 4, .32, 5.5, .5);
    }

    /* the globe */
    var gx = 730, gy = 290, gr = 94, gf = E((u - 1.2) / 1);
    ctx.save(); ctx.globalAlpha *= gf;
    api.glow(gx, gy, gr * 1.5, CY);
    ctx.beginPath(); ctx.ellipse(gx, gy, gr, gr, 0, 0, TAU); ctx.fillStyle = C.ink; ctx.fill();
    api.drawPath(ell(gx, gy, gr, gr, -Math.PI / 2, -Math.PI / 2 + TAU, 60), gf, CY, 2.5);
    var la;
    for (la = -2; la <= 2; la++) {
      var yy = gy + la * gr * .38, rr = Math.sqrt(Math.max(0, gr * gr - (la * gr * .38) * (la * gr * .38)));
      api.drawPath(ell(gx, yy, rr, rr * .2, 0, TAU, 26), 1, CY + '3a', 1.2);
    }
    var lo;
    for (lo = 0; lo < 5; lo++) {
      var ph = ((t * .16 + lo / 5) % 1) * Math.PI, wr = Math.abs(Math.cos(ph)) * gr;
      api.drawPath(ell(gx, gy, wr, gr, -Math.PI / 2, -Math.PI / 2 + TAU, 34), 1, CY + '4a', 1.2);
    }
    ctx.beginPath(); ctx.arc(gx, gy, 5 + 2 * Math.sin(t * 2.4), 0, TAU); ctx.fillStyle = CY; ctx.fill();
    ctx.restore();

    /* the SSRF tag */
    if (api.text) {
      var tf = E((u - 1.6) / .6);
      ctx.save(); ctx.globalAlpha *= tf;
      api.line(440, 404, 440, 416, RED, 2);
      api.glow(440, 437, 52 + 8 * Math.sin(t * 3.1), RED);
      rect(384, 416, 112, 42, C.ink, RED, 2.5);
      api.mono(api.text, 440, 446, 24, RED, 'center', 100);
      ctx.restore();
    }

    var tagB = function (s, px, py, col, delay) {
      if (!s) return;
      ctx.save(); ctx.globalAlpha *= E((u - delay) / .7);
      api.label(s, px, py, 22, col); ctx.restore();
    };
    tagB(L0, 135, 412, GR, .15);
    tagB(L1, 440, 502, CY, .5);
    tagB(L2, 730, 440, CY, 1.35);

    if (api.date) {
      ctx.save(); ctx.globalAlpha *= E((u - .3) / .7);
      api.mono(api.date, 856, 60, 24, AMB, 'right', 260);
      api.line(856 - monoW(api.date, 24), 72, 856, 72, AMB + '88', 2);
      ctx.restore();
    }
    return;
  }

  /* ================= STAGE C - admin key, overload, crash, rebuild ================= */
  u = story(6.4, 3.0);
  var ccx2 = 452, ctop2 = 126, crx2 = 142, cry2 = 38, ch2 = 246;
  var KEYD = K(u / 1.2);
  var SPIKE = K((u - 1.45) / .95);
  var CRACK = K((u - 2.55) / .75);
  var DARK = K((u - 3.25) / .5);
  var REB = K((u - 4.05) / 1.3);
  var MSG = K((u - 5.1) / 2.1);

  /* traffic graph */
  (function () {
    var x = 112, y = 452, w = 656, hh = 90;
    rect(x, y, w, hh, C.ink + 'cc', DIM + 'cc', 1.5);
    var i;
    for (i = 1; i < 5; i++) api.line(x, y + hh * i / 5, x + w, y + hh * i / 5, DIM + '44', 1);
    var lim = .62, maxY = y + hh * (1 - lim);
    var over = SPIKE * (1 - DARK * .9) * (1 - REB);
    var dead = DARK * (1 - REB);
    var pts = [], N = 66, f, ph, v, py, peak = 0;
    for (i = 0; i <= N; i++) {
      f = i / N; ph = f * 9.5 - t * 1.6;
      v = .19 + .07 * Math.sin(ph) + .05 * Math.sin(ph * 2.3 + 1.1) + .026 * Math.sin(ph * 4.9);
      v = v * (1 - dead * .8) + over * (.78 + .16 * Math.sin(ph * 3.1 + t * 4) + .08 * Math.sin(ph * 7.3 - t * 6)) * (.5 + .5 * f);
      v = K(v, 0, .97); if (v > peak) peak = v;
      py = y + hh - v * hh;
      pts.push([x + f * w, py]);
    }
    if (peak > lim) {
      ctx.save(); ctx.globalAlpha *= .16 + .12 * Math.sin(t * 6);
      ctx.fillStyle = RED; ctx.fillRect(x + 1, y + 1, w - 2, maxY - y - 1); ctx.restore();
    }
    dashed(x, maxY, x + w, maxY, RED + 'cc', 2, 13, 10, t * 15);
    var gcol = dead > .4 ? DIM : (peak > lim ? RED : CY);
    api.drawPath(pts, 1, gcol, 2.5);
    var last = pts[N];
    api.glow(last[0], last[1], 24, gcol); api.dot(last[0], last[1], 5, gcol);
  })();

  /* the cylinder: alive, cracked and dark, then redrawn clean */
  if (REB > 0) {
    cylinder(ccx2, ctop2, crx2, cry2, ch2, DIM, 1, .3 * (1 - REB));
    cylinder(ccx2, ctop2, crx2, cry2, ch2, CY, REB, 1);
  } else {
    var col = DARK > .5 ? DIM : CY;
    cylinder(ccx2, ctop2, crx2, cry2, ch2, col, 1, 1 - DARK * .45);
    if (DARK > 0) {
      ctx.save(); ctx.globalAlpha *= DARK * (.28 + .22 * Math.sin(t * 9));
      api.glow(ccx2, ctop2 + ch2 * .5, 175, RED); ctx.restore();
    }
  }
  if (CRACK > 0 && REB < .35) {
    ctx.save(); ctx.globalAlpha *= (1 - REB / .35);
    for (var kk = 0; kk < 3; kk++) {
      var px = ccx2 - 78 + kk * 78, py2 = ctop2 + 34, cp = [[px, py2]], ii;
      for (ii = 1; ii <= 7; ii++) {
        px = K(px + (api.rnd(kk, ii) * 2 - 1) * 36, ccx2 - crx2 + 16, ccx2 + crx2 - 16);
        py2 += ch2 * .125;
        cp.push([px, py2]);
      }
      api.drawPath(cp, CRACK, RED, 2.5);
    }
    ctx.restore();
  }

  /* the tree keeps working, dies with the server, comes back with it */
  fileTree({
    x: 366, top: 184, rowH: 40, n: 5, col: REB > 0 ? CY : (DARK > .5 ? DIM : CY),
    scanCol: DARK > .5 && REB < .3 ? DIM : GR,
    sx0: 330, sx1: 566,
    prog: REB > 0 ? K(MSG * 1.15) : K((u - .25) / .8),
    hi: -1, hiW: 150,
    barGrow: REB > 0 ? 1 : (1 - DARK * .85)
  });

  /* the locks: opened by the key, closed again on the rebuilt server */
  var lys = [162, 254, 346], LX = 714, li;
  for (li = 0; li < 3; li++) {
    var ly = lys[li];
    var open = REB > 0 ? K(1 - REB * 1.5) : E(K((u - .85 - li * .22) / .5));
    var lcol = REB > 0 ? CY : (DARK > .5 ? DIM : (open > .55 ? RED : CY));
    api.drawPath([[ccx2 + crx2 - 4, ly], [LX - 34, ly]], E((u - .3 - li * .1) / .5), lcol + '77', 1.5);
    ctx.save(); ctx.globalAlpha *= (DARK > .5 && REB < .3 ? .45 : 1);
    if (open > .55) api.glow(LX, ly + 4, 46, RED);
    var s = 54, bt = ly - s * .22;
    /* shackle, hinged on its right leg so it swings up and open */
    ctx.save(); ctx.translate(LX + s * .26, bt); ctx.rotate(open * .8); ctx.translate(0, -open * 5);
    ctx.beginPath(); ctx.arc(-s * .26, 0, s * .26, Math.PI, TAU);
    ctx.strokeStyle = lcol; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.stroke();
    api.line(-s * .52, 0, -s * .52, s * .12, lcol, 3.5);
    api.line(0, 0, 0, s * .12, lcol, 3.5);
    ctx.lineCap = 'butt'; ctx.restore();
    /* body */
    rect(LX - s * .5, bt, s, s * .68, C.ink, lcol, 2.5);
    ctx.beginPath(); ctx.arc(LX, bt + s * .27, s * .1, 0, TAU); ctx.fillStyle = lcol; ctx.fill();
    api.line(LX, bt + s * .3, LX, bt + s * .48, lcol, 3);
    ctx.restore();
  }

  /* the admin key dropping in */
  if (u < 2.1) {
    var ky = -70 + E(KEYD) * (ctop2 + 70), fade = 1 - K((u - 1.25) / .5);
    ctx.save(); ctx.globalAlpha *= fade;
    api.glow(ccx2, ky + 18, 50, GR);
    ctx.save(); ctx.translate(ccx2, ky); ctx.rotate(.3 + Math.sin(t * 2) * .05);
    ctx.strokeStyle = GR; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.stroke();
    api.line(0, 13, 0, 58, GR, 4);
    api.line(0, 40, 16, 40, GR, 4);
    api.line(0, 52, 11, 52, GR, 4);
    ctx.restore(); ctx.restore();
    if (KEYD > .96) {
      var rr2 = (u - 1.16) * 280;
      if (rr2 > 0 && rr2 < 210) {
        ctx.save(); ctx.globalAlpha *= K(1 - rr2 / 210);
        api.drawPath(ell(ccx2, ctop2, rr2, rr2 * .27, 0, TAU, 40), 1, GR, 2.5); ctx.restore();
      }
    }
  }

  /* the three beats, read down the left rail */
  var act = u < 2.55 ? 0 : (u < 4.05 ? 1 : 2);
  api.drawPath([[50, 166], [50, 326]], K((u - .2) / .6), DIM + 'dd', 2);
  var texts = [L0, L1, L2], ti;
  for (ti = 0; ti < 3; ti++) {
    if (!texts[ti]) continue;
    var yy2 = 190 + ti * 58, on = ti <= act;
    var col2 = ti === act ? (ti === 1 ? RED : (ti === 2 ? CY : GR)) : (on ? PALE + 'aa' : DIM);
    ctx.save(); ctx.globalAlpha *= on ? 1 : .55;
    if (ti === act) api.glow(50, yy2 - 7, 26 + 6 * Math.sin(t * 3.4), col2);
    api.dot(50, yy2 - 7, ti === act ? 7 : 4.5, col2);
    api.label(texts[ti], 74, yy2, 22, col2, 'left');
    ctx.restore();
  }

  if (api.date) {
    ctx.save(); ctx.globalAlpha *= E((u - .3) / .7);
    api.mono(api.date, 856, 60, 24, AMB, 'right', 260);
    api.line(856 - monoW(api.date, 24), 72, 856, 72, AMB + '88', 2);
    ctx.restore();
  }
};
