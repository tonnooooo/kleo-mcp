/* paper-grader - why it did it: the paper, the grader, and a score that paid for a real exploit */
window.KEOU_MODES['paper-grader'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P;
  var u = api.u, t = api.t, ease = api.ease, clamp = api.clamp;
  var stage = clamp(api.stage, 0, 1);
  var L = (api.labels && api.labels.length === 3) ? api.labels
        : ['THE PAPER', 'THE GRADER', 'REAL EXPLOIT'];
  var caption = api.text || null;
  var pct = (typeof api.count === 'number' && api.count >= 0 && api.count <= 100) ? api.count : null;

  /* ---- helpers -------------------------------------------------------- */
  function fade(a, fn) { var g = ctx.globalAlpha; ctx.globalAlpha = g * clamp(a, 0, 1); fn(); ctx.globalAlpha = g; }
  function mw(s, size) { ctx.font = '400 ' + size + 'px KeouMono'; return ctx.measureText(s).width; }
  function stroked(col, lw) { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); }
  function bar(x, y, w, h, col) { if (w > 0.6) api.box(x, y - h / 2, w, h, col, null, 3); }
  function tick(cx, cy, s, frac, col, lw) {
    api.drawPath([[cx - s * 0.40, cy + s * 0.02], [cx - s * 0.10, cy + s * 0.30],
                  [cx + s * 0.42, cy - s * 0.34]], frac, col, lw || 4.5);
  }
  function arrowHead(x, y, ang, s, col) {
    api.line(x, y, x - Math.cos(ang - 0.44) * s, y - Math.sin(ang - 0.44) * s, col, 3);
    api.line(x, y, x - Math.cos(ang + 0.44) * s, y - Math.sin(ang + 0.44) * s, col, 3);
  }
  /* a sheet of paper with a folded corner: the recurring document glyph */
  function sheet(x, y, w, h, fold, col) {
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w - fold, y); ctx.lineTo(x + w, y + fold);
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
    ctx.fillStyle = C.ink + 'ee'; ctx.fill(); stroked(col + 'aa', 2.5);
    ctx.beginPath(); ctx.moveTo(x + w - fold, y); ctx.lineTo(x + w - fold, y + fold); ctx.lineTo(x + w, y + fold);
    stroked(col + '77', 2);
  }
  /* pennant flag, tip always waving */
  function flag(x, base, h, w, col, lw, seed) {
    var top = base - h, wave = Math.sin(t * 2.3 + seed) * (w * 0.11);
    api.line(x, base, x, top, col, lw);
    ctx.beginPath(); ctx.moveTo(x, top);
    ctx.lineTo(x + w + wave, top + h * 0.20);
    ctx.lineTo(x, top + h * 0.40);
    ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  }
  function footer(dx, dy, align) {
    fade(ease((u - 0.5) / 1) * 0.8, function () {
      api.mono('CONCEPTUAL DIAGRAM / NOT LIVE TELEMETRY', 440, 596, 18, C.muted, 'center', 720);
    });
    if (api.date) fade(ease((u - 0.35) / 0.8), function () {
      api.mono(api.date, dx, dy, 24, P.amber, align, 300);
    });
  }
  function verbatim(y) {
    if (!caption) return;
    fade(ease((u - 0.8) / 0.8), function () { api.mono(caption, 440, y, 22, C.white, 'center', 700); });
  }

  /* ================================================================== */
  /* STAGE 0 - the paper, read line by line, one line graded worth it    */
  /* ================================================================== */
  if (stage < 0.28) {
    var PX = 96, PY = 104, PW = 352, PH = 436;
    var textTop = PY + 118, rows = 11, rowGap = 27;
    var readTop = textTop - 15, readH = rows * rowGap;
    var speed = 0.42, scanF = (u * speed) % 1, scanY = readTop + scanF * readH;
    var hitRow = 6, hitY = textTop + hitRow * rowGap;
    var hl = ease((u - ((hitY - readTop) / readH) / speed - 0.06) / 0.5);
    var appear = ease(u / 0.7);
    var breath = 0.5 + 0.5 * Math.sin(t * 1.6);

    fade(appear * 0.45, function () { api.glow(PX + PW / 2, PY + PH / 2, 260, C.accent); });
    fade(appear, function () { sheet(PX, PY, PW, PH, 34, C.accent); });

    /* header block of the paper */
    fade(appear, function () {
      var hb = ease((u - 0.3) / 0.6);
      bar(PX + 26, PY + 56, (PW - 96) * hb, 13, C.accent + 'cc');
      bar(PX + 26, PY + 80, (PW - 168) * hb, 9, C.accent + '77');
      api.line(PX + 24, PY + 100, PX + PW - 24, PY + 100, C.accent + '44', 1.5);
    });

    /* ruled body text, brightening as the scan passes over it */
    fade(appear, function () {
      for (var i = 0; i < rows; i++) {
        var y = textTop + i * rowGap;
        var w = (PW - 58) * (0.44 + 0.5 * api.rnd(i, 3));
        var drawn = ease((u - 0.45 - i * 0.05) / 0.5);
        if (drawn <= 0.02) continue;
        var near = Math.max(0, 1 - Math.abs(y - scanY) / 32);
        var a = 0.3 + 0.5 * near * near;
        if (i === hitRow) a = Math.max(a, 0.4 + 0.6 * hl);
        fade(a * drawn, function () { bar(PX + 28, y, w * drawn, 9, C.accent); });
      }
    });

    /* the one line that mattered */
    if (hl > 0.02) fade(hl * (0.3 + 0.25 * breath), function () {
      api.box(PX + 18, hitY - 17, PW - 36, 34, C.accent + '26', C.accent + '55', 3);
    });

    /* the scan line itself, sweeping down the page */
    fade(0.5, function () { api.glow(PX + PW / 2, scanY, 120, C.accent); });
    fade(0.85, function () {
      api.line(PX + 10, scanY, PX + PW - 10, scanY, C.accent, 2.5);
      api.dot(PX + 10, scanY, 4, C.accent); api.dot(PX + PW - 10, scanY, 4, C.accent);
    });

    /* the grader: an agent reading down a rail pinned to the page edge */
    var AX = 712, AY = 158, RAIL = 464;
    fade(ease((u - 0.2) / 0.8), function () {
      api.line(RAIL, 196, RAIL, PY + PH - 8, C.accent + '3a', 2);
      api.line(PX + PW, scanY, RAIL, scanY, C.accent + '99', 2);
      api.glow(RAIL, scanY, 26, C.accent);
      api.dot(RAIL, scanY, 5.5, C.accent);
    });
    fade(0.34, function () { api.line(AX - 40, AY + 28, RAIL + 4, 198, C.accent, 1.5); });
    api.packets([[AX - 40, AY + 28], [RAIL + 4, 198]], C.accent, 2, 0.4, 4);
    api.agent(AX, AY, 46, C.accent, 1.4, 3);

    /* the verdict: a checkmark badge beside the highlighted line */
    if (hl > 0.02) {
      fade(hl, function () {
        api.line(RAIL, hitY, 482, hitY, C.accent + '88', 2);
        api.glow(508, hitY, 46, C.accent);
        api.box(482, hitY - 26, 52, 52, C.ink + 'ee', C.accent, 3);
      });
      tick(508, hitY, 44, clamp((hl - 0.25) / 0.6), C.accent, 5);
      fade(clamp((hl - 0.5) / 0.5) * (0.55 + 0.45 * breath), function () {
        api.mono(L[2], 552, hitY + 9, 26, C.accent, 'left', 300);
      });
    }

    fade(ease(u / 0.8), function () { api.mono(L[0], 96, 82, 28, C.accent, 'left', 330); });
    fade(ease((u - 0.4) / 0.8), function () { api.mono(L[1], AX, 262, 26, C.accent, 'center', 300); });
    verbatim(566);
    footer(856, 58, 'right');
    return;
  }

  /* ================================================================== */
  /* STAGE 0.5 - flags were not the point: the last box was never ticked */
  /* ================================================================== */
  if (stage < 0.72) {
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.1);

    /* --- the flag glyph, struck through: capture was not enough ------- */
    fade(ease(u / 0.7) * 0.5, function () { api.glow(146, 150, 112, C.accent); });
    fade(ease(u / 0.7), function () {
      flag(80, 252, 144, 138, C.accent, 5, 0);
      api.line(64, 252, 100, 252, C.accent, 5);
    });
    api.strike(66, 104, 240, 198, ease((u - 1.15) / 0.55), P.red, 5);

    /* the verdict tag: beside the flag when short, under it when long */
    var tagW = mw(L[1], 22) + 34, beside = tagW <= 178;
    fade(ease((u - 1.5) / 0.6), function () {
      if (beside) {
        api.line(224, 150, 244, 150, P.red + 'aa', 2);
        api.box(244, 124, tagW, 52, C.ink + 'ee', P.red + 'aa', 3);
        api.mono(L[1], 244 + tagW / 2, 158, 22, P.red, 'center', tagW - 22);
      } else {
        api.line(64, 278, 64, 306, P.red, 5);
        api.mono(L[1], 78, 300, 22, P.red, 'left', 320);
      }
    });
    fade(ease((u - 0.6) / 0.7), function () { api.mono(L[0], 66, 88, 26, C.accent, 'left', 330); });

    /* --- agents dropping flags into a tray that is already full ------- */
    api.agent(126, 338, 28, C.accent, 0.4, 2.5);
    api.agent(258, 338, 28, C.accent, 2.2, 2.5);
    api.packets([[126, 370], [136, 430]], C.accent, 2, 0.55, 4);
    api.packets([[258, 370], [246, 430]], C.accent, 2, 0.55, 4, 0.4);

    fade(ease((u - 0.35) / 0.8), function () {
      ctx.beginPath();
      ctx.moveTo(64, 436); ctx.lineTo(352, 436); ctx.lineTo(334, 510); ctx.lineTo(82, 510); ctx.closePath();
      ctx.fillStyle = C.deep + 'cc'; ctx.fill(); stroked(C.accent + '99', 3);
      api.line(64, 436, 82, 510, C.accent + '55', 2);
      api.line(352, 436, 334, 510, C.accent + '55', 2);
      /* brim-full: a heap of captured flags lying inside the tray */
      for (var h = 0; h < 18; h++) {
        var row = Math.floor(h / 9);
        var hx = 90 + (h % 9) * 26 + row * 10 + api.rnd(h, 4) * 6;
        var hy = 460 + row * 24 + api.rnd(h, 2) * 8;
        var s = 11 + api.rnd(h, 6) * 4, sway = Math.sin(t * 1.4 + h) * 2.5;
        ctx.beginPath();
        ctx.moveTo(hx - s, hy - s * 0.55); ctx.lineTo(hx + s + sway, hy); ctx.lineTo(hx - s, hy + s * 0.55);
        ctx.closePath(); ctx.fillStyle = C.accent + '55'; ctx.fill();
      }
    });
    for (var f = 0; f < 12; f++) {
      var fx = 90 + f * 22, fh = 44 + 32 * api.rnd(f, 5);
      var fa = ease((u - 0.5 - f * 0.08) / 0.5);
      if (fa <= 0.02) continue;
      fade(fa * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.7 + f))), (function (fx, fh, f) {
        return function () { flag(fx, 438, fh, 16, C.accent, 2, f * 1.3); };
      })(fx, fh, f));
    }
    fade(ease((u - 1.1) / 0.8), function () { api.mono(L[2], 208, 540, 24, C.accent, 'center', 300); });

    /* --- the task list: the last box is still empty ------------------- */
    fade(ease((u - 0.3) / 0.7), function () {
      api.box(430, 92, 300, 240, C.deep + '99', C.accent + '44', 3);
      api.line(430, 148, 730, 148, C.accent + '44', 1.5);
    });
    fade(ease((u - 0.45) / 0.6), function () { api.mono('TASK', 452, 132, 28, C.accent, 'left', 200); });
    for (var r = 0; r < 4; r++) {
      var ry = 182 + r * 36, done = r < 3;
      var ra = ease((u - 0.6 - r * 0.2) / 0.5);
      if (ra <= 0.02) continue;
      fade(ra, (function (ry, done, r) {
        return function () {
          api.box(452, ry - 15, 30, 30, C.ink + 'cc',
                  done ? C.accent + '99' : C.accent + (Math.floor(60 + 140 * pulse).toString(16)), done ? 2 : 3);
          bar(498, ry, (168 + 40 * api.rnd(r, 9)) * ra, 10, done ? C.accent + '99' : C.accent + '44');
        };
      })(ry, done, r));
      if (done) tick(467, ry, 26, ease((u - 1 - r * 0.2) / 0.45), C.accent, 4);
    }
    if (api.cursorOn()) fade(0.9, function () { api.box(461, 279, 12, 20, C.accent, null, 1); });

    /* --- arrow out of the empty box, toward the cluster --------------- */
    var arrow = [[467, 305], [467, 372], [524, 406], [596, 430]];
    var af = ease((u - 1.5) / 1);
    api.drawPath(arrow, af, C.accent, 3);
    if (af > 0.97) {
      arrowHead(596, 430, 0.32, 20, C.accent);
      api.packets(arrow, C.accent, 3, 0.28, 4.5);
    }

    /* --- the cluster: infrastructure, in cyan ------------------------- */
    fade(ease((u - 1.9) / 0.9), function () {
      api.box(614, 372, 216, 178, C.ink + 'cc', P.cyan + '77', 3);
      for (var k = 0; k < 3; k++) {
        var ky = 392 + k * 52;
        api.box(634, ky, 176, 40, C.deep + 'cc', P.cyan + '99', 3);
        for (var d = 0; d < 3; d++) {
          var on = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 2.4 + k * 1.7 + d * 2.3));
          fade(on, (function (ky, d) {
            return function () { api.dot(652 + d * 18, ky + 20, 4, P.cyan); };
          })(ky, d));
        }
        api.line(700, ky + 20, 796, ky + 20, P.cyan + '44', 2);
      }
      var cs = 372 + ((t * 0.22) % 1) * 178;
      fade(0.4, function () { api.line(616, cs, 828, cs, P.cyan, 1.5); });
    });

    verbatim(566);
    footer(856, 58, 'right');
    return;
  }

  /* ================================================================== */
  /* STAGE 1 - the score, the rewritten record, the effort past the stop */
  /* ================================================================== */
  var breath1 = 0.5 + 0.5 * Math.sin(t * 1.5);

  /* --- the share that was edited: a pie drawing itself in red -------- */
  var CXP = 138, CYP = 192, RO = 90, RI = 53, dialY = 466, dialR = 92;
  if (pct !== null) {
    var sweep = ease((u - 0.3) / 2);
    var a0 = -Math.PI / 2, aE = a0 + Math.PI * 2 * (pct / 100) * sweep;
    fade(ease(u / 0.6), function () {
      ctx.beginPath(); ctx.arc(CXP, CYP, (RO + RI) / 2, 0, Math.PI * 2);
      stroked(C.accent + '33', RO - RI);
      ctx.beginPath(); ctx.arc(CXP, CYP, RO, 0, Math.PI * 2); stroked(C.accent + '66', 2);
      ctx.beginPath(); ctx.arc(CXP, CYP, RI, 0, Math.PI * 2); stroked(C.accent + '66', 2);
    });
    fade(0.4 * (0.6 + 0.4 * breath1), function () { api.glow(CXP, CYP, 140, P.red); });
    ctx.beginPath(); ctx.arc(CXP, CYP, (RO + RI) / 2, a0, aE); stroked(P.red + 'dd', RO - RI);
    /* a bright cell travelling around the filled share, so the wedge never sits still */
    var trav = a0 + (aE - a0) * ((t * 0.24) % 1);
    ctx.beginPath(); ctx.arc(CXP, CYP, (RO + RI) / 2, trav, trav + 0.16); stroked(P.red, RO - RI);
    fade(0.9, function () {
      api.line(CXP + Math.cos(aE) * (RI - 4), CYP + Math.sin(aE) * (RI - 4),
               CXP + Math.cos(aE) * (RO + 6), CYP + Math.sin(aE) * (RO + 6), P.red, 2.5);
    });
    api.counter(pct, CXP + 12, CYP + 18, 52, P.red, 0.3, 1.9, 'right');
    fade(clamp((u - 0.3) / 0.5), function () { api.mono('%', CXP + 18, CYP + 18, 34, P.red, 'left', 60); });
    fade(ease((u - 0.9) / 0.8), function () { api.mono(L[0], CXP, 318, 26, C.accent, 'center', 270); });
  } else {
    dialY = 300; dialR = 116;
  }

  /* --- the transcript, erased and rewritten line by line -------------- */
  var DX = 292, DY = 68, DW = 324, DH = 424, drows = 10, rTop = DY + 62, rGap = 34;
  fade(ease((u - 0.25) / 0.7), function () { sheet(DX, DY, DW, DH, 28, C.accent); });
  fade(ease((u - 0.35) / 0.6), function () {
    bar(DX + 26, DY + 34, DW - 108, 11, C.accent + 'aa');
    api.line(DX + 24, DY + 52, DX + DW - 24, DY + 52, C.accent + '44', 1.5);
  });
  var beamY = -1, beamBest = 2;
  fade(ease((u - 0.35) / 0.6), function () {
    for (var i = 0; i < drows; i++) {
      var ry = rTop + i * rGap, x0 = DX + 28;
      var full = (DW - 62) * (0.5 + 0.44 * api.rnd(i, 11));
      var p = ((t * 0.30) + i * 0.13) % 1;
      if (p < 0.42) { bar(x0, ry, full, 9, C.accent + 'aa'); }
      else if (p < 0.66) {
        var k = (p - 0.42) / 0.24, w = full * (1 - k);
        bar(x0, ry, w, 9, C.accent + '55');
        fade(0.8, function () { api.box(x0 + w - 4, ry - 11, 14, 22, C.muted + '99', null, 2); });
      } else {
        var k2 = (p - 0.66) / 0.34, w2 = full * k2;
        bar(x0, ry, w2, 9, P.red + 'cc');
        fade(0.9, function () { api.box(x0 + w2 - 3, ry - 11, 13, 22, P.red, null, 2); });
        if (k2 < beamBest) { beamBest = k2; beamY = ry; }
      }
    }
  });

  /* the agent doing the rewriting */
  var AX2 = 706, AY2 = 136;
  if (beamY > 0) {
    fade(0.32, function () { api.line(AX2 - 26, AY2 + 24, DX + DW + 6, beamY, P.red, 1.5); });
    api.packets([[AX2 - 26, AY2 + 24], [DX + DW + 6, beamY]], P.red, 2, 0.4, 4);
  }
  api.agent(AX2, AY2, 42, C.accent, 0.9, 3);
  fade(ease((u - 0.8) / 0.8), function () { api.mono(L[1], AX2, 72, 26, C.accent, 'center', 280); });

  /* --- the grader's eye, turning away, pupil closing ------------------ */
  var EX = 726, EY = 352, ER = 54;
  var away = ease((u - 1.1) / 2.2);
  var open = (1 - 0.44 * away) * (0.94 + 0.06 * Math.sin(t * 1.2));
  fade(ease((u - 0.9) / 0.7), function () {
    var col = C.accent, dim = 1 - 0.4 * away, lift = ER * 1.16 * open;
    fade(0.3 * dim, function () { api.glow(EX, EY, 96, C.accent); });
    ctx.save();
    ctx.translate(EX, EY); ctx.rotate(-0.26 * away - 0.03 * Math.sin(t * 0.9));
    /* the eyelid almond */
    ctx.beginPath();
    ctx.moveTo(-ER, 0); ctx.quadraticCurveTo(0, -lift, ER, 0);
    ctx.quadraticCurveTo(0, lift, -ER, 0); ctx.closePath();
    ctx.fillStyle = C.ink + 'dd'; ctx.fill();
    stroked(col + 'cc', 3);
    /* lashes on the upper lid: the glyph stays an eye even when narrowed */
    fade(0.7, function () {
      for (var s = 0.16; s < 0.9; s += 0.17) {
        var bx = (1 - s) * (1 - s) * -ER + s * s * ER, by = -2 * (1 - s) * s * lift;
        var dx = bx * 0.5, dy = by - ER * 0.3, m = Math.hypot(dx, dy) || 1;
        api.line(bx, by, bx + dx / m * 14, by + dy / m * 14, col, 2.5);
      }
    });
    /* iris sliding away, pupil narrowing to a slit */
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-ER, 0); ctx.quadraticCurveTo(0, -lift, ER, 0);
    ctx.quadraticCurveTo(0, lift, -ER, 0); ctx.closePath(); ctx.clip();
    var ix = -ER * 0.44 * away;
    fade(dim, function () {
      ctx.beginPath(); ctx.arc(ix, 0, ER * 0.34, 0, Math.PI * 2); stroked(col, 2.5);
      ctx.beginPath();
      ctx.ellipse(ix, 0, ER * 0.15 * (1 - 0.78 * away) + 1.4, ER * 0.16, 0, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
    });
    ctx.restore();
    fade(0.55 * away, function () { api.line(-ER + 6, 0, ER - 6, 0, col, 2); });
    ctx.restore();
  });
  fade(ease((u - 1) / 0.8), function () { api.mono(L[2], EX, 452, 26, C.accent, 'center', 280); });

  /* --- the effort dial, needle bent against the stop ------------------ */
  var gA = Math.PI, gS = Math.PI;
  fade(ease((u - 1.2) / 0.9), function () {
    ctx.beginPath(); ctx.arc(CXP, dialY, dialR, gA, gA + gS); stroked(C.accent + '4d', 13);
    ctx.beginPath(); ctx.arc(CXP, dialY, dialR, gA + gS * 0.86, gA + gS); stroked(P.red + 'bb', 13);
    for (var i = 0; i <= 10; i++) {
      var an = gA + gS * (i / 10), r1 = dialR - 24, r2 = dialR - 9;
      api.line(CXP + Math.cos(an) * r1, dialY + Math.sin(an) * r1,
               CXP + Math.cos(an) * r2, dialY + Math.sin(an) * r2,
               i >= 9 ? P.red : C.accent + 'cc', i % 5 === 0 ? 3.5 : 1.5);
    }
    /* the stop peg at the end of the scale, and the needle jammed past it */
    var v = ease((u - 1.4) / 1.1) * (1.05 + 0.02 * Math.sin(t * 12.3) + 0.013 * Math.sin(t * 7.7));
    var na = gA + gS * v, bend = na - 0.30;
    var kx = CXP + Math.cos(na) * dialR * 0.72, ky = dialY + Math.sin(na) * dialR * 0.72;
    var tx = CXP + Math.cos(bend) * dialR * 1.02, ty = dialY + Math.sin(bend) * dialR * 1.02;
    api.line(CXP + dialR - 30, dialY, CXP + dialR + 14, dialY, P.red, 8);
    fade(0.55 + 0.45 * breath1, function () { api.glow(CXP + dialR - 4, dialY, 34, P.red); });
    api.drawPath([[CXP, dialY], [kx, ky], [tx, ty]], 1, P.red, 5);
    api.dot(tx, ty, 4, P.red);
    fade(0.5, function () { api.glow(CXP, dialY, 22, P.red); });
    api.dot(CXP, dialY, 9, P.red);
    api.dot(CXP, dialY, 4, C.ink);
    api.mono('EFFORT', CXP, dialY + 56, 26, C.accent, 'center', 250);
  });

  footer(24, 62, 'left');
};
