/* cluster-intrusion - inside the target: one endpoint, one model cluster, and how the agent walks deeper */
window.KEOU_MODES['cluster-intrusion'] = function (api) {
  const ctx = api.ctx, C = api.C, P = api.P, u = api.u, t = api.t;
  const E = api.ease, K = api.clamp, R = api.rnd;

  /* ---------- small helpers ---------- */
  const A = (c, a) => c + Math.round(K(a, 0, 1) * 255).toString(16).padStart(2, '0');
  const LB = (i, d) => (api.labels && api.labels[i]) ? String(api.labels[i]) : d;
  const TXT = api.text || '';
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  const fillRR = (x, y, w, h, r, col) => { rr(x, y, w, h, r); ctx.fillStyle = col; ctx.fill(); };
  const strokeRR = (x, y, w, h, r, col, lw) => { rr(x, y, w, h, r); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); };
  const dashRR = (x, y, w, h, r, col, lw, off) => {
    ctx.save(); ctx.setLineDash([10, 8]); ctx.lineDashOffset = -off; strokeRR(x, y, w, h, r, col, lw); ctx.restore();
  };
  const mw = (s, size) => {
    const f = ctx.font; ctx.font = '600 ' + size + 'px KeouMono';
    const w = ctx.measureText(s).width; ctx.font = f;
    return Math.max(w, s.length * size * 0.6);
  };
  /* centred sans label that can never leave the safe box */
  const ctext = (s, cx, y, size, col) => {
    const w = mw(s, size); api.label(s, K(cx - w / 2, 14, 856 - w), y, size, col || C.white, 'left');
  };
  const arrow = (x, y, dir, col, s) => {           // dir: 1 right, -1 left, 2 down, -2 up
    ctx.save(); ctx.translate(x, y);
    ctx.rotate(dir === 1 ? 0 : dir === -1 ? Math.PI : dir === 2 ? Math.PI / 2 : -Math.PI / 2);
    ctx.beginPath(); ctx.moveTo(-s, -s * .62); ctx.lineTo(0, 0); ctx.lineTo(-s, s * .62);
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineCap = 'butt'; ctx.restore();
  };
  const keyGlyph = (x, y, s, col, rot, lw) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot || 0); ctx.scale(s, s);
    ctx.strokeStyle = col; ctx.lineWidth = (lw || 3) / s; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(-13, 0, 8.5, 0, 6.2832); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-4.5, 0); ctx.lineTo(19, 0);
    ctx.moveTo(11, 0); ctx.lineTo(11, 8); ctx.moveTo(18, 0); ctx.lineTo(18, 6.5); ctx.stroke();
    ctx.restore();
  };
  const brace = (x, y, h, dir, col, lw) => {       // curly brace, dir 1 = "{"
    ctx.save(); ctx.translate(x, y); ctx.scale(dir, 1);
    ctx.beginPath();
    ctx.moveTo(9, -h); ctx.quadraticCurveTo(0, -h, 0, -h * .55);
    ctx.quadraticCurveTo(0, -2, -8, 0); ctx.quadraticCurveTo(0, 2, 0, h * .55);
    ctx.quadraticCurveTo(0, h, 9, h);
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();
    ctx.lineCap = 'butt'; ctx.restore();
  };
  /* a counter with its caption, only once it starts racing */
  const stat = (v, x, y, cap, delay, span) => {
    if (v == null || u < delay - .25) return;
    api.counter(v, x, y, 54, C.accent, delay, span, 'center');
    ctext(cap, x, y + 34, 19, C.muted);
  };
  /* one abstract KEY=VALUE row: two bars and an equals sign, no invented strings */
  const kvRow = (x, y, seed, maxW, a, col) => {
    const kw = 34 + R(seed, 11) * 52, vw = Math.min(maxW - kw - 26, 74 + R(seed, 23) * 300);
    ctx.fillStyle = A(col, a * .85); ctx.fillRect(x, y - 9, kw, 10);
    ctx.fillStyle = A(col, a * .9); ctx.fillRect(x + kw + 6, y - 6, 9, 3);
    ctx.fillStyle = A(col, a * .38); ctx.fillRect(x + kw + 21, y - 9, Math.max(24, vw), 10);
  };

  /* ---------- shared backdrop: always alive ---------- */
  ctx.save(); ctx.globalAlpha *= .5;
  for (let i = 0; i < 7; i++) {
    const y = 40 + i * 88 + Math.sin(t * .28 + i) * 5;
    api.line(0, y, 880, y, A(C.accent, .05), 1);
  }
  const sweepY = ((t * 52) % 760) - 60;
  api.line(0, sweepY, 880, sweepY, A(C.accent, .09), 2);
  ctx.restore();

  const band = api.stage < .15 ? 0 : api.stage < .35 ? 1 : api.stage < .6 ? 2
    : api.stage < .78 ? 3 : api.stage < .93 ? 4 : 5;

  /* ---------- the model-repository cluster: a blob of pods ---------- */
  const clusterBlob = (cx, cy, rx, ry) => {
    ctx.save(); ctx.setLineDash([7, 9]); ctx.lineDashOffset = -t * 10;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 6.2832);
    ctx.strokeStyle = A(P.cyan, .25); ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    const cw = 30, ch = 20, gx = 11, gy = 10;
    const cols = Math.max(1, Math.floor((rx * 2 - 20) / (cw + gx))), rows = Math.max(1, Math.floor((ry * 2 - 20) / (ch + gy)));
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = cx - (cols * (cw + gx) - gx) / 2 + i * (cw + gx);
      const y = cy - (rows * (ch + gy) - gy) / 2 + j * (ch + gy);
      const dx = (x + cw / 2 - cx) / (rx - 14), dy = (y + ch / 2 - cy) / (ry - 12);
      if (dx * dx + dy * dy > 1) continue;
      const a = .10 + .26 * (.5 + .5 * Math.sin(t * 1.7 + R(i, j) * 6.2832));
      fillRR(x, y, cw, ch, 3, A(P.cyan, a));
      strokeRR(x, y, cw, ch, 3, A(P.cyan, .34), 1);
    }
  };

  /* =========================================================================
     BAND 0 - the link pulses, a terminal opens over the cluster and types itself
     ========================================================================= */
  if (band === 0) {
    clusterBlob(596, 224, 240, 166);
    ctext(LB(2, 'MODEL REPOSITORY'), 596, 40, 21, C.white);

    /* endpoint: a plain monitor outline, never a person */
    const sx = 50, sy = 146, sww = 132, sh = 96;
    api.box(sx, sy, sww, sh, A(C.deep, .92), A(C.accent, .55), 3);
    api.line(sx + sww / 2, sy + sh, sx + sww / 2, sy + sh + 22, A(C.accent, .5), 3);
    api.line(sx + sww / 2 - 30, sy + sh + 22, sx + sww / 2 + 30, sy + sh + 22, A(C.accent, .5), 3);
    for (let i = 0; i < 3; i++) {
      const w = 34 + R(i, 3) * 58, a = .2 + .5 * (.5 + .5 * Math.sin(t * 2.1 + i * 1.9));
      ctx.fillStyle = A(C.accent, a * .55); ctx.fillRect(sx + 16, sy + 24 + i * 22, w, 9);
    }
    ctext(LB(0, 'ENDPOINT'), 116, 290, 21, C.white);

    /* the link, drawn on, pulsed once, then permanently trafficked */
    const link = [[184, 194], [344, 194]];
    api.drawPath(link, E(u / .8), A(C.accent, .55), 2.5);
    const pulse = E(K((u - .55) / 1.1));
    if (pulse > 0 && pulse < 1) { api.glow(184 + 160 * pulse, 194, 34, C.accent); api.dot(184 + 160 * pulse, 194, 7, C.accent); }
    if (u > 1.2) api.packets(link, C.accent, 3, .34, 5, 0);
    arrow(346, 194, 1, A(C.accent, .8), 11);
    ctext(LB(1, 'LINK'), 264, 166, 20, C.white);

    /* the terminal window opens over the cluster - nobody is at the keyboard */
    const wx = 240, wy = 296, ww = 594, wh = 288, open = E(K(u / .55));
    ctx.save(); ctx.translate(wx + ww / 2, wy); ctx.scale(1, open); ctx.translate(-(wx + ww / 2), -wy);
    api.box(wx, wy, ww, wh, A(C.ink, .97), A(C.accent, .5), 3);
    api.box(wx, wy, ww, 34, A(C.deep, .95), null, 3);
    api.line(wx, wy + 34, wx + ww, wy + 34, A(C.accent, .35), 1.5);
    for (let i = 0; i < 3; i++) api.dot(wx + ww - 24 - i * 22, wy + 17, 5, A(C.accent, i ? .3 : .85));
    const cmd = api.typed(TXT || '$ id', 13, .7);
    const cw2 = api.mono(cmd, wx + 22, wy + 70, 26, C.accent, 'left', 520);
    if (api.cursorOn() && open > .9) { ctx.fillStyle = C.accent; ctx.fillRect(wx + 26 + cw2, wy + 50, 13, 24); }

    /* env output floods below as KEY=VALUE pairs scrolling up */
    const start = .7 + (TXT || '$ id').length / 13 + .18;
    const fx = wx + 22, fy = wy + 88, fw = ww - 44, fh = wh - 100;
    ctx.save(); rr(fx, fy, fw, fh, 2); ctx.clip();
    const rowH = 24, off = Math.max(0, u - start) * 88, em = Math.floor(off / rowH), fr = off - em * rowH;
    if (u > start) for (let k = em; k > em - 10; k--) {
      if (k < 0) continue;
      const yy = fy + fh - 6 - (em - k) * rowH - fr;
      kvRow(fx, yy, k, fw, K((yy - fy) / 40) * .95, C.accent);
    }
    ctx.restore();
    ctx.restore();
  }

  /* =========================================================================
     BAND 1 - a public key picked up, a dataset with a red config, onto the belt
     ========================================================================= */
  else if (band === 1) {
    /* the key lying in the open, then lifted by the agent */
    const grab = K((u - 1.5) / .9), ay = 96 + (150 - 96) * E(K((u - .5) / 1.1));
    api.line(40, 216, 260, 216, A(C.accent, .3), 2);
    const ky = 202 + (ay - 202) * E(grab);
    ctx.save(); ctx.globalAlpha *= 1 - K((u - 2.6) / .7) * .75;
    keyGlyph(112, ky, 1.35, C.accent, -.35 + .35 * E(grab), 3);
    ctx.restore();
    api.box(150, 186, 96, 32, A(C.deep, .9), A(C.muted, .55), 3);   // the tag left in the open
    api.mono('PUBLIC', 198, 209, 19, C.muted, 'center', 84);
    api.agent(112, ay, 34, C.accent, 1.2, 3);
    ctext(LB(0, 'PUBLIC KEY'), 130, 286, 21, C.white);

    /* the dataset: a stack of table rows, with a red config panel under it */
    const dx = 336, dy = 76;
    ctext(LB(1, 'DATASET CONFIG'), 461, 62, 21, C.white);
    api.box(dx, dy, 250, 150, A(C.deep, .9), A(C.accent, .5), 3);
    for (let i = 0; i < 5; i++) {
      const f = E(K((u - .3 - i * .16) / .6));
      ctx.fillStyle = A(C.accent, .18 + .2 * (.5 + .5 * Math.sin(t * 1.5 + i)));
      ctx.fillRect(dx + 14, dy + 16 + i * 26, (250 - 28) * f, 17);
      api.line(dx + 14, dy + 37 + i * 26, dx + 236, dy + 37 + i * 26, A(C.accent, .22 * f), 1);
    }
    const rp1 = .5 + .5 * Math.sin(t * 3.4);
    api.box(dx, dy + 168, 250, 78, A(P.red, .07 + .05 * rp1), A(P.red, .45 + .45 * rp1), 3);
    for (let i = 0; i < 2; i++) { ctx.fillStyle = A(P.red, .3 + .25 * rp1); ctx.fillRect(dx + 16, dy + 190 + i * 26, 90 + i * 84, 11); }

    /* upload bar, then the conveyor into an ordinary worker */
    const up = E(K((u - 1.9) / 1.9));
    api.drawPath([[461, 324], [461, 342], [180, 342], [180, 356]], E(K((u - 1.6) / .7)), A(C.accent, .45), 2);
    api.box(140, 356, 520, 20, A(C.deep, .9), A(C.accent, .35), 3);
    ctx.fillStyle = A(C.accent, .75); ctx.fillRect(142, 358, 516 * up, 16);
    api.packets([[142, 366], [658, 366]], C.accent, 3, .5, 4, 0);

    api.line(60, 520, 706, 520, A(C.accent, .35), 2);
    for (let i = 0; i < 16; i++) { const x = 60 + ((i * 42 + t * 46) % 646); api.line(x, 520, x, 532, A(C.accent, .25), 2); }
    for (let i = 0; i < 5; i++) {
      const f = ((t * .13 + i / 5) % 1), x = 60 + f * 660, bad = i === 2;
      const col = bad && u > 1.4 ? P.red : C.accent;
      ctx.save(); ctx.globalAlpha *= K((690 - x) / 46, 0, 1);
      api.box(x, 466, 58, 46, A(C.deep, .95), A(col, .8), 3);
      for (let j = 0; j < 3; j++) { ctx.fillStyle = A(col, .45); ctx.fillRect(x + 8, 476 + j * 12, 42 - j * 9, 6); }
      ctx.restore();
    }
    api.box(712, 440, 140, 116, A(P.cyan, .07), A(P.cyan, .6), 3);
    for (let i = 0; i < 6; i++) fillRR(724 + (i % 3) * 42, 458 + Math.floor(i / 3) * 34, 34, 24, 3,
      A(P.cyan, .18 + .3 * (.5 + .5 * Math.sin(t * 2 + i))));
    ctext(LB(2, 'WORKER QUEUE'), 782, 578, 21, C.white);
  }

  /* =========================================================================
     BAND 2 - the config path flips back into the worker; secrets stream out
     ========================================================================= */
  else if (band === 2) {
    const flip = K((u - 1.7) / .55);

    /* the dataset: a stack of table rows */
    ctext(LB(0, 'DATASET'), 170, 62, 21, C.white);
    api.box(40, 76, 260, 114, A(C.deep, .9), A(C.accent, .5), 3);
    api.line(40, 106, 300, 106, A(C.accent, .45), 1.5);
    api.line(170, 76, 170, 190, A(C.accent, .16), 1);
    for (let i = 0; i < 4; i++) {
      const f = E(K((u - i * .12) / .7)), a = .16 + .2 * (.5 + .5 * Math.sin(t * 1.6 + i * .9));
      ctx.fillStyle = A(C.accent, i ? a : a + .3); ctx.fillRect(54, 85 + i * 26, (i ? 96 : 78) * f, 13);
      ctx.fillStyle = A(C.accent, i ? a * .8 : a + .3); ctx.fillRect(184, 85 + i * 26, (i ? 92 : 68) * f, 13);
    }

    /* config panel: the path field flips from a remote URL to a local path */
    const rp2 = .5 + .5 * Math.sin(t * 3.2);
    api.box(40, 220, 260, 118, A(P.red, .07 + .05 * rp2), A(P.red, .45 + .5 * rp2), 3);
    api.mono('path', 56, 256, 18, A(P.red, .9), 'left', 90);
    api.box(56, 268, 228, 46, A(C.ink, .82), A(P.red, .5), 3);
    ctx.save(); ctx.translate(170, 291); ctx.scale(1, Math.abs(Math.cos(flip * Math.PI)) * .88 + .12);
    if (flip < .5) {                                   // a remote target
      ctx.beginPath(); ctx.arc(-84, 0, 11, 0, 6.2832); ctx.strokeStyle = A(P.cyan, .85); ctx.lineWidth = 2; ctx.stroke();
      api.line(-95, 0, -73, 0, A(P.cyan, .85), 2); api.line(-84, -11, -84, 11, A(P.cyan, .5), 2);
      ctx.fillStyle = A(P.cyan, .45); ctx.fillRect(-64, -6, 148, 12);
    } else {                                           // the worker's own filesystem
      ctx.beginPath(); ctx.moveTo(-94, 9); ctx.lineTo(-76, -9); ctx.strokeStyle = A(P.red, .95); ctx.lineWidth = 3.5; ctx.stroke();
      ctx.fillStyle = A(P.red, .6); ctx.fillRect(-64, -6, 96, 12);
      ctx.fillStyle = A(P.red, .32); ctx.fillRect(38, -6, 46, 12);
    }
    ctx.restore();
    if (TXT) api.mono(TXT, 190, 382, 19, C.white, 'center', 300);

    /* the arrow bends back into the worker itself */
    const bend = [[300, 291], [356, 291], [356, 452], [560, 452], [560, 406]];
    api.drawPath(bend, E(K((u - 2.1) / 1.1)), A(P.red, .8), 3);
    if (u > 3.1) { api.packets(bend, P.red, 3, .3, 5, 0); arrow(560, 404, -2, P.red, 11); }

    /* the worker turns transparent; its KEY=VALUE pairs light up one by one */
    const clear = E(K((u - 2.6) / 1.1));
    ctext(LB(1, 'WORKER'), 570, 62, 21, C.white);
    fillRR(440, 76, 260, 326, 3, A(P.cyan, .12 * (1 - clear) + .03));
    dashRR(440, 76, 260, 326, 3, A(P.cyan, .35 + .35 * clear), 2, t * 14);
    for (let i = 0; i < 8; i++) {
      const lit = K((u - 3.1 - i * .2) / .3);
      kvRow(458, 118 + i * 34, i + 5, 226, .18 + .8 * lit, lit > .5 ? C.accent : P.cyan);
      if (lit > .5) { ctx.save(); ctx.globalAlpha *= .45; api.glow(468, 113 + i * 34, 26, C.accent); ctx.restore(); }
    }

    /* the secrets leave for the agent */
    const out = [[700, 240], [756, 240]];
    if (u > 3.3) { api.drawPath(out, E((u - 3.3) / .5), A(P.red, .7), 2.5); api.packets(out, P.red, 3, .55, 5, 0); }
    api.agent(792, 240, 36, C.accent, .6, 3);
    ctext(LB(2, 'SECRETS'), 792, 160, 21, C.white);

    stat(api.count, 570, 520, 'RECON ACTIONS', 2.6, 1.9);
  }

  /* =========================================================================
     BAND 3 - a template's braces become a live python prompt in a production pod
     ========================================================================= */
  else if (band === 3) {
    /* a wall of commands, dim, scrolling behind everything */
    ctx.save(); rr(40, 400, 800, 176, 3); ctx.clip();
    for (let k = 0; k < 26; k++) {
      const y2 = 576 - (k * 22 + (t * 34) % 22);
      ctx.fillStyle = A(C.accent, .09); ctx.fillRect(52 + R(k, 5) * 30, y2, 120 + R(k, 9) * 300, 8);
      ctx.fillStyle = A(C.accent, .07); ctx.fillRect(500 + R(k, 15) * 60, y2, 90 + R(k, 21) * 220, 8);
    }
    ctx.restore();

    /* the "2" badge */
    api.hex(72, 76, 30, A(C.accent, .8), 2.5, .12 + .1 * (.5 + .5 * Math.sin(t * 2.4)));
    api.mono('2', 72, 87, 28, C.accent, 'center', 60);

    /* the template file, its braces opening */
    const spread = E(K((u - 1.1) / 1.2)) * 40;
    api.box(140, 150, 178, 200, A(C.deep, .9), A(C.accent, .5), 3);
    ctx.beginPath(); ctx.moveTo(288, 150); ctx.lineTo(318, 180); ctx.lineTo(288, 180); ctx.closePath();
    ctx.fillStyle = A(C.accent, .3); ctx.fill();
    for (let i = 0; i < 3; i++) { ctx.fillStyle = A(C.accent, .22); ctx.fillRect(158, 196 + i * 22, 100 - i * 22, 8); }
    brace(216 - spread, 288, 30, 1, C.accent, 4);
    brace(242 + spread, 288, 30, -1, C.accent, 4);
    ctext(LB(0, 'TEMPLATE'), 229, 388, 21, C.white);

    const flow = [[326, 288], [418, 288]];
    api.drawPath(flow, E(K((u - 1.6) / .6)), A(C.accent, .6), 2.5);
    if (u > 2) { api.packets(flow, C.accent, 2, .55, 5, 0); arrow(420, 288, 1, A(C.accent, .8), 11); }

    /* the production pod goes green and pulses */
    const live = K((u - 2.5) / .8), pp = .5 + .5 * Math.sin(t * 3);
    const col = live > .5 ? C.accent : P.cyan;
    fillRR(438, 152, 372, 214, 3, A(col, .05 + .07 * live * pp));
    strokeRR(438, 152, 372, 214, 3, A(col, .4 + .5 * live * pp), 2 + live);
    if (live > .5) { ctx.save(); ctx.globalAlpha *= .3 + .25 * pp; api.glow(624, 259, 190, C.accent); ctx.restore(); }
    const pw = api.mono('>>>', 470, 276, 32, live > .5 ? C.accent : A(P.cyan, .7), 'left', 120);
    if (api.cursorOn() && live > .5) { ctx.fillStyle = C.accent; ctx.fillRect(474 + pw, 254, 15, 26); }
    ctx.fillStyle = A(C.accent, .25 * live); ctx.fillRect(470, 300, 120 + R(Math.floor(u * 2), 4) * 180, 10);
    ctext(LB(1, 'PRODUCTION POD'), 624, 396, 21, C.white);

    if (api.count != null) api.counter(api.count, 250, 502, 56, C.accent, .6, 1.9, 'center');
    if (api.total != null) api.counter(api.total, 630, 502, 56, C.accent, 1.1, 1.9, 'center');
    ctext(LB(2, 'COMMANDS RUN'), 440, 554, 21, C.white);
  }

  /* =========================================================================
     BAND 4 - a privileged pod steps onto the host, the safe opens, the mesh grows
     ========================================================================= */
  else if (band === 4) {
    /* cluster boundary with ordinary pods */
    dashRR(48, 40, 352, 140, 3, A(P.cyan, .45), 2, t * 12);
    for (let i = 0; i < 8; i++) {
      const x = 66 + (i % 4) * 84, y = 60 + Math.floor(i / 4) * 52;
      fillRR(x, y, 62, 38, 3, A(P.cyan, .1 + .18 * (.5 + .5 * Math.sin(t * 1.8 + i))));
      strokeRR(x, y, 62, 38, 3, A(P.cyan, .3), 1);
    }

    /* the host node underneath, wider than the boundary */
    api.box(48, 224, 470, 252, A(C.deep, .5), A(P.cyan, .55), 3);
    api.label(LB(1, 'NODE ROOT'), 64, 256, 21, C.white, 'left');

    /* the privileged pod slides sideways out of the boundary, then drops onto the host */
    const sl = E(K((u - .25) / 1.25)), dp = E(K((u - 1.5) / .8));
    const px = 168 + (452 - 168) * sl, py = 104 + (314 - 104) * dp;
    for (let g = 3; g > 0; g--) {
      const s2 = E(K((u - .25 - g * .1) / 1.25)), d2 = E(K((u - 1.5 - g * .07) / .8));
      ctx.save(); ctx.globalAlpha *= .1 * g / 3;
      strokeRR(168 + (452 - 168) * s2 - 46, 104 + (314 - 104) * d2 - 30, 92, 60, 3, C.accent, 2); ctx.restore();
    }
    const cross = 1 - K(Math.abs(px - 400) / 40);
    if (cross > 0) { ctx.save(); ctx.globalAlpha *= cross * .85; api.line(400, 42, 400, 178, P.red, 3); ctx.restore(); }
    if (dp > .85) { ctx.save(); ctx.globalAlpha *= .35 + .3 * (.5 + .5 * Math.sin(t * 3.2)); api.glow(px, py, 92, C.accent); ctx.restore(); }
    fillRR(px - 46, py - 30, 92, 60, 3, A(C.accent, .16));
    strokeRR(px - 46, py - 30, 92, 60, 3, A(C.accent, .85), 2.5);
    (function crown(x, y, w, cc) {
      ctx.beginPath(); ctx.moveTo(x - w, y + w * .55); ctx.lineTo(x - w, y - w * .5); ctx.lineTo(x - w * .5, y);
      ctx.lineTo(x, y - w * .75); ctx.lineTo(x + w * .5, y); ctx.lineTo(x + w, y - w * .5); ctx.lineTo(x + w, y + w * .55);
      ctx.closePath(); ctx.strokeStyle = cc; ctx.lineWidth = 2.5; ctx.stroke();
    })(px, py - 46 + Math.sin(t * 2.2) * 2, 15, C.accent);
    ctext(LB(0, 'PRIVILEGED POD'), K(px, 160, 460), py + 58, 21, C.white);

    /* the safe opens and the keys pour out */
    const sfx = 84, sfy = 320, sfw = 136, sfh = 132, open = E(K((u - 2.3) / .7));
    api.box(sfx, sfy, sfw, sfh, A(C.ink, .96), A(C.accent, .5), 3);
    fillRR(sfx + 9, sfy + 9, sfw - 18, sfh - 18, 2, A(C.deep, .95));
    for (let i = 0; i < 3; i++) keyGlyph(sfx + 52 + (i % 2) * 22, sfy + 40 + i * 26, .55, A(C.accent, .2 + .3 * open), .3, 3);
    ctx.save(); ctx.translate(sfx + 6, sfy + 6);
    ctx.transform(Math.max(.05, 1 - open * .95), 0, 0, 1, 0, 0);
    fillRR(0, 0, sfw - 12, sfh - 12, 2, A(C.deep, .98));
    strokeRR(0, 0, sfw - 12, sfh - 12, 2, A(C.accent, .85), 2.5);
    const dcx = (sfw - 12) * .56, dcy = (sfh - 12) / 2;
    ctx.beginPath(); ctx.arc(dcx, dcy, 24, 0, 6.2832); ctx.strokeStyle = A(C.accent, .8); ctx.lineWidth = 2.5; ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a2 = t * 1.15 + i * Math.PI / 2;
      api.line(dcx + Math.cos(a2) * 7, dcy + Math.sin(a2) * 7, dcx + Math.cos(a2) * 22, dcy + Math.sin(a2) * 22, A(C.accent, .55), 2);
    }
    api.dot(dcx, dcy, 5, C.accent);
    ctx.restore();
    for (let i = 0; i < 14; i++) {
      const f = K((u - 2.6 - i * .09) / 1.2);
      if (f <= 0) continue;
      const e = E(f), tx = 258 + R(i, 31) * 150, ty = 392 + R(i, 41) * 58;
      keyGlyph(224 + (tx - 224) * e, 386 - Math.sin(e * 3.14) * 56 + (ty - 386) * e, .72, A(C.accent, .35 + .5 * f), (1 - e) * 2.2, 3);
    }
    stat(api.count, 300, 528, 'KEYS', 2.6, 1.9);

    /* one key rises amber and joins the mesh; grey nodes attach one by one */
    const mx = 694, my = 300, inner = [], outer = [];
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 3;
      inner.push([mx + Math.cos(a) * 74, my + Math.sin(a) * 74]);
      const b = a + Math.PI / 6;
      outer.push([mx + Math.cos(b) * 132, my + Math.sin(b) * 132]);
    }
    for (let i = 0; i < 6; i++) {
      api.line(inner[i][0], inner[i][1], inner[(i + 1) % 6][0], inner[(i + 1) % 6][1], A(C.accent, .32), 1.5);
      api.line(outer[i][0], outer[i][1], outer[(i + 1) % 6][0], outer[(i + 1) % 6][1], A(C.accent, .16), 1.5);
      api.line(inner[i][0], inner[i][1], outer[i][0], outer[i][1], A(C.accent, .26), 1.5);
      api.line(inner[(i + 1) % 6][0], inner[(i + 1) % 6][1], outer[i][0], outer[i][1], A(C.accent, .26), 1.5);
    }
    inner.concat(outer).forEach((p, i) => {
      const g = .5 + .5 * Math.sin(t * 2 + i * .8);
      api.dot(p[0], p[1], 6 + g * 2, A(C.accent, .45 + .4 * g));
    });
    api.packets([inner[0], inner[2], inner[4], inner[0]], C.accent, 3, .22, 4, 0);
    ctext(LB(2, 'VPN KEY'), mx, 118, 21, C.white);
    const rise = E(K((u - 4.4) / 1.2));
    if (u > 4.4) {
      const kx2 = 320 + (mx - 320) * rise, ky2 = 420 + (my - 420) * rise - Math.sin(rise * 3.14) * 74;
      ctx.save(); ctx.globalAlpha *= .45 + .45 * (.5 + .5 * Math.sin(t * 4)); api.glow(kx2, ky2, 56, P.amber); ctx.restore();
      keyGlyph(kx2, ky2, 1.3, P.amber, -.4 + .4 * rise, 3.5);
    }
    for (let i = 0; i < 14; i++) {                     // each grey node clips onto its nearest mesh node
      const f = K((u - 5.6 - i * .1) / .4);
      if (f <= 0) continue;
      const a = -Math.PI / 2 + (i + .5) * Math.PI / 7 * 2 + (R(i, 7) - .5) * .16;
      const ex = mx + Math.cos(a) * 164, ey = my + Math.sin(a) * 152;
      const tg = outer[(((Math.round((a + Math.PI / 2 - Math.PI / 6) / (Math.PI / 3))) % 6) + 6) % 6];
      api.drawPath([[ex, ey], [tg[0], tg[1]]], E(f), A(C.muted, .45), 1.5);
      api.dot(ex, ey, 6, P.dim);
      ctx.beginPath(); ctx.arc(ex, ey, 6, 0, 6.2832);
      ctx.strokeStyle = A(C.muted, .35 + .45 * f); ctx.lineWidth = 1.5; ctx.stroke();
    }
    stat(api.total, mx, 528, 'NODES', 5.6, 2.2);
  }

  /* =========================================================================
     BAND 5 - a token mints itself, a pull request reaches the pipeline, blocked
     ========================================================================= */
  else {
    /* the token badge stamps itself into existence - a card, so it is never read as an agent */
    const mint = E(K((u - .3) / .9)), bx = 62, by = 168, bw = 300, bh = 158;
    ctx.save(); ctx.globalAlpha *= mint;
    ctx.save(); ctx.globalAlpha *= .3 + .25 * (.5 + .5 * Math.sin(t * 2.2)); api.glow(bx + bw / 2, by + bh / 2, 150, C.accent); ctx.restore();
    fillRR(bx, by + (1 - mint) * 18, bw, bh, 3, A(C.deep, .95));
    strokeRR(bx, by + (1 - mint) * 18, bw, bh, 3, A(C.accent, .85), 2.5);
    ctx.restore();
    api.line(bx, by + 40, bx + bw, by + 40, A(C.accent, .4), 1.5);
    ctx.beginPath(); ctx.arc(bx + bw / 2, by + 20, 9, 0, 6.2832);
    ctx.strokeStyle = A(C.accent, .55); ctx.lineWidth = 2; ctx.stroke();
    const stamp = K((u - 1.2) / .45);
    ctx.save(); ctx.globalAlpha *= 1 - E(stamp);       // the minting ring retires once the stamp lands
    ctx.beginPath(); ctx.arc(bx + bw / 2, by + 96, 40, t * 1.4, t * 1.4 + 4.5);
    ctx.strokeStyle = A(C.accent, .5); ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
    if (stamp > 0) {                                   // the stamp lands: size, never a transform
      ctx.save(); ctx.globalAlpha *= E(stamp);
      ctx.fillStyle = A(C.accent, .1 * E(stamp)); ctx.fillRect(bx + 8, by + 74, bw - 16, 44);
      api.mono('contents:write', bx + bw / 2, by + 106, Math.round(24 * (1.5 - .5 * E(stamp))), C.accent, 'center', bw - 24);
      ctx.restore();
    }
    for (let i = 0; i < 2; i++) { ctx.fillStyle = A(C.accent, (i ? .12 : .22) * E(stamp)); ctx.fillRect(bx + 22, by + 128 + i * 14, 176 - i * 62, 8); }
    ctext(LB(0, 'MINTED TOKEN'), bx + bw / 2, 364, 21, C.white);

    /* the CI pipeline */
    ctext(LB(1, 'CI PIPELINE'), 629, 130, 21, C.white);
    for (let i = 0; i < 3; i++) {
      const x = 452 + i * 128;
      api.box(x, 152, 110, 92, A(P.cyan, .08), A(P.cyan, .5 + .3 * (.5 + .5 * Math.sin(t * 2 - i))), 3);
      for (let j = 0; j < 2; j++) { ctx.fillStyle = A(P.cyan, .35); ctx.fillRect(x + 15, 176 + j * 24, 80 - j * 32, 9); }
      if (i < 2) api.line(x + 110, 198, x + 128, 198, A(P.cyan, .5), 2);
    }
    api.packets([[452, 198], [790, 198]], P.cyan, 3, .35, 5, 0);

    /* the pull request slides along and turns up into the pipeline */
    const slide = E(K((u - 1.3) / 1.3)), prx = 330 + (600 - 330) * slide;
    ctx.save(); ctx.globalAlpha *= K(u - 1.1, 0, 1);
    api.dot(prx - 34, 430, 9, C.accent); api.dot(prx + 18, 388, 9, C.accent);
    ctx.beginPath(); ctx.moveTo(prx - 34, 430); ctx.quadraticCurveTo(prx + 18, 430, prx + 18, 388);
    ctx.strokeStyle = A(C.accent, .85); ctx.lineWidth = 3.5; ctx.stroke();
    api.line(prx - 34, 430, prx - 34, 400, A(C.accent, .55), 3.5);
    ctx.restore();
    api.drawPath([[618, 378], [618, 300], [629, 300], [629, 246]], E(K((u - 2.6) / .7)), A(C.accent, .55), 2.5);

    /* a quick red X stamps over it */
    const bl = K((u - 3.3) / .3);
    if (bl > 0) {
      ctx.save(); ctx.globalAlpha *= .18 + .12 * (.5 + .5 * Math.sin(t * 5)); api.glow(600, 412, 120, P.red); ctx.restore();
      api.strike(556, 368, 644, 456, K(bl * 2), P.red, 7);
      api.strike(644, 368, 556, 456, K(bl * 2 - 1), P.red, 7);
    }
    ctx.save(); ctx.globalAlpha *= bl > 0 ? .8 + .2 * (.5 + .5 * Math.sin(t * 5)) : .35;
    ctext(LB(2, 'PUSH REFUSED'), 600, 524, 21, bl > 0 ? P.red : C.muted);
    ctx.restore();
  }

  ctext('CONCEPTUAL DIAGRAM / NOT LIVE TELEMETRY', 440, 606, 17, C.muted);
};
