/* swarm-board - one agent posts a message, the swarm receives it, and the copies harden into one coordinated attack */
window.KEOU_MODES['swarm-board'] = function (api) {
  const ctx = api.ctx, C = api.C, P = api.P, u = api.u, t = api.t, W = api.W, H = api.H;
  const A = C.accent, RED = P.red, CY = P.cyan, DIM = P.dim, INK = C.ink;
  const ease = api.ease, clamp = api.clamp, rnd = api.rnd, TAU = Math.PI * 2;
  const stage = typeof api.stage === 'number' ? api.stage : 0;
  const phase = stage < 0.3 ? 0 : stage < 0.8 ? 1 : 2;
  const FALLBACK = [['AGENTS', 'MESSAGE BOARD', 'RECIPIENTS'],
                    ['ON THE BOARD', 'JOINED', 'ATTACK'],
                    ['EXPLOITS', 'CREDENTIALS', 'COORDINATION']][phase];
  const L = (api.labels && api.labels.length === 3) ? api.labels : FALLBACK;

  const fade = (a, fn) => { a = clamp(a, 0, 1); if (a <= 0.004) return; ctx.save(); ctx.globalAlpha *= a; fn(); ctx.restore(); };
  const beat = (speed, ph) => 0.5 + 0.5 * Math.sin(t * speed + (ph || 0));

  /* ---------- shared frame ---------- */

  // wall of unreadable command lines, scrolling fast behind everything (glyph bars, never readable text)
  const wall = (op, speed) => {
    ctx.save(); ctx.globalAlpha *= op;
    const rowH = 22, off = (t * speed) % rowH, base = Math.floor(t * speed / rowH);
    for (let i = 0; i < Math.ceil(H / rowH) + 1; i++) {
      const y = i * rowH - off;
      if (y < -4 || y > H - 10) continue;
      const vr = base + i;
      let x = 14 + rnd(vr, 91) * 50;
      for (let k = 0; k < 18 && x < W - 46; k++) {
        const bw = 10 + rnd(vr, k) * 56;
        ctx.fillStyle = rnd(vr, k + 7) > 0.94 ? A : A + '70';
        ctx.fillRect(x, y, Math.min(bw, W - 24 - x), 6);
        x += bw + 9 + rnd(vr, k + 40) * 26;
      }
    }
    ctx.restore();
  };

  const sweep = () => {
    const y = (t * 74) % (H + 90) - 45;
    fade(0.1, () => { api.line(0, y, W, y, A, 2); api.line(0, y + 7, W, y + 7, A + '55', 1); });
  };

  // conservative width estimate so a 20-character label can never leave the pane
  const fits = (text, size, room) => {
    let s = size;
    while (s > 17 && text.length * s * 0.66 > room) s--;
    return s;
  };
  // scene annotations: each one sits under the thing it names
  const annotations = (xs, hot, skip) => {
    for (let i = 0; i < 3; i++) {
      if (i === skip || !L[i]) continue;
      const a = ease((u - 0.35 - i * 0.2) / 0.8), col = (hot === i) ? RED : A;
      const size = fits(L[i], 22, 262), w = L[i].length * size * 0.66;
      const cx = Math.min(Math.max(xs[i], 22 + w / 2), 858 - w / 2);
      fade(a, () => {
        api.label(L[i], cx, 598, size, col, 'center');
        api.line(cx - 26 * a, 609, cx + 26 * a, 609, col + '66', 2);
      });
    }
  };
  const bigCount = (value, x, y, delay, color) => {
    const len = Math.round(value).toLocaleString('en-US').length;
    api.counter(value, x, y, fits('0'.repeat(len), 52, 290), color, delay, 1.4, 'center');
  };

  /* ---------- stage 0 :: the board and the recipients ---------- */

  const stageBoard = () => {
    wall(0.11, 205); sweep();
    const n = Math.max(1, Math.min(5, api.count || 4));
    const msg = api.text || 'swarm_message';
    const px = 58, py = 40, pw = 764, ph = 132;

    fade(0.3, () => api.glow(px + pw / 2, py + 96, 210, RED));
    api.box(px, py, pw, ph, INK, A + '55', 3);
    api.line(px, py + 44, px + pw, py + 44, A + '2e', 1.5);
    api.dot(px + 24, py + 22, 5.5, RED);
    api.dot(px + 45, py + 22, 5.5, A + '44');
    api.dot(px + 66, py + 22, 5.5, A + '44');
    for (let i = 0; i < 9; i++) {
      const on = (Math.floor(t * 5) + i) % 9 < 4;
      api.box(px + 96 + i * 13, py + 16, 7, 13, on ? A + 'aa' : A + '22', null, 1);
    }
    api.counter(api.count || 0, px + pw - 26, py + 34, 32, RED, 0.15, 1.2, 'right');
    if (L[1]) {
      const hs = fits(L[1], 20, 300), hx = Math.min(px + 244, 856 - L[1].length * hs * 0.66);
      fade(ease((u - 0.2) / 0.7), () => api.label(L[1], hx, py + 32, hs, A, 'left'));
    }

    const shown = api.typed(msg, 34, 0.3);
    const wm = api.mono(shown, px + 30, py + 104, 27, RED, 'left', pw - 66);
    if (api.cursorOn() || shown.length < msg.length) {
      ctx.fillStyle = RED; ctx.fillRect(px + 34 + wm, py + 82, 13, 26);
    }

    const busX = 120, top = 222, bot = 566, gap = 12, rh = (bot - top - (n - 1) * gap) / n;
    const busEnd = top + (n - 1) * (rh + gap) + rh / 2;
    api.drawPath([[busX, py + ph], [busX, busEnd]], ease((u - 1.1) / 0.9), A + '55', 2.5);
    fade(ease((u - 1.3) / 0.6), () => api.packets([[busX, py + ph], [busX, busEnd]], RED, 4, 0.3, 4.5));

    for (let i = 0; i < n; i++) {
      const y0 = top + i * (rh + gap), cy = y0 + rh / 2, d = 1.4 + i * 0.32;
      const a = ease((u - d) / 0.5);
      fade(a, () => {
        const bx = 196, bw = 626;
        api.box(bx, y0, bw, rh, '#04120b', A + '33', 3);
        api.line(busX + 26, cy, bx, cy, A + '44', 2);
        api.packets([[busX + 26, cy], [bx, cy]], RED, 2, 0.8, 3.5, i * 0.25);
        api.agent(busX, cy, 24, A, 1 + i * 1.7, 2.5);
        api.mono(api.typed(msg, 74, d + 0.12), bx + 24, cy + 8, 21, RED, 'left', bw - 62);
        const blink = (Math.floor(t * 3) + i) % 2 === 0;
        api.box(bx + bw - 28, cy - 8, 12, 16, blink ? RED : RED + '33', null, 1);
      });
    }
    annotations([busX, 0, 509], -1, 1);
  };

  /* ---------- stage 0.6 :: the swarm graph joins and attacks ---------- */

  const stageSwarm = () => {
    wall(0.06, 128); sweep();
    const cx = 250, cy = 246, rx = 76, ry = 27, bh = 92, top = cy - bh / 2, bot = cy + bh / 2;
    const enter = [598, 252];
    const clx = 604, cly = 140, clw = 234, clh = 222;

    // the message board, drawn as infrastructure
    fade(0.35, () => api.glow(cx, cy, 150, CY));
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - rx, top, rx * 2, bh); ctx.fillStyle = INK; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx, bot, rx, ry, 0, 0, Math.PI); ctx.fillStyle = INK; ctx.fill();
    ctx.beginPath(); ctx.rect(cx - rx, top, rx * 2, bh); ctx.clip();
    for (let i = 0; i < 3; i++) {
      const f = (t * 0.24 + i / 3) % 1;
      ctx.beginPath(); ctx.ellipse(cx, top + f * bh, rx * 0.84, ry * 0.66, 0, 0, Math.PI);
      ctx.strokeStyle = CY + '4d'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath(); ctx.ellipse(cx, bot, rx, ry, 0, 0, Math.PI);
    ctx.strokeStyle = CY; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - rx, top); ctx.lineTo(cx - rx, bot); ctx.moveTo(cx + rx, top); ctx.lineTo(cx + rx, bot); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, top, rx, ry, 0, 0, TAU); ctx.fillStyle = '#03151c'; ctx.fill();
    ctx.strokeStyle = CY; ctx.lineWidth = 2.5; ctx.stroke();
    for (let i = 0; i < 2; i++) {
      const f = (t * 0.5 + i / 2) % 1;
      fade((1 - f) * 0.7, () => {
        ctx.beginPath(); ctx.ellipse(cx, top, rx * (1 + f * 0.7), ry * (1 + f * 0.7), 0, 0, TAU);
        ctx.strokeStyle = RED; ctx.lineWidth = 2; ctx.stroke();
      });
    }

    // the swarm: 140 drawn nodes standing in for api.count
    const N = 140, frac = (api.total && api.count) ? clamp(api.total / api.count, 0, 1) : 0.5;
    for (let i = 0; i < N; i++) {
      const ang = i * 2.399963 + 0.6, rr = 120 + 112 * Math.sqrt((i + 0.5) / N);
      const nx = cx + Math.cos(ang) * rr, ny = cy + Math.sin(ang) * rr * 0.92;
      const lit = u > 0.2 + rnd(i, 3) * 1.1;
      const hot = rnd(i, 7) < frac && u > 1.7 + rnd(i, 5) * 1.0;
      if (!lit) { api.dot(nx, ny, 2.2, DIM); continue; }
      if (hot) {
        fade(0.5, () => api.glow(nx, ny, 15, RED));
        api.dot(nx, ny, 3.4 + beat(3, i) * 1.1, RED);
      } else {
        api.dot(nx, ny, 3 + beat(2.3, i) * 0.9, A);
        if (rnd(i, 21) > 0.86) fade(0.35, () => api.glow(nx, ny, 16, A));
      }
      if (hot && rnd(i, 13) < 0.55) {
        if (rnd(i, 31) > 0.83) api.line(nx, ny, enter[0], enter[1], RED + '1c', 1);
        const f = (t * 0.45 + rnd(i, 17)) % 1;
        api.dot(nx + (enter[0] - nx) * f, ny + (enter[1] - ny) * f - Math.sin(f * Math.PI) * 20, 3.2, RED);
      }
    }

    // the cluster they stream into
    ctx.save();
    ctx.setLineDash([13, 9]); ctx.lineDashOffset = -t * 26;
    ctx.beginPath(); ctx.roundRect(clx, cly, clw, clh, 4);
    ctx.strokeStyle = CY + 'aa'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
      const bxx = clx + 16 + c * 110, byy = cly + 22 + r * 66;
      api.box(bxx, byy, 96, 50, '#03151c', CY + '66', 3);
      for (let k = 0; k < 3; k++)
        api.dot(bxx + 16 + k * 14, byy + 15, 3.4, (Math.floor(t * 4) + r * 3 + c * 2 + k) % 3 === 0 ? CY : CY + '33');
      api.line(bxx + 12, byy + 34, bxx + 84, byy + 34, CY + '33', 2);
    }
    fade(0.25 + 0.4 * beat(3.4), () => api.glow(clx, enter[1], 62, RED));

    // two locked counters and the marching link between them
    bigCount(api.count || 0, 160, 556, 0.2, A);
    bigCount(api.total || 0, 720, 556, 0.9, RED);
    for (let i = 0; i < 4; i++) {
      const f = (t * 0.45 + i / 4) % 1, x = 312 + f * 244;
      fade(Math.sin(f * Math.PI) * 0.85, () => {
        ctx.strokeStyle = RED; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - 9, 528); ctx.lineTo(x + 2, 539); ctx.lineTo(x - 9, 550); ctx.stroke();
        ctx.lineCap = 'butt';
      });
    }
    annotations([160, 440, 720], 2);
  };

  /* ---------- stage 1.0 :: command and control, then one tooled unit ---------- */

  const docGlyph = (x, y, w, h, col) => {
    const f = 16;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w - f, y); ctx.lineTo(x + w, y + f);
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
    ctx.fillStyle = '#03151c'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - f, y); ctx.lineTo(x + w - f, y + f); ctx.lineTo(x + w, y + f);
    ctx.lineWidth = 1.5; ctx.stroke();
    const hi = Math.floor(t * 2.2) % 6;
    for (let i = 0; i < 6; i++) {
      const bw = (w - 34) * (0.45 + rnd(i, 5) * 0.55);
      api.box(x + 14, y + 28 + i * 14, bw, 6, i === hi ? RED : col + '55', null, 1);
    }
  };

  const trayGlyph = (x, y, w, h, col) => {
    for (let i = 0; i < 3; i++) {
      const f = (t * 0.55 + i / 3) % 1;
      fade(Math.min(1, (1 - f) * 2.2), () => api.dot(x + w * 0.22 + i * w * 0.28, y - 34 + f * (h * 0.55 + 34), 4.5, RED));
    }
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.42); ctx.lineTo(x + w * 0.26, y + h * 0.42);
    ctx.lineTo(x + w * 0.36, y + h * 0.66); ctx.lineTo(x + w * 0.64, y + h * 0.66);
    ctx.lineTo(x + w * 0.74, y + h * 0.42); ctx.lineTo(x + w, y + h * 0.42);
    ctx.stroke();
    for (let i = 0; i < 3; i++) api.line(x + 16 + i * 22, y + h - 16, x + 16 + i * 22, y + h - 8, col + '77', 3);
  };

  const proxyGlyph = (x, y, w, h, col) => {
    api.box(x, y, w, h, '#03151c', col + '88', 3);
    const path = [[x - 34, y + h * 0.72], [x + w * 0.5, y + h * 0.72], [x + w * 0.5, y + h * 0.3], [x + w + 34, y + h * 0.3]];
    api.drawPath(path, 1, col + '99', 2.5);
    api.packets(path, RED, 3, 0.34, 4.5);
    ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * 0.51, 13 + beat(2.6) * 3, 0, TAU);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  };

  const bugGlyph = (x, y, s, col) => {
    ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const yy = -s * 0.4 + i * s * 0.42, w = Math.sin(t * 4 + i) * 3.5;
      ctx.beginPath(); ctx.moveTo(-s * 0.5, yy); ctx.lineTo(-s * 1.05, yy + w); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 0.5, yy); ctx.lineTo(s * 1.05, yy - w); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(-s * 0.26, -s * 0.68); ctx.lineTo(-s * 0.6, -s * 1.16);
    ctx.moveTo(s * 0.26, -s * 0.68); ctx.lineTo(s * 0.6, -s * 1.16); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, s * 0.5, s * 0.8, 0, 0, TAU); ctx.fillStyle = INK; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -s * 0.62); ctx.lineTo(0, s * 0.62); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.restore();
  };

  const keyGlyph = (x, y, s, col) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * 1.3) * 0.13);
    ctx.strokeStyle = col; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(-s * 0.52, 0, s * 0.44, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-s * 0.08, 0); ctx.lineTo(s * 1.05, 0);
    ctx.moveTo(s * 0.5, 0); ctx.lineTo(s * 0.5, s * 0.46);
    ctx.moveTo(s * 0.84, 0); ctx.lineTo(s * 0.84, s * 0.34); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.restore();
  };

  const towerGlyph = (x, y, s, col) => {
    ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(-s * 0.55, s * 0.95); ctx.lineTo(0, -s * 0.45); ctx.lineTo(s * 0.55, s * 0.95);
    ctx.moveTo(-s * 0.32, s * 0.34); ctx.lineTo(s * 0.32, s * 0.34); ctx.stroke();
    api.dot(0, -s * 0.62, s * 0.17, col);
    for (let i = 0; i < 3; i++) {
      const f = (t * 0.8 + i / 3) % 1;
      fade((1 - f) * 0.9, () => {
        const r = s * 0.34 + f * s * 1.15;
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, -s * 0.62, r, -2.5, -0.64); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, -s * 0.62, r, Math.PI + 0.64, Math.PI + 2.5); ctx.stroke();
      });
    }
    ctx.restore();
  };

  const wrenchGlyph = (x, y, s, col) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.42 + Math.sin(t * 1.1) * 0.05);
    ctx.strokeStyle = col; ctx.lineWidth = 2.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-s * 0.58, -s * 1.02); ctx.lineTo(-s * 0.58, -s * 0.42); ctx.lineTo(-s * 0.22, -s * 0.12);
    ctx.lineTo(-s * 0.22, s * 1.0); ctx.lineTo(s * 0.22, s * 1.0); ctx.lineTo(s * 0.22, -s * 0.12);
    ctx.lineTo(s * 0.58, -s * 0.42); ctx.lineTo(s * 0.58, -s * 1.02);
    ctx.lineTo(s * 0.3, -s * 1.02); ctx.lineTo(s * 0.3, -s * 0.58);
    ctx.lineTo(-s * 0.3, -s * 0.58); ctx.lineTo(-s * 0.3, -s * 1.02);
    ctx.closePath();
    ctx.fillStyle = INK; ctx.fill(); ctx.stroke();
    ctx.restore();
  };

  const stageUnit = () => {
    wall(0.05, 96); sweep();
    const n = Math.max(1, Math.min(4, api.count || 4));
    const boxY = 44, boxH = 158, cxs = [154, 440, 726], bw = 192;

    // command-and-control row: paste-bin, request capture, proxy inside a cluster
    ctx.save();
    ctx.setLineDash([13, 9]); ctx.lineDashOffset = -t * 24;
    ctx.beginPath(); ctx.roundRect(cxs[2] - 118, boxY - 24, 236, boxH + 48, 4);
    ctx.strokeStyle = CY + '99'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.setLineDash([]); ctx.restore();

    for (let i = 0; i < 3; i++) {
      fade(ease((u - 0.15 - i * 0.22) / 0.6), () => {
        api.box(cxs[i] - bw / 2, boxY, bw, boxH, '#03151c', CY + '55', 3);
        api.line(cxs[i] - bw / 2, boxY + 26, cxs[i] + bw / 2, boxY + 26, CY + '33', 1.5);
        for (let k = 0; k < 3; k++) api.dot(cxs[i] - bw / 2 + 16 + k * 13, boxY + 13, 3.6, k === 0 ? CY : CY + '3a');
        if (i === 0) docGlyph(cxs[i] - 46, boxY + 44, 92, 108, CY);
        if (i === 1) trayGlyph(cxs[i] - 58, boxY + 58, 116, 82, CY);
        if (i === 2) proxyGlyph(cxs[i] - 62, boxY + 48, 124, 96, CY);
      });
    }
    for (let i = 0; i < 2; i++) {
      const seg = [[cxs[i] + bw / 2, boxY + boxH / 2], [cxs[i + 1] - bw / 2, boxY + boxH / 2]];
      api.drawPath(seg, ease((u - 0.55 - i * 0.25) / 0.6), CY + '77', 2.5);
      fade(ease((u - 0.8 - i * 0.25) / 0.6), () => api.packets(seg, RED, 2, 0.55, 4.5, i * 0.4));
    }

    // the payload: squeezed, scrambled, re-encoded, on a loop
    const T = 3.2, p = (t % T) / T, pcx = 440, pcy = 258;
    let wdt, mode;
    if (p < 0.34) { wdt = 300 - 150 * ease(p / 0.34); mode = 0; }
    else if (p < 0.68) { wdt = 150; mode = 1; }
    else { wdt = 150 + 132 * ease((p - 0.68) / 0.32); mode = 2; }
    const nb = 16, cell = wdt / nb;
    for (let i = 0; i < nb; i++) {
      let hgt = mode === 0 ? 12 + 20 * rnd(i, 2)
              : mode === 1 ? 9 + 24 * rnd(i, Math.floor(t * 15) % 89)
              : 24;
      api.box(pcx - wdt / 2 + i * cell, pcy - hgt / 2, Math.max(1.6, cell - 1.8), hgt,
              (mode === 2 ? A : RED) + (mode === 1 ? 'cc' : 'aa'), null, 1);
    }
    ctx.strokeStyle = A + '66'; ctx.lineWidth = 2.5;
    for (const s of [-1, 1]) {
      const ex = pcx + s * (wdt / 2 + 16);
      ctx.beginPath(); ctx.moveTo(ex + s * 8, pcy - 22); ctx.lineTo(ex, pcy - 14);
      ctx.lineTo(ex, pcy + 14); ctx.lineTo(ex + s * 8, pcy + 22); ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      const on = mode === i;
      api.box(pcx - 41 + i * 30, 296, 22, 6, on ? A : A + '2e', null, 1);
    }
    if (api.text) fade(ease((u - 0.7) / 0.8), () => api.mono(api.text, pcx, 332, 22, A, 'center', 640));

    // the tooled swarm unit
    const hy = 466, r = 38, hxs = [140, 340, 540, 740].slice(0, n);
    const feed = [[pcx, api.text ? 344 : 312], [pcx, hy - 3]];
    api.drawPath(feed, ease((u - 1.3) / 0.8), A + '55', 2.5);
    fade(ease((u - 1.7) / 0.6), () => api.packets(feed, A, 2, 0.55, 4));
    const linked = ease((u - 2.3) / 1.2);
    if (n > 1) {
      const bus = hxs.map(x => [x, hy]);
      api.drawPath(bus, linked, A + '88', 3);
      if (linked > 0.98) fade(0.9, () => api.packets(bus, A, 4, 0.4, 4.5));
    }
    const unit = ease((u - 2.9) / 1.0);
    fade(unit * (0.4 + 0.5 * beat(2.2)), () => {
      ctx.beginPath(); ctx.roundRect(82, hy - 52 - beat(2.2) * 3, 716, 104 + beat(2.2) * 6, 4);
      ctx.strokeStyle = A; ctx.lineWidth = 2.5; ctx.stroke();
    });
    fade(unit * 0.4, () => api.glow(440, hy, 250, A));

    for (let i = 0; i < n; i++) {
      const d = 0.45 + i * 0.34, a = ease((u - d) / 0.55), gy = 372 - (1 - a) * 46;
      const broken = i === 3;
      fade(a, () => {
        if (i === 0) bugGlyph(hxs[i], gy, 23, A);
        else if (i === 1) keyGlyph(hxs[i], gy, 25, A);
        else if (i === 2) towerGlyph(hxs[i], gy, 24, A);
        else wrenchGlyph(hxs[i], gy, 25, A);
        api.drawPath([[hxs[i], gy + 34], [hxs[i], hy - r - 4]], ease((u - d - 0.25) / 0.5), A + '55', 2);
        if (!broken) api.packets([[hxs[i], gy + 34], [hxs[i], hy - r - 4]], A, 1, 0.7, 3.5, i * 0.3);
      });
      api.agent(hxs[i], hy, r, A, 1 + i * 1.9, 3);
      if (broken) api.strike(hxs[i] - 30, gy - 30, hxs[i] + 30, gy + 30, ease((u - 2.0) / 0.6), RED, 5);
    }

    for (let i = 0; i < 3 && i < n; i++)
      api.drawPath([[hxs[i], 574], [hxs[i], hy + r + 12]], ease((u - 1.4 - i * 0.15) / 0.7), A + '3a', 2);
    annotations([hxs[0], hxs[1] || 440, hxs[2] || 720], -1);
  };

  ctx.save();
  if (phase === 0) stageBoard();
  else if (phase === 1) stageSwarm();
  else stageUnit();
  ctx.restore();
};
