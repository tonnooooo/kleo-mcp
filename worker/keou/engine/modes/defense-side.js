/* defense-side - what the defence actually caught, and what refused to look at it. */
window.KEOU_MODES['defense-side'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P, u = api.u, t = api.t;
  var A = C.accent, M = C.muted, clamp = api.clamp, ease = api.ease;
  var stage = clamp(typeof api.stage === 'number' ? api.stage : 0, 0, 1);
  var LB = (api.labels && api.labels.length >= 3) ? api.labels
         : ['LOG STREAM', 'AI AGENT', 'NOT CRITICAL'];
  var wave = function (speed, phase) { return 0.5 + 0.5 * Math.sin(t * speed + (phase || 0)); };

  /* ---------- shared: a redacted log line, drawn as bars, never invented text ---------- */
  function bars(x, y, maxW, seed, color, h) {
    var cx = x, n = 3 + Math.floor(api.rnd(seed, 7) * 4);
    for (var j = 0; j < n; j++) {
      var bw = 20 + api.rnd(seed, j) * maxW * 0.24;
      if (cx + bw > x + maxW) break;
      ctx.fillStyle = color;
      ctx.fillRect(cx, y - h, bw, h);
      cx += bw + 11;
    }
  }

  /* ---------- shared: rows scrolling upward forever, clipped to their pane ---------- */
  function streamRows(x, y, w, h, rowH, rate, draw) {
    var span = h / rowH, base = u * rate + span + 0.5;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (var k = Math.ceil(base - span) - 1; k <= Math.floor(base); k++) {
      draw(k, y + h - (base - k) * rowH);
    }
    ctx.restore();
  }

  /* an optional timestamp, the only amber in the frame */
  function dateStamp(x, y, align, max) {
    if (!api.date) return;
    ctx.save();
    ctx.globalAlpha *= ease(clamp((u - 0.2) / 0.6, 0, 1)) * (0.82 + 0.18 * wave(1.6));
    api.mono(api.date, x, y, 21, P.amber, align, max);
    ctx.restore();
  }

  function panel(x, y, w, h, strokeAlpha) {
    api.box(x, y, w, h, C.ink, A + (strokeAlpha || '3a'), 3);
  }

  function windowDots(x, y) {
    for (var d = 0; d < 3; d++) api.box(x + d * 22, y, 8, 8, d === 0 ? A : A + '44', null, 1);
  }

  function arrowHead(x, y, dx, dy, s, color) {
    var l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    var nx = -dy, ny = dx;
    api.line(x, y, x - dx * s + nx * s * 0.6, y - dy * s + ny * s * 0.6, color, 2.5);
    api.line(x, y, x - dx * s - nx * s * 0.6, y - dy * s - ny * s * 0.6, color, 2.5);
  }

  /* =====================================================================
     A - THE ALERT THAT SCROLLED PAST  (shield, watching agent, log stream)
     ===================================================================== */
  function stageA() {
    var PX = 288, PY = 92, PW = 566, PH = 448;
    var RX = PX + 8, RT = 160, RW = PW - 16, RH = 372, ROW = 36, RATE = 1.6;
    var BEAM = 392, ALERT = 12;

    /* -- the shield: the defensive posture, scanning -- */
    var scx = 148, scy = 198, sw = 62, sh = 96;
    function shieldPath() {
      ctx.beginPath();
      ctx.moveTo(scx - sw, scy - sh * 0.62);
      ctx.lineTo(scx, scy - sh * 0.80);
      ctx.lineTo(scx + sw, scy - sh * 0.62);
      ctx.lineTo(scx + sw, scy + sh * 0.04);
      ctx.quadraticCurveTo(scx + sw * 0.9, scy + sh * 0.58, scx, scy + sh * 0.88);
      ctx.quadraticCurveTo(scx - sw * 0.9, scy + sh * 0.58, scx - sw, scy + sh * 0.04);
      ctx.closePath();
    }
    ctx.save();
    ctx.globalAlpha *= 0.22 + 0.14 * wave(1.2);
    api.glow(scx, scy, 128, P.cyan);
    ctx.restore();
    shieldPath();
    ctx.fillStyle = C.ink; ctx.fill();
    ctx.save();                                   /* scan band sweeping down the shield */
    shieldPath(); ctx.clip();
    var sy = scy - sh * 0.8 + ((t * 0.3) % 1) * sh * 1.7;
    var g = ctx.createLinearGradient(0, sy - 26, 0, sy + 26);
    g.addColorStop(0, P.cyan + '00'); g.addColorStop(0.5, P.cyan + '3a'); g.addColorStop(1, P.cyan + '00');
    ctx.fillStyle = g; ctx.fillRect(scx - sw, sy - 26, sw * 2, 52);
    for (var b = 0; b < 4; b++) {
      var by = scy - 44 + b * 26;
      api.line(scx - 34, by, scx + 34, by, P.cyan + (Math.abs(by - sy) < 20 ? '99' : '30'), 3);
    }
    ctx.restore();
    shieldPath();
    ctx.strokeStyle = P.cyan; ctx.lineWidth = 3.5; ctx.stroke();

    /* -- shield feeds the agent -- */
    var link = [[scx, scy + sh * 0.9 + 6], [scx, 344]];
    api.drawPath(link, ease(clamp((u - 0.25) / 0.5, 0, 1)), P.cyan + '55', 2);
    api.packets(link, P.cyan, 2, 0.42, 4, 0);

    /* -- the AI security agent, watching -- */
    var ap = ease(clamp((u - 0.1) / 0.55, 0, 1));
    ctx.save();
    ctx.globalAlpha *= ap;
    ctx.save();
    ctx.globalAlpha *= 0.26 + 0.2 * wave(1.7, 0.6);
    api.glow(scx, BEAM, 122, A);
    ctx.restore();
    api.agent(scx, BEAM, 46 + 2.5 * wave(1.9, 1.2), A, 1.4, 3);
    api.mono(LB[1], scx, 486, 24, C.white, 'center', 250);
    ctx.restore();

    /* -- the reading beam into the stream -- */
    var beamPts = [[PX, BEAM], [scx + 50, BEAM]];
    api.drawPath(beamPts, ease(clamp((u - 0.35) / 0.6, 0, 1)), A + '55', 2);
    api.packets(beamPts, A, 3, 0.5, 4.5, 0);
    api.line(PX + 2, BEAM - 22, PX + 2, BEAM + 22, A + '88', 2.5);

    /* -- the log stream -- */
    panel(PX, PY, PW, PH, '48');
    api.mono(LB[0], PX + 18, PY + 40, 25, C.white, 'left', 300);
    api.line(PX, PY + 56, PX + PW, PY + 56, A + '33', 1.5);
    windowDots(PX + PW - 84, PY + 22);

    streamRows(RX, RT, RW, RH, ROW, RATE, function (k, y) {
      if (k === ALERT) {
        var pl = 152, plx = RX + RW - pl - 14;
        api.box(RX + 4, y - 26, RW - 8, 38, A + '10', A + '88', 2);
        ctx.save();                                        /* low-severity warning mark */
        ctx.globalAlpha *= 0.75;
        ctx.beginPath();
        ctx.moveTo(RX + 26, y - 20); ctx.lineTo(RX + 36, y - 3); ctx.lineTo(RX + 16, y - 3); ctx.closePath();
        ctx.strokeStyle = M; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = M; ctx.fillRect(RX + 25, y - 15, 2, 6); ctx.fillRect(RX + 25, y - 7, 2, 2);
        ctx.restore();
        bars(RX + 48, y - 2, RW - 240, 91, A + 'cc', 5);
        api.box(plx, y - 22, pl, 30, P.dim, M + '66', 3);   /* the grey severity tag */
        api.mono(LB[2], plx + pl / 2, y - 1, 19, M, 'center', pl - 12);
        return;
      }
      var near = clamp(1 - Math.abs(y - BEAM) / 30, 0, 1);
      var dim = api.rnd(k, 5) > 0.72;
      api.dot(RX + 18, y - 6, 3, (dim ? M : A) + (near > 0.4 ? 'ee' : '77'));
      bars(RX + 36, y, RW - 150, k, (dim ? M : A) + (near > 0.4 ? 'cc' : '4a'), 4);
      if (near > 0.4) api.line(RX + 4, y - 24, RX + 4, y + 6, A + 'aa', 2);
    });

    dateStamp(scx, 66, 'center', 250);

    ctx.save();                                            /* phosphor sweep over the pane */
    var swy = RT + ((t * 0.11) % 1) * RH;
    var sg = ctx.createLinearGradient(0, swy - 60, 0, swy + 60);
    sg.addColorStop(0, A + '00'); sg.addColorStop(0.5, A + '0c'); sg.addColorStop(1, A + '00');
    ctx.fillStyle = sg; ctx.fillRect(RX, Math.max(RT, swy - 60), RW, 120);
    ctx.restore();
  }

  /* =====================================================================
     B - THE SIEM DASHBOARD: two identity log lines, correlated by humans
     ===================================================================== */
  function stageB() {
    var DX = 30, DY = 86, DW = 556, DH = 430;
    var R1 = 312, R2 = 408, RXX = 100, RWW = 468;
    var join = ease(clamp((u - 0.85) / 1.45, 0, 1));
    var alert = ease(clamp((u - 2.45) / 0.65, 0, 1));

    panel(DX, DY, DW, DH, '48');
    api.mono(LB[0], DX + 18, DY + 36, 25, C.white, 'left', 320);
    api.line(DX, DY + 50, DX + DW, DY + 50, A + '33', 1.5);
    windowDots(DX + DW - 84, DY + 18);

    /* -- sparkline panel: always drifting -- */
    var sx0 = 62, sx1 = 556, sy0 = 150, sy1 = 250, mid = (sy0 + sy1) / 2;
    api.box(48, sy0, 520, sy1 - sy0, C.deep, A + '2a', 2);
    api.line(sx0, mid, sx1, mid, A + '22', 1);
    var pts = [], i, ph, v;
    for (i = 0; i <= 52; i++) {
      ph = i * 0.4 - t * 1.15;
      v = Math.sin(ph) * 0.52 + Math.sin(ph * 0.53 + 1.7) * 0.3 + Math.sin(ph * 1.87 + 0.6) * 0.17;
      pts.push([sx0 + (sx1 - sx0) * i / 52, mid - v * 32]);
    }
    api.drawPath(pts, ease(clamp((u - 0.15) / 0.8, 0, 1)), A + 'cc', 2.5);
    var cur = sx0 + ((t * 0.2) % 1) * (sx1 - sx0), ci = Math.round((cur - sx0) / (sx1 - sx0) * 52);
    api.line(cur, sy0 + 8, cur, sy1 - 8, A + '55', 1.5);
    api.dot(pts[ci][0], pts[ci][1], 4.5, A);

    /* -- the two identity log lines -- */
    function logRow(y, seed, color, glowA) {
      if (glowA > 0) {
        ctx.save(); ctx.globalAlpha *= glowA; api.glow(RXX + RWW / 2, y, 150, P.red); ctx.restore();
      }
      api.box(RXX, y - 26, RWW, 52, C.deep, color, 2);
      api.dot(RXX + 20, y, 4, color);
      bars(RXX + 38, y + 6, RWW - 130, seed, color + 'ee', 5);
      api.line(RXX + 38, y - 10, RXX + 38 + 96 + api.rnd(seed, 2) * 90, y - 10, color + '66', 4);
    }
    if (alert < 0.99) {
      ctx.save();
      ctx.globalAlpha *= 1 - alert;
      logRow(R1, 21, A, 0); logRow(R2, 34, A, 0);
      ctx.restore();
    }
    if (alert > 0.02) {
      ctx.save();
      ctx.globalAlpha *= alert;
      logRow(R1, 21, P.red, 0.4 * (0.5 + 0.5 * wave(2.4)));
      logRow(R2, 34, P.red, 0.4 * (0.5 + 0.5 * wave(2.4, 1.1)));
      var bx = RXX + RWW - 46;
      ctx.save();
      ctx.globalAlpha *= 0.72 + 0.28 * wave(3.1);
      [R1, R2].forEach(function (y) {
        ctx.beginPath();
        ctx.moveTo(bx, y - 14); ctx.lineTo(bx + 15, y + 12); ctx.lineTo(bx - 15, y + 12); ctx.closePath();
        ctx.strokeStyle = P.red; ctx.lineWidth = 2.5; ctx.stroke();
        ctx.fillStyle = P.red; ctx.fillRect(bx - 1.5, y - 6, 3, 9); ctx.fillRect(bx - 1.5, y + 6, 3, 3);
      });
      ctx.restore();
      ctx.restore();
    }

    /* -- the correlation drawn between them -- */
    var jp = [[RXX, R1], [74, R1], [74, R2], [RXX, R2]];
    api.drawPath(jp, join, alert > 0.5 ? P.red : A, 3);
    if (join >= 1) {
      api.packets(jp, alert > 0.5 ? P.red : A, 3, 0.4, 4.5, 0);
      api.dot(74, (R1 + R2) / 2, 5 + 2 * wave(2.6), alert > 0.5 ? P.red : A);
    }
    api.mono(LB[1], DX + DW / 2 - 8, 484, 24, join >= 1 ? C.white : M, 'center', 420);

    dateStamp(DX + 2, 64, 'left', 300);

    /* -- the second stream keeps running beside the dashboard -- */
    panel(612, DY, 238, 258, '30');
    streamRows(618, DY + 6, 226, 246, 24, 2.4, function (k, y) {
      var dim = api.rnd(k, 9) > 0.6;
      api.dot(630, y - 5, 2.5, (dim ? M : A) + '77');
      bars(642, y, 190, k + 60, (dim ? M : A) + '5a', 3);
    });

    /* -- the analysts' workstation: never a person, only their desk -- */
    var wx = 732;
    api.box(wx - 44, 370, 88, 60, C.deep, M, 3);
    streamRows(wx - 38, 376, 76, 48, 12, 3.2, function (k, y) {
      bars(wx - 33, y, 58 - api.rnd(k, 4) * 22, k + 200, A + '77', 2);
    });
    ctx.strokeStyle = M; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(wx, 430); ctx.lineTo(wx, 446); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wx - 18, 448); ctx.lineTo(wx + 18, 448); ctx.stroke();
    api.line(wx - 86, 456, wx + 86, 456, M, 5);
    ctx.beginPath(); ctx.roundRect(wx - 30, 500, 58, 13, 5); ctx.stroke();        /* seat */
    ctx.beginPath(); ctx.roundRect(wx + 22, 466, 13, 42, 6); ctx.stroke();        /* backrest */
    ctx.beginPath(); ctx.moveTo(wx - 2, 513); ctx.lineTo(wx - 2, 532); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wx - 24, 542); ctx.lineTo(wx - 2, 532); ctx.lineTo(wx + 20, 542); ctx.stroke();
    ctx.lineCap = 'butt';
    api.mono(LB[2], wx, 578, 24, C.white, 'center', 260);

    var feed = [[DX + DW + 4, 400], [wx - 50, 400]];
    api.drawPath(feed, ease(clamp((u - 0.5) / 0.7, 0, 1)), A + '4a', 2);
    api.packets(feed, A, 2, 0.4, 4, 0.2);
    arrowHead(wx - 50, 400, 1, 0, 11, A + '88');
  }

  /* =====================================================================
     C - THE ENCODED PAYLOAD: two refusals, then the open-weight model
     ===================================================================== */
  function stageC() {
    var BX = 336, BY = 186, BW = 236, BH = 210;
    var ROWY = [256, 302, 348], RWD = 196, ROWX = BX + 20;
    var send1 = ease(clamp((u - 0.9) / 0.6, 0, 1)), no1 = ease(clamp((u - 1.6) / 0.4, 0, 1));
    var send2 = ease(clamp((u - 2.0) / 0.6, 0, 1)), no2 = ease(clamp((u - 2.7) / 0.4, 0, 1));
    var send3 = ease(clamp((u - 3.3) / 0.7, 0, 1)), yes = ease(clamp((u - 4.0) / 0.5, 0, 1));
    var dec = ease(clamp((u - 4.3) / 1.7, 0, 1));
    var p1 = [[BX - 2, 256], [318, 256], [318, 174], [288, 174]];
    var p2 = [[BX - 2, 348], [318, 348], [318, 384], [288, 384]];
    var p3 = [[BX + BW + 2, 316], [610, 316], [610, 354], [644, 354]];

    /* -- the stream still runs at the edge of the frame -- */
    panel(14, 106, 64, 420, '22');
    streamRows(18, 112, 56, 408, 22, 2.7, function (k, y) {
      var c = (api.rnd(k, 3) > 0.6 ? M : A) + '55';
      ctx.fillStyle = c; ctx.fillRect(26, y - 3, 10 + api.rnd(k, 1) * 12, 3);
      ctx.fillStyle = c; ctx.fillRect(42 + api.rnd(k, 1) * 12, y - 3, 6 + api.rnd(k, 2) * 12, 3);
    });

    /* -- the two closed models -- */
    function modelBox(x, y, w, h, live) {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 16);
      ctx.fillStyle = C.deep; ctx.fill();
      ctx.strokeStyle = live > 0.5 ? A : A + '77'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.save();
      ctx.globalAlpha *= 0.3 + 0.35 * wave(1.6, y * 0.01);
      ctx.beginPath(); ctx.roundRect(x + 16, y + 16, w - 32, h - 32, 10);
      ctx.strokeStyle = A; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha *= 0.5 + 0.3 * wave(2.1, y * 0.02);
      api.dot(x + w / 2, y + h / 2, 7, A);
      ctx.restore();
    }
    modelBox(104, 128, 184, 92, send1);
    modelBox(104, 338, 184, 92, send2);

    function refusal(x, y, w, text, show) {
      if (show <= 0.02) return;
      ctx.save();
      ctx.globalAlpha *= show;
      var s = 0.82 + 0.18 * show;
      ctx.translate(x + w / 2, y + 25); ctx.scale(s, s); ctx.translate(-(x + w / 2), -(y + 25));
      ctx.save();
      ctx.globalAlpha *= 0.24 + 0.16 * wave(2.8, y * 0.01);
      api.glow(x + w / 2, y + 25, 120, P.red);
      ctx.restore();
      api.box(x, y, w, 50, C.ink, P.red, 3);
      api.line(x + 16, y + 17, x + 32, y + 33, P.red, 3);
      api.line(x + 32, y + 17, x + 16, y + 33, P.red, 3);
      api.mono(text, x + 44, y + 34, 20, P.red, 'left', w - 56);
      ctx.restore();
    }

    /* -- the payload block -- */
    ctx.save();
    ctx.globalAlpha *= 0.2 + 0.12 * wave(1.3);
    api.glow(BX + BW / 2, BY + BH / 2, 190, dec > 0.5 ? A : M);
    ctx.restore();
    api.mono(api.text || 'ENCODED PAYLOAD', BX + BW / 2, BY - 18, 21, dec > 0.5 ? A : M, 'center', BW + 14);
    panel(BX, BY, BW, BH, dec > 0.5 ? 'cc' : '66');
    api.line(BX, BY + 34, BX + BW, BY + 34, A + '30', 1.5);
    for (var q = 0; q < 3; q++) api.box(BX + 16 + q * 16, BY + 14, 7, 7, A + (q === 0 ? 'cc' : '44'), null, 1);

    var POOL = 'abcdefghijklmnopqrstuvwxyz';
    for (var r = 0; r < 3; r++) {
      var y = ROWY[r], reveal = ROWX + RWD * clamp((dec - r * 0.12) / 0.7, 0, 1);
      ctx.save();                                     /* still-encoded part: shimmering blocks */
      ctx.beginPath(); ctx.rect(reveal, y - 20, ROWX + RWD - reveal + 2, 26); ctx.clip();
      var cx = ROWX;
      for (var j = 0; j < 24 && cx < ROWX + RWD; j++) {
        var bw = 9 + Math.floor(api.rnd(r + 1, j) * 3) * 8;
        if (cx + bw > ROWX + RWD) break;
        ctx.save();
        ctx.globalAlpha *= 0.34 + 0.42 * wave(3.2, j * 1.1 + r * 2.3);
        ctx.fillStyle = M; ctx.fillRect(cx, y - 15, bw, 15);
        ctx.restore();
        cx += bw + 6;
      }
      ctx.restore();
      if (dec > 0.01) {                               /* decoded part: legible monospace */
        var s = '';
        for (var ci2 = 0; ci2 < 17; ci2++) {
          s += (ci2 % 6 === 5) ? ' ' : POOL.charAt(Math.floor(api.rnd(r + 1, ci2, 3) * 26));
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(ROWX - 2, y - 22, reveal - ROWX + 2, 28); ctx.clip();
        api.mono(s, ROWX, y, 18, A, 'left', RWD + 4);
        ctx.restore();
      }
      if (reveal > ROWX && reveal < ROWX + RWD) api.line(reveal, y - 18, reveal, y + 4, A, 2);
    }
    if (dec >= 1) {                                   /* the decoded block keeps breathing */
      ctx.save();
      var scan = BY + 40 + ((t * 0.26) % 1) * (BH - 54);
      var sg = ctx.createLinearGradient(0, scan - 22, 0, scan + 22);
      sg.addColorStop(0, A + '00'); sg.addColorStop(0.5, A + '18'); sg.addColorStop(1, A + '00');
      ctx.fillStyle = sg; ctx.fillRect(BX + 2, scan - 22, BW - 4, 44);
      ctx.restore();
    }

    /* -- the payload is shown to each model in turn -- */
    function carry(path, frac, color) {
      if (frac <= 0 || frac >= 1) return;
      var seg = [], total = 0, i;
      for (i = 0; i < path.length - 1; i++) {
        var d = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
        seg.push(d); total += d;
      }
      var want = total * frac, acc = 0, px = path[0][0], py = path[0][1];
      for (i = 0; i < seg.length; i++) {
        if (acc + seg[i] >= want) {
          var q = seg[i] ? (want - acc) / seg[i] : 0;
          px = path[i][0] + (path[i + 1][0] - path[i][0]) * q;
          py = path[i][1] + (path[i + 1][1] - path[i][1]) * q;
          break;
        }
        acc += seg[i];
      }
      api.box(px - 17, py - 12, 34, 24, C.ink, color, 2);
      for (var b = 0; b < 3; b++) api.line(px - 11, py - 5 + b * 5, px + 5 + b * 2, py - 5 + b * 5, color + 'aa', 2);
      api.glow(px, py, 34, color);
    }
    api.drawPath(p1, send1, A + (no1 > 0.5 ? '44' : 'aa'), 2.5);
    api.drawPath(p2, send2, A + (no2 > 0.5 ? '44' : 'aa'), 2.5);
    api.drawPath(p3, send3, A + 'aa', 2.5);
    if (send1 >= 1 && no1 < 0.5) api.packets(p1, A, 2, 0.5, 4, 0);
    if (send2 >= 1 && no2 < 0.5) api.packets(p2, A, 2, 0.5, 4, 0.3);
    if (send3 >= 1) api.packets(p3, A, 3, 0.45, 4.5, 0.15);
    carry(p1, send1, A); carry(p2, send2, A); carry(p3, send3, A);
    refusal(104, 232, 206, LB[0], no1);
    refusal(104, 442, 206, LB[1], no2);

    dateStamp(104, 74, 'left', 300);

    /* -- the open-weight model: a cube whose lid is already open -- */
    var open = ease(clamp((u - 0.35) / 0.7, 0, 1));
    var lift = (26 + 5 * wave(0.9)) * open + 22 * yes, cx3 = 738;
    var FL = 648, FR = 792, FT = 306, FB = 396, BL = 684, BR = 828, BT = 280;
    ctx.save();
    ctx.globalAlpha *= 0.16 + 0.14 * wave(1.5, 2.1) + 0.28 * yes;
    api.glow(cx3, 340, 178, A);
    ctx.restore();
    ctx.beginPath();                                   /* opening */
    ctx.moveTo(FL, FT); ctx.lineTo(BL, BT); ctx.lineTo(BR, BT); ctx.lineTo(FR, FT); ctx.closePath();
    ctx.fillStyle = C.ink; ctx.fill();
    ctx.strokeStyle = A + '88'; ctx.lineWidth = 2; ctx.stroke();
    ctx.save();                                        /* the inside keeps glowing */
    ctx.globalAlpha *= (0.25 + 0.2 * wave(2.2, 0.4)) * open;
    api.glow((FL + BR) / 2, FT - 12, 74, A);
    ctx.restore();
    ctx.beginPath();                                   /* right face */
    ctx.moveTo(FR, FT); ctx.lineTo(BR, BT); ctx.lineTo(BR, BT + (FB - FT)); ctx.lineTo(FR, FB); ctx.closePath();
    ctx.fillStyle = C.deep; ctx.fill();
    ctx.strokeStyle = A; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath();                                   /* front face */
    ctx.moveTo(FL, FT); ctx.lineTo(FR, FT); ctx.lineTo(FR, FB); ctx.lineTo(FL, FB); ctx.closePath();
    ctx.fillStyle = C.deep; ctx.fill();
    ctx.strokeStyle = A; ctx.lineWidth = 3; ctx.stroke();
    ctx.save();                                        /* the lid, hinged open at the back */
    ctx.beginPath();
    ctx.moveTo(FL, FT - lift); ctx.lineTo(BL, BT - lift * 0.35);
    ctx.lineTo(BR, BT - lift * 0.35); ctx.lineTo(FR, FT - lift);
    ctx.closePath();
    ctx.fillStyle = C.ink; ctx.fill();
    ctx.strokeStyle = A; ctx.lineWidth = 2.5; ctx.stroke();
    api.line(FL, FT - lift, FL, FT - lift + 7, A + '77', 2);
    api.line(FR, FT - lift, FR, FT - lift + 7, A + '77', 2);
    api.line(BL, BT - lift * 0.35, BL, BT, A + '55', 1.5);
    api.line(BR, BT - lift * 0.35, BR, BT, A + '55', 1.5);
    ctx.restore();
    var drop = clamp((u - 3.95) / 0.55, 0, 1);          /* the payload goes in */
    if (drop > 0.01 && drop < 1) {
      var dz = ease(drop), dpx = 644 + (cx3 - 644) * dz;
      var dpy = 354 + (FT - 24 - 354) * dz - Math.sin(dz * Math.PI) * 26, ds = 1 - 0.45 * dz;
      ctx.save();
      ctx.globalAlpha *= 1 - 0.3 * dz;
      ctx.translate(dpx, dpy); ctx.scale(ds, ds); ctx.translate(-dpx, -dpy);
      api.box(dpx - 17, dpy - 12, 34, 24, C.ink, A, 2);
      for (var b2 = 0; b2 < 3; b2++) api.line(dpx - 11, dpy - 5 + b2 * 5, dpx + 5 + b2 * 2, dpy - 5 + b2 * 5, A + 'aa', 2);
      api.glow(dpx, dpy, 36, A);
      ctx.restore();
    }
    if (yes > 0.02) {                                  /* accepted */
      ctx.save();
      ctx.globalAlpha *= yes;
      api.drawPath([[678, 350], [704, 374], [764, 320]], ease(clamp((u - 4.5) / 0.5, 0, 1)), A, 7);
      ctx.restore();
    }
    if (dec > 0.01 && dec < 1) api.packets([p3[3], p3[2], p3[1], p3[0]], A, 3, 0.55, 5, 0);
    api.mono(LB[2], cx3, 458, 24, yes > 0.5 ? C.white : M, 'center', 280);
  }

  if (stage < 0.3) stageA();
  else if (stage < 0.78) stageB();
  else stageC();
};
