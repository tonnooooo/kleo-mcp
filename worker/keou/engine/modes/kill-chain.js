/* kill-chain - the whole intrusion chain, run end to end by cooperating agents with no operator. */
window.KEOU_MODES['kill-chain'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P, u = api.u, t = api.t;
  var A = C.accent, clamp = api.clamp, ease = api.ease;
  var smooth = function (x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

  var stage = clamp(typeof api.stage === 'number' ? api.stage : 0, 0, 1);
  var m = smooth((stage - 0.58) / 0.14);            /* 0 = chain diagram, 1 = agent ring */
  var chainTextA = 1 - m, ringTextA = m;            /* the two caption sets cross-fade */

  var LB = (api.labels && api.labels.length >= 3) ? api.labels : ['ACCESS', 'LATERAL', 'PERSIST'];
  var STAGES = ['RECON', LB[0], LB[1], LB[2], 'CLEAN UP'];

  /* ---------- shared geometry: the ring is where the chain compresses to ---------- */
  var CX = 440, CY = 316, RX = 266, RY = 158;
  var n = Math.max(3, Math.min(8, api.count || 4));
  var ringPts = [];
  for (var q = 0; q <= 72; q++) {
    var qa = -Math.PI / 2 + q / 72 * Math.PI * 2;
    ringPts.push([CX + RX * Math.cos(qa), CY + RY * Math.sin(qa)]);
  }
  var agentAt = function (k) {
    var a = -Math.PI / 2 + Math.PI / n + k * 2 * Math.PI / n;   /* keeps top + bottom clear */
    return [CX + RX * Math.cos(a), CY + RY * Math.sin(a)];
  };

  /* ---------- centred monospace with a typing reveal ---------- */
  function typedCentre(value, y, size, color, cps, delay) {
    ctx.font = '400 ' + size + 'px KeouMono';
    var full = ctx.measureText(value).width;
    if (full > 700) {
      size = Math.max(17, Math.floor(size * 700 / full));
      ctx.font = '400 ' + size + 'px KeouMono';
      full = ctx.measureText(value).width;
    }
    var x0 = Math.max(14, CX - full / 2);
    var shown = api.typed(value, cps, delay);
    var w = api.mono(shown, x0, y, size, color, 'left', 840);
    if (shown.length < value.length && api.cursorOn()) {
      ctx.fillStyle = color;
      ctx.fillRect(x0 + w + 3, y - size + 4, size * 0.5, size * 0.84);
    }
    return [x0, full];
  }

  /* =====================  A. THE FIVE-STAGE CHAIN  ===================== */
  var LW = 132, GAP = 40, LH = 204, X0 = 30, TOP = 182, MID = TOP + LH / 2;
  var linkX = function (i) { return X0 + i * (LW + GAP); };
  var linkFill = function (i) { return clamp((u - 0.34 - i * 0.5) / 0.74, 0, 1); };
  var linkIn = function (i) { return ease(clamp((u - i * 0.5) / 0.45, 0, 1)); };
  var travel = function (i) {                        /* the row bends left to right onto the ring */
    var home = [linkX(i) + LW / 2, MID], w = Math.PI + i * Math.PI / 4;
    var tgt = [CX + RX * Math.cos(w), CY + RY * Math.sin(w)];
    return [home[0] + (tgt[0] - home[0]) * m, home[1] + (tgt[1] - home[1]) * m, home];
  };

  function drawChain(alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;

    ctx.save();                                      /* rail + connectors dissolve first */
    ctx.globalAlpha *= (1 - m) * (1 - m);
    api.drawPath([[X0, MID], [X0 + 4 * (LW + GAP) + LW, MID]], clamp((u - 0.1) / 2.8, 0, 1), A + '2a', 2);
    for (var g = 0; g < 4; g++) {
      var gx = linkX(g) + LW, seg = [[gx, MID], [gx + GAP, MID]];
      var f = clamp((linkFill(g) - 0.62) / 0.38, 0, 1);
      api.drawPath(seg, f, A, 3.5);
      if (f >= 1) api.packets(seg, A, 2, 0.55, 4, g * 0.27);
    }
    ctx.restore();

    for (var i = 0; i < 5; i++) {
      var lx = linkX(i), p = linkFill(i), a = linkIn(i), cx = lx + LW / 2;
      var tr = travel(i), sc = 1 - 0.55 * m, j, ry, r0 = lx + 18, r1 = lx + LW - 18;
      ctx.save();
      ctx.translate(tr[0], tr[1]); ctx.scale(sc, sc); ctx.translate(-tr[2][0], -tr[2][1]);

      if (a < 0.99) {                                /* the five slots wait as dim placeholders */
        ctx.save();
        ctx.globalAlpha *= (1 - a) * 0.5;
        ctx.beginPath(); ctx.roundRect(lx, TOP, LW, LH, 3);
        ctx.strokeStyle = A + '44'; ctx.lineWidth = 1.5; ctx.stroke();
        for (j = 0; j < 4; j++) { ry = TOP + 38 + j * 42; api.line(r0, ry, r1, ry, A + '22', 1.5) }
        ctx.restore();
      }
      if (a <= 0.01) { ctx.restore(); continue }
      ctx.save();
      ctx.globalAlpha *= a;
      ctx.translate(0, (1 - a) * 16);

      if (p > 0) {                                   /* breathing halo once the link is live */
        ctx.save();
        ctx.globalAlpha *= (0.18 + 0.14 * (0.5 + 0.5 * Math.sin(t * 1.5 - i * 0.8))) * p;
        api.glow(cx, MID, 124, A);
        ctx.restore();
      }

      ctx.beginPath(); ctx.roundRect(lx, TOP, LW, LH, 3);
      ctx.fillStyle = C.ink; ctx.fill();
      ctx.strokeStyle = p > 0 ? A : A + '33';
      ctx.lineWidth = p > 0 ? 2.5 : 1.5;
      ctx.stroke();

      var edge = lx + 7 + (LW - 14) * ease(p);
      if (p > 0) api.box(lx + 7, TOP + 7, edge - lx - 7, LH - 14, A + '22', null, 2);

      for (j = 0; j < 4; j++) {                      /* interior work rows, swept by the fill edge */
        ry = TOP + 38 + j * 42;
        api.line(r0, ry, r1, ry, A + '26', 2);
        var rp = ease(clamp((p - j * 0.04) / 0.86, 0, 1));
        if (rp > 0.01) api.line(r0, ry, r0 + (r1 - r0) * rp, ry, A, 2.5);
        if (p >= 1) api.packets([[r0, ry], [r1, ry]], A, 1, 0.34, 3.5, j * 0.27 + i * 0.19);
      }
      if (p > 0 && p < 1) api.line(edge, TOP + 8, edge, TOP + LH - 8, A, 2.5);
      if (p >= 1) {
        api.line(lx + 14, TOP + LH - 16, lx + LW - 14, TOP + LH - 16, A + '55', 2);
        api.dot(cx, TOP + LH - 16, 3 + (0.5 + 0.5 * Math.sin(t * 2.1 + i * 1.1)) * 2.5, A);
      }
      ctx.restore();
      ctx.restore();
    }

    for (var q2 = 0; q2 < 5; q2++) {                 /* the five stage names, dim until reached */
      if (chainTextA <= 0.02) break;
      var tr2 = travel(q2), sc2 = 1 - 0.55 * m, a2 = linkIn(q2);
      ctx.save();
      ctx.translate(tr2[0], tr2[1]); ctx.scale(sc2, sc2); ctx.translate(-tr2[2][0], -tr2[2][1]);
      ctx.globalAlpha *= chainTextA * (0.42 + 0.58 * a2);
      api.mono(STAGES[q2], linkX(q2) + LW / 2, 424, 26, linkFill(q2) > 0 ? C.white : C.muted, 'center', 166);
      ctx.restore();
    }

    /* soft sweep so the whole band keeps moving */
    ctx.save();
    ctx.globalAlpha *= 1 - m;
    var sx = -110 + ((t * 0.12) % 1) * 1100;
    var grad = ctx.createLinearGradient(sx - 75, 0, sx + 75, 0);
    grad.addColorStop(0, A + '00'); grad.addColorStop(0.5, A + '0e'); grad.addColorStop(1, A + '00');
    ctx.fillStyle = grad; ctx.fillRect(sx - 75, TOP, 150, LH);
    ctx.restore();
    ctx.restore();
  }

  function chainText() {
    ctx.save();
    ctx.globalAlpha *= chainTextA;
    /* dim callback marker over link 1 - the previous film only covered recon */
    ctx.save();
    ctx.globalAlpha *= 0.6 + 0.22 * Math.sin(t * 1.15);
    api.line(36, 150, 156, 150, C.muted, 1.5);
    api.line(36, 150, 36, 161, C.muted, 1.5);
    api.line(156, 150, 156, 161, C.muted, 1.5);
    api.line(96, 150, 96, TOP - 6, C.muted, 1.5);
    api.mono('PREVIOUS VIDEO', 96, 136, 19, C.muted, 'center', 200);
    ctx.restore();
    if (api.text) {
      var c = typedCentre(api.text, 502, 32, A, 24, 1.15);
      var uw = c[1] * ease(clamp((u - 1.15) / 1.3, 0, 1));
      api.line(c[0], 522, c[0] + uw, 522, A + '66', 2);
    }
    ctx.restore();
  }

  /* =====================  B. THE AGENT RING, NO OPERATOR  ===================== */
  function chair(alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = C.muted; ctx.lineWidth = 4.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.save();                                      /* backrest, leaning slightly */
    ctx.translate(486, 272); ctx.rotate(0.1);
    ctx.beginPath(); ctx.roundRect(-9, -46, 18, 92, 8); ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.roundRect(390, 310, 98, 15, 5); ctx.stroke();     /* seat */
    ctx.beginPath(); ctx.moveTo(438, 327); ctx.lineTo(438, 376); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(398, 392); ctx.lineTo(438, 376); ctx.lineTo(478, 392); ctx.stroke();
    api.dot(396, 397, 5, C.muted); api.dot(480, 397, 5, C.muted);
    ctx.lineCap = 'butt';
    ctx.restore();
  }

  function drawRing(alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    var drawn = ease(clamp((u - 0.12) / 1.15, 0, 1));

    api.drawPath(ringPts, drawn, A + '72', 3);

    if (drawn > 0.97) {                              /* impulse comet running the ring */
      var head = (t * 0.15) % 1;
      for (var s = 0; s < 72; s++) {
        var d = (head - s / 72 + 1) % 1, aa = 1 - d / 0.26;
        if (aa <= 0.03) continue;
        ctx.save();
        ctx.globalAlpha *= aa * 0.85;
        api.line(ringPts[s][0], ringPts[s][1], ringPts[s + 1][0], ringPts[s + 1][1], A, 5);
        ctx.restore();
      }
      var hi = Math.floor(head * 72) % 72;
      api.glow(ringPts[hi][0], ringPts[hi][1], 34, A);
      api.packets(ringPts, A, 6, 0.16, 5.5, 0);
    }

    for (var k = 0; k < n; k++) {
      var pos = agentAt(k), ap = ease(clamp((u - 0.25 - k * 0.16) / 0.5, 0, 1));
      if (ap <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha *= ap;
      ctx.save();
      ctx.globalAlpha *= 0.3 + 0.2 * Math.sin(t * 1.7 + k * 1.4);
      api.glow(pos[0], pos[1], 100 + 10 * Math.sin(t * 1.3 + k), A);
      ctx.restore();
      api.agent(pos[0], pos[1], 37 + 2 * Math.sin(t * 1.9 + k * 1.7), A, 1 + k * 1.3, 3);
      ctx.restore();
    }

    chair(ease(clamp((u - 0.5) / 0.8, 0, 1)) * (0.74 + 0.06 * Math.sin(t * 1.1)));
    ctx.save();
    ctx.globalAlpha *= 0.86 + 0.14 * Math.sin(t * 2.2);
    api.strike(372, 240, 506, 386, ease(clamp((u - 1.25) / 0.6, 0, 1)), P.red, 6);
    ctx.restore();
    ctx.restore();
  }

  function ringText() {
    ctx.save();
    ctx.globalAlpha *= ringTextA;
    if (api.count != null) {
      ctx.font = '400 42px KeouMono';
      var wn = ctx.measureText(String(api.count)).width;
      ctx.font = '400 28px KeouMono';
      var wl = ctx.measureText(LB[0]).width, x0 = CX - (wn + 22 + wl) / 2;
      api.counter(api.count, x0 + wn, 78, 42, A, 0.2, 1.1, 'right');
      api.mono(LB[0], x0 + wn + 22, 76, 28, C.white, 'left', 420);
    } else {
      api.mono(LB[0], CX, 76, 28, C.white, 'center', 520);
    }
    ctx.save();
    ctx.globalAlpha *= ease(clamp((u - 1.7) / 0.7, 0, 1));
    api.mono(LB[2], CX, 452, 24, P.red, 'center', 300);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha *= ease(clamp((u - 1.0) / 0.8, 0, 1));
    api.mono(LB[1], CX, 580, 26, A, 'center', 620);
    ctx.restore();
    ctx.restore();
  }

  if (m < 0.985) drawChain(1 - m);
  if (m > 0.015) drawRing(m);
  if (chainTextA > 0.02) chainText();
  if (ringTextA > 0.02) ringText();
};
