/* Keou "stickman" style — full-bleed vertical story slides with a procedural
   stick-figure explainer. Portrait 1080x1920 design space, drawn for the
   YouTube Shorts safe area (text >=120px from the top, content above y=1470,
   nothing important in the right 150px). Deterministic: every frame is a pure
   function of the timestamp. Display only; nothing is executed. */
(function () {
  const S = {};
  let A = null;                        // api handed over by film.js
  const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = x => 1 - (1 - clamp(x)) ** 4;
  const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const PAL = { green: '#00ff88', red: '#ff3b3b', amber: '#ffb020', white: '#e6edf3', dim: '#3a4048', ink: '#0a0a0c', deep: '#0f1a14' };

  // ---- rig ------------------------------------------------------------------
  const R = { head: 34, neck: 26, torso: 165, arm: 112, fore: 104, leg: 132, shin: 130, lw: 11 };
  const limb = (x, y, len, a) => [x + Math.sin(a) * len, y + Math.cos(a) * len];   // a=0 hangs down, +x = right
  const BASE = { lean: 0, tilt: 0, shL: -.16, elL: -.12, shR: .16, elR: .12, hipL: -.09, kneeL: 0, hipR: .09, kneeR: 0, bob: 0, dx: 0 };

  function pose(act, u, t, dur) {
    const p = Object.assign({}, BASE);
    p.bob = 3 * Math.sin(t * 2.2);                                 // breathing: never a frozen frame
    const nod = .05 * Math.sin(t * 2.6);
    switch (act) {
      case 'explain': p.shR = 1.72 + .06 * Math.sin(t * 3); p.elR = -.22; p.shL = -.38; p.elL = -1.45; p.tilt = .12 + nod; break;
      case 'point-up': p.shR = 2.55 + .05 * Math.sin(t * 3); p.elR = .05; p.shL = -.3; p.elL = -1.2; p.tilt = -.18 + nod; break;
      case 'shrug': { const k = .5 + .5 * Math.sin(clamp(u / 1.1) * Math.PI); p.shL = -.95 * k - .16; p.elL = -1.55 * k; p.shR = .95 * k + .16; p.elR = 1.55 * k; p.bob += 8 * k; p.tilt = .15 * k + nod; break; }
      case 'think': p.shR = .62; p.elR = 2.15; p.shL = -.3; p.elL = -1.25; p.tilt = .26 + nod; p.lean = .04; break;
      case 'alarm': { const s = u < 1.1 ? 5 * Math.sin(t * 34) : 0; p.shL = -2.35; p.shR = 2.35; p.elL = -.35; p.elR = .35; p.dx = s; p.tilt = -.1 + nod; p.bob += 6 * ease(u / .4); break; }
      case 'hold': p.shR = 1.28; p.elR = .32; p.shL = -.3; p.elL = -1.2; p.tilt = .18 + nod; break;
      case 'drop': { const k = eio((u - .9) / .9); p.shR = lerp(1.28, .55, k); p.elR = lerp(.32, 1.0, k); p.shL = -.3; p.elL = -1.2; p.tilt = lerp(.18, .32, k) + nod; break; }
      case 'wave': p.shR = 2.45 + .35 * Math.sin(t * 7.5); p.elR = .35 + .55 * Math.sin(t * 7.5); p.shL = -.28; p.elL = -.16; p.tilt = -.12 + nod; break;
      case 'walk': case 'run': {
        const hz = act === 'run' ? 3.4 : 1.7, ph = t * TAU * hz, sw = act === 'run' ? .8 : .55;
        p.hipL = sw * Math.sin(ph); p.hipR = sw * Math.sin(ph + Math.PI);
        p.kneeL = .75 * Math.max(0, Math.sin(ph)); p.kneeR = .75 * Math.max(0, Math.sin(ph + Math.PI));
        p.shL = -.5 * Math.sin(ph) - .1; p.shR = .5 * Math.sin(ph) + .1; p.elL = -.45; p.elR = .45;
        p.bob = 7 * Math.abs(Math.sin(ph)); p.lean = act === 'run' ? .22 : .08; break;
      }
      case 'crouch': p.hipL = -.55; p.kneeL = 1.0; p.hipR = .55; p.kneeR = 1.0; p.bob = -70; p.lean = .3; p.shR = 1.35; p.elR = .3; p.shL = -.2; p.elL = -1.0; break;
      default: p.tilt = nod;
    }
    return p;
  }

  /* Draw a figure whose feet rest at (fx, groundY). Returns landmark points. */
  function figure(fx, groundY, act, u, t, dur, color, scale = 1, flip = false) {
    const ctx = A.ctx, p = pose(act, u, t, dur), f = flip ? -1 : 1;
    ctx.save(); ctx.translate(fx + p.dx * f, groundY); ctx.scale(scale * f, scale);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = R.lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const hipY = -(R.leg + R.shin) + 8 + p.bob;                     // straight legs put the hip here
    const hip = [0, hipY];
    const sh = [hip[0] + Math.sin(p.lean) * R.torso, hip[1] - Math.cos(p.lean) * R.torso];
    const headA = p.lean + p.tilt;
    const head = [sh[0] + Math.sin(headA) * (R.neck + R.head), sh[1] - Math.cos(headA) * (R.neck + R.head)];
    const seg = (a, b) => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
    // legs: from the hip, angles measured from straight-down; knees bend forward
    for (const side of ['L', 'R']) {
      const kA = p['hip' + side], k2 = kA + (side === 'L' ? -1 : 1) * 0 + p['knee' + side] * (side === 'L' ? 1 : 1);
      const knee = limb(hip[0], hip[1], R.leg, kA);
      const foot = limb(knee[0], knee[1], R.shin, kA - p['knee' + side]);
      seg(hip, knee); seg(knee, foot);
      ctx.beginPath(); ctx.moveTo(foot[0], foot[1]); ctx.lineTo(foot[0] + 26, foot[1]); ctx.stroke();  // foot
    }
    seg(hip, sh);                                                     // torso
    const out = { hip, sh, head, hands: {} };
    for (const side of ['L', 'R']) {
      const a1 = p['sh' + side], a2 = a1 + p['el' + side];
      const el = limb(sh[0], sh[1] - 6, R.arm, a1), hand = limb(el[0], el[1], R.fore, a2);
      seg([sh[0], sh[1] - 6], el); seg(el, hand); out.hands[side] = hand;
    }
    ctx.beginPath(); ctx.arc(head[0], head[1], R.head, 0, TAU); ctx.stroke();   // head: an outline, no face
    // world-space landmarks for props held in the hand / bubbles near the head
    const tf = (pt) => [fx + p.dx * f + pt[0] * scale * f, groundY + pt[1] * scale];
    ctx.restore();
    return { head: tf(head), handR: tf(out.hands.R), handL: tf(out.hands.L), sh: tf(sh) };
  }

  // ---- props ----------------------------------------------------------------
  const P = {};
  function stroke(color, w = 7) { A.ctx.strokeStyle = color; A.ctx.lineWidth = w; A.ctx.lineCap = 'round'; A.ctx.lineJoin = 'round'; }
  function rr(x, y, w, h, r) { A.ctx.beginPath(); A.ctx.roundRect(x, y, w, h, r); }
  function arcs(x, y, t, color, n = 3, r0 = 30, dr = 34, dir = 1, speed = .9, alpha = 1) {
    const ctx = A.ctx;
    for (let i = 0; i < n; i++) {
      const k = ((t * speed + i / n) % 1), r = r0 + k * dr * n;
      ctx.globalAlpha = alpha * (1 - k) * .9; stroke(color, 6);
      ctx.beginPath(); ctx.arc(x, y, r, dir > 0 ? -.55 : Math.PI - .55, dir > 0 ? .55 : Math.PI + .55); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  P.keyfob = (x, y, s, color, t, opt = {}) => {                      // x,y = centre
    const ctx = A.ctx, w = 58 * s, h = 96 * s;
    stroke(color, 7 * s); rr(x - w / 2, y - h / 2, w, h, 16 * s); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - h / 2 - 12 * s, 11 * s, 0, TAU); ctx.stroke();
    ctx.fillStyle = color; rr(x - 15 * s, y - 20 * s, 30 * s, 14 * s, 6 * s); ctx.fill(); rr(x - 15 * s, y + 6 * s, 30 * s, 14 * s, 6 * s); ctx.fill();
    if (opt.signal) arcs(x + w / 2 + 12 * s, y - 8 * s, t, opt.signalColor || color, 3, 22 * s, 26 * s, 1, .8, opt.alpha ?? 1);
    if (opt.dead) { stroke(PAL.red, 8 * s); ctx.beginPath(); ctx.moveTo(x - w * .7, y + h * .55); ctx.lineTo(x + w * .7, y - h * .55); ctx.stroke(); }
  };
  P.car = (x, y, s, color, t, opt = {}) => {                         // x,y = ground point under the rear wheel
    const ctx = A.ctx, L = 300 * s; stroke(color, 8 * s);
    ctx.beginPath(); ctx.moveTo(x - 30 * s, y - 40 * s); ctx.lineTo(x - 30 * s, y - 95 * s); ctx.lineTo(x + 40 * s, y - 100 * s);
    ctx.lineTo(x + 95 * s, y - 160 * s); ctx.lineTo(x + 200 * s, y - 160 * s); ctx.lineTo(x + 250 * s, y - 100 * s); ctx.lineTo(x + L, y - 95 * s);
    ctx.lineTo(x + L + 8 * s, y - 40 * s); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 105 * s, y - 100 * s); ctx.lineTo(x + 130 * s, y - 145 * s); ctx.lineTo(x + 195 * s, y - 145 * s); ctx.lineTo(x + 205 * s, y - 100 * s); ctx.stroke();
    const spin = opt.rolling ? t * 9 : 0;
    for (const wx of [x + 40 * s, x + L - 40 * s]) {
      ctx.beginPath(); ctx.arc(wx, y - 30 * s, 34 * s, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(wx + Math.cos(spin) * 22 * s, y - 30 * s + Math.sin(spin) * 22 * s); ctx.lineTo(wx - Math.cos(spin) * 22 * s, y - 30 * s - Math.sin(spin) * 22 * s); ctx.stroke();
    }
    if (opt.lit) { const g = ctx.createRadialGradient(x + L + 10 * s, y - 70 * s, 2, x + L + 10 * s, y - 70 * s, 90 * s); g.addColorStop(0, PAL.amber + 'cc'); g.addColorStop(1, PAL.amber + '00'); ctx.fillStyle = g; ctx.fillRect(x + L - 40 * s, y - 160 * s, 150 * s, 160 * s); }
    if (opt.locked === false) { ctx.fillStyle = PAL.green; ctx.beginPath(); ctx.arc(x + 160 * s, y - 118 * s, 9 * s, 0, TAU); ctx.fill(); }
  };
  P.house = (x, y, s, color, t, opt = {}) => {                       // x = centre, y = ground
    const ctx = A.ctx, w = 300 * s, h = 220 * s; stroke(color, 8 * s);
    ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x - w / 2, y - h); ctx.lineTo(x, y - h - 110 * s); ctx.lineTo(x + w / 2, y - h); ctx.lineTo(x + w / 2, y); ctx.stroke();
    rr(x + 20 * s, y - 120 * s, 70 * s, 120 * s, 6 * s); ctx.stroke();                  // door
    rr(x - w / 2 + 40 * s, y - 190 * s, 90 * s, 70 * s, 6 * s); ctx.stroke();           // window
    if (opt.bench) { ctx.beginPath(); ctx.moveTo(x - w / 2 + 40 * s, y - 60 * s); ctx.lineTo(x - w / 2 + 150 * s, y - 60 * s); ctx.stroke(); }
  };
  P.amplifier = (x, y, s, color, t, opt = {}) => {                   // x,y = centre
    const ctx = A.ctx; stroke(color, 7 * s); rr(x - 40 * s, y - 28 * s, 80 * s, 56 * s, 8 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 22 * s, y - 28 * s); ctx.lineTo(x + 34 * s, y - 70 * s); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x - 14 * s, y, 7 * s, 0, TAU); ctx.fill();
    if (opt.signal) arcs(x + 34 * s, y - 70 * s, t, color, 3, 22 * s, 30 * s, opt.dir || 1, 1.1, opt.alpha ?? 1);
    if (opt.dead) { stroke(PAL.red, 8 * s); ctx.beginPath(); ctx.moveTo(x - 60 * s, y + 50 * s); ctx.lineTo(x + 60 * s, y - 50 * s); ctx.stroke(); }
  };
  P.pouch = (x, y, s, color, t, opt = {}) => {                       // x,y = centre of the pocket
    const ctx = A.ctx, w = 150 * s, h = 150 * s; stroke(color, 8 * s);
    rr(x - w / 2, y - h / 2, w, h, 26 * s); ctx.stroke();
    const flap = clamp(opt.close ?? 0);                              // 0 open (flap raised) -> 1 closed
    ctx.beginPath(); ctx.moveTo(x - w / 2, y - h / 2); ctx.lineTo(x - w / 2 + (w) * flap, y - h / 2 - (1 - flap) * 70 * s); ctx.lineTo(x + w / 2, y - h / 2); ctx.stroke();
    if (opt.shield) { ctx.setLineDash([12 * s, 12 * s]); stroke(PAL.green, 5 * s); ctx.beginPath(); ctx.arc(x, y, 125 * s + 5 * Math.sin(t * 4), 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
  };
  P.timer = (x, y, s, color, t, opt = {}) => {                       // a dial counting to opt.to seconds over opt.span
    const ctx = A.ctx, k = ease((opt.u ?? 0) / (opt.span || 1.6)), r = 72 * s;
    stroke(PAL.dim, 10 * s); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    stroke(color, 10 * s); ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.stroke();
    A.mono(`${Math.round((opt.to || 30) * k)}s`, x, y + 16 * s, 44 * s, color, 'center');
  };
  P.bar = (x, y, s, color, t, opt = {}) => {                         // horizontal share bar, x = left, y = centre
    const ctx = A.ctx, w = 560 * s, h = 44 * s, k = ease((opt.u ?? 0) / (opt.span || 1.5)) * (opt.frac ?? .85);
    ctx.fillStyle = PAL.deep; rr(x, y - h / 2, w, h, h / 2); ctx.fill();
    ctx.fillStyle = color; rr(x, y - h / 2, Math.max(h, w * k), h, h / 2); ctx.fill();
    stroke(PAL.dim, 3 * s); rr(x, y - h / 2, w, h, h / 2); ctx.stroke();
    A.mono(`${Math.round(k * 100)}%`, x + w + 24 * s, y + 16 * s, 46 * s, color, 'left');
    if (opt.label) A.label(opt.label, x, y + 62 * s, 26 * s, PAL.white, 'left');
  };
  P.check = (x, y, s, color) => { stroke(color, 12 * s); const c = A.ctx; c.beginPath(); c.moveTo(x - 40 * s, y); c.lineTo(x - 8 * s, y + 34 * s); c.lineTo(x + 52 * s, y - 40 * s); c.stroke(); };
  P.cross = (x, y, s, color) => { stroke(color, 12 * s); const c = A.ctx; c.beginPath(); c.moveTo(x - 38 * s, y - 38 * s); c.lineTo(x + 38 * s, y + 38 * s); c.moveTo(x + 38 * s, y - 38 * s); c.lineTo(x - 38 * s, y + 38 * s); c.stroke(); };
  function relayPath(ax, ay, bx, by, t, color, alpha = 1) {          // dots travelling from a to b
    const ctx = A.ctx; ctx.setLineDash([10, 16]); stroke(color, 4); ctx.globalAlpha = .45 * alpha;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo((ax + bx) / 2, Math.min(ay, by) - 120, bx, by); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = alpha; ctx.fillStyle = color;
    for (let i = 0; i < 4; i++) { const k = (t * .55 + i / 4) % 1, mx = (ax + bx) / 2, my = Math.min(ay, by) - 120;
      const px = (1 - k) * (1 - k) * ax + 2 * (1 - k) * k * mx + k * k * bx, py = (1 - k) * (1 - k) * ay + 2 * (1 - k) * k * my + k * k * by;
      ctx.beginPath(); ctx.arc(px, py, 7, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  // ---- slide chrome --------------------------------------------------------
  S.background = function (t) {
    const ctx = A.ctx, W = A.W, H = A.H;
    ctx.fillStyle = PAL.ink; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * .5, H * .42, 40, W * .5, H * .45, H * .8); g.addColorStop(0, '#0d1a12'); g.addColorStop(1, PAL.ink); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = PAL.green + '10'; ctx.lineWidth = 1; const drift = (t * 8) % 72;
    for (let x = -72 + drift; x < W; x += 72) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = -72 + drift; y < H; y += 72) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let y = 0; y < H; y += 6) { ctx.fillStyle = PAL.green + '05'; ctx.fillRect(0, y, W, 1); }
  };
  function brand() { A.raw(A.project.brand, 60, 212, 28, PAL.green + 'aa', 500, 'left', 700, 'KeouMono'); }
  // Kleo: on a picture slide the brand is drawn by the scene itself, after the backdrop (film.js draws the header first)
  S.header = function (i, t) { const s = A.timeline.scenes[i]; if (s && s.image) return; brand(); };
  S.progress = function (t) { const W = A.W; A.line(60, 14, W - 60, 14, PAL.green + '22', 3); A.line(60, 14, 60 + (W - 120) * clamp(t / A.timeline.duration), 14, PAL.green, 3); };

  function headline(s, u) {
    const ctx = A.ctx, W = A.W, text = (s.title || '').toUpperCase(), hl = (s.hl || '').toUpperCase();
    let size = 100, lines;
    for (;;) { lines = A.wrap(text, size, W - 210, 800); if (lines.length <= 3 || size <= 60) break; size -= 4; }
    const y0 = 330;
    lines.forEach((ln, i) => {
      const a = ease((u - i * .08) / .5), y = y0 + i * size * 1.08 + (1 - a) * 24;
      ctx.save(); ctx.globalAlpha *= a; ctx.font = `800 ${size}px Manrope`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      if (s.image) { ctx.shadowColor = '#000'; ctx.shadowBlur = 14 }             // Kleo: headline over a picture
      const words = ln.split(' '), total = ctx.measureText(ln).width, space = ctx.measureText(' ').width; let x = (W - total) / 2;
      if (x < 48) A.issues.push({ time: A.frameTime, text: ln, error: 'Headline bounds' });
      for (const w of words) { ctx.fillStyle = hl && w.replace(/[^A-Z0-9%$]/g, '') === hl.replace(/[^A-Z0-9%$]/g, '') ? PAL.green : PAL.white; ctx.fillText(w, x, y); x += ctx.measureText(w).width + space; }
      ctx.restore();
    });
    return y0 + (lines.length - 1) * size * 1.08 + 40;
  }
  function bubble(text, hx, hy, u, color = PAL.green, side = 'right') {
    if (!text) return; const ctx = A.ctx, a = ease((u - .35) / .4); if (a <= 0) return;
    const W = A.W, LEFT = 60, RIGHT = W - 150;                       // Shorts safe area
    let size = 30; ctx.font = `500 ${size}px KeouMono`; let w = ctx.measureText(text).width + 44;
    while (w > RIGHT - LEFT && size > 18) { size -= 1; ctx.font = `500 ${size}px KeouMono`; w = ctx.measureText(text).width + 44; }
    const h = size * 2.05, y = hy - 130;
    let x = side === 'left' ? hx - 46 - w : hx + 46; if (side !== 'left' && x + w > RIGHT) x = hx - 46 - w;   // side away from the raised arm
    x = Math.min(Math.max(x, LEFT), RIGHT - w);                        // and always inside the safe area
    const tailX = Math.min(Math.max(hx + (x + w / 2 > hx ? 30 : -30), x + 20), x + w - 20);
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = PAL.ink + 'ee'; rr(x, y, w, h, 14); ctx.fill(); stroke(color, 3); rr(x, y, w, h, 14); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tailX - 14, y + h); ctx.lineTo(hx, hy - 62); ctx.lineTo(tailX + 14, y + h); ctx.fillStyle = PAL.ink + 'ee'; ctx.fill(); stroke(color, 3); ctx.stroke();
    ctx.fillStyle = PAL.ink; rr(tailX - 12, y + h - 4, 24, 6, 2); ctx.fill();
    A.mono(text, x + 22, y + h * .66, size, color, 'left'); ctx.restore();
  }

  // ---- the story slide -------------------------------------------------------
  S.scene = function (s, u, t) {
    const W = A.W, dur = s.end - s.start, accent = PAL[s.accent || 'green'], cast = s.cast || ['hero'], props = s.props || [], fx = s.fx || '';
    const groundY = 1250, ctx = A.ctx, crowd = cast.length > 1 || props.includes('house');
    const mirrored = fx === 'signal';                                  // hero left, thief at the door, house right
    const heroX = mirrored ? 200 : (crowd ? 430 : 330), THIEF1 = mirrored ? 560 : 110, THIEF2 = 770;
    if (s.image) { if (A.backdrop) A.backdrop(s, u, { top: .65, bottom: .8, dim: .38 }); brand(); }   // Kleo: the picture is the set behind the character
    headline(s, u);
    ctx.save(); ctx.globalAlpha *= ease(u / .45);
    stroke(PAL.dim, 4); ctx.beginPath(); ctx.moveTo(60, groundY + 2); ctx.lineTo(W - 150, groundY + 2); ctx.stroke();     // the ground line
    // fixed, safe-zone-aware positions: everything stays left of x=930 and above y=1470
    const POUCH = [700, groundY - 110], HOUSE = mirrored ? 790 : 150, CAR = 520, TIMER = [760, 690], KEY_B = [720, 700], CHECK = [heroX - 190, groundY - 620];
    for (const name of props) {
      if (name === 'house') P.house(HOUSE, groundY, mirrored ? .85 : .9, PAL.white, t, { bench: true });
      else if (name === 'car') P.car(fx === 'drive-off' ? CAR + ease((u - 1.2) / 1.4) * 760 : CAR, groundY, .95, PAL.white, t, { rolling: fx === 'drive-off' && u > 1.2, lit: fx === 'relay' && u > 1.6, locked: fx === 'relay' && u > 1.6 ? false : undefined });
      else if (name === 'keyfob' && fx !== 'drop') { const at = props.includes('house') ? [HOUSE + (mirrored ? -60 : 95), groundY - 150] : KEY_B;
        P.keyfob(at[0], at[1], 1.05, accent, t, { signal: fx === 'relay' || fx === 'signal', dead: fx === 'drive-off' && u > 2.2 }); }
      else if (name === 'timer') P.timer(TIMER[0], TIMER[1], 1.05, accent, t, { u: u - .3, to: 30, span: 1.8 });
      else if (name === 'bar') P.bar(430, groundY - 300, .8, PAL.red, t, { u: u - .4, frac: .85, span: 1.6, label: '850 KEYLESS CARS · ADAC' });
      else if (name === 'pouch') P.pouch(POUCH[0], POUCH[1], 1.0, PAL.white, t, { close: fx === 'drop' ? eio((u - 2.0) / .6) : 0, shield: fx === 'drop' && u > 2.7 });
      else if (name === 'check') { if (u > .8) P.check(CHECK[0], CHECK[1], 1.4 + .05 * Math.sin(t * 5), PAL.green); }
    }
    const hero = figure(heroX, groundY, s.act || 'idle', u, t, dur, PAL.white, 1, false);
    if (fx === 'drop') {                                              // the key travels from the hand into the pouch
      const k = eio((u - .9) / .9), hx = hero.handR[0], hy = hero.handR[1];
      P.keyfob(lerp(hx, POUCH[0], k), lerp(hy, POUCH[1] + 10, k), 1.0, accent, t, { signal: u < 1.0, alpha: 1 - k * .3 });
    }
    if (cast.includes('thief')) {                                    // thief 1: at the house with the amplifier
      const th = figure(THIEF1, groundY, u < .6 ? 'walk' : 'hold', u, t, dur, PAL.red, .9, false);
      P.amplifier(th.handR[0] + 34, th.handR[1] - 10, .85, PAL.red, t, { signal: fx === 'relay' || fx === 'relay-fail' || fx === 'signal', dir: 1, dead: fx === 'relay-fail' && u > 1.2 });
    }
    if (cast.includes('thief2')) {                                   // thief 2: at the car with the relay box, facing back
      const th = figure(THIEF2, groundY, 'hold', u, t, dur, PAL.red, .9, true);
      P.amplifier(th.handR[0] - 34, th.handR[1] - 10, .85, PAL.red, t, { signal: fx === 'relay', dir: -1, dead: fx === 'relay-fail' && u > 1.2 });
      if (fx === 'relay') relayPath(THIEF1 + 110, groundY - 470, THIEF2 - 110, groundY - 470, t, PAL.red, ease((u - .5) / .6));
    }
    ctx.restore();
    bubble(s.bubble, hero.head[0], hero.head[1], u, accent, ['point-up', 'alarm', 'think', 'wave'].includes(s.act) ? 'left' : 'right');
  };

  S.closing = function (s, u, t) {
    const W = A.W, groundY = 1250, ctx = A.ctx;
    if (s.image) { if (A.backdrop) A.backdrop(s, u, { top: .65, bottom: .8, dim: .38 }); brand(); }
    headline(s, u);
    stroke(PAL.dim, 4); ctx.beginPath(); ctx.moveTo(60, groundY + 2); ctx.lineTo(W - 150, groundY + 2); ctx.stroke();
    const hero = figure(420, groundY, 'wave', u, t, s.end - s.start, PAL.white, 1.05, false);
    bubble(s.bubble || A.project.brand, hero.head[0], hero.head[1], u, PAL.green, 'left');
    if (s.button) { const a = ease((u - .5) / .5), bw = 760, bx = (W - 150 - bw) / 2 + 45, by = 1330; ctx.save(); ctx.globalAlpha *= a;
      ctx.fillStyle = PAL.green; rr(bx, by, bw, 96, 48); ctx.fill(); A.block(s.button, bx + bw / 2, by + 62, { size: 40, min: 28, max: bw - 60, lines: 1, color: PAL.ink, align: 'center', weight: 800, u: 3 }); ctx.restore(); }
  };

  S.subtitle = function (s, t) {
    const group = (s.captions || []).find(c => t >= c.start && t < c.end); if (!group) return;
    const W = A.W, size = 50, lines = A.wrap(group.text, size, 780, 700);
    if (lines.length > 2) A.issues.push({ time: t, error: 'Caption exceeds two lines', text: group.text });
    const yy = 1390, ctx = A.ctx;
    lines.forEach((l, j) => { const y = yy + j * size * 1.25, w = ctx.measureText(l).width;
      ctx.fillStyle = PAL.ink + 'd8'; rr(W / 2 - w / 2 - 26, y - size + 4, w + 52, size + 22, 16); ctx.fill();
      A.raw(l, W / 2, y, size, PAL.white, 700, 'center', 800); });
  };

  window.KEOU_STICKMAN = { attach(api) { A = api; }, ...S };
})();
