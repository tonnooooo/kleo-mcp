/* Keou "sketch" style — hand-drawn white marker line art on pure black, calibrated frame by
   frame against the channel's reference Short (docs/REFERENCE-CALIBRATION.md).
   One accent colour per section, six shots, a camera that never stops pushing in, and burned-in
   karaoke captions as the only text. Deterministic; display only. */
(function () {
  const S = {}; let A = null; const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = x => 1 - (1 - clamp(x)) ** 3;
  const lerp = (a, b, t) => a + (b - a) * t;
  const WHITE = '#ffffff', PALE = '#e8e8e8';
  const ACC = { red: '#EC1F20', blue: '#15B3F6', green: '#16FC2B', yellow: '#EBC705', white: '#ffffff' };
  // Measured from the reference film (docs/REFERENCE-CALIBRATION.md): the caption baseline sits at
  // 81.8 % of frame height and its cap-height is 2.6 % of it. Both are ratios, so 16:9 keeps the
  // same reading rhythm on a wider, shorter frame.
  const CAP = { baseline: .818, cap: .026, track: 1.5, maxW: .88, live: '#16FC2B' };
  const cap = () => ({ y: Math.round(A.H * CAP.baseline), size: Math.round(A.H * CAP.cap / .72),
                       max: Math.round(A.W * CAP.maxW), track: CAP.track, live: CAP.live });
  const stage = () => ({ x: A.W / 2, y: Math.round(A.H * (A.H > A.W ? .448 : .46)) });   // where art sits by default
  const acc = s => ACC[s.accent || 'white'];

  // ---- deterministic noise -------------------------------------------------------
  const n1 = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) };
  const jit = (i, amp) => (n1(i) - .5) * 2 * amp;

  // ---- path builders (arrays of [x, y] in design pixels) --------------------------
  const P = {
    poly: pts => pts.slice(),
    line: (x0, y0, x1, y1) => { const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 14)); return Array.from({ length: n }, (_, i) => [lerp(x0, x1, i / (n - 1)), lerp(y0, y1, i / (n - 1))]) },
    rect: (x, y, w, h) => [...P.line(x, y, x + w, y), ...P.line(x + w, y, x + w, y + h), ...P.line(x + w, y + h, x, y + h), ...P.line(x, y + h, x, y)],
    arc: (cx, cy, r, a0, a1) => { const n = Math.max(6, Math.round(Math.abs(a1 - a0) * r / 10)); return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] }) },
    circle: (cx, cy, r) => P.arc(cx, cy, r, 0, TAU),
    quad: (x0, y0, cx, cy, x1, y1) => { const n = 14; return Array.from({ length: n }, (_, i) => { const t = i / (n - 1), m = 1 - t; return [m * m * x0 + 2 * m * t * cx + t * t * x1, m * m * y0 + 2 * m * t * cy + t * t * y1] }) },
  };

  // ---- the marker ----------------------------------------------------------------
  // A stroke of varying pressure that wobbles off the true path: the chalkboard feel the
  // reference has, and never a clean vector line. `draw` < 1 leaves the stroke unfinished.
  function mk(pts, w, col, seed = 0, draw = 1, a = 1) {
    if (pts.length < 2 || a <= 0 || draw <= 0) return;
    const ctx = A.ctx, keep = Math.max(2, Math.round(pts.length * clamp(draw)));
    ctx.save(); ctx.globalAlpha *= a; ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < keep; i++) {
      const p = pts[i - 1], q = pts[i], s = seed * 7.3 + i;
      const pressure = .72 + .5 * n1(s * 1.7);
      ctx.lineWidth = w * pressure;
      ctx.beginPath();
      ctx.moveTo(p[0] + jit(s, w * .5), p[1] + jit(s + 91, w * .5));
      ctx.lineTo(q[0] + jit(s + 1, w * .5), q[1] + jit(s + 92, w * .5));
      ctx.stroke();
    }
    ctx.restore();
  }
  function shade(pts, a = .07) {                                   // opaque base, then the soft grey interior
    if (pts.length < 3) return; const ctx = A.ctx; ctx.save();
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts) ctx.lineTo(p[0], p[1]); ctx.closePath();
    ctx.fillStyle = '#000000'; ctx.fill();                         // it knocks out whatever sits behind it
    ctx.globalAlpha *= a; ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
  }
  function glow(col, blur, fn) { const ctx = A.ctx; ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = blur; fn(); ctx.restore() }

  // ---- drifting dust -------------------------------------------------------------
  function dust(t) {
    const ctx = A.ctx, W = A.W, H = A.H; ctx.save(); ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 46; i++) {
      const x = n1(i) * W, sp = 14 + n1(i + 50) * 26, y = (n1(i + 99) * H - t * sp) % H;
      ctx.globalAlpha = .10 + .16 * n1(i + 7);
      ctx.beginPath(); ctx.arc(x + Math.sin(t * .5 + i) * 6, y < 0 ? y + H : y, 1.6 + n1(i + 13) * 1.8, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  // ---- art: the hotel-lock film's own world --------------------------------------
  const ART = {};
  // people_: helpers shared by the people family — ovals, capsule/finger outlines, nails, creases, dots, dashed ground shadow
  function people_oval(cx, cy, rx, ry, rot = 0, a0 = 0, a1 = TAU) {
    const n = Math.max(8, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 9)), cr = Math.cos(rot), sr = Math.sin(rot);
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)), x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * cr - y * sr, cy + x * sr + y * cr] });
  }
  function people_capsule(x0, y0, x1, y1, r) {                 // closed rounded tube from (x0,y0) to (x1,y1)
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, a = Math.atan2(uy, ux);
    return [...P.line(x0 - uy * r, y0 + ux * r, x1 - uy * r, y1 + ux * r), ...P.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2),
            ...P.line(x1 + uy * r, y1 - ux * r, x0 + uy * r, y0 - ux * r), ...P.arc(x0, y0, r, a - Math.PI / 2, a - 3 * Math.PI / 2)];
  }
  function people_finger(bx, by, tx, ty, r, bend = 0, taper = .86) {   // a finger: bent centreline, tapered sides, round tip; open at the base
    const dx = tx - bx, dy = ty - by, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const C = P.quad(bx, by, (bx + tx) / 2 + nx * bend, (by + ty) / 2 + ny * bend, tx, ty), a = [], b = [];
    for (let i = 0; i < C.length; i++) {
      const p = C[i], q = C[Math.min(C.length - 1, i + 1)], o2 = C[Math.max(0, i - 1)];
      const ddx = q[0] - o2[0], ddy = q[1] - o2[1], l = Math.hypot(ddx, ddy) || 1, mx = -ddy / l, my = ddx / l, rr = r * lerp(1, taper, i / (C.length - 1));
      a.push([p[0] + mx * rr, p[1] + my * rr]); b.push([p[0] - mx * rr, p[1] - my * rr]);
    }
    const e = C[C.length - 1], pe = C[C.length - 2], ang = Math.atan2(e[1] - pe[1], e[0] - pe[0]);
    return { open: [...a, ...P.arc(tx, ty, r * taper, ang + Math.PI / 2, ang - Math.PI / 2), ...b.reverse()], ang, tip: [tx, ty] };
  }
  function people_nail(tx, ty, ang, r, col, seed, d, a = .9) {
    mk(people_oval(tx - Math.cos(ang) * r * .95, ty - Math.sin(ang) * r * .95, r * .6, r * .52, ang), 3.2, col, seed, d, a);
  }
  function people_crease(px, py, ang, r, col, seed, d, a = .6) {   // a joint line across a finger, bowing toward the tip
    const nx = -Math.sin(ang), ny = Math.cos(ang), fx = Math.cos(ang) * r * .28, fy = Math.sin(ang) * r * .28;
    mk(P.quad(px + nx * r * .7, py + ny * r * .7, px + fx, py + fy, px - nx * r * .7, py - ny * r * .7), 3, col, seed, d, a);
  }
  function people_cuff(x, y, ux, uy, half, col, seed, d, a = .7) {   // a line across a sleeve, perpendicular to its direction (ux,uy)
    mk(P.line(x - uy * half, y + ux * half, x + uy * half, y - ux * half), 4, col, seed, d, a);
  }
  function people_glove(bx, by, tx, ty, r, ts, col, seed, d) {   // a mitten-like glove from its cuff (bx,by) to the fingertips (tx,ty): thumb on side `ts` (+1 = left normal), cuff line, knuckle crease
    const dx = tx - bx, dy = ty - by, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy * ts, ny = ux * ts;
    const W = (s, q) => [bx + ux * s + nx * q, by + uy * s + ny * q], tr = r * .9, tc = L - tr, ta = Math.atan2(ny, nx);
    const th = people_finger(...W(L * .24, r * .5), ...W(L * .5, r + 15), r * .4, -ts * 5, .84);   // thumb first: the mitten's shade trims its root
    shade(th.open, .07); mk(th.open, 4.5, col, seed + 1, d);
    const fill = [...P.line(...W(0, r), ...W(tc, tr)), ...P.arc(...W(tc, 0), tr, ta, ta - ts * Math.PI), ...P.line(...W(tc, -tr), ...W(0, -r))];
    const body = [...P.line(...W(L * .52, r), ...W(tc, tr)), ...P.arc(...W(tc, 0), tr, ta, ta - ts * Math.PI), ...P.line(...W(tc, -tr), ...W(0, -r)),
                  ...P.line(...W(0, -r), ...W(0, r)), ...P.line(...W(0, r), ...W(L * .12, r))];   // open where the thumb comes out
    shade(fill, .07); mk(body, 5.5, col, seed, d);
    mk(P.line(...W(11, r * .85), ...W(11, -r * .85)), 4, col, seed + 2, d, .75);                                   // glove cuff
    mk(P.quad(...W(L * .58, -r * .75), ...W(L * .72, -r * .25), ...W(L * .6, r * .2)), 3.5, col, seed + 3, d, .5);   // knuckle crease
  }
  function people_dot(x, y, r, col, a = 1) { if (a <= 0) return; const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore() }
  function people_ground(x0, x1, y, col, seed, d, a = .4) {       // dashed shadow line under something standing
    const n = Math.max(2, Math.round((x1 - x0) / 46));
    for (let i = 0; i < n; i++) mk(P.line(lerp(x0, x1, i / n) + 6, y, lerp(x0, x1, (i + 1) / n) - 12, y), 3.5, col, seed + i, d, a);
  }
  function people_mitt(x, y, ang, r, col, seed, d) {              // a stick figure's hand: a small open loop plus a thumb tick
    const cx = x - Math.cos(ang) * r * .7, cy = y - Math.sin(ang) * r * .7, nx = -Math.sin(ang), ny = Math.cos(ang);
    mk(P.arc(cx, cy, r, ang - 2.5, ang + 2.5), 5, col, seed, d);
    mk(P.line(cx + nx * r * .9, cy + ny * r * .9, cx + nx * r * 1.6 - Math.cos(ang) * r * .4, cy + ny * r * 1.6 - Math.sin(ang) * r * .4), 4, col, seed + 1, d, .9);
  }
  function people_bust(i, x, y, sc, col, w, seed, d, t) {        // one person of the crowd, seen from the chest up
    const c = A.ctx; c.save(); c.translate(x, y + Math.sin(t * 1.4 + i * 1.7) * 2.5); c.scale(sc, sc);
    const v = Math.floor(n1(i * 3 + 1) * 4), specs = n1(i * 5 + 2) > .68, smile = n1(i * 7 + 3) > .4;
    const body = [[-94, 0], ...P.line(-94, 0, -94, -66), ...P.quad(-94, -66, -90, -102, -32, -108), ...P.line(-32, -108, -32, -122), ...P.line(32, -122, 32, -108), ...P.quad(32, -108, 90, -102, 94, -66), ...P.line(94, -66, 94, 0)];
    shade(body, .06); mk(body, w, col, seed, d);
    if (v % 2) mk(P.quad(-32, -108, 0, -70, 32, -108), w * .7, col, seed + 1, d, .8); else mk(P.line(0, -108, 0, -40), w * .6, col, seed + 1, d, .6);
    shade(P.circle(0, -170, 48), .05); mk(P.circle(0, -170, 48), w, col, seed + 2, d);
    if (v === 0) mk(P.arc(0, -172, 52, Math.PI * 1.1, Math.PI * 1.9), w * .7, col, seed + 3, d, .9);
    else if (v === 1) mk(P.quad(-46, -192, -12, -226, 44, -196), w * .7, col, seed + 3, d, .9);
    else if (v === 2) { mk(P.circle(0, -228, 15), w * .7, col, seed + 3, d, .9); mk(P.arc(0, -172, 52, Math.PI * 1.15, Math.PI * 1.85), w * .6, col, seed + 4, d, .8) }
    else { mk(P.arc(0, -178, 54, Math.PI * 1.05, Math.PI * 1.95), w * .7, col, seed + 3, d, .9); mk(P.line(-56, -186, 62, -190), w * .7, col, seed + 4, d, .9) }
    people_dot(-16, -178, 4.5, col, d); people_dot(16, -178, 4.5, col, d);
    if (specs) { mk(P.circle(-16, -178, 11), w * .5, col, seed + 5, d, .8); mk(P.circle(16, -178, 11), w * .5, col, seed + 6, d, .8); mk(P.line(-5, -178, 5, -178), w * .5, col, seed + 7, d, .8) }
    mk(smile ? P.quad(-14, -148, 0, -138, 14, -148) : P.line(-12, -144, 12, -144), w * .6, col, seed + 8, d);
    c.restore();
  }
  // figure: the reference's stick person, large — round head with hair/ears, dot eyes that blink, brows, mouth, shoulders, hips, single-stroke limbs ending in mittens and shoes, dashed shadow; `reach` [x,y] is where the leading hand ends, `frown` makes brows (inner ends raised) and mouth sad
  ART.figure = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, es = o.es == null ? 99 : o.es;
    const d1 = ease(es / .35), d2 = ease((es - .16) / .35), d3 = ease((es - .32) / .3);
    const [rx, ry] = o.reach || [180, -40], side = rx < 0 ? -1 : 1, blink = (t % 3.9) < .13 ? .15 : 1;
    c.save(); c.translate(0, Math.sin(t * 1.3) * 2.5);
    const hy = -292, hr = 98;
    shade(P.circle(0, hy, hr), .05); mk(P.circle(0, hy, hr), 6.5, col, 1000, d1);
    mk(P.quad(-56, -372, -24, -408, 14, -394), 4, col, 1001, d3, .85);                         // hair
    mk(P.quad(-6, -386, 30, -414, 62, -382), 4, col, 1002, d3, .85);
    mk(P.quad(50, -368, 76, -392, 90, -354), 4, col, 1003, d3, .75);
    mk(P.arc(-hr + 6, hy + 8, 15, Math.PI * .55, Math.PI * 1.45), 4, col, 1004, d3, .85);        // ears
    mk(P.arc(hr - 6, hy + 8, 15, -Math.PI * .45, Math.PI * .45), 4, col, 1005, d3, .85);
    for (const sx of [-1, 1]) { c.save(); c.translate(sx * 36, hy - 12); c.scale(1, blink); people_dot(0, 0, 9.5, col, d2); c.restore() }
    if (o.frown) { mk(P.line(-64, -338, -18, -350), 5.5, col, 1006, d2); mk(P.line(18, -350, 64, -338), 5.5, col, 1007, d2) }   // sad brows: inner ends up
    else { mk(P.quad(-64, -340, -38, -352, -14, -342), 5, col, 1006, d2); mk(P.quad(14, -342, 38, -352, 64, -340), 5, col, 1007, d2) }
    mk(o.frown ? P.quad(-38, -232, 0, -258, 38, -232) : P.quad(-40, -246, 0, -218, 40, -246), 5.5, col, 1008, d2);
    mk(P.line(0, hy + hr - 2, 0, -168), 6.5, col, 1009, d1);                                    // neck
    mk(P.quad(-80, -158, 0, -178, 80, -158), 6.5, col, 1010, d1);                                // shoulders
    mk(P.line(0, -170, 0, 52), 6.5, col, 1011, d1);                                              // spine
    mk(P.quad(-42, 60, 0, 44, 42, 60), 6, col, 1012, d1);                                        // hips
    mk(P.quad(-32, 56, -62, 184, -86, 300), 6.5, col, 1013, d1);                                 // legs
    mk(P.quad(32, 56, 60, 184, 84, 300), 6.5, col, 1014, d1);
    mk(P.quad(-84, 300, -112, 316, -140, 300), 6, col, 1015, d3);                               // shoes
    mk(P.quad(84, 300, 112, 316, 140, 300), 6, col, 1016, d3);
    const sx = side * 74, sy = -160, ex = lerp(sx, rx, .5) + side * 10, ey = lerp(sy, ry, .5) + 46;
    mk(P.quad(sx, sy, ex, ey, rx, ry), 6.5, col, 1017, d2);                                      // reaching arm
    people_mitt(rx, ry, Math.atan2(ry - ey, rx - ex), 15, col, 1018, d3);
    const hx = -side * 108;
    mk(P.quad(-side * 74, sy, hx - side * 6, -40, hx, 68), 6.5, col, 1020, d2);                 // hanging arm
    people_mitt(hx + side * 2, 84, Math.PI / 2, 15, col, 1021, d3);
    people_ground(-160, 160, 328, col, 1030, d3);
    c.restore();
  };
  // an open hand of four separate fingers plus a thumb, holding whatever sits at the origin
  // hand: a hand seen from the back (thumb below), pointing right — jacket sleeve, buttoned shirt cuff and wrist on the left, then ONE continuous silhouette: a long back of the hand, index and middle finger extended (a hand that points or holds), ring and pinky curled short toward the palm, and the thumb hanging below from the heel; nails, knuckle arcs, joint creases, faint tendons; the extended fingers breathe; `flip` mirrors it so it points left
  ART.hand = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, es = o.es == null ? 99 : o.es, s = o.flip ? -1 : 1;
    const d1 = ease(es / .35), d2 = ease((es - .16) / .35), d3 = ease((es - .32) / .3), wig = Math.sin(t * 1.5) * 3;
    c.save(); c.scale(s, 1); c.translate(0, Math.sin(t * 1.1) * 2);
    const sleeve = [...P.line(-372, -122, -304, -118), ...P.quad(-304, -118, -290, 0, -304, 118), ...P.line(-304, 118, -372, 122)];
    shade(sleeve, .06); mk(sleeve, 6.5, col, 1100, d1);
    const cuff = [...P.line(-306, -104, -236, -100), ...P.quad(-236, -100, -226, 0, -236, 100), ...P.line(-236, 100, -306, 104), ...P.quad(-306, 104, -296, 0, -306, -104)];
    shade(cuff, .07); mk([...cuff, cuff[0]], 6, col, 1101, d1);
    mk(P.quad(-270, -96, -262, 0, -270, 96), 3.5, col, 1102, d2, .6);                          // cuff fold
    people_dot(-252, 58, 6, col, d3);                                                          // cuff button
    mk(P.line(-236, -72, -172, -76), 6, col, 1103, d1); mk(P.line(-236, 74, -172, 78), 6, col, 1104, d1);   // wrist
    // fingers top to bottom: pinky and ring curled (short, hooking toward the palm), middle and index extended; thumb from the heel, pointing down-right
    const F = [[96, -102, 196, -92, 20, -22, .3, 1], [110, -44, 244, -36, 24, -18, .5, 1], [114, 16, 334, 16, 25, 2, 1, 2], [104, 76, 310, 90, 24, 5, .8, 2]];   // bx by tx ty r bend breathe creases
    const fg = F.map(([bx, by, tx, ty, r, bend, k]) => people_finger(bx, by, tx + wig * k, ty, r, bend, .86));
    const th = people_finger(-40, 84, 96, 206, 31, 30, .82);
    const rev = f => f.open.slice().reverse(), A0 = f => f.open[0], B0 = f => f.open[f.open.length - 1];
    const pb = B0(fg[0]), ia = A0(fg[3]), tb = B0(th), ta = A0(th);
    const sil = [...P.quad(-172, -76, -50, -108, pb[0], pb[1]), ...rev(fg[0]), ...rev(fg[1]), ...rev(fg[2]), ...rev(fg[3]),
                 ...P.quad(ia[0], ia[1], 30, 100, tb[0], tb[1]), ...rev(th), ...P.quad(ta[0], ta[1], -130, 110, -172, 78)];
    shade(sil, .06); mk(sil, 6.5, col, 1105, d1);
    F.forEach(([bx, by, tx, ty, r, bend, k, nc], i) => {
      const f = fg[i], L = Math.hypot(tx - bx, ty - by), ux = (tx - bx) / L, uy = (ty - by) / L;
      people_nail(f.tip[0], f.tip[1], f.ang, r * .86, col, 1110 + i, d3);
      if (nc > 1) { people_crease(bx + ux * L * .46, by + uy * L * .46, f.ang, r, col, 1115 + i, d3); people_crease(bx + ux * L * .74, by + uy * L * .74, f.ang, r * .94, col, 1120 + i, d3) }
      else people_crease(bx + ux * L * .55 - uy * bend * .5, by + uy * L * .55 + ux * bend * .5, f.ang, r, col, 1115 + i, d3);
      mk(P.arc(bx - 6, by, r * .72, Math.PI * .58, Math.PI * 1.42), 4, col, 1125 + i, d2, .75);   // knuckle
    });
    people_nail(th.tip[0], th.tip[1], th.ang, 31 * .82, col, 1130, d3);
    people_crease(22, 140, th.ang, 31, col, 1131, d3);
    mk(P.arc(-26, 100, 22, Math.PI * .9, Math.PI * 1.6), 3.5, col, 1132, d3, .6);                 // thumb root fold
    mk(P.quad(-150, -30, -60, -66, 60, -84), 3, col, 1135, d3, .32);                              // tendons
    mk(P.quad(-150, -4, -50, -20, 70, -22), 3, col, 1136, d3, .32);
    mk(P.quad(-150, 24, -50, 36, 60, 44), 3, col, 1137, d3, .28);
    mk(P.arc(-200, 0, 76, -.4, .4), 3.5, col, 1138, d3, .5);                                      // wrist crease
    c.restore();
  };
  // hotel key card: rounded card with thickness, hatched magnetic stripe, the property's mark, embossed lines, insert arrow and contactless waves; `xray` makes it translucent and shows the RFID chip and its coil aerial glowing red
  ART.keycard = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, es = o.es ?? 99, w = 700, h = 440, r = 40;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    const body = security_rrect(-w / 2, -h / 2, w, h, r), edge = security_rrect(-w / 2 + 10, -h / 2 + 10, w, h, r);
    const nT = P.line(0, 0, w - 2 * r, 0).length, nS = P.line(0, 0, 0, h - 2 * r).length, nA = P.arc(0, 0, r, 0, Math.PI / 2).length;
    shade(edge, .04); mk(edge.slice(nT, nT + nA + nS + nA + nT + nA), 4.5, col, 7700, d0, .6);   // the card's thickness peeks out right and below
    if (o.xray) { c.save(); c.globalAlpha *= .5; shade(body, .10); c.restore() } else shade(body, .06);
    mk(body, 6.5, col, 7701, d0);
    const y0 = -h / 2 + 44, y1 = y0 + 72, sa = o.xray ? .45 : 1;
    mk(P.line(-w / 2 + 2, y0, w / 2 - 2, y0), 4.5, col, 7702, d1, sa); mk(P.line(-w / 2 + 2, y1, w / 2 - 2, y1), 4.5, col, 7703, d1, sa);   // the magnetic stripe
    for (let i = 0; i < 22; i++) { const x = -w / 2 + 18 + i * 31; mk(P.line(x, y1 - 5, x + 16, y0 + 5), 2.5, col, 7704 + i, d1, .36 * sa) }
    const sh = Math.sin(t * .8) * 14; mk(P.line(-262 + sh, 150, -196 + sh, 84), 3, col, 7730, d1, .4);   // a glint that drifts
    if (!o.xray) {
      mk(P.circle(-230, 90, 58), 4.5, col, 7731, d1);                                              // the property's mark
      mk([...P.line(-258, 122, -258, 96), ...P.arc(-230, 96, 28, Math.PI, TAU), ...P.line(-202, 96, -202, 122)], 4, col, 7732, d1);
      mk(P.line(-268, 122, -192, 122), 4, col, 7733, d1); security_dot(-230, 106, 6, col, d1); security_dot(-230, 54, 4, col, d1);
      mk(P.line(-140, 78, 60, 78), 4, col, 7734, d1, .8); mk(P.line(-140, 116, -10, 116), 4, col, 7735, d1, .6);   // embossed lines
      mk(P.line(w / 2 - 130, 115, w / 2 - 74, 115), 4.5, col, 7736, d1);                                             // insert arrow
      mk(P.poly([[w / 2 - 74, 132], [w / 2 - 74, 98], [w / 2 - 44, 115], [w / 2 - 74, 132]]), 4.5, col, 7737, d1);
      [16, 32, 48].forEach((rr, i) => mk(P.arc(w / 2 - 96, -40, rr, -1.05, 1.05), 4, col, 7740 + i, ease((es - .28 - i * .05) / .3), .9));   // contactless waves
    } else {
      const x = ease((es - .22) / .3), cut = security_rrect(-w / 2 + 34, -h / 2 + 34, w - 68, h - 68, 24);   // dashed cut-line
      for (let i = 0; i + 4 < cut.length; i += 8) mk(cut.slice(i, i + 5), 3, col, 7750 + i / 8, x, .8);
      const g = ease((es - .42) / .4), pulse = .72 + .28 * Math.sin(t * 5.2), R = ACC.red;
      if (g > 0) {
        for (let j = 0; j < 4; j++) { const ins = 56 + j * 15, coil = security_rrect(-w / 2 + ins, -h / 2 + ins, w - 2 * ins, h - 2 * ins, 30 - j * 4);
          mk(coil.slice(0, Math.round(coil.length * .97)), 3.2, R, 7780 + j, ease((es - .42 - j * .06) / .3), (.5 + .12 * j) * pulse) }   // the aerial: four turns of wire
        glow(R, 34 * pulse, () => { const chip = security_rrect(110, -34, 84, 68, 8); mk(chip, 5, R, 7790, g, g * pulse);
          mk(P.line(124, -12, 180, -12), 3, R, 7791, g, g * pulse * .8); mk(P.line(124, 12, 180, 12), 3, R, 7792, g, g * pulse * .8);
          mk(P.line(152, -24, 152, 24), 3, R, 7793, g, g * pulse * .8) });                                                         // the chip
        mk([...P.line(110, -4, 84, -4), ...P.line(84, -4, 84, -119)], 3.2, R, 7794, g, .7 * pulse);                                // leads: out of the chip, then up to the
        mk([...P.line(110, 4, 68, 4), ...P.line(68, 4, 68, -119)], 3.2, R, 7795, g, .7 * pulse);                                   // innermost turn of the aerial (y=-119)
        c.save(); c.fillStyle = R;                                                                                                  // sparks drifting up-right
        for (let i = 0; i < 12; i++) { const ph = (t * .7 + n1(i + 3)) % 1; c.globalAlpha *= 1; c.globalAlpha = (1 - ph) * .8 * g;
          c.beginPath(); c.arc(152 + jit(i, 120) + ph * 70, jit(i + 60, 80) - ph * 130, 2.8, 0, TAU); c.fill() }
        c.restore();
      }
    }
  };
  // door: hotel room door in its frame (architrave, mitred corners, hinges, threshold) — two bevelled panels, room plate, peephole, card reader with slot and LED, lever handle on a rose, kick plate; open/open_to/swing_over swing the leaf toward the viewer showing its thickness and the lit room behind; led = colour of the reader LED
  ART.door = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1, d2 } = places_layers(o.es), W2 = 200, H2 = 330;
    const open = clamp(o.open_to != null ? lerp(o.open || 0, o.open_to, ease(es / (o.swing_over || .7))) : (o.open || 0));
    const sw = W2 * (1 - open * .78), Lf = (x, y) => { const k = (x + W2) / (2 * W2); return [lerp(-W2, sw, k), y * (1 + open * 34 / H2 * k)] }, M = pts => places_map(pts, Lf);
    // floor, frame
    mk(P.line(-W2 - 110, H2 + 40, W2 + 140, H2 + 40), 4, col, 11900, d0, .45); places_ground(-W2 - 30, W2 + 40, H2 + 18, 11901, d1, .35);
    const fo = P.rect(-W2 - 42, -H2 - 42, 2 * W2 + 84, 2 * H2 + 42), fi = P.rect(-W2 - 14, -H2 - 14, 2 * W2 + 28, 2 * H2 + 14);
    shade([...fo], .06); shade(fi, .0); mk(fo, 6.5, col, 11950, d0); mk(fi, 4.5, col, 11951, d0);
    mk(P.line(-W2 - 42, -H2 - 42, -W2 - 14, -H2 - 14), 3, col, 11952, d1, .6); mk(P.line(W2 + 42, -H2 - 42, W2 + 14, -H2 - 14), 3, col, 11953, d1, .6);
    const th = P.rect(-W2 - 14, H2 - 6, 2 * W2 + 28, 12); shade(th, .12); mk(th, 4, col, 11954, d1);
    for (let i = 0; i < 3; i++) { const hy = [-H2 + 50, -20, H2 - 100][i]; mk(P.rect(-W2 - 12, hy, 14, 48), 3.2, col, 11955 + i, d1, .8); mk(P.line(-W2 - 12, hy + 16, -W2 + 2, hy + 16), 2.2, col, 11958 + i, d1, .6); mk(P.line(-W2 - 12, hy + 32, -W2 + 2, hy + 32), 2.2, col, 11961 + i, d1, .6) }
    // the room beyond, its light on the floor
    if (open > .05) { const gap = [[sw, -H2 - open * 34], [W2 + 14, -H2 - 14], [W2 + 14, H2], [sw, H2 + open * 34]]; shade(gap, .07 * open); mk([...gap, gap[0]], 4, col, 11970, d0, .8);
      const lit = [[sw + 10, H2 + 6], [W2 + 12, H2 + 6], [W2 + 130, H2 + 66], [sw - 30, H2 + 66]]; shade(lit, .05 * open);
      for (let k = 0; k < 5; k++) mk(P.line(sw + 20 + k * 40, H2 + 12, sw - 10 + k * 52, H2 + 60), 2.4, col, 11971 + k, d1, .3 * open) }
    // the leaf, its thickness, the details mapped onto it
    const leaf = M(P.rect(-W2, -H2, 2 * W2, 2 * H2)); shade(leaf, .11); mk(leaf, 6.5, col, 11980, d0);
    if (open > .05) { const tk = 24 * open, edge = [[sw, -H2 - open * 34], [sw + tk, -H2 - open * 34 + 8], [sw + tk, H2 + open * 34 - 8], [sw, H2 + open * 34]]; shade(edge, .16); mk([...edge, edge[0]], 5, col, 11981, d0);
      mk(P.rect(sw + 4, 22, tk - 8, 40), 2.6, col, 11982, d1, .7); mk(P.rect(sw + tk * .35, 30, tk * .3, 14), 2.2, col, 11983, d1, .8) }
    for (const [px, py, pw, ph] of [[-W2 + 36, -H2 + 50, 2 * W2 - 146, 170], [-W2 + 36, 100, 2 * W2 - 146, 150]]) {
      const outer = M(P.rect(px, py, pw, ph)), inner = M(P.rect(px + 14, py + 14, pw - 28, ph - 28)); shade(inner, .06); mk(outer, 4.5, col, 11984 + (py > 0), d1); mk(inner, 3, col, 11986 + (py > 0), d1, .6);
      for (const [qx, qy] of [[px, py], [px + pw, py], [px, py + ph], [px + pw, py + ph]]) { const [ax, ay] = Lf(qx, qy), [bx, by] = Lf(qx + (qx > px ? -14 : 14), qy + (qy > py ? -14 : 14)); mk(P.line(ax, ay, bx, by), 2.4, col, 11988 + (py > 0) * 4 + (qx > px) + (qy > py) * 2, d1, .5) } }
    mk(M(places_rr(-100, -318, 66, 22, 5)), 3.2, col, 11996, d1, .8); places_dot(...Lf(-92, -307), 2, col, .7 * d1); places_dot(...Lf(-42, -307), 2, col, .7 * d1);
    mk(M(P.circle(-37, -200, 10)), 3.4, col, 11997, d1); mk(M(P.circle(-37, -200, 4)), 2.4, col, 11998, d1, .7);
    mk(M(P.rect(-W2 + 16, H2 - 70, 2 * W2 - 32, 52)), 3.6, col, 11999, d1, .8); for (let k = 0; k < 4; k++) places_dot(...Lf(-W2 + 30 + k * 113, H2 - 44), 2.2, col, .6 * d1);
    const rd = places_rr(108, -150, 66, 118, 9); shade(M(rd), .1); mk(M(rd), 4.5, col, 12000, d1); mk(M(places_rr(120, -60, 42, 10, 5)), 3, col, 12001, d1, .9);
    mk(M(P.rect(118, -138, 46, 48)), 2.6, col, 12002, d1, .55); places_dot(...Lf(114, -144), 1.8, col, .6 * d1); places_dot(...Lf(168, -38), 1.8, col, .6 * d1);
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) places_dot(...Lf(126 + k * 15, -80 + r * 12), 2.2, col, .5 * d1);
    const rose = M(P.circle(140, 40, 17)); shade(rose, .12); mk(rose, 4, col, 12003, d1); mk(M(P.circle(140, 40, 6)), 2.6, col, 12004, d1, .7);
    const lev = M([...places_rr(52, 32, 96, 18, 9)]); shade(lev, .14); mk(lev, 4.5, col, 12005, d1); mk(M(P.line(60, 41, 120, 41)), 2.2, col, 12006, d1, .4);
    const [lx, ly] = Lf(140, -120);
    if (o.led) { const Lc = ACC[o.led] || ACC.green, p = .6 + .4 * Math.sin(t * 6); places_led(lx, ly, 8, Lc, 26 * p, d2 * p) }
    else { mk(P.circle(lx, ly, 7), 3, col, 12007, d1, .8); places_dot(lx, ly, 2.5, col, .6 * d1) }
  };
  // hotel door card reader: vertical unit on the door's free edge with a bevelled card slot, insert arrow, ringed LED (`led` colour, `flare` bursts it), speaker holes, maker's strip, lever handle on its rosette and a keyed override cylinder
  ART.reader = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, es = o.es ?? 99, L = ACC[o.led || 'green'] || ACC.green;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    mk(P.line(-420, -370, -420, 370), 5, col, 7800, d0, .8); mk(P.line(-396, -370, -396, 370), 3, col, 7801, d0, .45);   // the door's edge and the frame
    const px = -150, py = -330, pw = 300, ph = 630, r = 30, ox = 20, oy = -10;
    const back = security_rrect(px + ox, py + oy, pw, ph, r), front = security_rrect(px, py, pw, ph, r);
    const nT = P.line(0, 0, pw - 2 * r, 0).length, nS = P.line(0, 0, 0, ph - 2 * r).length, nA = P.arc(0, 0, r, 0, Math.PI / 2).length;
    shade(back, .04); mk(back.slice(0, nT + nA + nS + nA), 5, col, 7802, d0, .7);                 // the unit stands off the door
    const k = r * (1 - .707);
    mk(P.line(px + k, py + k, px + k + ox, py + k + oy), 5, col, 7803, d0, .7); mk(P.line(px + pw - k, py + ph - k, px + pw - k + ox, py + ph - k + oy), 5, col, 7804, d0, .7);
    shade(front, .06); mk(front, 7, col, 7805, d0);
    [[-120, -300], [120, -300], [-120, 270], [120, 270]].forEach(([x, y], i) => { mk(P.circle(x, y, 8), 3, col, 7806 + i, d1, .8); mk(P.line(x - 4, y - 4, x + 4, y + 4), 2.5, col, 7810 + i, d1, .8) });   // screws
    const bevel = security_rrect(-116, -286, 232, 46, 10); shade(bevel, .1); mk(bevel, 4, col, 7815, d1, .7);   // the card slot
    security_hole(P.rect(-100, -271, 200, 16), d1); mk(P.rect(-100, -271, 200, 16), 3.5, col, 7816, d1);
    mk(P.poly([[-14, -318], [14, -318], [0, -300], [-14, -318]]), 3.5, col, 7817, d1);           // insert arrow
    mk(P.circle(0, -150, 40), 4.5, col, 7818, d1); mk(P.circle(0, -150, 29), 3, col, 7819, d1, .5);   // the LED and its ring
    const g = ease((es - .4) / .3), p = .6 + .4 * Math.sin(t * 5.5);
    if (g > 0) { glow(L, (o.flare ? 150 : 44) * p, () => security_dot(0, -150, 22 + (o.flare ? 48 * p : 0), L, g * p));
      if (o.flare) for (let i = 0; i < 8; i++) { const a = i * TAU / 8 + .2, r0 = 62 + 18 * p, r1 = r0 + 30 + 22 * p;
        mk(P.line(Math.cos(a) * r0, -150 + Math.sin(a) * r0, Math.cos(a) * r1, -150 + Math.sin(a) * r1), 3.5, L, 7820 + i, g, .8 * p) } }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 5; i++) security_dot(-28 + i * 14, -74 + j * 14, 3.5, col, d1 * .8);   // speaker holes
    const strip = security_rrect(-64, -22, 128, 26, 8); mk(strip, 3.5, col, 7830, d1, .6); mk(P.line(-48, -9, 48, -9), 3, col, 7831, d1, .4);   // maker's strip
    const ros = P.circle(0, 120, 54); shade(ros, .08); mk(ros, 5.5, col, 7832, d1);              // the rosette
    mk(P.circle(0, 120, 32), 3.5, col, 7833, d1, .7);
    mk(P.line(46, 104, 84, 104), 5, col, 7834, d1); mk(P.line(46, 138, 84, 138), 5, col, 7835, d1);   // the lever's neck
    const grip = security_rrect(78, 98, 250, 44, 22); shade(grip, .07); mk(grip, 6.5, col, 7836, d1);   // the lever handle
    mk(P.line(96, 108, 300, 108), 3, col, 7837, d1, .45); mk(P.arc(306, 120, 12, -Math.PI / 2, Math.PI / 2), 3, col, 7838, d1, .5);
    mk(P.circle(0, 236, 24), 4.5, col, 7840, d1); mk(P.circle(0, 236, 12), 3, col, 7841, d1, .6); mk(P.line(0, 224, 0, 248), 4, col, 7842, d1);   // keyed override
    security_hatch(-90, 150, 328, 8, col, 7850, d1);
  };
  // phone: smartphone straight on — rounded body with edge thickness, volume and power buttons, screen with notch (speaker slit + camera), status bar (signal bars, battery), a notification card (avatar, two lines, unread dot), a 4x5 app grid with glyphs, dock, home bar, glass glint; three blue arcs keep pulsing from its right side as before
  ART.phone = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1, d2 } = devices_layers(o.es);
    devices_ground(-150, 160, 386, 5200, d0);
    // body, right-edge thickness, side buttons
    const body = devices_rr(-172, -352, 344, 704, 52); shade(body, .05); mk(body, 7, col, 5240, d0);
    mk(P.line(178, -290, 178, 290), 4, col, 5241, d0, .5);
    mk(P.rect(-183, -212, 9, 54), 3.5, col, 5242, d1, .8); mk(P.rect(-183, -144, 9, 54), 3.5, col, 5243, d1, .8);
    mk(P.rect(174, -196, 9, 86), 3.5, col, 5244, d1, .8);
    // screen and notch
    const scr = devices_rr(-150, -324, 300, 648, 30); shade(scr, .025); mk(scr, 4, col, 5245, d1, .9);
    const notch = devices_rr(-48, -324, 96, 28, 13); shade(notch, .12); mk(notch, 3.5, col, 5246, d1);
    mk(P.line(-26, -310, 6, -310), 3, col, 5247, d1, .8); devices_dot(24, -310, 5.5, col, d1); mk(P.circle(24, -310, 8), 2, col, 5320, d1, .5);
    // status bar: signal bars left, battery right
    for (let i = 0; i < 4; i++) mk(P.line(-132 + i * 10, -284, -132 + i * 10, -292 - i * 4), 3.5, col, 5248 + i, d1, .85);
    mk(P.rect(96, -298, 36, 18), 3, col, 5252, d1, .85); mk(P.line(135, -294, 135, -284), 3.5, col, 5253, d1, .85);
    c.save(); c.globalAlpha *= d1 * .8; c.fillStyle = col; c.fillRect(100, -294, 24, 10); c.restore();
    // notification card: avatar, two lines, an unread dot that breathes
    const card = devices_rr(-134, -264, 268, 86, 14); shade(card, .06); mk(card, 3.5, col, 5254, d1, .9);
    mk(P.circle(-100, -221, 21), 3.5, col, 5255, d1, .9); mk(P.arc(-100, -212, 12, Math.PI * 1.15, Math.PI * 1.85), 3, col, 5321, d1, .7); devices_dot(-100, -228, 6, col, d1 * .8);
    mk(P.line(-66, -234, 62, -234), 4.5, col, 5256, d1, .85); mk(P.line(-66, -208, 24, -208), 3.5, col, 5257, d1, .6);
    devices_dot(112, -243, 6, ACC.blue, d2 * (.6 + .4 * Math.sin(t * 3)));
    // app grid 4x5, staggered draw-on, a tiny glyph in each
    for (let r = 0; r < 5; r++) for (let k = 0; k < 4; k++) {
      const x = -122 + k * 68, y = -156 + r * 68, i = r * 4 + k, da = ease((es - .28 - i * .022) / .28);
      const app = devices_rr(x, y, 50, 50, 12); shade(app, .05); mk(app, 3, col, 5260 + i, da, .85);
      if (i % 3 === 0) devices_dot(x + 25, y + 25, 7, col, .7 * da); else if (i % 3 === 1) mk(P.line(x + 13, y + 25, x + 37, y + 25), 3.5, col, 5280 + i, da, .6); else mk(P.circle(x + 25, y + 25, 9), 2.5, col, 5280 + i, da, .6);
    }
    // dock + home bar
    const dock = devices_rr(-136, 222, 272, 66, 18); shade(dock, .09); mk(dock, 3.5, col, 5300, d1, .8);
    for (let k = 0; k < 4; k++) { const app = devices_rr(-116 + k * 66, 230, 50, 50, 12); shade(app, .05); mk(app, 3, col, 5301 + k, d2, .85) }
    mk(P.line(-44, 306, 44, 306), 5, col, 5306, d1, .7);
    // glint on the glass
    mk(P.line(-118, -304, -62, -304), 3, col, 5307, d1, .3); mk(P.line(-137, -286, -137, -186), 3, col, 5308, d1, .3);
    // the phone is talking: three arcs pulsing out of its right side
    if (d2 > 0) for (let k = 0; k < 3; k++) { const ph = (t * .9 + k / 3) % 1; mk(P.arc(190, -40, 60 + ph * 150, -.95, .95), 5, ACC.blue, 5310 + k, 1, (1 - ph) * d2) }
  };
  // corridor: hotel corridor in one-point perspective — carpet runner with cross bands, baseboards, ceiling lights with their pools on the floor, doors receding on both walls (frame, plate, handle, card reader), a picture and a sconce on the right wall, an exit door at the far end; led = colour of the reader LEDs and the exit light (default green)
  ART.corridor = (t, u, o = {}) => {
    const col = o.col || WHITE, L = ACC[o.led || 'green'] || ACC.green, { es, d0, d1, d2 } = places_layers(o.es);
    const VX = 70, VY = -40, XL = -432, XR = 432, YC = -380, YF = 400, D = 1.2, ZF = 8;
    const pj = (px, py, z) => { const s = D / (D + z); return [VX + (px - VX) * s, VY + (py - VY) * s] }, sc = z => D / (D + z);
    const rect3 = (px0, py0, px1, py1, z0, z1) => [pj(px0, py0, z0), pj(px1, py1, z0), pj(px1, py1, z1), pj(px0, py0, z1)];
    let sd = 12100;
    // walls, floor, ceiling
    const fl = [pj(XL, YF, 0), pj(XR, YF, 0), pj(XR, YF, ZF), pj(XL, YF, ZF)]; shade(fl, .035);
    const lw = [pj(XL, YC, 0), pj(XL, YF, 0), pj(XL, YF, ZF), pj(XL, YC, ZF)]; shade(lw, .05);
    const rw = [pj(XR, YC, 0), pj(XR, YF, 0), pj(XR, YF, ZF), pj(XR, YC, ZF)]; shade(rw, .05);
    const ew = [pj(XL, YC, ZF), pj(XR, YC, ZF), pj(XR, YF, ZF), pj(XL, YF, ZF)]; shade(ew, .07);
    for (const [px, py] of [[XL, YC], [XR, YC], [XL, YF], [XR, YF]]) { const a = pj(px, py, 0), b = pj(px, py, ZF); mk(P.line(a[0], a[1], b[0], b[1]), 6, col, sd++, d0) }
    mk([...ew, ew[0]], 4.5, col, sd++, d0);
    for (const px of [XL, XR]) { const a = pj(px, YF - 16, 0), b = pj(px, YF - 16, ZF); mk(P.line(a[0], a[1], b[0], b[1]), 3.2, col, sd++, d1, .6) }
    // carpet runner and its bands
    for (const px of [-250, 250]) { const a = pj(px, YF, 0), b = pj(px, YF, ZF); mk(P.line(a[0], a[1], b[0], b[1]), 3.6, col, sd++, d1, .55) }
    for (const z of [.25, .7, 1.25, 1.9, 2.7, 3.7, 5, 6.6]) { const a = pj(-250, YF, z), b = pj(250, YF, z); mk(P.line(a[0], a[1], b[0], b[1]), 2.6, col, sd++, d1, .3) }
    // far end: exit door with its light
    const ed = rect3(-120, -210, 120, YF, ZF, ZF); mk([...ed, ed[0]], 3.2, col, sd++, d1, .9); const eh = pj(90, 110, ZF); places_dot(eh[0], eh[1], 2, col, d1);
    const ex = pj(0, -260, ZF); glow(L, 12, () => { const c = A.ctx; c.save(); c.fillStyle = L; c.globalAlpha *= d2 * .85; c.fillRect(ex[0] - 9, ex[1] - 4, 18, 8); c.restore() });
    // ceiling lights and their pools
    for (const z of [.35, 1.15, 2.05, 3.1, 4.4]) { const ring = [], pool = []; for (let k = 0; k <= 24; k++) { const a = TAU * k / 24; ring.push(pj(Math.cos(a) * 80, YC, z + Math.sin(a) * .1)); pool.push(pj(Math.cos(a) * 105, YF, z + Math.sin(a) * .14)) }
      shade(ring, .12); mk(ring, 3.4, col, sd++, d1, .8); mk(pool, 2.2, PALE, sd++, d1, .16);
      const cc = pj(0, YC, z), s = sc(z), pl = .9 + .1 * Math.sin(t * 2 + z); places_led(cc[0], cc[1] + 4 * s, 22 * s * pl, PALE, 24 * s, d2 * .35) }
    // doors on both walls, far to near
    const doors = [];
    for (const z of [.12, 1.02, 1.92, 2.82]) doors.push([XL, z, 1]);
    for (const z of [.57, 1.47, 2.37, 3.27]) doors.push([XR, z, -1]);
    doors.sort((a, b) => b[1] - a[1]);
    doors.forEach(([px, z0, dir], i) => {
      const z1 = z0 + .42, k = doors.length - 1 - i, d = ease((es - .1 - k * .05) / .3), dd = ease((es - .3 - k * .03) / .3), s = sc(z0), inn = -dir * 8;   // leaf recessed 8 px into the wall plane
      const fr = rect3(px, -215, px, YF, z0, z1); shade(fr, .09); mk([...fr, fr[0]], 4 + 3 * s, col, sd++, d);
      const zn = (D + z0) * (px + inn - VX) / (px - VX) - D;                                 // the leaf's near edge lands on the near jamb: the wall would hide anything nearer
      const rev = [pj(px, -215, z1), pj(px + inn, -205, z1), pj(px + inn, YF - 4, z1), pj(px, YF, z1)]; shade(rev, .02);   // far reveal, in shadow
      const lf = rect3(px + inn, -205, px + inn, YF - 4, zn, z1); shade(lf, .05); mk([...lf, lf[0]], 2.5 + 2 * s, col, sd++, d, .85);
      if (s > .3) { const zh = z1 - .12, zr = z1 - .14;
        const hd = [pj(px + inn, 96, zh - .06), pj(px + inn, 96, zh + .05)]; mk(P.line(hd[0][0], hd[0][1], hd[1][0], hd[1][1]), 3 + 3 * s, col, sd++, dd);
        const rd = rect3(px + inn, -30, px + inn, 60, zr - .05, zr + .04); mk([...rd, rd[0]], 2 + 2 * s, col, sd++, dd, .8);
        const pl8 = rect3(px + inn, -160, px + inn, -140, zh - .1, zh + .03); mk([...pl8, pl8[0]], 2 + 1.5 * s, col, sd++, dd, .7);
        if (s > .5) { const pp = pj(px + inn, -120, (z0 + z1) / 2); mk(P.circle(pp[0], pp[1], 5 * s), 2.4, col, sd++, dd, .7);
          const kp = rect3(px + inn, YF - 60, px + inn, YF - 24, z0 + .06, z1 - .06); mk([...kp, kp[0]], 2.4, col, sd++, dd, .5) } }
      const lp = pj(px + inn, -22, z1 - .14), p = .55 + .45 * Math.sin(t * 5 + i * 1.3);
      places_led(lp[0], lp[1], 3 + 5 * s, L, 20 * s * p + 6, d2 * p);
    });
    // right wall: a picture between the first doors, a sconce further on
    const pic = rect3(XR - 8, -170, XR - 8, -70, .16, .46); shade(pic, .08); mk([...pic, pic[0]], 3.6, col, sd++, d1); const pin = rect3(XR - 8, -155, XR - 8, -85, .2, .42); mk([...pin, pin[0]], 2.4, col, sd++, d1, .5);
    const sc0 = pj(XR - 8, -120, 1.2), sc1 = pj(XR - 8, -120, 1.3); mk(P.arc(sc0[0], sc0[1], 12 * sc(1.2), Math.PI, TAU), 3, col, sd++, d1, .8); places_led(sc0[0], sc0[1] - 3, 5 * sc(1.2), PALE, 12, d2 * .5); mk(P.line(sc0[0], sc0[1], sc1[0], sc1[1] + 14 * sc(1.2)), 2.4, col, sd++, d1, .5);
  };
  // a hand-lettered price tag: pointed end with its string hole and string, the label text in the accent colour, a dashed marker leader with an end dot when `leader` is set; `text` is the label, `col` its colour
  ART.tag = (t, u, o = {}) => {
    const c = A.ctx, col = ACC[o.col] || o.col || ACC.yellow, d = ease(o.es / .28), txt = (o.text || '').toUpperCase();
    c.save(); c.font = `800 60px Manrope`; const w = c.measureText(txt).width + 62; c.restore();
    const body = [[-w / 2 - 44, 0], [-w / 2, -46], [w / 2, -46], [w / 2, 46], [-w / 2, 46]];
    shade(body, .05); mk(data_closed(body), 5, col, 5700, d);
    mk(P.circle(-w / 2 - 18, 0, 8), 3.5, col, 5701, ease((o.es - .1) / .25));                          // the hole
    mk(P.quad(-w / 2 - 26, 0, -w / 2 - 72, 8 + Math.sin(t * 1.1) * 4, -w / 2 - 80, 46), 3.2, col, 5702, ease((o.es - .15) / .25), .8);   // the string
    c.save(); c.globalAlpha *= d; c.fillStyle = col; c.font = `800 60px Manrope`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, 0, 4); c.restore();
    if (o.leader) { const g = ease((o.es - .2) / .3);
      data_dash(w / 2, 10, w / 2 + 150, 120, 16, 12, 3.2, col, 5710, g, .85);
      data_dot(w / 2 + 150, 120, 6, col, ease((o.es - .45) / .15)) }
  };
  // room: hotel room from its doorway — back wall with a blind-covered window and curtains, framed print, wall-mounted TV over a dresser, bed in 3/4 with quilted headboard, two pillows, turned-down duvet and runner stripe, nightstand with a lamp, rug, closet with slatted doors on the right wall, ceiling pendant
  ART.room = (t, u, o = {}) => {
    const col = o.col || WHITE, { es, d0, d1, d2 } = places_layers(o.es), VP = [0, -20];
    let sd = 12300;
    // the box of the room
    const back = P.rect(-300, -320, 600, 410); shade(back, .045);                       // wall/floor junction at y=90: the furniture stands on the floor trapezoid below it
    shade([[-300, 90], [300, 90], [440, 400], [-440, 400]], .03); shade([[-440, -420], [-300, -320], [-300, 90], [-440, 400]], .06); shade([[440, -420], [300, -320], [300, 90], [440, 400]], .06);
    mk(back, 6.5, col, sd++, d0); for (const [x0, y0, x1, y1] of [[-440, -420, -300, -320], [440, -420, 300, -320], [-440, 400, -300, 90], [440, 400, 300, 90]]) mk(P.line(x0, y0, x1, y1), 5.5, col, sd++, d0, .8);
    // window with blinds and curtains, curtain rod
    const win = P.rect(-232, -270, 200, 210); shade(win, .02); mk(win, 5, col, sd++, d1); mk(P.rect(-222, -260, 180, 190), 3, col, sd++, d1, .6); mk(P.line(-132, -260, -132, -70), 3, col, sd++, d1, .6);
    for (let k = 0; k < 9; k++) mk(P.line(-220, -250 + k * 21, -44, -250 + k * 21), 2.4, col, sd++, d1, .4);
    mk(P.line(-276, -288, 12, -288), 4, col, sd++, d1); places_dot(-278, -288, 5, col, d1); places_dot(14, -288, 5, col, d1);
    for (const [cx, dir] of [[-262, 1], [-2, -1]]) { const cur = [[cx - dir * 0, -286], [cx + dir * 32, -286], [cx + dir * 40, -180], [cx + dir * 30, -60], [cx + dir * 42, -20], [cx - dir * 4, -20]]; shade(cur, .1); mk([...cur, cur[0]], 4.5, col, sd++, d1);
      for (let k = 1; k < 4; k++) mk(P.quad(cx + dir * k * 9, -284, cx + dir * (k * 10 + 4), -160, cx + dir * (k * 9 + 2), -24), 2.4, col, sd++, d1, .45) }
    // print on the wall, TV on its bracket, dresser
    mk(P.rect(96, -262, 130, 96), 4.5, col, sd++, d1); mk(P.rect(108, -250, 106, 72), 2.6, col, sd++, d1, .5);
    mk([[112, -196], [140, -228], [160, -206], [176, -222], [206, -196]], 3, col, sd++, d1, .7); mk(P.circle(190, -238, 6), 2.4, col, sd++, d1, .6);
    const tv = P.rect(88, -140, 190, 108); shade(tv, .12); mk(tv, 5, col, sd++, d1); mk(P.rect(96, -132, 174, 92), 2.6, col, sd++, d1, .5); mk(P.line(183, -32, 183, -20), 3, col, sd++, d1, .6);
    places_box(110, 120, 270, 250, VP, .88, col, sd, d1); sd += 3; mk(P.line(110, 165, 270, 165), 2.8, col, sd++, d1, .5); mk(P.line(110, 208, 270, 208), 2.8, col, sd++, d1, .5);
    for (const y of [143, 186, 229]) mk(P.line(178, y, 202, y), 3, col, sd++, d1, .7);
    // nightstand beside the headboard against the back wall, lamp on its top; drawn before the bed so the bed's near side occludes it
    places_box(0, 40, 80, 110, VP, .9, col, sd, d1); sd += 3; mk(P.line(12, 76, 68, 76), 2.6, col, sd++, d1, .6); places_dot(40, 58, 3, col, d1 * .8);
    mk(places_ell(40, 38, 16, 5), 3, col, sd++, d1); mk(P.line(40, 36, 40, -20), 4, col, sd++, d1);
    const lsh = [[4, -4], [76, -4], [64, -58], [16, -58]]; shade(lsh, .1); mk([...lsh, lsh[0]], 4.5, col, sd++, d1); const gp = .8 + .2 * Math.sin(t * 1.5); places_led(40, -14, 14 * gp, PALE, 22 * gp, d2 * .22);
    // bed: headboard, mattress top, right face, front face, base, pillows, duvet fold, runner
    const hb = [...P.line(-270, -20, -270, -120), ...P.arc(-250, -120, 20, Math.PI, Math.PI * 1.5), ...P.line(-250, -140, -30, -140), ...P.arc(-30, -120, 20, Math.PI * 1.5, TAU), ...P.line(-10, -120, -10, -20)];
    shade([...hb, [-270, -20]], .08); mk(hb, 5.5, col, sd++, d0); places_hatch([[-262, -132], [-18, -132], [-18, -28], [-262, -28]], 34, .78, 2.2, col, sd, d1, .3, 20); sd += 20; places_hatch([[-262, -132], [-18, -132], [-18, -28], [-262, -28]], 34, -.78, 2.2, col, sd, d1, .3, 20); sd += 20;
    const bm = (u_, v) => [lerp(lerp(-270, -10, u_), lerp(-350, 50, u_), v), lerp(-20, 190, v)];
    const mtop = [bm(0, 0), bm(1, 0), bm(1, 1), bm(0, 1)]; shade(mtop, .09);
    const mright = [bm(1, 0), bm(1, 1), [50, 230], [-10, 20]]; shade(mright, .04); mk([...mright, mright[0]], 4.5, col, sd++, d0);
    const mfront = [[-350, 190], [50, 190], [50, 232], [-350, 232]]; shade(mfront, .06); mk(mfront, 5.5, col, sd++, d0); mk([...mtop, mtop[0]], 6, col, sd++, d0);
    const base = [[-340, 232], [40, 232], [40, 252], [-340, 252]]; shade(base, .02); mk([...base, base[0]], 3.6, col, sd++, d1, .7);
    for (const [u0, u1] of [[.06, .46], [.54, .94]]) { const pw = places_map(places_rr(0, 0, 100, 60, 16), (x, y) => bm(lerp(u0, u1, x / 100), y / 60 * .2 + .03)); shade(pw, .14); mk(pw, 4, col, sd++, d1); mk(places_map(P.line(12, 30, 88, 30), (x, y) => bm(lerp(u0, u1, x / 100), .1)), 2.2, col, sd++, d1, .4) }
    const fold = []; for (let k = 0; k <= 20; k++) { const uu = k / 20; const p = bm(uu, .36 + .012 * Math.sin(k * 1.7)); fold.push(p) } mk(fold, 4.5, col, sd++, d1);
    mk(places_map(P.line(0, 0, 100, 0), (x) => bm(x / 100, .33)), 2.6, col, sd++, d1, .4);
    const run = [bm(0, .68), bm(1, .68), bm(1, .82), bm(0, .82)]; shade(run, .09); mk([...run, run[0]], 3.6, col, sd++, d1, .8); places_hatch(run, 16, -.6, 2, col, sd, d1, .25, 30); sd += 30;
    for (let k = 0; k < 4; k++) mk(P.line(-300 + k * 100, 196, -304 + k * 100, 228), 2.4, col, sd++, d1, .35);
    // rug, closet on the right wall, pendant
    const rug = places_rr(-190, 268, 300, 76, 26); shade(rug, .06); mk(rug, 4, col, sd++, d1, .8); mk(places_rr(-176, 278, 272, 56, 18), 2.6, col, sd++, d1, .45);
    const wy = x => [lerp(-320, -370, (x - 300) / 140), lerp(90, 400, (x - 300) / 140)];
    const cl = [[330, wy(330)[0]], [406, wy(406)[0]], [406, wy(406)[1]], [330, wy(330)[1]]]; shade(cl, .07); mk([...cl, cl[0]], 4.5, col, sd++, d1);
    mk(P.line(368, wy(368)[0], 368, wy(368)[1]), 3, col, sd++, d1, .7);
    for (let k = 1; k < 7; k++) { const f = k / 7; mk(P.line(336, lerp(wy(336)[0], wy(336)[1], f), 400, lerp(wy(400)[0], wy(400)[1], f)), 2.2, col, sd++, d1, .35) }
    places_dot(360, -40, 2.6, col, d1 * .8); places_dot(376, -40, 2.6, col, d1 * .8);
    mk(P.line(0, -420, 0, -372), 3.6, col, sd++, d1); const pd = [[-34, -372], [34, -372], [22, -344], [-22, -344]]; shade(pd, .1); mk([...pd, pd[0]], 4, col, sd++, d1);
  };

  // writer: the keycard writer — a wedge desk unit (angled top face, front lip with seam, right side, cable with strain relief), LCD with two lines of text and a progress bar that fills, blinking LED, 3x4 keypad, antenna pad with a four-turn coil, and a keycard with chip floating above it while the field arcs rise from the coil in the beam colour (default red)
  ART.writer = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, R = ACC[o.beam || 'red'] || ACC.red, { es, d0, d1, d2 } = tools_layers(o.es);
    tools_ground(-300, 330, 192, 8800, d0, .4);
    const side = [[300, -140], [334, -118], [334, 148], [300, 166]]; side.push(side[0]);
    shade(side, .03); mk(side, 5.5, col, 8840, d0);
    const lip = tools_rr(-300, 106, 600, 60, 10); shade(lip, .05); mk(lip, 6, col, 8841, d0);
    mk(P.line(-280, 136, 280, 136), 2.5, col, 8842, d1, .35);                                  // seam across the lip
    const top = tools_rr(-300, -150, 600, 262, 22); shade(top, .07); mk(top, 6.5, col, 8843, d0);
    mk(P.rect(-326, 118, 28, 26), 4, col, 8844, d1);                                            // strain relief and cable
    mk([...P.quad(-326, 131, -392, 131, -404, 178), ...P.quad(-404, 178, -418, 226, -372, 246).slice(1)], 5, col, 8845, d1, .9);
    const bez = tools_rr(-272, -124, 200, 118, 8); shade(bez, 0); mk(bez, 5, col, 8850, d1);   // the screen
    mk(tools_rr(-260, -112, 176, 94, 4), 3, col, 8851, d1, .5);
    mk(tools_wiggle(-246, -88, -126, -88, 4, 6), 3, col, 8852, d1, .85); mk(tools_wiggle(-246, -66, -160, -66, 4, 4.5), 3, col, 8853, d1, .85);
    if (Math.sin(t * 6) > 0) mk(P.line(-150, -76, -150, -58), 3, col, 8855, d1);              // cursor
    mk(P.rect(-246, -46, 150, 16), 3, col, 8854, d1, .8);                                       // progress bar filling up
    const seg = Math.floor((t * 1.5) % 10); for (let k = 0; k < seg; k++) tools_bar(-243 + k * 16.5, -43, 13, 10, col, .9 * d2);
    mk(P.circle(-52, -110, 10), 3.5, col, 8856, d1); tools_dot(-52, -110, 6, R, (Math.sin(t * 5) > -.2 ? 1 : .25) * d2);   // LED
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) { const x = -258 + j * 50, y = 22 + i * 30; shade(P.circle(x, y, 11), .12); mk(P.circle(x, y, 11), 3.5, col, 8860 + i * 4 + j, d1) }   // keypad
    mk(tools_rr(-20, -128, 300, 224, 18), 3.5, col, 8872, d1, .7);                              // antenna pad and its coil
    mk(tools_spiral(130, -16, 112, 24, 4), 4, col, 8873, d1, .85);
    for (let k = 0; k < 3; k++) { const ph = (t * 1.1 + k / 3) % 1; mk(P.arc(130, -16, 84 + ph * 168, -Math.PI / 2 - .85, -Math.PI / 2 + .85), 5, R, 8880 + k, 1, (1 - ph) * d2 * .9) }   // the field
    c.save(); c.translate(130, -292 + Math.sin(t * 1.3) * 6); c.rotate(-.1);                    // the card, hovering
    const card = tools_rr(-135, -80, 270, 160, 14); shade(card, .06); mk(card, 6, col, 8890, d2);
    mk(P.rect(-100, -30, 46, 36), 3.5, col, 8891, d2); mk(P.line(-100, -18, -54, -18), 2.5, col, 8892, d2, .7); mk(P.line(-100, -6, -54, -6), 2.5, col, 8893, d2, .7); mk(P.line(-77, -30, -77, 6), 2.5, col, 8894, d2, .7);   // the chip
    mk(P.line(-100, 40, 60, 40), 3, col, 8895, d2, .6); mk(P.line(-100, 56, 20, 56), 3, col, 8896, d2, .6); mk(P.line(-115, -52, 115, -52), 3, col, 8897, d2, .45);
    c.restore();
  };
  // blank white keycards fanned out (`count` of them; a lone card is drawn hero-size): rounded corners, magnetic stripe, signature panel, card thickness; `chip` reveals the forged contactless chip in the clear band between stripe and panel, with its contact grid, antenna coil and the rippling contactless arcs, in that colour
  ART.blank = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, w = 400, h = 252, n = Math.max(1, o.count || 2), mid = (n - 1) / 2, m = Math.max(1, n - 1);
    const sc = n === 1 ? 1.4 : 1, lw = v => v / sc;                                                    // one card alone scales to 560x352; stroke widths stay the same on screen
    const step = Math.min(230, 400 / m), ystep = Math.min(70, 240 / m), rot = Math.min(.16, .5 / m), lag = Math.min(.22, .4 / n);
    for (let i = 0; i < n; i++) { const d = ease((o.es - i * lag) / .34), d2 = ease((o.es - .12 - i * lag) / .3), B = 5800 + i * 40;
      c.save(); c.translate((i - mid) * step, (i - mid) * -ystep); c.rotate((i - mid) * rot); c.scale(sc, sc);
      const body = data_rrect(-w / 2, -h / 2, w, h, 26); shade(body, .06); mk(body, lw(6.5), col, B, d);
      mk(P.line(-w / 2 + 30, h / 2 + 7, w / 2 - 20, h / 2 + 7), lw(3.2), col, B + 1, d2, .6); mk(P.line(w / 2 + 7, -h / 2 + 30, w / 2 + 7, h / 2 - 20), lw(3.2), col, B + 2, d2, .6);   // card thickness
      const stripe = P.rect(-w / 2, -h / 2 + 30, w, 38); shade(stripe, .16); mk(stripe, lw(3.8), col, B + 3, d2, .8);   // magnetic stripe (y -96..-58)
      mk(P.rect(-w / 2 + 34, 44, w - 150, 34), lw(3.2), col, B + 4, d2, .6);                                              // signature panel (y 44..78)
      for (let k = 0; k < 3; k++) mk(P.line(-w / 2 + 60 + k * 40, 76, -w / 2 + 84 + k * 40, 46), lw(2.4), col, B + 5 + k, d2, .3);
      if (o.chip) { const R = ACC[o.chip] || col, g = ease((o.es - .2 - i * lag) / .3), pulse = .8 + .2 * Math.sin(t * 4 + i);
        for (let k = 0; k < 2; k++) mk(data_rrect(-w / 2 + 14 + k * 10, -h / 2 + 14 + k * 10, w - 28 - k * 20, h - 28 - k * 20, 20), lw(2.8), R, B + 8 + k, g, .35);   // antenna coil round the rim, clear of the stripe
        glow(R, 18 * pulse, () => { const chip = data_rrect(-140, -48, 92, 64, 10); shade(chip, .04); mk(chip, lw(5), R, B + 10, g, .95);   // the chip (y -48..16) and its contacts
          mk(data_rrect(-110, -30, 32, 28, 6), lw(3), R, B + 11, g, .9);
          mk(P.line(-140, -30, -110, -30), lw(3), R, B + 12, g, .8); mk(P.line(-140, -2, -110, -2), lw(3), R, B + 13, g, .8);
          mk(P.line(-78, -30, -48, -30), lw(3), R, B + 14, g, .8); mk(P.line(-78, -2, -48, -2), lw(3), R, B + 15, g, .8);
          mk(P.line(-94, -48, -94, -30), lw(3), R, B + 16, g, .8); mk(P.line(-94, -2, -94, 16), lw(3), R, B + 17, g, .8) });
        for (let k = 0; k < 3; k++) mk(P.arc(-48, -16, 22 + k * 16, -.65, .65), lw(3.4), R, B + 20 + k, ease((o.es - .3 - i * lag - k * .06) / .25), .5 + .5 * Math.sin(t * 4 + i - k * .9));   // its field: the contactless arcs, rippling outward, kept between stripe and panel
        }
      c.restore() }
  };
  // crowbar: a wrecking bar lying diagonally on the carpet — hex shaft with its facet line, flat chisel end with nail slot at lower left, gooseneck curling up into a forked claw at upper right, cast-shadow dashes and carpet tufts; no draws the big cross-out in no_col over it
  ART.crowbar = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1 } = tools_layers(o.es);
    const tufts = [[-340, 220], [-250, 262], [-120, 240], [-20, 276], [90, 250], [200, 226], [300, 262], [350, 150], [330, -20], [-330, -60], [-230, -150], [-90, -220], [-360, 60], [40, -150], [250, 40], [120, 140]];
    tufts.forEach(([x, y], k) => { const j = jit(k + 40, 10); mk([[x - 9, y - 8 + j], [x, y + 3], [x + 9, y - 8 - j]], 2.5, col, 8741 + k, d1, .35) });   // carpet tufts all round: it lies on the floor
    c.save(); c.scale(1.15, 1.15); c.rotate(-.36);                                          // the bar itself ~585 px on its long side
    const cl = tools_resample([...P.line(-300, 0, 150, 0), ...P.arc(150, -92, 92, Math.PI / 2, -Math.PI / 3).slice(1)], 8);
    const wf = s => s < .13 ? lerp(64, 40, s / .13) : s > .85 ? lerp(40, 70, (s - .85) / .15) : 40;
    const { left, right, tan } = tools_tube(cl, wf), n = cl.length, pe = cl[n - 1], te = tan[n - 1], p0 = cl[0], t0 = tan[0];
    const notchC = [pe[0] - te[0] * 40, pe[1] - te[1] * 40], notchS = [p0[0] + t0[0] * 18, p0[1] + t0[1] * 18];
    const body = [...left, notchC, ...right.slice().reverse(), notchS, left[0]];
    tools_dash(cl.slice(2, Math.round(n * .78)).map(p => [p[0] - 12, p[1] + 32]), 3.5, PALE, 8760, d1, .35, 18, 14);   // its shadow on the carpet (seeds 8760..8774)
    shade(body, .08); mk(body, 6.5, col, 8790, d0);
    const i0 = Math.round(n * .13), i1 = Math.round(n * .12), i2 = Math.round(n * .86);
    mk(cl.slice(i0, i2).map((p, i) => [p[0] - tan[i + i0][1] * 11, p[1] + tan[i + i0][0] * 11]), 3, col, 8791, d1, .55);   // hex facet edges, either side of the front face
    mk(cl.slice(i0, i2).map((p, i) => [p[0] + tan[i + i0][1] * 11, p[1] - tan[i + i0][0] * 11]), 3, col, 8795, d1, .35);
    mk(P.line(left[i1][0], left[i1][1], right[i1][0], right[i1][1]), 3.5, col, 8792, d1, .7);   // chisel shoulder
    mk(P.line(left[i2][0], left[i2][1], right[i2][0], right[i2][1]), 3.5, col, 8793, d1, .7);   // claw shoulder
    mk([...cl.slice(Math.round(n * .72), n - 5), notchC], 3, col, 8794, d1, .5);                 // claw ridge
    c.restore();
    if (o.no) tools_no(-44, -50, 360, ACC[o.no_col || 'white'] || WHITE, es, 8796);   // ring centred on the scaled bar: every extreme of it sits >= 23 px inside
  };
  // bell: a hand bell seen from just above — domed body with shoulder and flared lip, shoulder and waist rings, catch-light and hatched shade, thick rim band in perspective, the clapper ball showing under the rim, bolt cap and hanging ring on top; it swings and rings (three fading sound arcs each side) unless no, which draws the big cross-out in no_col and leaves it hanging still
  ART.bell = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1, d2 } = tools_layers(o.es), still = !!o.no;
    c.save();
    if (!still) { c.translate(0, -334); c.rotate(Math.sin(t * 2.3) * .045); c.translate(0, 334) }
    const rgt = [...P.quad(0, -262, 122, -262, 172, -150), ...P.quad(172, -150, 210, -40, 216, 110).slice(1), ...P.quad(216, 110, 226, 172, 272, 200).slice(1)];
    const lft = rgt.map(([x, y]) => [-x, y]).reverse(), body = [...lft, ...rgt.slice(1)];
    shade(body, .08); mk(body, 7, col, 8600, d0);
    mk(tools_ell(0, -150, 172, 34, .12, Math.PI - .12), 3.5, col, 8601, d1, .85);      // shoulder rings
    mk(tools_ell(0, -132, 180, 36, .2, Math.PI - .2), 3, col, 8602, d1, .5);
    mk(tools_ell(0, 104, 216, 44, .18, Math.PI - .18), 3.5, col, 8603, d1, .85);       // waist ring
    mk(P.quad(-140, -130, -186, -20, -178, 80), 3, col, 8604, d1, .45);                  // catch-light down the left
    tools_hatch(140, -100, 8, 30, 7, 28, -.95, 2.5, col, 8605, d1, .3);                   // shade down the right
    shade(P.circle(0, 290, 28), .1); mk(P.circle(0, 290, 28), 5.5, col, 8613, d1);   // the clapper ball peeking under the lip (its rod is inside the bell, unseen)
    const rimO = tools_ell(0, 200, 272, 78, 0, Math.PI), rimI = tools_ell(0, 200, 258, 60, 0, Math.PI);
    shade([...rimO, ...rimI.slice().reverse()], .12); mk(rimO, 7, col, 8614, d0); mk(rimI, 4, col, 8615, d1, .8);   // the rim band
    tools_drum(0, -292, 40, 12, 30, col, 8616, d1, .1);                                   // the bolt cap
    const ringO = P.circle(0, -336, 36), ringI = P.circle(0, -336, 17);
    shade(tools_ring(ringO, ringI), .1); mk(ringO, 6, col, 8620, d1); mk(ringI, 4, col, 8621, d1);   // the hanging ring
    c.restore();
    if (!still) for (let k = 0; k < 3; k++) { const ph = (t * .9 + k / 3) % 1, r = 296 + ph * 96, a = (1 - ph) * .8 * d2;
      mk(P.arc(0, -40, r, -.42, .42), 5, col, 8630 + k, 1, a); mk(P.arc(0, -40, r, Math.PI - .42, Math.PI + .42), 5, col, 8633 + k, 1, a) }
    if (o.no) tools_no(0, -16, 392, ACC[o.no_col || 'white'] || WHITE, es, 8640);
  };
  // hotels: grand hotel façade — tall central tower with balconies and railings, cornice with dentils, flags, two wings with arched lobby windows, a marquee canopy on posts over a revolving door between columns, steps, and a rooftop sign frame ringed with bulbs; led = colour of the glowing sign bar and a few lit rooms (default yellow)
  ART.hotels = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, L = ACC[o.led || 'yellow'] || ACC.yellow, { es, d0, d1, d2 } = places_layers(o.es), G = 250;
    let sd = 11400;
    const cornice = (x0, x1, y, d) => { mk(P.line(x0 - 8, y, x1 + 8, y), 5, col, sd++, d); mk(P.line(x0 - 4, y + 12, x1 + 4, y + 12), 3.2, col, sd++, d, .7); for (let x = x0 + 6; x < x1; x += 22) mk(P.line(x, y + 2, x, y + 10), 2.4, col, sd++, d, .5) };
    // wings (behind the tower)
    [[-400, -160, -110], [160, 400, -150]].forEach(([x0, x1, top], w) => {
      const d = ease((es - .06) / .3), dd = ease((es - .26) / .3), b = P.rect(x0, top, x1 - x0, G - top); shade(b, .05); mk(b, 6.5, col, sd++, d); cornice(x0, x1, top, d);
      const cols = 4, gap = (x1 - x0) / cols; let ok = 0;
      for (let r = 0; r < Math.floor((G - top - 80) / 62); r++) for (let k = 0; k < cols; k++) { const wx = x0 + gap * k + gap / 2 - 16, wy = top + 40 + r * 62;
        places_win(wx, wy, 32, 40, col, sd, dd, .8, (o.led && n1(sd) < .07) ? L : null, .5); sd += 4 }
      for (let k = 0; k < cols; k++) { const wx = x0 + gap * k + gap / 2, ar = [...P.line(wx - 22, G, wx - 22, G - 46), ...P.arc(wx, G - 46, 22, Math.PI, TAU), ...P.line(wx + 22, G - 46, wx + 22, G)]; mk(ar, 4, col, sd++, dd); mk(P.line(wx, G - 68, wx, G), 2.4, col, sd++, dd, .5); mk(P.line(wx - 22, G - 40, wx + 22, G - 40), 2.4, col, sd++, dd, .5) }
    });
    // central tower with its side face
    const TX0 = -150, TX1 = 150, TT = -330, d0t = ease(es / .3), d1t = ease((es - .2) / .32);
    const side = [[TX1, TT], [TX1 + 28, TT - 18], [TX1 + 28, G - 18], [TX1, G]]; shade(side, .03); mk([...side, side[0]], 5, col, sd++, d0t, .9);
    for (let r = 0; r < 8; r++) mk(P.rect(TX1 + 9, TT + 40 + r * 62, 10, 30), 2.4, col, sd++, d1t, .45);
    const tower = P.rect(TX0, TT, TX1 - TX0, G - TT); shade(tower, .07); mk(tower, 7, col, sd++, d0t); cornice(TX0, TX1, TT, d0t);
    mk(P.line(TX0, TT + 30, TX1, TT + 30), 3, col, sd++, d1t, .5);
    for (let r = 0; r < 6; r++) { const wy = TT + 52 + r * 56, bal = r % 2 === 0;
      for (let k = 0; k < 3; k++) { const wx = TX0 + 40 + k * 90; places_win(wx, wy, 30, 36, col, sd, d1t, .85, (o.led && n1(sd + 3) < .1) ? L : null, .5); sd += 4;
        if (bal) { mk(P.line(wx - 12, wy + 40, wx + 42, wy + 40), 3.6, col, sd++, d1t); mk(P.line(wx - 12, wy + 24, wx + 42, wy + 24), 3.2, col, sd++, d1t, .8);
          for (let b = 0; b < 5; b++) mk(P.line(wx - 8 + b * 11.5, wy + 24, wx - 8 + b * 11.5, wy + 40), 2.2, col, sd++, d1t, .55) } } }
    // flags on the roof corners
    [[TX0 + 14, -1], [TX1 - 14, 1]].forEach(([fx, dir], i) => { mk(P.line(fx, TT, fx, TT - 70), 4, col, sd++, d1t); const wv = Math.sin(t * 3 + i) * 6;
      const fl = [[fx, TT - 68], [fx + dir * 44, TT - 58 + wv], [fx, TT - 44]]; shade(fl, .1); mk([...fl, fl[0]], 3.6, col, sd++, d1t) });
    // rooftop sign: frame on posts, bulbs around, glowing bar inside
    const SX0 = -128, SX1 = 128, SY0 = -424, SY1 = -370;
    mk(P.line(-100, TT, -100, SY1), 4.5, col, sd++, d1t); mk(P.line(100, TT, 100, SY1), 4.5, col, sd++, d1t); mk(P.line(-100, TT - 22, 100, TT - 22), 2.6, col, sd++, d1t, .5);
    const sign = P.rect(SX0, SY0, SX1 - SX0, SY1 - SY0); shade(sign, .08); mk(sign, 6, col, sd++, d1t); mk(P.rect(SX0 + 10, SY0 + 10, SX1 - SX0 - 20, SY1 - SY0 - 20), 3, col, sd++, d1t, .5);
    for (let k = 0; k < 12; k++) { const bx = SX0 + 10 + k * (SX1 - SX0 - 20) / 11, on = Math.sin(t * 5 + k * .9) > 0; places_dot(bx, SY0 - 6, on ? 3.5 : 2.2, on ? L : col, d2 * (on ? .9 : .4)); places_dot(bx, SY1 + 6, on ? 3.5 : 2.2, on ? L : col, d2 * (on ? .9 : .4)) }
    const pl = .7 + .3 * Math.sin(t * 4);
    glow(L, 26 * pl, () => { c.save(); c.fillStyle = L; c.globalAlpha *= d2 * pl; c.fillRect(SX0 + 22, SY0 + 20, SX1 - SX0 - 44, SY1 - SY0 - 40); c.restore() });
    // entrance: columns, revolving door, canopy on posts, steps
    const EY = G - 96;
    for (const cx of [-96, 96]) { mk(P.rect(cx - 10, EY + 8, 20, G - EY - 8), 4.5, col, sd++, d1t); mk(P.rect(cx - 16, EY, 32, 10), 3.6, col, sd++, d1t); mk(P.rect(cx - 15, G - 12, 30, 12), 3.6, col, sd++, d1t) }
    const dr = 46, dc = G - dr - 2; mk(P.rect(-dr - 26, dc - dr - 8, 2 * dr + 52, 2 * dr + 10), 4, col, sd++, d1t, .8);
    shade(P.circle(0, dc, dr), .1); mk(P.circle(0, dc, dr), 4.5, col, sd++, d1t); const ra = t * .6;
    for (let k = 0; k < 4; k++) mk(P.line(0, dc, Math.cos(ra + k * Math.PI / 2) * (dr - 3), dc + Math.sin(ra + k * Math.PI / 2) * (dr - 3)), 3, col, sd++, d1t, .8);
    mk(P.line(-dr - 20, dc - dr, -dr - 20, G), 3, col, sd++, d1t, .5); mk(P.line(dr + 20, dc - dr, dr + 20, G), 3, col, sd++, d1t, .5);
    const can = [[-120, EY - 14], [120, EY - 14], [136, EY - 36], [-136, EY - 36]]; shade(can, .1); mk([...can, can[0]], 5, col, sd++, d1t);
    mk(P.rect(-122, EY - 14, 244, 16), 4, col, sd++, d1t); for (let k = 0; k < 9; k++) places_dot(-104 + k * 26, EY - 6, 2.6, Math.sin(t * 5 + k) > 0 ? L : col, d2 * .8);
    mk(P.line(-126, EY + 2, -126, G), 4.5, col, sd++, d1t); mk(P.line(126, EY + 2, 126, G), 4.5, col, sd++, d1t);
    for (let k = 0; k < 3; k++) mk(P.line(-150 - k * 14, G + 8 + k * 8, 150 + k * 14, G + 8 + k * 8), 3.6, col, sd++, d1t, .8 - k * .15);
    mk(P.line(-420, G, 420, G), 6, col, sd++, d0);
  };
  // ---- places family: shared helpers (prefix places_) --------------------------------
  // the three draw-on layers of the brief: contour, details, colour (es=99 -> all complete)
  function places_layers(es) { const e = es === undefined ? 99 : es; return { es: e, d0: ease(e / .35), d1: ease((e - .2) / .35), d2: ease((e - .4) / .3) } }
  // small filled dot (LED, rivet, bulb)
  function places_dot(x, y, r, col, a = 1) { const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore() }
  // glowing dot
  function places_led(x, y, r, col, blur, a = 1) { glow(col, blur, () => places_dot(x, y, r, col, a)) }
  // elliptical arc path; rot tilts the ellipse
  function places_ell(cx, cy, rx, ry, a0 = 0, a1 = TAU, rot = 0) {
    const n = Math.max(8, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 10)), c = Math.cos(rot), s = Math.sin(rot);
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)), x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * c - y * s, cy + x * s + y * c] });
  }
  // closed rounded-rectangle path
  function places_rr(x, y, w, h, r) {
    const q = Math.PI / 2, rr = Math.min(r, w / 2, h / 2);
    return [...P.arc(x + w - rr, y + rr, rr, -q, 0), ...P.arc(x + w - rr, y + h - rr, rr, 0, q), ...P.arc(x + rr, y + h - rr, rr, q, 2 * q), ...P.arc(x + rr, y + rr, rr, 2 * q, 3 * q), [x + w - rr, y]];
  }
  // map every point of a path through f(x, y) -> [x, y]
  function places_map(pts, f) { return pts.map(([x, y]) => f(x, y)) }
  // resample a polyline every `step` px
  function places_resample(pts, step) {
    const out = [pts[0]]; let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0); if (L === 0) continue;
      let s = step - carry; while (s <= L) { out.push([lerp(x0, x1, s / L), lerp(y0, y1, s / L)]); s += step }
      carry = L - (s - step);
    }
    return out;
  }
  // dashed marker stroke (uses seed..seed+cap)
  function places_dash(pts, w, col, seed, draw = 1, a = 1, dash = 20, gap = 14, cap = 40) {
    const rs = places_resample(pts, 5), per = Math.max(2, Math.round(dash / 5)), gp = Math.max(1, Math.round(gap / 5)), n = rs.length;
    for (let i = 0, k = 0; i < n - 1 && k < cap; i += per + gp, k++) {
      const seg = rs.slice(i, Math.min(n, i + per + 1)); if (seg.length < 2) break;
      const dd = clamp((draw * n - i) / seg.length); if (dd <= 0) break;
      mk(seg, w, col, seed + k, dd, a);
    }
  }
  // dashed ground shadow under an object (uses seed..seed+39)
  function places_ground(x0, x1, y, seed, d, a = .4) { places_dash(P.line(x0, y, x1, y), 3.5, PALE, seed, d, a, 24, 18) }
  // point-in-polygon (ray casting)
  function places_in(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // hatch lines clipped to a polygon (uses seed..seed+cap); ang = line direction; clipY = only below this y
  function places_hatch(poly, sp, ang, w, col, seed, d = 1, a = .5, cap = 60, clipY = -Infinity) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2, ca = Math.cos(ang), sa = Math.sin(ang);
    let k = 0, run = [];
    const flush = () => { if (run.length >= 2 && k < cap) { mk(run, w, col, seed + k, d, a); k++ } run = [] };
    for (let off = -R + sp / 2; off <= R && k < cap; off += sp) {
      for (let s = -R; s <= R; s += 6) { const x = cx - sa * off + ca * s, y = cy + ca * off + sa * s; if (y > clipY && places_in(poly, x, y)) run.push([x, y]); else flush() }
      flush();
    }
  }
  // scalloped closed outline (cloud / canopy): ellipse whose radius bulges k times
  function places_scallop(cx, cy, rx, ry, k, amp, seed = 0) {
    const n = Math.round(Math.max(rx, ry) * 1.4), out = [];
    for (let i = 0; i <= n; i++) { const a = TAU * i / n, b = 1 + amp * Math.pow(Math.abs(Math.sin(k * a / 2 + seed)), .8); out.push([cx + Math.cos(a) * rx * b, cy + Math.sin(a) * ry * b]) }
    return out;
  }
  // lat/lon on a sphere of radius R seen slightly from above (el) with the axis tilted (tilt) -> [x, y, z]; z > 0 means visible
  function places_sph(lat, lon, R, el, tilt) {
    const f = lat * Math.PI / 180, l = lon * Math.PI / 180, x = Math.cos(f) * Math.sin(l), y = Math.sin(f), z = Math.cos(f) * Math.cos(l);
    const y2 = y * Math.cos(el) - z * Math.sin(el), z2 = y * Math.sin(el) + z * Math.cos(el), sx = R * x, sy = -R * y2, c = Math.cos(tilt), s = Math.sin(tilt);
    return [sx * c - sy * s, sx * s + sy * c, z2];
  }
  // stroke the visible runs of a lat/lon polyline; returns the number of seeds used
  function places_sphline(pts, pr, w, col, seed, d, a) {
    const runs = []; let run = [];
    for (const [la, lo] of pts) { const [x, y, z] = pr(la, lo); if (z > 0) run.push([x, y]); else if (run.length) { runs.push(run); run = [] } }
    if (run.length) runs.push(run);
    let k = 0; for (const r of runs) if (r.length >= 2) { mk(r, w, col, seed + k, d, a); k++ }
    return Math.max(1, k);
  }
  // densify a lat/lon polygon (closed) so its projection curves
  function places_geo(poly, step = 4) {
    const out = [];
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let j = 0; j < n; j++) out.push([lerp(a[0], b[0], j / n), lerp(a[1], b[1], j / n)]) }
    out.push(out[0]); return out;
  }
  // window with a mullion cross and a sill; lit = fill colour (or null)
  function places_win(x, y, w, h, col, seed, d, a, lit, litA = .5) {
    if (lit) { const c = A.ctx; c.save(); c.globalAlpha *= litA * d; c.fillStyle = lit; c.fillRect(x + 2, y + 2, w - 4, h - 4); c.restore() }
    mk(P.rect(x, y, w, h), 3.2, col, seed, d, a);
    mk(P.line(x + w / 2, y + 2, x + w / 2, y + h - 2), 2.2, col, seed + 1, d, a * .6);
    mk(P.line(x + 2, y + h * .4, x + w - 2, y + h * .4), 2.2, col, seed + 2, d, a * .6);
    mk(P.line(x - 3, y + h + 3, x + w + 3, y + h + 3), 2.6, col, seed + 3, d, a * .7);
  }
  // box in one-point perspective toward vp with depth factor k (front rect x0,y0..x1,y1); draws top and the visible side, shaded
  function places_box(x0, y0, x1, y1, vp, k, col, seed, d, a = 1) {
    const q = (x, y) => [vp[0] + (x - vp[0]) * k, vp[1] + (y - vp[1]) * k];
    const front = P.rect(x0, y0, x1 - x0, y1 - y0), tl = q(x0, y0), tr = q(x1, y0), bl = q(x0, y1), br = q(x1, y1);
    if (vp[1] < y0) { const top = [[x0, y0], [x1, y0], tr, tl]; shade(top, .09); mk([...top, top[0]], 4.5, col, seed + 1, d, a) }
    if (vp[0] > x1) { const side = [[x1, y0], tr, br, [x1, y1]]; shade(side, .03); mk([...side, side[0]], 4.5, col, seed + 2, d, a) }
    else if (vp[0] < x0) { const side = [[x0, y0], tl, bl, [x0, y1]]; shade(side, .03); mk([...side, side[0]], 4.5, col, seed + 2, d, a) }
    shade(front, .06); mk(front, 5.5, col, seed, d, a);
  }
  // globe: desk globe on its stand — tilted axis, half meridian ring with pole caps, curved stem and a thick oval base; the sphere carries parallels, meridians and hatched continents (Americas, Greenland, Europe/Africa) and turns slowly; led = colour of the pulsing city nodes and of the arcs that link them (default yellow)
  ART.globe = (t, u, o = {}) => {
    const col = o.col || WHITE, L = ACC[o.led || 'yellow'] || ACC.yellow, { es, d0, d1, d2 } = places_layers(o.es);
    const R = 270, EL = .34, TILT = .4, spin = 30 + t * 2.2, c = Math.cos(TILT), s = Math.sin(TILT);
    const rot = (x, y) => [x * c - y * s, x * s + y * c], pr = (la, lo) => places_sph(la, lo + spin, R, EL, TILT);
    // the stand: half meridian ring behind the sphere, stem, oval base
    const ringO = places_map(P.arc(0, 0, R + 38, Math.PI / 2, Math.PI * 3 / 2), rot), ringI = places_map(P.arc(0, 0, R + 20, Math.PI / 2, Math.PI * 3 / 2), rot);
    shade([...ringO, ...ringI.slice().reverse()], .07); mk(ringO, 6.5, col, 10000, d0); mk(ringI, 4.5, col, 10001, d0);
    for (let i = 0; i < 7; i++) { const a = Math.PI / 2 + Math.PI * (i + .5) / 7, p0 = rot(Math.cos(a) * (R + 22), Math.sin(a) * (R + 22)), p1 = rot(Math.cos(a) * (R + 36), Math.sin(a) * (R + 36)); mk(P.line(p0[0], p0[1], p1[0], p1[1]), 2.6, col, 10002 + i, d1, .5) }
    const top = rot(0, -R - 29), bot = rot(0, R + 29);
    shade(P.circle(top[0], top[1], 15), .1); mk(P.circle(top[0], top[1], 15), 4.5, col, 10010, d0); places_dot(top[0], top[1], 4, col, .8 * d1);
    shade(P.circle(bot[0], bot[1], 15), .1); mk(P.circle(bot[0], bot[1], 15), 4.5, col, 10011, d0);
    const stemA = P.quad(bot[0] - 5, bot[1] + 12, bot[0] - 30, 330, -12, 336), stemB = P.quad(bot[0] + 9, bot[1] + 8, bot[0] - 12, 322, 12, 336);
    shade([...stemA, ...stemB.slice().reverse()], .08); mk(stemA, 5.5, col, 10012, d0); mk(stemB, 5.5, col, 10013, d0);
    const baseT = places_ell(0, 350, 190, 34), baseF = places_ell(0, 350, 190, 34, 0, Math.PI), baseB = places_ell(0, 370, 190, 34, Math.PI, 0);
    shade([...baseF, ...baseB], .04); mk(baseB, 6, col, 10014, d0); mk(P.line(-190, 350, -190, 370), 6, col, 10015, d0); mk(P.line(190, 350, 190, 370), 6, col, 10016, d0);
    shade(baseT, .09); mk(baseT, 6.5, col, 10017, d0); mk(places_ell(0, 350, 150, 22), 3, col, 10018, d1, .5);
    places_ground(-230, 240, 402, 10020, d0, .35);
    // the sphere
    const disc = P.circle(0, 0, R); shade(disc, .05); mk(disc, 7, col, 10060, d0);
    mk(P.arc(0, 0, R - 26, Math.PI * 1.12, Math.PI * 1.36), 4, col, 10061, d1, .35); mk(P.arc(0, 0, R - 40, Math.PI * 1.18, Math.PI * 1.3), 3, col, 10062, d1, .25);
    let sd = 10070;
    for (const lat of [-60, -30, 0, 30, 60]) { const pts = []; for (let lon = -180; lon <= 180; lon += 3) pts.push([lat, lon - spin]); sd += places_sphline(pts, pr, lat === 0 ? 4.2 : 3, col, sd, d1, lat === 0 ? .8 : .5) }
    for (let lon = 0; lon < 360; lon += 30) { const pts = []; for (let lat = -90; lat <= 90; lat += 3) pts.push([lat, lon - spin]); sd += places_sphline(pts, pr, 3, col, sd, d1, .5) }
    const LAND = [
      [[72, -95], [70, -70], [62, -64], [52, -56], [45, -66], [40, -74], [32, -80], [26, -80], [30, -90], [26, -97], [20, -97], [16, -92], [9, -84], [8, -78], [16, -100], [24, -110], [33, -118], [42, -124], [50, -128], [58, -140], [62, -152], [70, -162], [72, -140], [70, -120]],
      [[11, -73], [10, -62], [5, -52], [-3, -42], [-8, -35], [-14, -39], [-23, -42], [-30, -50], [-38, -58], [-48, -66], [-55, -70], [-48, -75], [-38, -73], [-24, -70], [-15, -76], [-5, -81], [2, -79], [8, -78]],
      [[60, -45], [66, -38], [72, -22], [80, -20], [83, -40], [80, -65], [76, -72], [68, -55], [62, -50]],
      [[36, -9], [43, -9], [48, -4], [50, 1], [53, 5], [57, 8], [58, 12], [62, 5], [66, 13], [70, 20], [71, 30], [66, 40], [60, 30], [55, 30], [50, 36], [45, 34], [41, 28], [38, 26], [40, 20], [43, 15], [44, 12], [41, 16], [38, 16], [40, 10], [43, 8], [43, 4], [40, 0], [37, -2]],
      [[36, -6], [37, 10], [33, 12], [31, 20], [32, 30], [31, 33], [24, 36], [16, 40], [11, 44], [12, 51], [2, 42], [-4, 40], [-12, 40], [-20, 35], [-26, 33], [-34, 26], [-34, 19], [-28, 16], [-18, 12], [-6, 12], [-1, 9], [4, 7], [5, -2], [5, -8], [8, -13], [12, -17], [20, -17], [27, -13], [33, -8]],
      [[30, 35], [26, 50], [22, 60], [17, 56], [13, 45], [18, 42], [26, 36]]];
    LAND.forEach((poly, i) => {                          // fixed seed block per landmass: hatch 10200+60i.., outline runs 10240+60i.. (tops out at 10559, under the colour layer)
      const geo = places_geo(poly, 3), proj = geo.map(([la, lo]) => pr(la, lo)); if (!proj.some(p => p[2] > 0)) return;
      const clip = proj.map(([x, y, z]) => { if (z > 0) return [x, y]; const m = Math.hypot(x, y) || 1; return [x / m * R, y / m * R] });
      places_hatch(clip, 13, -.7, 2.4, col, 10200 + i * 60, d1, .32, 40);
      places_sphline(geo, pr, 4.2, col, 10240 + i * 60, d0, .95);
    });
    // colour: the city nodes and their links
    const CITY = [[40.7, -74], [-23.5, -46.6], [51.5, 0], [6.5, 3.4], [-34, 18.5], [19.4, -99], [30, 31]], LINK = [[0, 2], [1, 3], [2, 6], [5, 0], [3, 4]];
    const np = CITY.map(([la, lo]) => pr(la, lo));
    LINK.forEach(([a, b], i) => { const A0 = np[a], B0 = np[b]; if (A0[2] < .1 || B0[2] < .1) return;
      const mx = (A0[0] + B0[0]) / 2, my = (A0[1] + B0[1]) / 2, m = Math.hypot(mx, my) || 1, lift = 1.35 + .08 * Math.sin(t * 2 + i);
      mk(P.quad(A0[0], A0[1], mx / m * Math.max(m * lift, R * .9), my / m * Math.max(m * lift, R * .9), B0[0], B0[1]), 3.2, L, 10600 + i, d2, .6 * Math.min(A0[2], B0[2]) ** .5) });
    np.forEach(([x, y, z], i) => { if (z < .08) return; const pl = .55 + .45 * Math.sin(t * 3.5 + i * 1.7);
      places_led(x, y, 6 + 3 * pl, L, 18 * pl, d2 * Math.min(1, z * 2.5)); mk(P.circle(x, y, 13 + 3 * pl), 2.4, L, 10620 + i, d2, .5 * Math.min(1, z * 2.5)) });
  };
  // face: a big head with tapering jaw, hair sweep, ears, neck and collar; almond eyes with iris, pupil and punched highlight that glance and blink, expressive brows, nose, cheeks; `mood` worried (default) / scared (wide eyes, open mouth) / anything else smiles; `sweat` drops a bead from the temple
  ART.face = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, es = o.es == null ? 99 : o.es, m = o.mood || 'worried';
    const d1 = ease(es / .35), d2 = ease((es - .16) / .35), d3 = ease((es - .32) / .3);
    const scared = m === 'scared', worried = m === 'worried';
    const blink = (t % 4.1) < .14 && !scared ? .12 : 1, gl = scared ? 0 : Math.sin(t * .9) * 12;
    const head = Array.from({ length: 72 }, (_, i) => { const a = i / 72 * TAU, sn = Math.sin(a), cs = Math.cos(a);
      const w = 282 * (sn > 0 ? 1 - .24 * sn * sn : 1), h = sn > 0 ? 306 : 296; return [cs * w, -44 + sn * h] });
    shade(head, .05); mk([...head, head[0]], 7, col, 1200, d1);
    mk(P.line(-70, 256, -84, 332), 6, col, 1201, d1); mk(P.line(70, 256, 84, 332), 6, col, 1202, d1);              // neck
    mk(P.quad(-84, 332, -190, 336, -300, 392), 6.5, col, 1203, d3); mk(P.quad(84, 332, 190, 336, 300, 392), 6.5, col, 1204, d3);   // shoulders
    mk(P.line(-84, 332, 0, 374), 5, col, 1205, d3); mk(P.line(84, 332, 0, 374), 5, col, 1206, d3);                    // collar V
    for (const sx of [-1, 1]) { const k = sx > 0 ? 1 : 0, o0 = sx > 0 ? 0 : Math.PI;
      mk(P.arc(sx * 272, -50, 46, o0 - 1.3, o0 + 1.3), 5, col, 1207 + k, d2);                                           // ears
      mk(P.arc(sx * 276, -46, 22, o0 - 1, o0 + 1), 3.5, col, 1209 + k, d3, .7) }
    mk(P.quad(-250, -150, -230, -320, -60, -340), 5, col, 1211, d3);                                                   // hair
    mk(P.quad(-60, -340, 90, -352, 236, -230), 5, col, 1212, d3);
    mk(P.quad(-200, -230, -120, -300, -40, -260), 4, col, 1213, d3, .8);
    mk(P.quad(-30, -290, 50, -320, 110, -250), 4, col, 1214, d3, .8);
    mk(P.quad(90, -300, 170, -300, 210, -220), 4, col, 1215, d3, .7);
    for (const sx of [-1, 1]) { const k = sx > 0 ? 1 : 0;
      c.save(); c.translate(sx * 112, -70); c.scale(1, blink);
      const lidU = P.quad(-66, 0, 0, scared ? -78 : -54, 66, 0), lidL = P.quad(66, 0, 0, scared ? 44 : 32, -66, 0), lid = [...lidU, ...lidL];
      shade(lid, .05);
      c.save(); c.beginPath(); c.moveTo(lid[0][0], lid[0][1]); for (const p of lid) c.lineTo(p[0], p[1]); c.closePath(); c.clip();
      const py = scared ? -6 : 0;
      mk(P.circle(gl, py, 30), 4.5, col, 1220 + k, d2);
      people_dot(gl, py, scared ? 10 : 16, col, d2); people_dot(gl - 5, py - 5, scared ? 3.5 : 5, '#000000', d2);
      c.restore();
      mk(lidU, 6, col, 1222 + k, d2); mk(lidL, 5, col, 1224 + k, d2);
      mk(P.quad(-70, -16, 0, scared ? -96 : -70, 70, -18), 3.5, col, 1226 + k, d3, .5);                              // lid crease
      c.restore();
      const b = scared ? P.quad(sx * 180, -170, sx * 110, -226, sx * 44, -176)
              : worried ? P.quad(sx * 184, -140, sx * 120, -172, sx * 50, -178)
              : P.quad(sx * 184, -152, sx * 112, -178, sx * 44, -150);
      mk(b, 8.5, col, 1228 + k, d2) }
    mk(P.quad(-10, -60, -38, 32, -16, 66), 5, col, 1230, d2); mk(P.quad(-16, 66, 8, 84, 34, 56), 5, col, 1231, d2);     // nose
    if (scared) { const mo = people_oval(0, 166, 44, 58); shade(mo, .05); mk([...mo, mo[0]], 6, col, 1232, d2);
      mk(P.line(-34, 130, 34, 130), 3.5, col, 1233, d3, .8); mk(P.arc(0, 222, 26, Math.PI * 1.15, Math.PI * 1.85), 3.5, col, 1234, d3, .7) }
    else if (worried) { mk(P.quad(-84, 160, 0, 118, 84, 160), 6, col, 1232, d2); mk(P.line(-84, 160, -98, 148), 4, col, 1233, d3, .8); mk(P.line(84, 160, 98, 148), 4, col, 1234, d3, .8) }
    else { mk(P.quad(-92, 128, 0, 196, 92, 128), 6, col, 1232, d2); mk(P.quad(-92, 128, -104, 120, -100, 108), 4, col, 1233, d3, .8); mk(P.quad(92, 128, 104, 120, 100, 108), 4, col, 1234, d3, .8);
      mk(P.arc(-150, 90, 40, .3, 1.4), 3.5, col, 1235, d3, .5); mk(P.arc(150, 90, 40, Math.PI - 1.4, Math.PI - .3), 3.5, col, 1236, d3, .5) }
    if (o.sweat) { const g = ease((es - .35) / .3), dy = ease((es - .35) / 1.1) * 110; c.save(); c.translate(236, -150 + dy);
      const drop = [...P.quad(0, -52, 34, 6, 0, 48), ...P.quad(0, 48, -34, 6, 0, -52)]; shade(drop, .05); mk(drop, 6, col, 1240, g, .95);
      mk(P.arc(-8, 14, 14, Math.PI * .6, Math.PI * 1.3), 3, col, 1241, g, .6); c.restore() }
  };
  // intruder: a burglar in fedora and belted trench coat — drawn coat, head, collar, hat: domino mask with shifty eye slits, upturned collar, lapels, buttons, belt buckle, pocket flaps; trousers (capsules, one knee bent, on tiptoe) and shoes; one sleeved arm bends at the elbow and reaches `reach` with a gloved hand (thumb up), the other is buried in a pocket up to the cuff; pale, slightly ghosted
  ART.intruder = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || PALE, es = o.es == null ? 99 : o.es;
    const d1 = ease(es / .35), d2 = ease((es - .16) / .35), d3 = ease((es - .32) / .3);
    const [rx, ry] = o.reach || [232, -104], side = rx < 0 ? -1 : 1, look = side * 6 + Math.sin(t * .7) * 3;
    c.save(); c.globalAlpha *= .88; c.translate(Math.sin(t * .8) * 3, 0);
    // trousers: the standing leg, the bent leg (thigh + shin via the knee), a crease down each, then the shoes
    const lgL = people_capsule(-64, 170, -92, 316, 16), lgA = people_capsule(64, 170, 122, 236, 16), lgB = people_capsule(122, 236, 92, 312, 16);
    shade(lgL, .06); mk([...lgL, lgL[0]], 6, col, 1300, d1); mk(P.line(-70, 196, -88, 298), 3, col, 1301, d3, .4);
    shade(lgA, .06); mk([...lgA, lgA[0]], 6, col, 1302, d1); shade(lgB, .06); mk([...lgB, lgB[0]], 6, col, 1303, d1);
    mk(P.line(116, 254, 98, 298), 3, col, 1304, d3, .4);
    const shL = people_capsule(-92, 318, -150, 322, 15), shR = people_capsule(90, 312, 146, 300, 15);
    shade(shL, .06); mk([...shL, shL[0]], 5.5, col, 1305, d2); shade(shR, .06); mk([...shR, shR[0]], 5.5, col, 1306, d2);
    mk(P.line(-104, 306, -106, 334), 3.5, col, 1307, d3, .7); mk(P.line(104, 300, 108, 324), 3.5, col, 1308, d3, .7);
    // the coat: an OPEN path (left side, hem, right side) starting under the collar; then front edge, buttons, belt and buckle
    const coat = [...P.quad(-114, -150, -140, 0, -152, 184), ...P.quad(-152, 184, 0, 194, 152, 184), ...P.quad(152, 184, 140, 0, 114, -150)];
    shade(coat, .06); mk(coat, 6.5, col, 1310, d1);
    mk(P.line(12, -56, 8, 184), 4, col, 1311, d2, .8);
    for (let i = 0; i < 3; i++) people_dot(24, -22 + i * 66, 6, col, d3);
    mk(P.line(-132, 6, 132, 6), 4, col, 1312, d2); mk(P.line(-134, 32, 134, 32), 4, col, 1313, d2);   // belt
    mk(P.rect(-16, 0, 32, 38), 4, col, 1314, d3);
    // head, mask, eyes, mouth; then the upturned collar over the neck and the lapels folding out of it
    shade(P.circle(0, -250, 68), .05); mk(P.circle(0, -250, 68), 6, col, 1320, d1);
    const mask = [...P.quad(-66, -282, 0, -270, 66, -282), ...P.quad(66, -282, 70, -248, 40, -246), ...P.quad(40, -246, 0, -236, -40, -246), ...P.quad(-40, -246, -70, -248, -66, -282)];
    shade(mask, .14); mk([...mask, mask[0]], 5, col, 1321, d2);
    people_dot(-28 + look, -260, 7, col, d2); people_dot(28 + look, -260, 7, col, d2);           // shifty eyes through the mask
    mk(P.quad(-26, -206, 0, -220, 26, -206), 5, col, 1322, d2);                                 // sour mouth
    const collar = [[-108, -214], ...P.quad(-108, -214, -60, -186, 0, -172), ...P.quad(0, -172, 60, -186, 108, -214), [90, -160], ...P.quad(90, -160, 0, -136, -90, -160)];
    shade(collar, .07); mk([...collar, collar[0]], 6, col, 1330, d1);
    mk(P.quad(-70, -172, -36, -110, 12, -56), 5, col, 1331, d2); mk(P.quad(70, -172, 36, -110, 12, -56), 5, col, 1332, d2);   // lapels
    // fedora: brim ~1.7x the head, crown, band
    const brim = [...P.quad(-118, -318, 0, -342, 118, -318), ...P.quad(118, -318, 0, -292, -118, -318)];
    shade(brim, .07); mk([...brim, brim[0]], 6.5, col, 1340, d1);
    const crown = [[-70, -324], ...P.quad(-70, -324, -80, -392, -50, -398), ...P.quad(-50, -398, 0, -380, 50, -398), ...P.quad(50, -398, 80, -392, 70, -324)];
    shade(crown, .06); mk([...crown, crown[0]], 6.5, col, 1341, d1);
    mk(P.line(-72, -356, 72, -356), 5, col, 1342, d2);                                          // hat band
    // reaching arm: shoulder -> elbow (hangs, chosen so the forearm keeps its length) -> forearm -> wrist -> glove at `reach`
    const S = [side * 116, -152]; let E = null;
    for (let k = 0; k <= 24; k++) { const dg = lerp(50, 110, k / 24), ph = dg * Math.PI / 180, ex = S[0] + side * Math.cos(ph) * 100, ey = S[1] + Math.sin(ph) * 100, L = Math.hypot(rx - ex, ry - ey);
      const cost = 2 * Math.max(0, 150 - L) + Math.max(0, L - 200) + .5 * Math.abs(dg - 94); if (!E || cost < E.cost) E = { x: ex, y: ey, L: L || 1, cost } }
    const GL = 50, HL = 21 + 12 + GL;                                                          // forearm cap + 12 px of wrist + glove
    const hx = (rx - E.x) / E.L, hy = (ry - E.y) / E.L, fl = Math.max(30, E.L - HL), wrist = E.L - HL >= 30;
    const F = [E.x + hx * fl, E.y + hy * fl], B = [rx - hx * GL, ry - hy * GL];
    const a1 = people_capsule(S[0], S[1], E.x, E.y, 22), a2 = people_capsule(E.x, E.y, F[0], F[1], 21);
    shade(a1, .06); mk([...a1, a1[0]], 6, col, 1350, d2);
    if (wrist) { const wr = people_capsule(F[0], F[1], B[0] + hx * 8, B[1] + hy * 8, 13); shade(wr, .06); mk([...wr, wr[0]], 5, col, 1351, d2) }
    shade(a2, .06); mk([...a2, a2[0]], 6, col, 1352, d2);
    people_cuff(F[0] - hx * 9, F[1] - hy * 9, hx, hy, 17, col, 1353, d3);
    people_glove(B[0], B[1], rx, ry, 19, -side, col, 1354, d3);
    // pocket arm: shoulder -> elbow out -> forearm down into the pocket, its cuff ending at the flap
    const e2 = [-side * 160, -30], f2 = [-side * 96, 72], pl = Math.hypot(f2[0] - e2[0], f2[1] - e2[1]), pux = (f2[0] - e2[0]) / pl, puy = (f2[1] - e2[1]) / pl;
    const b1 = people_capsule(-side * 116, -152, e2[0], e2[1], 22), b2 = people_capsule(e2[0], e2[1], f2[0], f2[1], 21);
    shade(b1, .06); mk([...b1, b1[0]], 6, col, 1360, d2); shade(b2, .06); mk([...b2, b2[0]], 6, col, 1361, d2);
    people_cuff(f2[0] - pux * 10, f2[1] - puy * 10, pux, puy, 17, col, 1362, d3);
    for (const s of [-1, 1]) { const flap = [...P.line(s * 128, 86, s * 56, 86), ...P.quad(s * 56, 86, s * 54, 112, s * 66, 114), ...P.line(s * 66, 114, s * 118, 114), ...P.quad(s * 118, 114, s * 130, 112, s * 128, 86)];
      shade(flap, .09); mk([...flap, flap[0]], 4.5, col, 1370 + (s > 0 ? 1 : 0), d3) }                                  // pocket flaps (hide the buried hand)
    people_ground(-190, 190, 344, col, 1380, d3);
    c.restore();
  };

  // footprints: a trail of shoe prints (sole with rounded toe and waist, separate heel, zig-zag tread) walking up and across the frame, alternating left/right foot, shrinking with distance; `count` sets how many (a straight diagonal up to 7, a serpentine with three turns past 7), `tint` the colour (red by default)
  ART.footprints = (t, u, o = {}) => {
    const c = A.ctx, col = (o.tint && ACC[o.tint]) || o.col || ACC.red, n = Math.max(1, Math.min(12, o.count || 4)), es = o.es == null ? 99 : o.es;
    const f = clamp((n - 1) / 3), base = n === 1 ? 2.4 : n === 2 ? 1.5 : n === 3 ? 1.2 : 1;   // one print: big and centred; short trails grow toward the centre
    const W = n <= 7 ? [[-230 * f, 282 * f], [236 * f, -296 * f]] : [[-330, 296], [-40, 90], [-300, -110], [330, -330]];
    const segs = []; let total = 0; for (let i = 1; i < W.length; i++) { const L = Math.hypot(W[i][0] - W[i - 1][0], W[i][1] - W[i - 1][1]); segs.push(L); total += L }
    const at = k => { if (total < 1) return [0, 0, -Math.PI / 2 + .3]; let s = k * total; for (let i = 0; i < segs.length; i++) { if (s <= segs[i] || i === segs.length - 1) { const f = clamp(s / segs[i]); return [lerp(W[i][0], W[i + 1][0], f), lerp(W[i][1], W[i + 1][1], f), Math.atan2(W[i + 1][1] - W[i][1], W[i + 1][0] - W[i][0])] } s -= segs[i] } };
    const sole = [...P.quad(-42, -36, -44, -104, -4, -106), ...P.quad(-4, -106, 40, -102, 44, -40), ...P.quad(44, -40, 38, 20, 22, 48), ...P.line(22, 48, -20, 48), ...P.quad(-20, 48, -40, 20, -42, -36)];
    const heel = [...P.quad(-32, 70, -34, 116, -4, 118), ...P.quad(-4, 118, 32, 116, 32, 70), ...P.quad(32, 70, 0, 62, -32, 70)];
    const stride = n > 7 ? 62 : 54;                                                           // lateral stance: wide enough that consecutive prints never touch
    for (let i = 0; i < n; i++) { const d = ease((es - .06 - i * (.5 / Math.max(1, n - 1))) / .3); if (d <= 0) continue;
      const k = n > 1 ? i / (n - 1) : 0, [x, y, a] = at(k), sc = lerp(1.08, .62, k) * (n > 7 ? .55 : base), side = i % 2 ? 1 : -1, off = n === 1 ? 0 : stride * sc, al = lerp(1, .72, k) * (i === n - 1 ? .92 + .08 * Math.sin(t * 3) : 1);
      c.save(); c.translate(x - Math.sin(a) * side * off, y + Math.cos(a) * side * off); c.rotate(a + Math.PI / 2); c.scale(sc * side, sc);
      shade(sole, .05); mk([...sole, sole[0]], 6.5, col, 1800 + i, d, al);
      shade(heel, .05); mk([...heel, heel[0]], 6, col, 1815 + i, d, al);
      for (let j = 0; j < 4; j++) { const y0 = -82 + j * 25, pts = Array.from({ length: 7 }, (_, q) => [-33 + q * 11, y0 + (q % 2 ? 6 : -6)]); mk(pts, 3, col, 1830 + i * 4 + j, d, al * .75) }
      for (let j = 0; j < 2; j++) { const y0 = 84 + j * 18, pts = Array.from({ length: 5 }, (_, q) => [-22 + q * 11, y0 + (q % 2 ? 5 : -5)]); mk(pts, 3, col, 1880 + i * 2 + j, d, al * .75) }
      c.restore() }
  };
  // suitcase: a rolling suitcase lying open — base tray with a rolled towel at the back and a folded shirt in front, held by elastic cross straps with a clip; lid standing open with its lining and a zip pocket; carry handle, two latches, corner guards, rivets; two wheels peeking out of the bottom end; a luggage tag that swings
  ART.suitcase = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1, d2 } = objects_layers(o.es);
    c.save(); c.translate(-80, 0);                                         // the lid leans right: shift so the ink is centred on the origin
    const D = [120, -140];                                                 // depth direction of the 3/4 view (the tray mouth is 140 px tall)
    // base box corners
    const FL = [-250, 40], FR = [250, 40], BL = [FL[0] + D[0], FL[1] + D[1]], BR = [FR[0] + D[0], FR[1] + D[1]], HB = 150;
    objects_dash([...P.line(-262, 240, 244, 240), ...P.line(262, 232, 386, 88)], 3.5, PALE, 3890, d0, .4, 24, 18);
    // wheels on the bottom end (left): the front one under the corner, the back one peeking out past the end
    for (const [wx, wy, k] of [[-236, 204, 0], [-264, 126, 1]]) { const wh = P.circle(wx, wy, 27); shade(wh, .05); mk(wh, 6, col, 3800 + k, d0); mk(P.circle(wx, wy, 11), 3.5, col, 3802 + k, d1, .7) }
    // the open tray (its floor is hidden by the clothes)
    const mouth = P.poly([FL, FR, BR, BL]); shade(mouth, .02);
    // the lid, hinged on the back edge, standing open and tilted back
    const LT = [50, -200], LL = [BL[0] + LT[0], BL[1] + LT[1]], LR = [BR[0] + LT[0], BR[1] + LT[1]], TK = [26, 9];
    const lidSide = P.poly([BR, LR, [LR[0] + TK[0], LR[1] + TK[1]], [BR[0] + TK[0], BR[1] + TK[1]]]); shade(lidSide, .03); mk([...lidSide, lidSide[0]], 6, col, 3810, d0);
    const lid = P.poly([BL, BR, LR, LL]); shade(lid, .06); mk([...lid, lid[0]], 7, col, 3811, d0);
    const fl = objects_face(BL, [BR[0] - BL[0], BR[1] - BL[1]], [LL[0] - BL[0], LL[1] - BL[1]]);
    const lin = [fl(.04, .12), fl(.96, .12), fl(.96, .87), fl(.04, .87)]; mk([...lin, lin[0]], 3.5, col, 3812, d1, .6);        // lining seam: 26 px inside the lid top, 10 px above the towel roll
    const pk = [fl(.14, .50), fl(.86, .50), fl(.86, .74), fl(.14, .74)]; shade(pk, .05); mk([...pk, pk[0]], 4, col, 3815, d1, .8);   // zip pocket, 26 px below the seam
    objects_dash([...P.line(pk[3][0], pk[3][1], pk[2][0], pk[2][1])], 3, col, 3930, d1, .8, 10, 8);                              // the zip along its top
    objects_dot(pk[2][0] - 22, pk[2][1] + 2, 5, col, .8 * d1);                                                                 // zip pull
    // the base: right end face, then the front face (covers the top halves of the wheels)
    const side = P.poly([FR, BR, [BR[0], BR[1] + HB], [FR[0], FR[1] + HB]]); shade(side, .04); mk([...side, side[0]], 6.5, col, 3830, d0);
    const front = P.poly([FL, FR, [FR[0], FR[1] + HB], [FL[0], FL[1] + HB]]); shade(front, .08); mk([...front, front[0]], 7, col, 3831, d0);
    // clothes in the tray: the towel roll along the back, the folded shirt in front, 22 px of tray between them
    const roll = [...objects_ell(274, -88, 20, 26, -Math.PI / 2, Math.PI / 2), ...P.line(274, -62, -96, -62), ...P.line(-96, -62, -96, -114), ...P.line(-96, -114, 274, -114)];
    shade(roll, .09); mk(roll, 5, col, 3840, d1); mk(objects_ell(274, -88, 20, 26, Math.PI / 2, Math.PI * 1.5), 3.5, col, 3841, d1, .5);
    mk(P.line(-70, -76, 250, -76), 3, col, 3842, d1, .35); mk(objects_ell(274, -88, 10, 13), 3, col, 3843, d1, .5);           // shadow line and the spiral of the roll
    const shirt = P.poly([[-216, 24], [150, 24], [205, -40], [-161, -40]]); shade(shirt, .1); mk([...shirt, shirt[0]], 5, col, 3844, d1);
    mk(P.line(-6, -40, 20, -14), 3.5, col, 3845, d1, .7); mk(P.line(20, -14, 46, -40), 3.5, col, 3846, d1, .7);              // collar V
    mk(P.line(20, -14, 16, 14), 3, col, 3861, d1, .4);                                                                          // placket
    mk(P.line(-176, 18, -128, -34), 3, col, 3847, d1, .45); mk(P.line(122, 18, 170, -34), 3, col, 3848, d1, .45);             // sleeve folds
    // elastic cross straps over the clothes, clipped where they cross
    const fm = objects_face(FL, [FR[0] - FL[0], FR[1] - FL[1]], [BL[0] - FL[0], BL[1] - FL[1]]);
    const s1 = fm(.06, .10), s2 = fm(.94, .90), s3 = fm(.94, .10), s4 = fm(.06, .90);
    mk(P.line(s1[0], s1[1], s2[0], s2[1]), 4.5, col, 3813, d1, .8); mk(P.line(s3[0], s3[1], s4[0], s4[1]), 4.5, col, 3814, d1, .8);
    const cp = fm(.5, .5), clip = objects_rr(cp[0] - 16, cp[1] - 11, 32, 22, 5); shade(clip, .14); mk(clip, 3.5, col, 3818, d1, .9);
    // rims of the tray in front of the clothes: front and right edges, then the left edge
    mk([...P.line(FL[0], FL[1], FR[0], FR[1]), ...P.line(FR[0], FR[1], BR[0], BR[1])], 7, col, 3849, d0);
    mk(P.line(FL[0], FL[1], BL[0], BL[1]), 6.5, col, 3832, d0);
    // front face details: latches, handle, corner guards
    for (const [lx, k] of [[-182, 0], [138, 1]]) { const la = objects_rr(lx, FL[1] + 14, 46, 34, 6); shade(la, .12); mk(la, 4.5, col, 3850 + k, d1); mk(P.line(lx + 8, FL[1] + 31, lx + 38, FL[1] + 31), 3, col, 3852 + k, d1, .7) }
    const hd = objects_rr(-72, FL[1] + 20, 144, 44, 20); shade(hd, .12); mk(hd, 6, col, 3854, d1); mk(objects_rr(-58, FL[1] + 30, 116, 24, 12), 3.5, col, 3855, d1, .5);
    mk(P.rect(-92, FL[1] + 26, 16, 32), 4, col, 3856, d1, .8); mk(P.rect(76, FL[1] + 26, 16, 32), 4, col, 3857, d1, .8);
    const q = Math.PI / 2;
    mk(P.arc(FL[0] + 34, FL[1] + HB - 34, 34, q, Math.PI), 5, col, 3858, d1, .8); mk(P.arc(FR[0] - 34, FR[1] + HB - 34, 34, 0, q), 5, col, 3859, d1, .8);
    mk(P.arc(FL[0] + 34, FL[1] + 34, 34, Math.PI, 3 * q), 5, col, 3860, d1, .8);
    for (let i = 0; i < 6; i++) objects_dot(FL[0] + 55 + i * 78, FL[1] + HB - 12, 3, col, .5 * d1);
    // luggage tag hanging from the handle, swinging a little
    c.save(); c.translate(70, FL[1] + 62); c.rotate(.18 + Math.sin(t * 1.3) * .07);
    mk(P.line(0, 0, 0, 34), 3.5, col, 3870, d2, .8);
    const tg = objects_rr(-24, 34, 48, 76, 8); shade(tg, .12); mk(tg, 4.5, col, 3871, d2); mk(P.circle(0, 46, 6), 3, col, 3872, d2, .7);
    mk(P.line(-12, 66, 12, 66), 3, col, 3873, d2, .6); mk(P.line(-12, 80, 8, 80), 3, col, 3874, d2, .6); mk(P.line(-12, 94, 12, 94), 3, col, 3875, d2, .6);
    c.restore();
    c.restore();
  };

  // ---- art: the general alphabet -------------------------------------------------
  // The nineteen drawings above were the hotel film's own world. These are the words every other
  // explainer needs: a person, a machine, a place, a number, an idea. One drawing per spoken phrase
  // only works if the phrase has a drawing, so the vocabulary has to be wide enough to say things.

  // crowd: up to 12 people from the chest up in staggered rows (front row biggest), each with shoulders, collar, head, hair variant (fringe/bun/cap/short), glasses on some, smile or not, bobbing; `count` sets how many, `led` colours the front-centre person in that accent (with glow)
  ART.crowd = (t, u, o = {}) => {
    const col = o.col || WHITE, n = Math.max(1, Math.min(12, o.count || 9)), one = o.led && ACC[o.led] ? ACC[o.led] : null, es = o.es == null ? 99 : o.es;
    const rows = Math.ceil(n / 4), list = []; let k = 0;
    for (let r = rows - 1; r >= 0; r--) { const m = Math.min(4, n - r * 4), sc = [1, .86, .74][r] || .7, y = [124, -14, -134][r] || -134, stag = r === 1 && m === 4 ? 37 : 0;
      for (let j = 0; j < m; j++) list.push({ r, x: (j - (m - 1) / 2) * 160 * sc + stag, y, sc, i: k++ }) }
    let pick = null; for (const p of list) if (p.r === 0 && (!pick || Math.abs(p.x) < Math.abs(pick.x))) pick = p;
    list.forEach((p, idx) => { const led = one && p === pick, d = ease((es - idx * .045) / .3), cc = led ? one : col, w = led ? 6.5 : 5.5;
      if (led) glow(one, 18, () => people_bust(p.i, p.x, p.y, p.sc, cc, w, 1400 + idx * 10, d, t)); else people_bust(p.i, p.x, p.y, p.sc, cc, w, 1400 + idx * 10, d, t) });
    people_ground(-330, 330, 146, col, 1560, ease((es - .4) / .3), .35);
  };

  // handshake: two forearms in jacket sleeves and buttoned shirt cuffs meeting in a grip — the left hand's back (tendons, wrist crease) with its thumb lying across the top, the right hand's knuckle edge and its four hooked fingers (nails, 18 px of black between them) wrapping over it, the right hand's back and wrist; shake ticks above and below; pumps gently
  ART.handshake = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, es = o.es == null ? 99 : o.es;
    const d1 = ease(es / .35), d2 = ease((es - .16) / .35), d3 = ease((es - .32) / .3);
    c.save(); c.translate(0, Math.sin(t * 2.2) * 3);
    for (const s of [-1, 1]) { const k = s > 0 ? 1 : 0, yo = s > 0 ? -14 : 0;
      const sl = [...P.line(s * 372, -84 + yo, s * 300, -80 + yo), ...P.quad(s * 300, -80 + yo, s * 288, -8 + yo, s * 300, 66 + yo), ...P.line(s * 300, 66 + yo, s * 372, 70 + yo)];
      shade(sl, .06); mk(sl, 6.5, col, 1600 + k, d1);
      const cf = [...P.line(s * 302, -96 + yo, s * 236, -92 + yo), ...P.quad(s * 236, -92 + yo, s * 226, -10 + yo, s * 236, 78 + yo), ...P.line(s * 236, 78 + yo, s * 302, 82 + yo), ...P.quad(s * 302, 82 + yo, s * 292, -8 + yo, s * 302, -96 + yo)];
      shade(cf, .07); mk([...cf, cf[0]], 6, col, 1602 + k, d1);
      people_dot(s * 252, 46 + yo, 5.5, col, d3);
      mk(P.line(s * 236, -70 + yo, s * 176, -70 + yo), 6, col, 1604 + k, d1); mk(P.line(s * 236, 60 + yo, s * 176, 60 + yo), 6, col, 1606 + k, d1);   // wrist
      mk(P.arc(s * 206, -5 + yo, 70, s > 0 ? Math.PI - .36 : -.36, s > 0 ? Math.PI + .36 : .36), 3.5, col, 1608 + k, d3, .5) }                  // wrist crease
    // left hand: the back of the hand, from the wrist to the knuckles — only the edges not hidden by the right hand's fingers are stroked; faint tendons fill the back
    const L = [...P.quad(-176, -70, -100, -92, -40, -90), ...P.quad(-40, -90, 60, -98, 108, -60), ...P.quad(108, -60, 112, 40, 40, 98), ...P.quad(40, 98, -90, 98, -176, 60)];
    shade(L, .06);
    mk(P.quad(-176, -70, -100, -92, -44, -90), 6.5, col, 1610, d1); mk(P.quad(-176, 60, -100, 96, 2, 99), 6.5, col, 1611, d1);
    mk(P.quad(-150, -36, -70, -58, 0, -70), 3, col, 1616, d3, .3); mk(P.quad(-150, 4, -70, -6, -10, -14), 3, col, 1617, d3, .3); mk(P.quad(-150, 40, -70, 46, -20, 44), 3, col, 1618, d3, .26);
    // right hand: its back and knuckle edge, from the right wrist; the knuckle edge is stroked under the fingers so knuckles show between them
    const R = [[176, -84], ...P.quad(176, -84, 148, -102, 124, -102), ...P.quad(124, -102, 112, 0, 120, 102), ...P.quad(120, 102, 150, 92, 176, 46)];
    shade(R, .06); mk([...P.quad(176, -84, 148, -102, 124, -102), ...P.line(124, -102, 122, -68)], 6.5, col, 1612, d1);
    mk(P.quad(124, -102, 112, 0, 120, 102), 5, col, 1614, d1, .7);
    mk(P.quad(176, 46, 152, 92, 126, 100), 6.5, col, 1613, d1);
    // the right hand's four fingers hook over the left hand's back, index on top, 48 px apart
    for (let i = 0; i < 4; i++) { const by = -56 + i * 48, f = people_finger(124, by, -16 + i * 7, by + 24, 15, 24, .9);
      shade(f.open, .06); mk(f.open, 6, col, 1620 + i, d2); people_nail(f.tip[0], f.tip[1], f.ang, 14, col, 1625 + i, d3) }
    // the left hand's thumb lies across the top, clear of the index finger, onto the right hand's back
    const th = people_finger(-36, -100, 136, -92, 19, -8, .86);
    shade(th.open, .07); mk(th.open, 6, col, 1640, d2); people_nail(th.tip[0], th.tip[1], th.ang, 16, col, 1641, d3); people_crease(52, -97, th.ang, 19, col, 1642, d3);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { const x = -40 + i * 40, a = (i - 1) * .35;
      mk(P.line(x, s * 134, x + Math.sin(a) * 26, s * 134 + s * 26 * Math.cos(a)), 4, col, 1650 + i + (s > 0 ? 3 : 0), d3, .8) }
    c.restore();
  };

  // eye: a big almond eye with brow, lid crease, lashes, tear duct and under-eye line; the iris (in `tint`, white otherwise) has radial fibres, an inner ring, a pupil with a punched highlight and a glint; it glances and blinks; `no` slashes it in red
  ART.eye = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, es = o.es == null ? 99 : o.es, iris = o.tint && ACC[o.tint] ? ACC[o.tint] : col;
    const d1 = ease(es / .35), d2 = ease((es - .16) / .35), d3 = ease((es - .36) / .3);
    const blink = (t % 4.3) < .16 ? .1 : 1, gx = Math.sin(t * .7) * 16, gy = Math.sin(t * 1.3) * 5;
    mk(P.quad(-350, -300, -60, -392, 350, -292), 10, col, 1700, d2);                             // brow
    mk(P.quad(-330, -284, -80, -366, 200, -318), 5, col, 1701, d3, .5);
    c.save(); c.scale(1, blink);
    const up = P.quad(-350, 0, 0, -232, 350, 0), lo = P.quad(350, 0, 0, 178, -350, 0), lid = [...up, ...lo];
    shade(lid, .05);
    c.save(); c.beginPath(); c.moveTo(lid[0][0], lid[0][1]); for (const p of lid) c.lineTo(p[0], p[1]); c.closePath(); c.clip();
    const ix = gx, iy = -14 + gy;
    mk(P.circle(ix, iy, 112), 6.5, iris, 1702, d2);
    for (let i = 0; i < 16; i++) { const a = i / 16 * TAU + .2, r0 = 60 + n1(i) * 10, r1 = 104 - n1(i + 20) * 8;
      mk(P.line(ix + Math.cos(a) * r0, iy + Math.sin(a) * r0, ix + Math.cos(a) * r1, iy + Math.sin(a) * r1), 3, iris, 1710 + i, d3, .55) }
    mk(P.circle(ix, iy, 64), 3.5, iris, 1703, d3, .5);
    people_dot(ix, iy, 48, col, d2); people_dot(ix - 17, iy - 17, 14, '#000000', d2);
    mk(P.arc(ix, iy, 84, Math.PI * 1.15, Math.PI * 1.45), 5, col, 1704, d3, .8);
    c.restore();
    mk(up, 7, col, 1705, d1); mk(lo, 6.5, col, 1706, d1);
    mk(P.quad(-300, -34, 0, -276, 316, -46), 4.5, col, 1707, d3, .55);                          // lid crease
    mk(P.quad(-250, 40, 0, 210, 250, 44), 3.5, col, 1708, d3, .45);                             // under-eye
    mk(P.quad(-350, 0, -374, 10, -360, 26), 5, col, 1709, d2);                                  // tear duct
    for (let i = 0; i < 7; i++) { const s = i < 5 ? .58 + i * .095 : .1 + (i - 5) * .1, m = 1 - s, dir = i < 5 ? 1 : -1;
      const x = m * m * -350 + s * s * 350, y = 2 * m * s * -232, bx = 700, by = 464 * (s - m), L = Math.hypot(bx, by), nx = by / L, ny = -bx / L, tx = bx / L * dir, ty = by / L * dir, len = i < 5 ? 44 + n1(i) * 24 : 30;
      mk(P.quad(x, y, x + nx * len * .5 + tx * len * .2, y + ny * len * .5 + ty * len * .2, x + nx * len + tx * len * .35, y + ny * len + ty * len * .35), 4.5, col, 1740 + i, d3, .9) }
    c.restore();
    if (o.no) { const g = ease((es - .3) / .3); glow(ACC.red, 24, () => mk(P.line(-310, 210, 310, -210), 13, ACC.red, 1730, g)) }
  };

  // brain: a brain in profile facing left — cerebrum outline with frontal, parietal and occipital lobes, lateral fissure and central sulcus, a dozen folded gyri, hatched shade on the far side, striated cerebellum at lower back and the brain stem, synapse sparks that blink in turn, dashed shadow beneath
  ART.brain = (t, u, o = {}) => {
    const col = o.col || WHITE, { es, d0, d1, d2 } = tools_layers(o.es);
    tools_ground(-220, 220, 330, 8960, d1, .35);
    const sh = [
      ...P.quad(-270, 120, -370, 70, -340, -80),
      ...P.quad(-340, -80, -300, -250, -130, -255).slice(1),
      ...P.quad(-130, -255, 40, -300, 190, -215).slice(1),
      ...P.quad(190, -215, 330, -140, 310, 0).slice(1),
      ...P.quad(310, 0, 300, 80, 240, 110).slice(1),
      ...P.quad(240, 110, 330, 150, 270, 220).slice(1),
      ...P.quad(270, 220, 190, 265, 130, 215).slice(1),
      ...P.line(130, 215, 118, 290).slice(1), ...P.line(118, 290, 62, 292).slice(1), ...P.line(62, 292, 66, 210).slice(1),
      ...P.quad(66, 210, -60, 225, -160, 175).slice(1),
      ...P.quad(-160, 175, -240, 165, -270, 120).slice(1)];
    shade(sh, .06); mk(sh, 7, col, 8901, d0);
    mk([...P.quad(-250, 40, -80, 20, 120, 62), ...P.quad(120, 62, 170, 66, 185, 24).slice(1)], 4.5, col, 8902, d1, .9);   // lateral fissure
    mk(tools_wiggle(-30, -272, -80, -10, 9, 2.2, .5), 4.5, col, 8903, d1, .85);                                             // central sulcus
    mk(P.quad(240, 110, 150, 120, 118, 212), 4.5, col, 8904, d1, .9);                                                       // cerebellum edge
    mk(P.line(70, 240, 116, 236), 3, col, 8905, d1, .5); mk(P.line(68, 266, 118, 262), 3, col, 8906, d1, .5);              // stem ridges
    for (let k = 0; k < 4; k++) mk(P.quad(176 + k * 14, 132 + k * 22, 250 + k * 6, 128 + k * 24, 292 - k * 14, 168 + k * 14), 3, col, 8910 + k, d1, .6);   // cerebellum striations
    tools_hatch(270, 10, -1.5, 15, 6, 26, -.9, 2.5, col, 8915, d1, .3);                                                        // shade on the far side, hugging the occipital curve
    mk(tools_wiggle(215, -205, 250, -70, 8, 2, 1.2), 4, col, 8907, d1, .7);                                                   // parieto-occipital sulcus
    const tiers = [[.9, 0], [.68, 2.1], [.46, 4.2]];                                                                          // gyri: folds that follow the cerebrum in three tiers
    tiers.forEach(([f, ph], k) => { const pts = tools_resample(tools_ell(-20, -60, 320 * f, 215 * f, Math.PI * .88, Math.PI * 2.12), 8), L = pts.length * 8;   // ends dropped to just above the fissure
      mk(tools_wigglePath(pts, 13, L / 70, ph), 3.5, col, 8930 + k, ease((es - .22 - k * .04) / .3), .75) });
    [[1, 0], [.6, 2.5]].forEach(([f, ph], k) => { const pts = tools_resample(tools_ell(-90, 70, 170 * f, 100 * f, .15, Math.PI - .15), 8), L = pts.length * 8;   // ...and two under the fissure, in the temporal lobe
      mk(tools_wigglePath(pts, 12, L / 64, ph), 3.5, col, 8924 + k, ease((es - .3 - k * .04) / .3), .75) });
    mk(tools_wiggle(94, 92, 210, 104, 10, 2.5), 3.5, col, 8933, ease((es - .34) / .3), .75);                                     // posterior temporal fold under the fissure tail
    mk(tools_wiggle(150, 124, 88, 178, 9, 2, .8), 3.5, col, 8934, ease((es - .38) / .3), .75);                                    // occipital fold in front of the cerebellum
    [[-200, -130], [70, -200], [230, -70], [-40, 110]].forEach(([x, y], k) => tools_spark(x, y, 16, col, 8940 + k * 4, d2, .9 * clamp(Math.sin(t * 1.9 + k * 1.7))));   // synapses
  };

  // robot: friendly standing robot — antenna with glowing ball, rounded head with ear discs, two round eyes with pupils in the led/tint colour (they blink), brows, speaker-grille mouth, neck, torso with shoulder joints and a chest panel (two dials, three lights, a gauge), left arm resting, right arm waving with a two-finger claw, hip block, legs with knee joints and boots, dashed shadow; led/tint = eye, antenna and chest light colour
  ART.robot = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = ACC[o.led || o.tint || 'white'] || WHITE, { es, d0, d1, d2 } = devices_layers(o.es);
    devices_ground(-170, 170, 362, 6600, d0);
    // legs and boots
    for (const s of [-1, 1]) { const i = (s + 1) / 2, x = s * 62;
      const thigh = devices_rr(x - 26, 120, 52, 90, 14); shade(thigh, .05); mk(thigh, 6, col, 6640 + i, d0);
      const knee = P.circle(x, 218, 24); shade(knee, .1); mk(knee, 5, col, 6642 + i, d0);
      const shin = devices_rr(x - 22, 236, 44, 74, 12); shade(shin, .05); mk(shin, 6, col, 6644 + i, d0);
      const foot = devices_rr(x - 48 - (s < 0 ? 22 : 0), 306, 118, 40, 14); shade(foot, .07); mk(foot, 6.5, col, 6646 + i, d0);
      mk(P.line(x - 30, 326, x + 30, 326), 3, col, 6648 + i, d1, .4);
    }
    const hip = devices_rr(-104, 86, 208, 44, 12); shade(hip, .08); mk(hip, 6, col, 6650, d0);
    // arms: upper arm, elbow, forearm, wrist, two-finger claw
    const arm = (sx, sy, a1, a2, seed, da) => {
      c.save(); c.translate(sx, sy); c.rotate(a1);
      mk(P.line(0, 0, 0, 96), 13, col, seed, da); mk(P.line(0, 0, 0, 96), 4, col, seed + 1, da, .3);
      c.translate(0, 96); c.rotate(a2);
      const el = P.circle(0, 0, 18); shade(el, .1); mk(el, 5, col, seed + 2, da);
      mk(P.line(0, 18, 0, 100), 11, col, seed + 3, da);
      const wr = devices_rr(-16, 96, 32, 20, 6); shade(wr, .1); mk(wr, 4, col, seed + 4, da);
      mk(P.arc(-14, 134, 20, Math.PI * .5, Math.PI * 1.5), 6, col, seed + 5, da); mk(P.arc(14, 134, 20, -Math.PI * .5, Math.PI * .5), 6, col, seed + 6, da);
      c.restore();
    };
    arm(-158, -136, .28 + Math.sin(t * 1.3) * .02, -.25, 6660, d1);
    arm(158, -136, -Math.PI * .85, -Math.PI * .3 + Math.sin(t * 3) * .18, 6670, d1);
    // torso, shoulders, chest panel
    const torso = devices_rr(-150, -176, 300, 264, 34); shade(torso, .06); mk(torso, 7.5, col, 6680, d0);
    for (const s of [-1, 1]) { const sh = P.circle(s * 150, -136, 26); shade(sh, .12); mk(sh, 5.5, col, 6681 + (s + 1) / 2, d0) }
    const panel = devices_rr(-100, -140, 200, 150, 14); shade(panel, .04); mk(panel, 4.5, col, 6683, d1, .9);
    for (const s of [-1, 1]) { const x = s * 52, y = -96, a = -.9 + s * .5 + t * .3; mk(P.circle(x, y, 26), 4, col, 6684 + (s + 1) / 2, d1); mk(P.line(x, y, x + Math.cos(a) * 18, y + Math.sin(a) * 18), 3.5, col, 6686 + (s + 1) / 2, d1) }
    for (let i = 0; i < 3; i++) { const x = -40 + i * 40, on = i === 1 ? .5 + .5 * Math.sin(t * 2.5) : (n1(Math.floor(t * 4) + i * 7) > .5 ? 1 : .15); devices_led(x, -40, 8, i === 1 ? hot : col, on, 6688 + i, d2) }
    mk(devices_rr(-70, -8, 140, 14, 5), 3, col, 6691, d1, .7); c.save(); c.globalAlpha *= d2 * .8; c.fillStyle = hot; c.fillRect(-66, -5, 40 + 40 * (.5 + .5 * Math.sin(t * .9)), 8); c.restore();
    mk(P.line(-120, 40, 120, 40), 3, col, 6692, d1, .3);
    // neck
    const neck = devices_rr(-30, -206, 60, 34, 8); shade(neck, .1); mk(neck, 5, col, 6693, d0);
    mk(P.line(-18, -196, 18, -196), 3, col, 6694, d1, .5); mk(P.line(-18, -184, 18, -184), 3, col, 6695, d1, .5);
    // head with ear discs and antenna
    for (const s of [-1, 1]) { const ear = P.circle(s * 130, -280, 22); shade(ear, .1); mk(ear, 5, col, 6696 + (s + 1) / 2, d0); mk(P.circle(s * 130, -280, 9), 3, col, 6698 + (s + 1) / 2, d1, .6) }
    const head = devices_rr(-124, -364, 248, 168, 40); shade(head, .06); mk(head, 7.5, col, 6700, d0);
    mk(P.line(0, -364, 0, -396), 6, col, 6701, d0); glow(hot, 18, () => devices_dot(0, -406, 13, hot, d2 * (.6 + .4 * Math.sin(t * 2)))); mk(P.circle(0, -406, 13), 3.5, col, 6702, d0, .8);
    // face: eyes with pupils and catch-lights (blink), brows, speaker mouth
    const blink = ((t * .45) % 1) > .93 ? .15 : 1;
    for (const s of [-1, 1]) { const x = s * 50, y = -300, i = (s + 1) / 2;
      const eye = devices_ell(x, y, 30, 30 * blink); shade(eye, .12); mk(eye, 5, col, 6703 + i, d1);
      glow(hot, 14, () => devices_dot(x + 6, y, 12 * blink, hot, d2)); devices_dot(x + 10, y - 5 * blink, 3.5, WHITE, d2 * .9);
      mk(P.line(x - 26, y - 44, x + 22, y - 48 + s * 4), 4.5, col, 6705 + i, d1, .8);
    }
    const mouth = devices_rr(-44, -248, 88, 28, 8); shade(mouth, .08); mk(mouth, 4, col, 6707, d1, .9);
    for (let i = 0; i < 5; i++) mk(P.line(-32 + i * 16, -242, -32 + i * 16, -222), 3, col, 6708 + i, d1, .6);
  };

  // ---- devices family: shared helpers (prefix devices_) --------------------------
  // closed rounded-rectangle path
  function devices_rr(x, y, w, h, r) {
    const q = Math.PI / 2, rr = Math.min(r, w / 2, h / 2);
    return [...P.arc(x + w - rr, y + rr, rr, -q, 0), ...P.arc(x + w - rr, y + h - rr, rr, 0, q), ...P.arc(x + rr, y + h - rr, rr, q, 2 * q), ...P.arc(x + rr, y + rr, rr, 2 * q, 3 * q), [x + w - rr, y]];
  }
  // elliptical arc path (P.arc is circular only); rot tilts the ellipse
  function devices_ell(cx, cy, rx, ry, a0 = 0, a1 = TAU, rot = 0) {
    const n = Math.max(8, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 10)), c = Math.cos(rot), s = Math.sin(rot);
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)), x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * c - y * s, cy + x * s + y * c] });
  }
  // small filled dot (rivet, LED, pupil)
  function devices_dot(x, y, r, col, a = 1) { if (a <= 0) return; const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore() }
  // an LED: glowing filled dot + thin ring; on in [0,1] dims it
  function devices_led(x, y, r, col, on, seed, d) {
    if (d <= 0) return;
    glow(col, 16, () => devices_dot(x, y, r, col, d * (.25 + .75 * on)));
    mk(P.circle(x, y, r + 3), 2.5, WHITE, seed, d, .5);
  }
  // the three draw-on layers of the brief: contour, details, colour (es undefined -> complete)
  function devices_layers(es) { const e = es === undefined ? 99 : es; return { es: e, d0: ease(e / .35), d1: ease((e - .2) / .35), d2: ease((e - .4) / .3) } }
  // resample a polyline every `step` px
  function devices_resample(pts, step) {
    const out = [pts[0]]; let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0); if (L === 0) continue;
      let s = step - carry; while (s <= L) { out.push([lerp(x0, x1, s / L), lerp(y0, y1, s / L)]); s += step }
      carry = L - (s - step);
    }
    return out;
  }
  // dashed marker stroke (each dash its own mk; reserve 40 seeds per call)
  function devices_dash(pts, w, col, seed, draw = 1, a = 1, dash = 20, gap = 14) {
    const rs = devices_resample(pts, 5), per = Math.max(2, Math.round(dash / 5)), gp = Math.max(1, Math.round(gap / 5)), n = rs.length;
    for (let i = 0, k = 0; i < n - 1 && k < 40; i += per + gp, k++) {
      const seg = rs.slice(i, Math.min(n, i + per + 1)); if (seg.length < 2) break;
      const dd = clamp((draw * n - i) / seg.length); if (dd <= 0) break;
      mk(seg, w, col, seed + k, dd, a);
    }
  }
  // dashed ground shadow under an object (seed..seed+39)
  function devices_ground(x0, x1, y, seed, d, a = .4) { devices_dash(P.line(x0, y, x1, y), 3.5, PALE, seed, d, a, 24, 18) }
  // hatch a quad with parallel short strokes (vent grille); seed..seed+n
  function devices_hatch(x, y, w, h, n, seed, d, a = .55, wd = 2.5, col = WHITE) { for (let i = 0; i < n; i++) { const xx = x + (i + .5) * w / n; mk(P.line(xx, y, xx, y + h), wd, col, seed + i, d, a) } }
  // laptop: open laptop in light 3/4 — lid with bezel + webcam, a window on screen (title bar, 3 dots, 3 text lines, blinking cursor), barrel hinge, base with visible front lip, 5 rows of single keys with a long spacebar, trackpad, dashed ground shadow; tint = colour of the screen content
  ART.laptop = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = (o.tint && ACC[o.tint] && ACC[o.tint] !== WHITE) ? ACC[o.tint] : col, { es, d0, d1, d2 } = devices_layers(o.es);
    devices_ground(-330, 330, 214, 5000, d0);
    // base: front lip (thickness) then the top deck, wider at the front
    const lip = [[-372, 176], [372, 176], [364, 198], [-364, 198]];
    shade(lip, .025); mk([...lip, lip[0]], 6.5, col, 5040, d0);
    const top = [[-330, 22], [330, 22], [372, 176], [-372, 176]];
    shade(top, .06); mk([...top, top[0]], 7, col, 5041, d0);
    // hinge barrel with two end caps
    const hinge = devices_rr(-300, 2, 600, 24, 12); shade(hinge, .1); mk(hinge, 5, col, 5042, d1);
    mk(P.line(-258, 2, -258, 26), 4, col, 5043, d1, .8); mk(P.line(258, 2, 258, 26), 4, col, 5044, d1, .8);
    // lid: outer shell, its right edge thickness, bezel, webcam
    const lid = devices_rr(-320, -298, 640, 300, 24); shade(lid, .05); mk(lid, 7, col, 5045, d0);
    mk(P.line(330, -270, 330, -30), 4, col, 5046, d0, .55);
    const bez = devices_rr(-298, -276, 596, 254, 8); shade(bez, .02); mk(bez, 4, col, 5047, d1, .9);
    devices_dot(0, -287, 4.5, col, d1); mk(P.circle(0, -287, 8), 2.5, col, 5048, d1, .6);
    // screen content: a window with a title bar, three dots, three lines of text and a blinking cursor
    glow(hot === col ? '#000000' : hot, hot === col ? 0 : 14, () => {
      const win = devices_rr(-252, -244, 504, 196, 10); shade(win, .04); mk(win, 4, hot, 5049, d1, .9);
      mk(P.line(-252, -210, 252, -210), 3.5, hot, 5050, d1, .8);
      for (let i = 0; i < 3; i++) mk(P.circle(-230 + i * 22, -227, 5), 3, hot, 5051 + i, d1, .8);
      const L = [330, 210, 280];
      for (let i = 0; i < 3; i++) mk(P.line(-226, -182 + i * 36, -226 + L[i], -182 + i * 36), 4.5, hot, 5054 + i, ease((es - .32 - i * .08) / .25), .9);
      if (d2 > 0 && Math.sin(t * 5) > 0) { c.save(); c.globalAlpha *= d2; c.fillStyle = hot; c.fillRect(-226 + L[2] + 12, -122, 10, 24); c.restore() }
    });
    // screen glint
    mk(P.line(-270, -262, -170, -262), 3, col, 5057, d1, .3); mk(P.line(-286, -246, -286, -160), 3, col, 5058, d1, .3);
    // keyboard: 5 rows of individual keys drawn in the deck's perspective, bottom row with a long spacebar
    for (let r = 0; r < 5; r++) {
      const y0 = 38 + r * 20, y1 = y0 + 15, f0 = (y0 - 22) / 154, f1 = (y1 - 22) / 154;
      const xl0 = lerp(-296, -338, f0), xl1 = lerp(-296, -338, f1), xr0 = -xl0, xr1 = -xl1, g = 2.5 / (xr0 - xl0);
      const cells = r < 4 ? Array.from({ length: 12 }, (_, i) => [i / 12, (i + 1) / 12]) : [[0, 1 / 12], [1 / 12, 2 / 12], [2 / 12, 3 / 12], [3 / 12, 9 / 12], [9 / 12, 10 / 12], [10 / 12, 11 / 12], [11 / 12, 1]];
      const dk = ease((es - .18 - r * .05) / .3);
      cells.forEach(([a, b], i) => {
        const q = [[lerp(xl0, xr0, a + g), y0], [lerp(xl0, xr0, b - g), y0], [lerp(xl1, xr1, b - g), y1], [lerp(xl1, xr1, a + g), y1]];
        mk([...q, q[0]], 2.5, col, 5100 + r * 16 + i, dk, .75);
      });
    }
    // trackpad
    const pad = devices_rr(-84, 140, 168, 30, 6); shade(pad, .04); mk(pad, 3.5, col, 5190, d1, .85);
    mk(P.line(0, 158, 0, 170), 2.5, col, 5191, d1, .5);
  };

  // server: 3/4 rack cabinet — top and right faces for depth, rack rails with mounting holes, 5 units each with two handles (rivets), a hatched vent grille, a drive bay with lever, a status LED breathing in `led` colour and a white activity LED flickering, feet, three cables trailing out of the back; led = status LED colour
  ART.server = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, led = ACC[o.led || 'green'] || ACC.green, { es, d0, d1, d2 } = devices_layers(o.es);
    devices_ground(-190, 300, 350, 5400, d0);
    // cables out of the back
    const cab = [[250, -140, 340, -60, 300, 120], [250, -20, 350, 80, 310, 240], [250, 100, 330, 180, 280, 322]];
    cab.forEach(([x0, y0, cx, cy, x1, y1], i) => mk(P.quad(x0, y0, cx + Math.sin(t * .8 + i) * 4, cy, x1 + Math.sin(t * .6 + i * 2) * 5, y1), 5, col, 5440 + i, d1, .85));
    // depth faces, then the front
    const side = [[200, -300], [252, -336], [252, 284], [200, 320]]; shade(side, .03); mk([...side, side[0]], 6, col, 5443, d0);
    const topf = [[-200, -300], [-148, -336], [252, -336], [200, -300]]; shade(topf, .09); mk([...topf, topf[0]], 6, col, 5444, d0);
    const front = P.rect(-200, -300, 400, 620); shade(front, .05); mk(front, 7, col, 5445, d0);
    // rack rails with mounting holes
    mk(P.line(-178, -292, -178, 312), 3, col, 5446, d1, .5); mk(P.line(178, -292, 178, 312), 3, col, 5447, d1, .5);
    for (let i = 0; i < 12; i++) { mk(P.rect(-193, -286 + i * 50, 9, 9), 2.5, col, 5450 + i, d1, .5); mk(P.rect(184, -286 + i * 50, 9, 9), 2.5, col, 5462 + i, d1, .5) }
    // five units
    for (let i = 0; i < 5; i++) {
      const y = -280 + i * 116, du = ease((es - .12 - i * .05) / .3), dd = ease((es - .3 - i * .05) / .3);
      const unit = devices_rr(-170, y, 340, 100, 6); shade(unit, .04); mk(unit, 5, col, 5480 + i, du);
      for (const s of [-1, 1]) { const hx = s * 148, h = devices_rr(hx - 7, y + 22, 14, 56, 5); shade(h, .12); mk(h, 3.5, col, 5490 + i * 2 + (s + 1) / 2, dd, .9);
        devices_dot(hx, y + 14, 3, col, dd * .8); devices_dot(hx, y + 86, 3, col, dd * .8) }
      mk(P.rect(-124, y + 14, 150, 72), 3, col, 5500 + i, dd, .7);
      devices_hatch(-120, y + 20, 142, 26, 14, 5520 + i * 30, dd, .5, 2.5, col); devices_hatch(-120, y + 54, 142, 26, 14, 5535 + i * 30, dd, .5, 2.5, col);
      const bay = devices_rr(40, y + 52, 84, 34, 4); shade(bay, .1); mk(bay, 3, col, 5700 + i, dd, .8); mk(P.line(48, y + 69, 74, y + 69), 3.5, col, 5705 + i, dd, .8);
      const on = .5 + .5 * Math.sin(t * 2.2 + i * 1.7), act = n1(Math.floor(t * 9) + i * 13) > .5 ? 1 : .15;
      devices_led(60, y + 30, 8, led, on, 5710 + i, d2); devices_led(98, y + 30, 6, col, act, 5715 + i, d2);
    }
    // feet
    for (const s of [-1, 1]) { const f = P.rect(s * 150 - 20, 320, 40, 16); shade(f, .04); mk(f, 4, col, 5720 + (s + 1) / 2, d0) }
  };

  // router: 3/4 wi-fi router — flat box with top and right faces, three antennas with base cylinders and knuckle joints tilted outward, vent slots on top, WPS button, a row of six LEDs on the front (led colour, default green, running pattern), power switch, four RJ45 ports + power jack on the right side, rubber feet, dashed shadow; beam/tint = three signal arcs rising over the antennas in that colour
  ART.router = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, wv = ACC[o.beam || o.tint || 'blue'] || ACC.blue, ledc = ACC[o.led || 'green'] || ACC.green, { es, d0, d1, d2 } = devices_layers(o.es);
    devices_ground(-300, 360, 204, 5800, d0);
    // antennas behind the box: base cylinder, lower segment, knuckle, upper segment, cap
    const AX = [-210, 0, 210], TILT = [-.16, 0, .16];
    AX.forEach((ax, i) => {
      c.save(); c.translate(ax + 40, 26); c.rotate(TILT[i] + Math.sin(t * .9 + i) * .01);
      const da = ease((es - .05 - i * .06) / .3);
      const base = devices_rr(-17, -30, 34, 32, 6); shade(base, .08); mk(base, 5, col, 5840 + i, da);
      mk(P.line(-9, -30, -9, -130), 8, col, 5843 + i, da); mk(P.line(9, -30, 9, -130), 8, col, 5846 + i, da);
      const kn = devices_rr(-14, -144, 28, 24, 8); shade(kn, .1); mk(kn, 4.5, col, 5849 + i, da);
      mk(P.line(-8, -144, -8, -250), 7, col, 5852 + i, da); mk(P.line(8, -144, 8, -250), 7, col, 5855 + i, da);
      mk(P.arc(0, -250, 8, Math.PI, TAU), 6, col, 5858 + i, da);
      mk(P.line(0, -60, 0, -120), 2.5, col, 5861 + i, da, .3);
      c.restore();
    });
    // the box: right face, top face, front face
    const right = [[320, 60], [380, 20], [380, 132], [320, 172]]; shade(right, .03); mk([...right, right[0]], 6.5, col, 5870, d0);
    const topf = [[-320, 60], [-260, 20], [380, 20], [320, 60]]; shade(topf, .09); mk([...topf, topf[0]], 6.5, col, 5871, d0);
    const front = [[-320, 60], [320, 60], [320, 172], [-320, 172]]; shade(front, .05); mk([...front, front[0]], 7, col, 5872, d0);
    // vent slots on the top face and the WPS button
    for (let i = 0; i < 16; i++) { const x = -240 + i * 26; mk(P.line(x + 16, 34, x + 4, 48), 3, col, 5880 + i, d1, .5) }
    mk(P.circle(296, 40, 9), 3, col, 5896, d1, .8); devices_dot(296, 40, 3, col, d1 * .8);
    // front: bevel line, six LEDs with tick marks, power switch
    mk(P.line(-310, 74, 310, 74), 3, col, 5897, d1, .35);
    for (let i = 0; i < 6; i++) { const x = -240 + i * 40, on = i === 0 ? 1 : (n1(Math.floor(t * 3) * 7 + i * 31) > .45 ? 1 : .1);
      devices_led(x, 118, 8, ledc, on, 5900 + i, d2); mk(P.line(x - 8, 144, x + 8, 144), 2.5, col, 5906 + i, d1, .5) }
    const sw = devices_rr(220, 100, 60, 34, 8); shade(sw, .08); mk(sw, 3.5, col, 5912, d1, .85); mk(P.line(236, 117, 250, 117), 3.5, col, 5913, d1, .8);
    // ports on the right face: four RJ45 stacked + a round power jack
    for (let i = 0; i < 4; i++) { const y = 50 + i * 22, q = [[339, y + 7], [361, y - 7], [361, y + 7], [339, y + 21]]; shade(q, 0); mk([...q, q[0]], 3, col, 5920 + i, d1, .8) }
    mk(devices_ell(350, 146, 7, 6, 0, TAU, -.3), 3, col, 5924, d1, .8);
    // rubber feet
    for (const s of [-1, 1]) { const f = P.rect(s * 270 - 14, 172, 28, 12); shade(f, .04); mk(f, 4, col, 5925 + (s + 1) / 2, d0, .8) }
    // signal: three arcs rising over the antennas in the beam/tint colour
    if (o.beam || o.tint) for (let i = 0; i < 3; i++) { const k = (t * .8 + i / 3) % 1, r = 90 + k * 210;
      glow(wv, 12, () => mk(P.arc(40, -100, r, Math.PI * 1.22, Math.PI * 1.78), 5.5, wv, 5930 + i, 1, (1 - k) * .9 * d2)) }
  };

  // camera: CCTV bullet camera hung from a ceiling bracket, front 3/4 — plate with two screws, arm with ball joint, sun hood with visible lip, lens glass with iris, pupil and glints, a ring of ten IR LEDs, body cylinder with two seam rings, top highlight and rear vent slots, cable looping from the back to the bracket, a blinking status LED; led = status LED colour; the camera pans slowly
  ART.camera = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, ledc = ACC[o.led || 'red'] || ACC.red, { es, d0, d1, d2 } = devices_layers(o.es), sw = Math.sin(t * .7) * .06;
    // ceiling plate with screws, collar, arm down to the ball joint
    const plate = devices_rr(60, -330, 190, 30, 8); shade(plate, .08); mk(plate, 6, col, 6400, d0);
    for (const x of [92, 218]) { devices_dot(x, -315, 6, col, d1 * .9); mk(P.line(x - 5, -319, x + 5, -311), 2.5, col, 6401 + (x > 200 ? 1 : 0), d1, .8) }
    mk(P.line(130, -300, 190, -300), 6, col, 6405, d1, .8);
    mk(P.line(160, -300, 138, -226), 13, col, 6403, d0); mk(P.line(160, -300, 138, -226), 4, col, 6404, d1, .3);
    const joint = P.circle(130, -200, 30); shade(joint, .1); mk(joint, 6, col, 6406, d0); mk(P.arc(130, -200, 19, Math.PI * 1.1, Math.PI * 1.6), 3, col, 6407, d1, .5);
    // below the joint everything pans with the camera
    c.save(); c.translate(130, -200); c.rotate(sw); c.translate(-130, 200);
    mk(P.line(118, -172, 60, -110), 13, col, 6408, d0);
    const cy = 10, hx = -240, bx = 210;
    const back = devices_ell(bx, cy, 32, 96, -Math.PI / 2, Math.PI / 2);
    shade([...back, [hx, cy + 124], [hx, cy - 124]], .05);
    mk(P.line(hx, cy - 124, bx, cy - 96), 7, col, 6410, d0); mk(P.line(hx, cy + 124, bx, cy + 96), 7, col, 6411, d0); mk(back, 6.5, col, 6412, d0);
    for (const x of [-70, 90]) { const f = (x - hx) / (bx - hx), ry = lerp(124, 96, f); mk(devices_ell(x, cy, 13, ry, -Math.PI / 2, Math.PI / 2), 4, col, 6413 + (x > 0 ? 1 : 0), d1, .7) }
    mk(P.line(-200, cy - 100, 60, cy - 82), 3, col, 6415, d1, .3);
    for (let i = 0; i < 4; i++) mk(P.line(140 + i * 14, cy - 44, 140 + i * 14, cy + 44), 3, col, 6416 + i, d1, .5);
    // the hood ring with its lip, the glass, the IR LEDs, the lens
    const hood = devices_ell(hx, cy, 66, 130); shade(hood, .08); mk(hood, 7.5, col, 6420, d0);
    mk(devices_ell(hx - 20, cy, 60, 118, Math.PI / 2, Math.PI * 1.5), 5, col, 6421, d0, .8);
    const glass = devices_ell(hx - 12, cy, 46, 92); shade(glass, .03); mk(glass, 5, col, 6422, d1);
    for (let i = 0; i < 10; i++) { const a = i * TAU / 10 + Math.PI / 10, lx = hx - 12 + Math.cos(a) * 37, ly = cy + Math.sin(a) * 75; devices_dot(lx, ly, 4.5, col, d2 * .85); mk(devices_ell(lx, ly, 7, 9), 2, col, 6430 + i, d2, .5) }
    mk(devices_ell(hx - 12, cy, 25, 50), 4.5, col, 6440, d1); mk(devices_ell(hx - 12, cy, 15, 30), 4, col, 6441, d1, .8);
    devices_dot(hx - 12, cy, 7, col, d1 * .9);
    mk(devices_ell(hx - 12, cy, 20, 40, -Math.PI * .85, -Math.PI * .55), 3, col, 6442, d1, .6); devices_dot(hx - 16, cy - 23, 3, col, d1 * .8);
    devices_led(hx + 34, cy - 110, 7, ledc, Math.sin(t * 4) > 0 ? 1 : 0, 6443, d2);
    c.restore();
    // cable from the back cap up to the plate
    mk(P.quad(236, -30, 300, -140, 236, -300), 5, col, 6450, d1, .85);
  };

  // chip: microprocessor package in light 3/4 — square body with bevelled rim and bottom/right thickness, pin-1 notch and index dot, 8 gull-wing pins per side with feet, the die in the centre with twelve traces and pads running toward the rim, a signal pulse travelling the traces; tint = die/traces colour
  ART.chip = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = (o.tint && ACC[o.tint] && ACC[o.tint] !== WHITE) ? ACC[o.tint] : col, { es, d0, d1, d2 } = devices_layers(o.es), R = 228, PL = 62;
    devices_ground(-250, 290, R + PL + 36, 6200, d0);
    // pins: 8 per side, a stub with a foot pad each
    for (let i = 0; i < 8; i++) { const p = -182 + i * 52, dp = ease((es - .1 - i * .02) / .3);
      mk(P.line(p, -R, p, -R - PL + 14), 7, col, 6240 + i, dp); mk(P.rect(p - 9, -R - PL, 18, 14), 3, col, 6248 + i, dp, .8);
      mk(P.line(p, R, p, R + PL - 14), 7, col, 6256 + i, dp); mk(P.rect(p - 9, R + PL - 14, 18, 14), 3, col, 6264 + i, dp, .8);
      mk(P.line(-R, p, -R - PL + 14, p), 7, col, 6272 + i, dp); mk(P.rect(-R - PL, p - 9, 14, 18), 3, col, 6280 + i, dp, .8);
      mk(P.line(R, p, R + PL - 14, p), 7, col, 6288 + i, dp); mk(P.rect(R + PL - 14, p - 9, 14, 18), 3, col, 6296 + i, dp, .8);
    }
    // body thickness (bottom + right), the body, its bevel and the bevel corners
    const th = [[-R, R], [R, R], [R, -R], [R + 16, -R + 16], [R + 16, R + 16], [-R + 16, R + 16]]; shade(th, .02); mk([...th, th[0]], 6, col, 6304, d0);
    const body = P.rect(-R, -R, 2 * R, 2 * R); shade(body, .07); mk(body, 7.5, col, 6305, d0);
    const bev = P.rect(-R + 22, -R + 22, 2 * R - 44, 2 * R - 44); shade(bev, .03); mk(bev, 4, col, 6306, d1, .8);
    for (const [x, y] of [[-R, -R], [R, -R], [R, R], [-R, R]]) mk(P.line(x, y, x + (x < 0 ? 22 : -22), y + (y < 0 ? 22 : -22)), 3, col, 6307 + (x > 0 ? 1 : 0) + (y > 0 ? 2 : 0), d1, .6);
    // pin-1 notch and index dot
    const notch = P.arc(0, -R, 26, 0, Math.PI); shade([[-26, -R], ...notch, [26, -R]], 0); mk(notch, 5, col, 6311, d1);
    devices_dot(-R + 52, -R + 52, 9, col, d1 * .9); mk(P.circle(-R + 52, -R + 52, 13), 3, col, 6312, d1, .7);
    // the die and its traces (in tint, glowing)
    glow(hot === col ? '#000000' : hot, hot === col ? 0 : 14, () => {
      const die = P.rect(-88, -88, 176, 176); shade(die, .1); mk(die, 5.5, hot, 6313, d1);
      mk(P.rect(-70, -70, 140, 140), 3, hot, 6314, d1, .6);
      const T = [[[-88, -50], [-150, -50], [-150, -120]], [[-88, 0], [-176, 0], [-176, 0]], [[-88, 50], [-150, 50], [-150, 120]],
                 [[88, -50], [150, -50], [150, -120]], [[88, 0], [176, 0], [176, 0]], [[88, 50], [150, 50], [150, 120]],
                 [[-50, -88], [-50, -150], [-120, -150]], [[0, -88], [0, -176], [0, -176]], [[50, -88], [50, -150], [120, -150]],
                 [[-50, 88], [-50, 150], [-120, 150]], [[0, 88], [0, 176], [0, 176]], [[50, 88], [50, 150], [120, 150]]];
      T.forEach((tr, i) => { mk([...P.line(tr[0][0], tr[0][1], tr[1][0], tr[1][1]), ...P.line(tr[1][0], tr[1][1], tr[2][0], tr[2][1])], 3.5, hot, 6320 + i, ease((es - .3 - i * .03) / .3), .85);
        devices_dot(tr[2][0], tr[2][1], 5, hot, d2 * .9) });
      const k = (t * .7) % 1, tr = T[Math.floor(t * .7) % T.length];
      const px = k < .5 ? lerp(tr[0][0], tr[1][0], k * 2) : lerp(tr[1][0], tr[2][0], (k - .5) * 2), py = k < .5 ? lerp(tr[0][1], tr[1][1], k * 2) : lerp(tr[1][1], tr[2][1], (k - .5) * 2);
      devices_dot(px, py, 6, hot, d2);
    });
  };

  // usb: USB-A plug in light 3/4 seen from its open end — metal shell with top face and the two rectangular cut-outs, double-lined mouth with the plastic tongue and four contact strips inside, brushed highlight, moulded grip with ridges and seam, five-ring strain relief, the cable running off into a loop; xray/tint = a circuit board with chip, traces and pads glowing inside the grip
  ART.usb = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = ACC[o.tint || 'red'] || ACC.red, { es, d0, d1, d2 } = devices_layers(o.es), sw = Math.sin(t * .7) * 4;
    devices_ground(-370, 110, 122, 6000, d0);
    // the cable: out of the strain relief, one lazy loop, then off to the right
    const ax = 296, ay = 100, ar = 46, a0 = -.2 * Math.PI;
    const cable = [...P.quad(158, 10, 290, 12 + sw, ax + ar * Math.cos(a0), ay + ar * Math.sin(a0)), ...P.arc(ax, ay, ar, a0, Math.PI * 1.5).slice(1), ...P.quad(ax, ay - ar, 330, 30, 392, 22 + sw).slice(1)];
    mk(cable, 8, col, 6040, d1);
    // plastic grip: right end face, top face, front face
    const gR = [[60, -70], [86, -100], [86, 60], [60, 90]]; shade(gR, .03); mk([...gR, gR[0]], 6.5, col, 6041, d0);
    const gT = [[-190, -70], [-164, -100], [86, -100], [60, -70]]; shade(gT, .09); mk([...gT, gT[0]], 6.5, col, 6042, d0);
    const gF = devices_rr(-190, -70, 250, 160, 16); shade(gF, .05); mk(gF, 7, col, 6043, d0);
    for (let i = 0; i < 3; i++) mk(P.line(-150 + i * 18, -44, -150 + i * 18, 64), 3.5, col, 6044 + i, d1, .6);
    mk(P.line(-100, 10, 40, 10), 2.5, col, 6047, d1, .3);
    // strain relief: five rings shrinking toward the cable
    for (let i = 0; i < 5; i++) { const x = 86 + i * 15, h = 66 - i * 9, r = devices_rr(x, 10 - h / 2, 13, h, 4); shade(r, .06); mk(r, 4, col, 6050 + i, d1) }
    // metal shell: top face with two cut-outs, front face with a brushed highlight
    const sT = [[-360, -40], [-334, -70], [-164, -70], [-190, -40]]; shade(sT, .1); mk([...sT, sT[0]], 6, col, 6060, d0);
    for (const x of [-322, -262]) { const w = [[x, -46], [x + 14, -62], [x + 50, -62], [x + 36, -46]]; shade(w, 0); mk([...w, w[0]], 4, col, 6061 + (x + 322) / 60, d1) }
    const sF = P.rect(-360, -40, 170, 100); shade(sF, .06); mk(sF, 6.5, col, 6063, d0);
    mk(P.line(-340, 0, -210, 0), 2.5, col, 6064, d1, .25);
    // the mouth: dark end face, inner rim (shell thickness), tongue with four contacts
    const mouth = [[-360, -40], [-334, -70], [-334, 30], [-360, 60]]; shade(mouth, 0); mk([...mouth, mouth[0]], 6, col, 6065, d0);
    const rim = [[-354, -36], [-340, -52], [-340, 24], [-354, 40]]; mk([...rim, rim[0]], 3, col, 6066, d1, .7);
    const tongue = [[-352, -2], [-342, -14], [-342, 20], [-352, 34]]; shade(tongue, .18); mk([...tongue, tongue[0]], 3, col, 6067, d1);
    for (let i = 0; i < 4; i++) { const y = 4 + i * 7; mk(P.line(-351, y, -343, y - 10), 2, col, 6068 + i, d1, .7) }
    // circuit inside the grip (xray / tint): board, chip with legs, two traces, three pads
    if (o.xray || o.tint) glow(hot, 16, () => {
      mk(P.rect(-150, -40, 190, 90), 3.5, hot, 6080, d2, .85);
      mk(P.rect(-90, -22, 56, 44), 4, hot, 6081, d2);
      for (let i = 0; i < 4; i++) { mk(P.line(-90, -14 + i * 10, -110, -14 + i * 10), 3, hot, 6082 + i, d2, .8); mk(P.line(-34, -14 + i * 10, -14, -14 + i * 10), 3, hot, 6086 + i, d2, .8) }
      mk([...P.line(-110, -14, -134, -14), ...P.line(-134, -14, -134, 30), ...P.line(-134, 30, -150, 30)], 3, hot, 6090, d2, .8);
      mk([...P.line(-14, 16, 6, 16), ...P.line(6, 16, 6, -30), ...P.line(6, -30, 30, -30)], 3, hot, 6091, d2, .8);
      for (let i = 0; i < 3; i++) devices_dot(-140 + i * 60, 40, 4, hot, d2 * (.5 + .5 * Math.sin(t * 4 + i)));
    });
  };

  // car: sedan in side view with a hint of 3/4 (far roof and hood edge) — greenhouse with pillars and windows, mirror, two doors with seams and handles, character line, wheel arches, wheels with tyre, rim, hub and five spokes that turn, headlight, grille slots, bumpers, tail light, exhaust, antenna, dashed ground shadow
  ART.car = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1, d2 } = places_layers(o.es);
    let sd = 12600;
    c.save(); c.scale(.98, .98);                                    // whole car 2 % smaller about the origin: width lands inside the 560-760 hero band
    places_ground(-330, 330, 152, sd, d1, .35); sd += 40;
    // body
    const body = [[-366, 64], [-374, 30], [-366, -10], [-348, -54], [-300, -62], ...P.quad(-300, -62, -252, -128, -178, -142), ...P.quad(-178, -142, -60, -156, 68, -148), ...P.quad(68, -148, 150, -132, 222, -70),
      ...P.line(222, -70, 330, -56), ...P.quad(330, -56, 370, -52, 376, -10), [380, 40], [370, 64], [304, 70], ...P.arc(225, 80, 82, 0, -Math.PI), ...P.line(143, 80, -133, 80), ...P.arc(-215, 80, 82, 0, -Math.PI), [-297, 80], [-366, 64]];
    shade(body, .06); mk(body, 7, col, sd++, d0);
    mk(P.quad(-170, -152, -60, -166, 66, -158), 3.6, col, sd++, d1, .45); mk(P.line(226, -80, 330, -66), 3, col, sd++, d1, .4);
    // windows and pillars
    const rw = [[-290, -66], [-246, -126], [-166, -136], [-166, -66]]; shade(rw, .1); mk([...rw, rw[0]], 4.5, col, sd++, d1);
    const fw = [[-146, -136], [62, -140], [154, -122], [166, -66], [-146, -66]]; shade(fw, .1); mk([...fw, fw[0]], 4.5, col, sd++, d1);
    mk(P.line(-158, -68, -158, -134), 4, col, sd++, d1, .7); mk(P.quad(-280, -70, -140, -76, 160, -70), 3, col, sd++, d1, .5);
    mk(P.quad(-240, -118, -200, -128, -172, -128), 2.4, col, sd++, d1, .35); mk(P.quad(-120, -128, 0, -134, 60, -132), 2.4, col, sd++, d1, .35);
    const mir = places_rr(160, -118, 28, 18, 7); shade(mir, .12); mk(mir, 3.6, col, sd++, d1); mk(P.line(162, -104, 152, -94), 3, col, sd++, d1, .7);
    // doors, handles, sill, crease
    mk(P.line(-152, -62, -156, 72), 4, col, sd++, d1, .8); mk(P.line(128, -66, 134, 72), 4, col, sd++, d1, .8); mk(P.line(-262, -62, -266, 10), 4, col, sd++, d1, .8); mk(P.quad(-300, -62, -310, 20, -292, 78), 3, col, sd++, d1, .4);
    for (const hx of [70, -200]) { const h = places_rr(hx, -34, 40, 12, 6); shade(h, .12); mk(h, 3.2, col, sd++, d1); places_dot(hx + 46, -28, 2, col, .6 * d1) }
    mk(P.line(-120, 62, 128, 62), 3, col, sd++, d1, .45); mk(P.quad(-300, -6, 0, -16, 300, -12), 3, col, sd++, d1, .35);
    mk(P.line(180, 6, 260, 6), 2.6, col, sd++, d1, .35); mk(P.line(-280, 6, -200, 6), 2.6, col, sd++, d1, .35);
    // front: headlight, grille, bumper, fog; rear: tail light, exhaust; antenna
    const hl = [[326, -50], [370, -46], [376, -24], [332, -30]]; shade(hl, .14); mk([...hl, hl[0]], 4, col, sd++, d1); mk(places_ell(352, -38, 12, 7, 0, TAU, -.1), 2.6, col, sd++, d1, .7);
    mk(P.line(348, -2, 378, -4), 3, col, sd++, d1, .6); mk(P.line(346, 12, 380, 10), 3, col, sd++, d1, .6); mk(P.line(300, 46, 378, 42), 3.6, col, sd++, d1, .6); mk(P.circle(354, 30, 5), 2.4, col, sd++, d1, .7);
    const tl = [[-344, -48], [-318, -50], [-322, -20], [-352, -18]]; shade(tl, .14); mk([...tl, tl[0]], 4, col, sd++, d1); mk(P.line(-340, -34, -326, -35), 2.4, col, sd++, d1, .6); mk(P.line(-366, 46, -304, 48), 3.6, col, sd++, d1, .6);
    mk(P.line(-330, 74, -348, 76), 5, col, sd++, d1, .8); mk(P.line(-130, -152, -104, -180), 3, col, sd++, d1, .8);
    // wheels
    const ang = t * 1.4;
    for (const wx of [-215, 225]) { const wy = 80;
      shade(P.circle(wx, wy, 66), .04); mk(P.circle(wx, wy, 66), 7, col, sd++, d0); mk(P.circle(wx, wy, 44), 4.5, col, sd++, d1); mk(P.circle(wx, wy, 12), 3.6, col, sd++, d1);
      for (let k = 0; k < 5; k++) { const a = ang + k * TAU / 5; mk(P.line(wx + Math.cos(a) * 13, wy + Math.sin(a) * 13, wx + Math.cos(a) * 41, wy + Math.sin(a) * 41), 4, col, sd++, d1, .85) }
      for (let k = 0; k < 12; k++) { const a = ang * .5 + k * TAU / 12; mk(P.line(wx + Math.cos(a) * 52, wy + Math.sin(a) * 52, wx + Math.cos(a) * 62, wy + Math.sin(a) * 62), 2.4, col, sd++, d1, .35) }
      for (let k = 0; k < 5; k++) { const a = -Math.PI * (.18 + k * .16); mk(P.line(wx + Math.cos(a) * 68, wy + Math.sin(a) * 68, wx + Math.cos(a) * 79, wy + Math.sin(a) * 79), 2.4, col, sd++, d1, .3) }
      places_dot(wx, wy, 3, col, d1 * .8) }
    c.restore();
  };

  // ---- security family helpers ---------------------------------------------------
  // points along an ellipse arc (rx, ry), optionally rotated
  function security_ell(cx, cy, rx, ry, a0, a1, rot = 0) {
    const n = Math.max(6, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 10)), cr = Math.cos(rot), sr = Math.sin(rot);
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)), x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * cr - y * sr, cy + x * sr + y * cr] });
  }
  // closed rounded rectangle: top edge, then clockwise
  function security_rrect(x, y, w, h, r) {
    const H = Math.PI / 2;
    return [...P.line(x + r, y, x + w - r, y), ...P.arc(x + w - r, y + r, r, -H, 0), ...P.line(x + w, y + r, x + w, y + h - r), ...P.arc(x + w - r, y + h - r, r, 0, H),
            ...P.line(x + w - r, y + h, x + r, y + h), ...P.arc(x + r, y + h - r, r, H, Math.PI), ...P.line(x, y + h - r, x, y + r), ...P.arc(x + r, y + r, r, Math.PI, 3 * H), [x + r, y]];
  }
  // closed polygon with rounded corners (k = how far from each vertex the rounding starts)
  function security_rpoly(pts, k) { const n = pts.length, out = [];
    const to = (A, B) => { const dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy); return [A[0] + dx / l * k, A[1] + dy / l * k] };
    for (let i = 0; i < n; i++) { const V = pts[i], Pv = pts[(i + n - 1) % n], Nx = pts[(i + 1) % n], a = to(V, Pv), b = to(V, Nx), c2 = to(Nx, V);
      out.push(...P.quad(a[0], a[1], V[0], V[1], b[0], b[1]), ...P.line(b[0], b[1], c2[0], c2[1])) }
    return out;
  }
  // a row of slanted dashes under an object: the hatched shadow line, drawn dash by dash
  function security_hatch(x0, x1, y, n, col, seed, d, a = .45) {
    for (let i = 0; i < n; i++) { const g = clamp(d * n - i); if (g <= 0) continue; const x = lerp(x0, x1, (i + .5) / n);
      mk(P.line(x - 7, y + 6, x + 7, y - 6), 3, col, seed + i, g, a) }
  }
  // a small filled dot (an eye, a LED, a rivet head)
  function security_dot(x, y, r, col, a = 1) { const c = A.ctx; if (a <= 0) return; c.save(); c.fillStyle = col; c.globalAlpha *= a; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore() }
  // a small filled polygon in black: a hole punched through a surface
  function security_hole(pts, a = 1) { const c = A.ctx; if (a <= 0 || pts.length < 3) return; c.save(); c.fillStyle = '#000000'; c.globalAlpha *= a; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts) c.lineTo(p[0], p[1]); c.closePath(); c.fill(); c.restore() }
  // stroke colour: the tint accent when asked for, else the forced colour, else white
  function security_col(o) { const a = ACC[o.tint || 'white']; return a && a !== WHITE ? a : (o.col || WHITE) }
  // heater shield outline for a given inset (the rim, the plate, the rivet track share one shape)
  function security_shieldPath(ins) { const hw = 250 - ins, top = -300 + ins, se = -70 + ins * .4, bt = 330 - ins * 1.35, cy = 210 - ins * .6;
    return [...P.line(-hw, top, hw, top), ...P.line(hw, top, hw, se), ...P.quad(hw, se, hw, cy, 0, bt), ...P.quad(0, bt, -hw, cy, -hw, se), ...P.line(-hw, se, -hw, top)] }
  // padlock: laminated body with corner rivets and a round keyhole plate, a tube shackle with latch notch; `open`/`no` pop the shackle and swing the short leg up and away, `tint` colours the keyhole
  ART.lock = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, es = o.es ?? 99;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    const op = clamp(o.open ?? (o.no ? 1 : 0)), tint = ACC[o.tint || 'white'], kc = tint && tint !== WHITE ? tint : col;
    const bx = -210, by = -40, bw = 420, bh = 340, r = 44, ox = 24, oy = -14;
    c.save(); c.translate(0, 34);                                                              // the body sits a touch low so the swung-open shackle stays under the 440 ceiling
    // the shackle goes first: the body's shade knocks out the legs where they enter it
    c.save(); c.translate(-120, by); c.translate(0, -op * 28); c.rotate(-op * (.42 + Math.sin(t * 1.3) * .02)); c.translate(120, -by);   // hinge at the long leg's base, counter-clockwise: the short leg rises
    const legL = by + 20 + op * 90, legS = lerp(by + 20, -112, op);                            // closed: BOTH legs seat in the body; open: the short leg is out
    const sl = [...P.line(-146, legL, -146, -250), ...P.arc(0, -250, 146, Math.PI, TAU), ...P.line(146, -250, 146, legS)];
    const si = [...P.line(-94, legL, -94, -250), ...P.arc(0, -250, 94, Math.PI, TAU), ...P.line(94, -250, 94, legS)];
    const tip = P.arc(120, legS, 26, 0, Math.PI), dt = op > 0 ? d1 : 0;                        // tip and notch only exist once the leg has left the body
    shade([...sl, ...tip, ...si.slice().reverse()], .05);
    mk(sl, 7, col, 7200, d0); mk(si, 6, col, 7201, d0);
    mk(tip, 6.5, col, 7202, dt);                                                                // rounded tip of the short leg
    mk(P.poly([[94, legS - 66], [110, legS - 46], [94, legS - 26]]), 4, col, 7203, dt);         // the latch notch near the tip
    mk(P.arc(0, -250, 120, Math.PI * 1.12, Math.PI * 1.42), 3, col, 7204, d1, .45);          // highlight along the tube
    c.restore();
    // the body: a block with depth (top and right faces), rounded corners
    const back = security_rrect(bx + ox, by + oy, bw, bh, r), front = security_rrect(bx, by, bw, bh, r);
    const nT = P.line(0, 0, bw - 2 * r, 0).length, nS = P.line(0, 0, 0, bh - 2 * r).length, nA = P.arc(0, 0, r, 0, Math.PI / 2).length;
    shade(back, .04); mk(back.slice(0, nT + nA + nS + nA), 5, col, 7205, d0, .7);
    const k = r * (1 - .707);
    shade(front, .07); mk(front, 7, col, 7206, d0);
    mk(P.line(bx + k, by + k, bx + k + ox, by + k + oy), 5, col, 7207, d0, .7);
    mk(P.line(bx + bw - k, by + bh - k, bx + bw - k + ox, by + bh - k + oy), 5, col, 7208, d0, .7);
    for (let i = 0; i < 6; i++) mk(P.line(bx + 18, by + 52 + i * 44, bx + bw - 18, by + 52 + i * 44), 2.6, col, 7210 + i, d1, .28);   // laminations
    [[bx + 42, by + 42], [bx + bw - 42, by + 42], [bx + 42, by + bh - 42], [bx + bw - 42, by + bh - 42]].forEach(([x, y], i) => {
      mk(P.circle(x, y, 11), 3.5, col, 7220 + i, d1); security_dot(x, y, 3, col, d1 * .8) });                                       // rivets
    const plate = P.circle(0, 130, 66); shade(plate, .1); mk(plate, 4.5, col, 7230, d1);                                              // the keyhole plate
    [-1, 1].forEach((s, i) => { mk(P.circle(s * 48, 130, 7), 3, col, 7231 + i, d1, .8); mk(P.line(s * 48 - 4, 126, s * 48 + 4, 134), 2.5, col, 7233 + i, d1, .8) });
    const kh = [...P.arc(0, 112, 28, Math.PI / 2 + .5, Math.PI / 2 - .5 + TAU), [22, 184], [-22, 184]];
    security_hole(kh, d2);
    const kg = tint && tint !== WHITE ? .6 + .4 * Math.sin(t * 3) : 0;
    glow(kc, 18 * kg, () => mk([...kh, kh[0]], 5, kc, 7235, d2));
    security_hatch(-150, 170, by + bh + 26, 9, col, 7240, d1);
    c.restore();
  };

  // house key: round bow with ring hole and machined rim, shoulder collar, blade with warding groove, eight irregular cuts and a chamfered tip; floats gently
  ART.key = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, es = o.es ?? 99;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .35) / .35);
    c.save(); c.translate(0, Math.sin(t * 1.2) * 4); c.rotate(Math.sin(t * .9) * .01);
    const bow = P.circle(-250, 0, 118); shade(bow, .07); mk(bow, 7, col, 7300, d0);
    mk(P.circle(-250, 0, 98), 3.5, col, 7301, d1, .5);                                       // the machined rim
    security_hole(P.circle(-298, 0, 30), d1); mk(P.circle(-298, 0, 30), 5, col, 7302, d1);   // the ring hole
    mk(P.arc(-250, 0, 108, Math.PI * .3, Math.PI * .7), 3, col, 7303, d1, .4);               // a facet catch-light
    // the blade: top edge, chamfered tip, the bitting along the bottom, back to the shoulder
    const cuts = [24, 44, 16, 40, 30, 44, 20]; let x = 292; const bit = [];                 // cuts stop at y=2: the grooves above never cross an empty notch
    for (const dep of cuts) { bit.push([x, 46], [x - 16, 46 - dep], [x - 30, 46 - dep], [x - 46, 46]); x -= 46 }
    const blade = [[-130, -46], [300, -46], [332, -14], [332, 12], [318, 28], [300, 46], ...bit, [-130, 46]];
    shade(blade, .07); mk([...blade, blade[0]], 6.5, col, 7304, d0);
    mk(P.line(-126, -56, 300, -56), 3.5, col, 7305, d1, .55); mk(P.line(300, -56, 332, -24), 3.5, col, 7306, d1, .55);   // the top face: the blade has thickness
    mk(P.line(-118, -16, 294, -16), 4, col, 7307, d1, .75);                                     // warding groove
    mk(P.line(-100, -30, 180, -30), 3, col, 7308, d1, .4);                                      // a second, lighter groove above it
    mk(P.line(306, -34, 324, -16), 3, col, 7309, d1, .5);                                     // tip chamfer
    const collar = security_rrect(-166, -64, 40, 128, 8); shade(collar, .09); mk(collar, 5, col, 7310, d0);   // the shoulder that stops the key in the lock
    mk(P.line(-146, -50, -146, 50), 2.6, col, 7311, d1, .35);
    security_hatch(-290, 250, 146, 12, col, 7320, d2);
    c.restore();
  };

  // heater shield with a thick plate edge, a riveted rim, a cross of spine and band and a central boss; `flash` a glowing green check, `no` a red crack splitting it, `tint` colours the strokes
  ART.shield = (t, u, o = {}) => { const c = A.ctx, col = security_col(o), es = o.es ?? 99;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    const outer = security_shieldPath(0), rim = security_shieldPath(28), back = outer.map(p => [p[0] + 18, p[1] + 12]);
    const nTop = P.line(-250, -300, 250, -300).length, nSide = P.line(0, -300, 0, -70).length;
    shade(back, .04); mk(back.slice(nTop - 2, nTop + nSide + 14 + 1), 5, col, 7400, d0, .65);   // the plate's edge: it has thickness
    mk(P.line(250, -300, 268, -288), 5, col, 7401, d0, .65); mk(P.line(0, 330, 18, 342), 5, col, 7402, d0, .65);
    shade(outer, .06); mk([...outer, outer[0]], 7, col, 7403, d0);
    mk([...rim, rim[0]], 4, col, 7404, d1, .85);
    if (!o.flash && !o.no) { mk(P.line(0, -272, 0, 294), 3.5, col, 7405, d1, .5); mk(P.line(-222, -60, 222, -60), 3.5, col, 7406, d1, .5) }   // spine and band: skipped, like the boss, when the crack or the check takes the centre
    const track = security_shieldPath(14), nt = track.length;
    for (let i = 0; i < 12; i++) { const p = track[Math.round(i * (nt - 1) / 12)], g = ease((es - .22 - i * .02) / .3);
      mk(P.circle(p[0], p[1], 7), 3, col, 7410 + i, g, .9) }                                                          // rivets around the rim
    if (!o.flash && !o.no) { mk(P.circle(0, -60, 44), 5, col, 7422, d1); mk(P.circle(0, -60, 19), 3.5, col, 7423, d1, .7) }   // the boss
    security_hatch(-70, 70, 358, 5, col, 7425, d1);
    if (o.flash) { const g = ease((es - .4) / .3), p = .85 + .15 * Math.sin(t * 4);
      glow(ACC.green, 34 * p, () => mk(P.poly([[-120, -30], [-34, 66], [136, -130]]), 16, ACC.green, 7430, g)) }
    if (o.no) { const g = ease((es - .4) / .3), R = ACC.red;
      glow(R, 16, () => { mk(P.poly([[-14, -300], [24, -210], [-30, -120], [30, -30], [-16, 60], [34, 150], [-6, 240], [22, 330]]), 7, R, 7440, g);
        mk(P.poly([[-30, -120], [-70, -140], [-96, -176]]), 4.5, R, 7441, ease((es - .5) / .25));
        mk(P.poly([[34, 150], [88, 138], [118, 108]]), 4.5, R, 7442, ease((es - .55) / .25));
        mk(P.poly([[30, -30], [70, -6], [86, 26]]), 4, R, 7443, ease((es - .6) / .25)) }) }
  };

  // beetle from above: round head with dot eyes, mandibles and segmented antennae, pronotum, split elytra with striations and spots, six jointed legs that twitch; `tint` colours it
  ART.bug = (t, u, o = {}) => { const c = A.ctx, col = security_col(o), es = o.es ?? 99;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3), wg = Math.sin(t * 6), aw = Math.sin(t * 2.2) * 5;
    const legs = [[[95, -165], [185, -255], [262, -198], [288, -214]], [[106, -40], [252, -92], [300, 12], [320, -6]], [[135, 90], [252, 148], [282, 280], [302, 266]]];
    [-1, 1].forEach((s, si) => legs.forEach((L, i) => { const ph = ((i + si) % 2 ? 1 : -1) * wg * 6, g = ease((es - .15 - i * .05) / .3), b = 7500 + si * 20 + i * 4;
      const [B, K, F, T] = L.map(([x, y]) => [s * x, y]);
      mk(P.line(B[0], B[1], K[0], K[1] + ph), 5.5, col, b, g);
      mk(P.line(K[0], K[1] + ph, F[0], F[1] + ph * .5), 5, col, b + 1, g);
      mk(P.line(F[0], F[1] + ph * .5, T[0], T[1] + ph * .5), 4, col, b + 2, g);
      security_dot(K[0], K[1] + ph, 7, col, g) }));
    const ab = security_ell(0, 80, 150, 190, 0, TAU); shade(ab, .07); mk(ab, 7, col, 7550, d0);             // elytra
    mk(P.line(0, -90, 0, 268), 4.5, col, 7551, d1);                                                            // the split between the wing cases
    for (let j = 0; j < 3; j++) { const rx = 50 + j * 34, ry = 118 + j * 24;
      mk(security_ell(0, 80, rx, ry, -Math.PI / 2 + .3, Math.PI / 2 - .3), 3, col, 7552 + j, d1, .4);
      mk(security_ell(0, 80, rx, ry, Math.PI / 2 + .3, Math.PI * 1.5 - .3), 3, col, 7555 + j, d1, .4) }        // striations
    [[70, -20], [102, 92], [56, 186]].forEach(([x, y], i) => [-1, 1].forEach((s, si) => mk(P.circle(s * x, y, 13), 3.5, col, 7560 + i * 2 + si, d1, .9)));   // spots
    const th = security_ell(0, -150, 112, 66, 0, TAU); shade(th, .08); mk(th, 6.5, col, 7570, d0);            // pronotum
    mk(P.quad(-52, -170, 0, -128, 52, -170), 3.5, col, 7571, d1, .5);
    const hd = P.circle(0, -262, 62); shade(hd, .08); mk(hd, 6.5, col, 7572, d0);                              // head
    security_dot(-32, -268, 13, col, d1); security_dot(32, -268, 13, col, d1);
    mk(P.quad(-30, -316, -36, -346, -10, -354), 4, col, 7573, d1); mk(P.quad(30, -316, 36, -346, 10, -354), 4, col, 7574, d1);   // mandibles
    [-1, 1].forEach((s, si) => { const g = ease((es - .3) / .3);
      const an = [...P.quad(s * 36, -312, s * 110, -380, s * 150, -402), ...P.quad(s * 150, -402, s * 172 + aw * s, -410 + aw, s * 184, -392 + aw)];
      mk(an, 4, col, 7580 + si, g);
      for (let k = 1; k < 5; k++) { const p = an[k * 3], q = an[k * 3 + 1], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
        mk(P.line(p[0] - dy / l * 7, p[1] + dx / l * 7, p[0] + dy / l * 7, p[1] - dx / l * 7), 3, col, 7584 + si * 5 + k, g, .6) } });   // antenna segments
    security_hatch(-120, 120, 304, 9, col, 7595, d1);
  };

  // fingerprint under a scanner: a whorl of broken ridges around a core, base ridges arching across the bottom, four corner brackets and a slow scan line; `tint` colours it
  ART.fingerprint = (t, u, o = {}) => { const c = A.ctx, tint = ACC[o.tint || 'white'], col = tint && tint !== WHITE ? tint : (o.col || WHITE), es = o.es ?? 99, N = 11;
    for (let i = 0; i < N; i++) { const f = i / (N - 1), g = ease((es - i * .04) / .32);
      const cx = jit(i, 4), cy = lerp(-70, 4, f), rx = lerp(16, 222, f), ry = lerp(24, 302, f), rot = lerp(-.12, .04, f) + jit(i + 20, .04);
      const open = i >= 7;                                                                       // the outer ridges do not close under the core
      const k = 2 + (i % 3 === 1 ? 1 : 0), A0 = open ? Math.PI * .75 : 0, A1 = open ? Math.PI * .25 + TAU : TAU;
      for (let j = 0; j < k; j++) { const a0 = lerp(A0, A1, j / k) + .1 + n1(i * 7 + j) * .14, a1 = lerp(A0, A1, (j + 1) / k) - .1;
        if (a1 - a0 > .2) mk(security_ell(cx, cy, rx, ry, a0, a1, rot), 3.8, col, 7600 + i * 4 + j, g, .95) }
      if (i > 1 && i % 2 === 0 && i < 10) { const a = n1(i + 40) * TAU, r2 = lerp(rx, lerp(16, 222, (i + 1) / (N - 1)), .5), r3 = lerp(ry, lerp(24, 302, (i + 1) / (N - 1)), .5);
        mk(security_ell(cx, cy + 3, r2, r3, a, a + .45, rot), 3.4, col, 7660 + i, g, .8) }         // a short ridge that bifurcates
    }
    for (let j = 0; j < 4; j++) { const g = ease((es - .3 - j * .06) / .3), rx = 124 + j * 25, ry = 192 - j * 30;
      mk(security_ell(0, 380, rx, ry, Math.PI * 1.15, Math.PI * 1.85), 3.8, col, 7680 + j, g, .95) }   // the base ridges across the bottom, ending well clear of the brackets
    const d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy], i) => {                              // the scanner's corner brackets
      mk(P.poly([[sx * 262, sy * 300], [sx * 262, sy * 350], [sx * 212, sy * 350]]), 4.5, col, 7690 + i, d1, .85) });
    const sy = Math.sin(t * 1.4) * 280, sa = tint && tint !== WHITE ? .6 : .3;
    glow(col, tint && tint !== WHITE ? 14 : 0, () => mk(P.line(-236, sy, 236, sy), 3, col, 7695, d2, sa));
  };

  // ---- data family helpers (envelope, signal, chart, graph, folder, cloud, code, tag, blank, satellite) ----
  function data_rrect(x, y, w, h, r) {                         // rounded rectangle path, clockwise from the top-left corner
    r = Math.min(r, w / 2, h / 2); const H = Math.PI / 2;
    return [...P.line(x + r, y, x + w - r, y), ...P.arc(x + w - r, y + r, r, -H, 0), ...P.line(x + w, y + r, x + w, y + h - r),
            ...P.arc(x + w - r, y + h - r, r, 0, H), ...P.line(x + w - r, y + h, x + r, y + h), ...P.arc(x + r, y + h - r, r, H, 2 * H),
            ...P.line(x, y + h - r, x, y + r), ...P.arc(x + r, y + r, r, 2 * H, 3 * H), [x + r, y]];
  }
  function data_seg(pts) {                                     // densify a polygon's edges into 14-px segments: every edge gets the marker wobble and draws on stroke by stroke
    return pts.flatMap((p, i, a) => i ? P.line(a[i - 1][0], a[i - 1][1], p[0], p[1]).slice(1) : [p]);
  }
  function data_closed(pts) { return data_seg([...pts, pts[0]]) }   // the same, closed back on its first vertex
  function data_ellipse(cx, cy, rx, ry, a0 = 0, a1 = TAU) {    // elliptical arc path
    const n = Math.max(8, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 10));
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)); return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] });
  }
  function data_dash(x0, y0, x1, y1, len, gap, w, col, seed, d = 1, a = 1) {   // a dashed marker line, dash by dash (uses seeds seed..seed+n)
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.floor((L + gap) / (len + gap)));
    for (let i = 0; i < n; i++) { const s0 = i * (len + gap) / L, s1 = Math.min(1, s0 + len / L);
      mk(P.line(lerp(x0, x1, s0), lerp(y0, y1, s0), lerp(x0, x1, s1), lerp(y0, y1, s1)), w, col, seed + i, clamp(d * n - i), a) }
  }
  function data_arrow(x, y, ang, s = 26) {                       // open chevron arrowhead, tip at (x, y), pointing along ang
    return data_seg([[x - Math.cos(ang - .55) * s, y - Math.sin(ang - .55) * s], [x, y], [x - Math.cos(ang + .55) * s, y - Math.sin(ang + .55) * s]]);
  }
  function data_scribble(x, y, len, k, amp = 4) {                // a line of handwriting: a wobbling stroke, never letters
    const n = Math.max(4, Math.round(len / 8));
    return Array.from({ length: n }, (_, i) => { const s = i / (n - 1); return [x + s * len, y + Math.sin(s * len / 6.5 + k * 1.7) * amp + jit(k * 31 + i, 1.5)] });
  }
  function data_dot(x, y, r, col, a = 1) {                       // a small filled dot (an eye, a LED, a packet)
    const c = A.ctx; if (a <= 0) return; c.save(); c.fillStyle = col; c.globalAlpha *= a; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore();
  }
  // an envelope seen from the back: pocket folds, flap lifted open on its crease with glue strip and a round seal at its tip, a handwritten letter sliding out in front of it, paper thickness, dashed shadow; `tint` colours the flap edge and the seal
  ART.envelope = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = o.tint ? ACC[o.tint] || col : col;
    const d1 = ease(o.es / .35), d2 = ease((o.es - .2) / .35), d3 = ease((o.es - .4) / .3);
    const W = 640, H = 380, x0 = -W / 2, y0 = -120, y1 = y0 + H, sway = Math.sin(t * .9) * 4, bob = Math.sin(t * 1.3) * 3;
    data_dash(x0 + 40, y1 + 30, x0 + W + 18, y1 + 30, 34, 18, 4, col, 5000, d2, .4);                 // shadow on the desk
    const ax = sway, ay = y0 - 280;                                                                    // the flap's tip
    const flap = [[x0, y0], [ax, ay], [x0 + W, y0]];                                                   // the open flap, hinged on the top edge
    shade(flap, .04); mk(data_closed(flap), 6.5, hot, 5040, d1);
    mk(data_seg([[x0 + 43, y0 - 8], [ax, ay + 30], [x0 + W - 43, y0 - 8]]), 3, col, 5041, d2, .5);    // glue strip inside the flap, running under the seal
    const seal = P.circle(ax, ay + 50, 22); shade(seal, .06); mk(seal, 4.5, hot, 5042, d3); mk(P.circle(ax, ay + 50, 9), 3, hot, 5043, d3, .8);   // the seal at the tip
    c.save(); c.translate(0, bob); c.rotate(-.04);                                                     // the letter, half out of the pocket: narrower than the flap so both flap edges stay whole
    const L = [[-160, -240], [160, -240], [160, 80], [-160, 80]]; shade(L, .09); mk(data_closed(L), 5.5, col, 5044, d2);
    for (let i = 0; i < 4; i++) { const w = i === 0 ? 120 : 250 - n1(i + 3) * 90;
      mk(data_scribble(-126, -214 + i * 26, w, i), 3.5, col, 5045 + i, ease((o.es - .25 - i * .05) / .3), .9) }
    c.restore();
    const body = P.rect(x0, y0, W, H); shade(body, .06); mk(body, 7, col, 5051, d1);                  // the pocket: covers the letter's hidden half
    mk(P.line(x0 + 8, y1 + 9, x0 + W + 8, y1 + 9), 3.5, col, 5052, d2, .65);                         // paper thickness
    mk(P.line(x0 + W + 9, y0 + 10, x0 + W + 9, y1 + 9), 3.5, col, 5053, d2, .65);
    mk(P.line(x0, y1, 0, y0 + 140), 5, col, 5054, d2); mk(P.line(x0 + W, y1, 0, y0 + 140), 5, col, 5055, d2);   // bottom flap
    mk(P.line(x0, y0, -56, 62), 5, col, 5056, d2); mk(P.line(x0 + W, y0, 56, 62), 5, col, 5057, d2);            // side flaps tucked under it
  };

  // a broadcast mast: tapered lattice tower with rungs and X-braces on footing pads, a platform and rod up to a glowing emitter, three concentric waves each side and one travelling out; `beam`/`tint` set the wave colour
  ART.signal = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, wv = ACC[o.tint || o.beam || 'blue'];
    const d1 = ease(o.es / .35), d2 = ease((o.es - .2) / .35), d3 = ease((o.es - .4) / .3);
    const yb = 330, yt = -150, wb = 112, wt = 22, N = 6, hw = s => lerp(wb, wt, s), yy = s => lerp(yb, yt, s), ey = yt - 100;
    mk(P.line(-200, yb + 6, 200, yb + 6), 5.5, col, 5100, d1, .85);                                    // the ground
    data_dash(-160, yb + 30, 170, yb + 30, 30, 16, 3.5, col, 5101, d2, .4);
    for (const s of [-1, 1]) { mk(P.rect(s * wb - 22, yb - 16, 44, 22), 4, col, 5140 + s, d2, .8);     // footing pads
      mk(P.line(s * wb, yb - 16, s * wt, yt), 6.5, col, 5143 + s, d1) }                                 // the two legs
    for (let i = 0; i <= N; i++) { const s = i / N, y = yy(s), w = hw(s);
      mk(P.line(-w, y, w, y), 3.8, col, 5150 + i, ease((o.es - .1 - i * .03) / .3), .9);              // rungs
      if (i < N) { const s2 = (i + 1) / N, y2 = yy(s2), w2 = hw(s2), dd = ease((o.es - .2 - i * .04) / .3);
        mk(P.line(-w, y, w2, y2), 2.8, col, 5160 + i, dd, .7); mk(P.line(w, y, -w2, y2), 2.8, col, 5170 + i, dd, .7) } }   // X braces
    mk(P.rect(-40, yt - 12, 80, 12), 4, col, 5180, d2);                                                // top platform
    mk(P.line(0, yt - 12, 0, ey + 30), 5.5, col, 5181, d1);                                            // the rod
    mk(P.line(-20, yt - 44, 20, yt - 44), 3.4, col, 5182, d2, .8); mk(P.line(-13, yt - 62, 13, yt - 62), 3.4, col, 5183, d2, .8);   // its cross-bars
    mk(P.circle(0, ey, 30), 5.5, col, 5184, d1);                                                       // the emitter
    const pulse = .5 + .5 * Math.sin(t * 3.4);
    mk(P.circle(0, ey, 17), 3.2, wv, 5185, d3, .5 + .5 * pulse); data_dot(0, ey, 9, wv, d3 * (.6 + .4 * pulse));
    for (let k = 0; k < 3; k++) { const r = 90 + k * 70, a = (.4 + .6 * (.5 + .5 * Math.sin(t * 3.4 - k * 1.1))) * d3;   // three waves each side
      mk(P.arc(0, ey, r, -.62, .62), 5.5, wv, 5190 + k, 1, a); mk(P.arc(0, ey, r, Math.PI - .62, Math.PI + .62), 5.5, wv, 5193 + k, 1, a) }
    const ph = (t * .9) % 1, rr = 230 + ph * 90;                                                       // and one leaving
    mk(P.arc(0, ey, rr, -.5, .5), 4.5, wv, 5196, 1, (1 - ph) * .35 * d3); mk(P.arc(0, ey, rr, Math.PI - .5, Math.PI + .5), 4.5, wv, 5197, 1, (1 - ph) * .35 * d3);
  };

  // a line chart: axes with arrowheads and ticks, a faint dashed grid, five outlined bars, a trend line through hollow points ending in a lit dot and an arrow; `flip` makes it fall (red), `tint` colours the trend
  ART.chart = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, line = ACC[o.tint || (o.flip ? 'red' : 'green')];
    const d1 = ease(o.es / .35), d2 = ease((o.es - .15) / .35), dl = ease((o.es - .35) / .45), d4 = ease((o.es - .7) / .2);
    const ox = -320, oy = 220, xe = 360, ye = -280;
    mk(P.line(ox, oy, xe, oy), 6.5, col, 5200, d1); mk(P.line(ox, oy, ox, ye), 6.5, col, 5201, d1);   // the axes
    mk(data_arrow(xe, oy, 0, 26), 5.5, col, 5202, d2); mk(data_arrow(ox, ye, -Math.PI / 2, 26), 5.5, col, 5203, d2);
    for (let i = 1; i <= 5; i++) { const x = ox + i * 120, y = oy - i * 82;
      mk(P.line(x, oy - 10, x, oy + 12), 4, col, 5210 + i, d2);                                        // ticks
      mk(P.line(ox - 12, y, ox + 10, y), 4, col, 5216 + i, d2);
      if (i < 5) data_dash(ox + 16, y, xe - 40, y, 16, 14, 2.4, col, 5230 + i * 30, d2, .28) }         // faint grid
    const hs = o.flip ? [340, 250, 285, 150, 68] : [68, 150, 128, 250, 340], pts = hs.map((h, i) => [ox + 60 + i * 120, oy - h]);
    pts.forEach(([x, y], i) => { const bar = [[x - 34, oy], [x - 34, y], [x + 34, y], [x + 34, oy]];   // the bars grow from the axis, stroke by stroke
      shade(bar, .05); mk(data_seg(bar), 4.5, col, 5400 + i, ease((o.es - .15 - i * .06) / .3), .75) });
    const path = pts.slice(1).flatMap((p, i) => P.line(pts[i][0], pts[i][1], p[0], p[1]));
    glow(line, 12, () => mk(path, 7.5, line, 5410, dl));                                               // the trend
    pts.forEach(([x, y], i) => { if (i < 4) { data_dot(x, y, 9, '#000000', 1); mk(P.circle(x, y, 9), 4, col, 5420 + i, ease((o.es - .3 - i * .1) / .25)) } });
    const [lx, ly] = pts[4], [px, py] = pts[3], ang = Math.atan2(ly - py, lx - px), tx = lx + Math.cos(ang) * 70, ty = ly + Math.sin(ang) * 70;
    mk([...P.line(lx, ly, tx, ty), ...data_arrow(tx, ty, ang, 28)], 6.5, line, 5430, d4);              // where it is heading
    data_dot(lx, ly, 15, line, d4 * (.85 + .15 * Math.sin(t * 4)));
  };

  // a network: a double-ringed hub with seven nodes on irregular spokes and cross-links, every node ringed with a centre, packets running the edges; `tint` lights the hub and the packets
  ART.graph = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = o.tint ? ACC[o.tint] || col : col;
    const N = [[0, 0, 64], [-250, -190, 40], [232, -206, 38], [-306, 92, 44], [304, 64, 42], [-124, 244, 38], [154, 250, 44], [44, -272, 30]];
    const E = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [1, 7], [2, 7], [3, 5], [4, 6], [2, 4], [1, 3]];
    E.forEach(([a, b], i) => { const [ax, ay, ar] = N[a], [bx, by, br] = N[b], ang = Math.atan2(by - ay, bx - ax);       // edges, rim to rim
      mk(P.line(ax + Math.cos(ang) * ar, ay + Math.sin(ang) * ar, bx - Math.cos(ang) * br, by - Math.sin(ang) * br), 4.5, col, 5300 + i, ease((o.es - .1 - i * .03) / .3), .85) });
    N.forEach(([x, y, r], i) => { const d = ease((o.es - i * .04) / .3), on = i === 0 && !!o.tint, ring = P.circle(x, y, r);
      shade(ring, .06);
      if (on) glow(hot, 22, () => mk(ring, 7, hot, 5320 + i, d)); else mk(ring, i === 0 ? 7 : 6, col, 5320 + i, d);
      mk(P.circle(x, y, r - 14), 3.5, on ? hot : col, 5330 + i, ease((o.es - .15 - i * .04) / .3), .7);
      data_dot(x, y, i === 0 ? 9 : 5, on ? hot : col, d * (i === 0 ? .8 + .2 * Math.sin(t * 3) : .9)) });
    const d3 = ease((o.es - .4) / .3);                                                                 // packets, hub to node and back
    for (let i = 1; i <= 6; i++) { const [x, y, r] = N[i], ph = (t * .32 + n1(i + 20)) % 1, s = i % 2 ? ph : 1 - ph, ang = Math.atan2(y, x);
      data_dot(lerp(Math.cos(ang) * 64, x - Math.cos(ang) * r, s), lerp(Math.sin(ang) * 64, y - Math.sin(ang) * r, s), 6, hot, .9 * d3) }
  };

  // a manila folder: tabbed back panel with its colour strip, three sheets fanned inside it (tucked under the tab, peeking above the pocket) with lines of writing, a front pocket leaning open with a label, paper-stack thickness and a dashed shadow; `tint` colours the label and the strip
  ART.folder = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = o.tint ? ACC[o.tint] || col : col;
    const d1 = ease(o.es / .35), d2 = ease((o.es - .2) / .35), d3 = ease((o.es - .4) / .3), lift = Math.sin(t * .8) * 2;
    data_dash(-300, 278, 344, 278, 34, 18, 4, col, 5400, d2, .4);
    const back = [[-330, -214], [-150, -214], [-112, -166], [300, -166], [300, 232], [-330, 232]];     // back panel with its tab
    shade(back, .05); mk(data_closed(back), 7, col, 5440, d1);
    mk(P.rect(-300, -200, 100, 22), 3.5, hot, 5441, d3, .9);                                           // colour strip on the tab
    for (let k = 0; k < 3; k++) { const dx = k * 22 - 20, top = -152 + k * 18 + lift * (k - 1);          // three sheets: below the panel's top edge, right of the tab, each one lower and further right
      const sh = [[-100 + dx, top], [250 + dx, top - 2], [254 + dx, 120], [-96 + dx, 126]];
      shade(sh, .09); mk(data_closed(sh), 5, col, 5450 + k, ease((o.es - .15 - k * .06) / .3));
      const nl = k === 2 ? 2 : 1;                                                                    // writing: one line on the strips that show, two on the front sheet
      for (let j = 0; j < nl; j++) mk(data_scribble(-62 + dx, top + 9 + j * 25, 240 - n1(k * 5 + j) * 90, k * 4 + j, 2.2), 3.2, col, 5460 + k * 6 + j, ease((o.es - .25 - k * .06 - j * .04) / .3), .85) }
    const front = [[-352, -66], [322, -66], [334, 248], [-342, 248]];                                  // front pocket, leaning toward us, drawn last
    shade(front, .07); mk(data_closed(front), 7, col, 5480, d1);
    mk(P.line(-332, 258, 344, 258), 3.5, col, 5481, d2, .65); mk(P.line(344, -56, 344, 258), 3.5, col, 5482, d2, .65);   // stack thickness
    const lab = data_rrect(-306, -30, 200, 74, 10); shade(lab, .08); mk(lab, 4.5, hot, 5483, d2);       // the label
    mk(data_scribble(-286, -8, 150, 9, 2.5), 3, hot, 5484, d3, .8); mk(data_scribble(-286, 20, 110, 10, 2.5), 3, hot, 5485, d3, .8);
  };

  // a cumulus cloud: five puffs of different sizes over a flat base, creases where the puffs overlap, hatching in its shadowed belly, a dashed shadow beneath and a small trailing cloud; it bobs slowly
  ART.cloud = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, d1 = ease(o.es / .38), d2 = ease((o.es - .2) / .35);
    c.save(); c.translate(0, Math.sin(t * .8) * 4);
    const sh = [...P.arc(-200, 40, 100, 2.214, 5.09), ...P.arc(-90, -40, 115, 3.32, 5.59), ...P.arc(60, -60, 130, 3.857, 5.93),
                ...P.arc(200, 0, 100, 4.54, 6.78), ...P.arc(250, 60, 60, 5.98, 7.85), ...P.line(250, 120, -260, 120)];
    shade(sh, .06); mk([...sh, sh[0]], 7, col, 5500, d1);
    mk(P.arc(-90, -40, 115, .35, 1.1), 3.5, col, 5501, d2, .55); mk(P.arc(200, 0, 100, 1.9, 2.6), 3.5, col, 5502, d2, .55);   // where the puffs overlap
    mk(P.arc(-200, 40, 100, -.3, .5), 3.5, col, 5503, d2, .45);
    for (let i = 0; i < 6; i++) mk(P.line(-200 + i * 22, 112, -184 + i * 22, 84), 2.6, col, 5510 + i, ease((o.es - .3 - i * .03) / .3), .35);   // shadowed belly
    data_dash(-190, 152, 236, 152, 30, 16, 4, col, 5520, d2, .4);
    c.restore();
    c.save(); c.translate(Math.sin(t * .5) * 6, 0);                                                    // the small one drifting behind
    const mini = [...P.arc(318, 176, 34, 2.3, 5.0), ...P.arc(372, 156, 42, 3.6, 6.5), ...P.arc(412, 190, 22, 5.9, 7.85), ...P.line(412, 212, 292, 212)];
    shade(mini, .05); mk([...mini, mini[0]], 5, col, 5530, ease((o.es - .3) / .3));
    c.restore();
  };

  // a code editor window: rounded frame, title bar with three lights and a tab bearing a </> glyph, a gutter of line ticks, nine lines of indented token bars, a scrollbar, a blinking cursor; `tint` colours the highlighted line, its breakpoint and the cursor
  ART.code = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = o.tint ? ACC[o.tint] || col : col;
    const d1 = ease(o.es / .35), d2 = ease((o.es - .2) / .35), d3 = ease((o.es - .4) / .3);
    const X = -360, Y = -240, W = 720, H = 480, hi = 3;
    data_dash(X + 40, Y + H + 30, X + W + 16, Y + H + 30, 34, 18, 4, col, 5600, d2, .4);
    const win = data_rrect(X, Y, W, H, 18); shade(win, .05); mk(win, 7, col, 5640, d1);
    mk(P.line(X, Y + 58, X + W, Y + 58), 4.5, col, 5641, d2);                                          // title bar
    for (let i = 0; i < 3; i++) mk(P.circle(X + 38 + i * 34, Y + 29, 11), 4, col, 5642 + i, d2, .9);   // its three lights
    mk(data_seg([[-200, Y + 58], [-200, Y + 14], [-40, Y + 14], [-40, Y + 58]]), 4, col, 5645, d2, .85);   // the open tab
    mk(data_seg([[-160, Y + 26], [-174, Y + 36], [-160, Y + 46]]), 3.5, col, 5646, d2); mk(P.line(-150, Y + 48, -134, Y + 24), 3.5, col, 5647, d2);
    mk(data_seg([[-124, Y + 26], [-110, Y + 36], [-124, Y + 46]]), 3.5, col, 5648, d2);                // the </> glyph
    mk(P.line(X + 64, Y + 58, X + 64, Y + H), 3.5, col, 5649, d2, .7);                                 // gutter
    const IND = [0, 1, 2, 2, 1, 2, 3, 1, 0], TOK = [[70, 130], [90, 40, 160], [140, 60], [40, 210, 30], [110], [60, 80, 120], [150, 40], [40], [30]];
    IND.forEach((ind, i) => { const y = Y + 96 + i * 40, dd = ease((o.es - .2 - i * .05) / .3), on = i === hi && !!o.tint, k = on ? hot : col;
      mk(P.line(X + 22, y, X + 42, y), 2.6, col, 5650 + i, dd, .55);                                    // line-number tick
      let x = X + 90 + ind * 36;
      TOK[i].forEach((w, j) => { const tok = () => mk(P.line(x, y, x + w, y), j === 0 ? 7 : 9, k, 5670 + i * 4 + j, dd, on ? 1 : .85); if (on) glow(hot, 14, tok); else tok(); x += w + 16 }) });
    data_dot(X + 54, Y + 96 + hi * 40, 7, hot, o.tint ? d3 * (.7 + .3 * Math.sin(t * 4)) : 0);           // breakpoint on the hot line
    mk(P.line(X + W - 22, Y + 80, X + W - 22, Y + H - 24), 3, col, 5710, d2, .5);                      // scrollbar
    mk(data_rrect(X + W - 28, Y + 100, 12, 90, 6), 3.5, col, 5711, d2, .85);
    const cx = X + 90 + 36 + 40 + 14, cy = Y + 96 + 7 * 40;                                            // the cursor after the last token
    mk(P.line(cx, cy - 15, cx, cy + 15), 4.5, hot, 5712, d3, (t * 1.25 + .5) % 1 < .65 ? 1 : 0);
  };

  // scale: a balance — two-tier drum base, fluted column with collar and capital, fork holding the pivot boss, tapered beam with hanger rings, pointer sweeping a fixed tick plate, two dished pans on three cords each, a bell-shaped weight in the heavier pan; the right side sinks (flip mirrors it), tint colours the right pan, its cords and its load
  ART.scale = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = tools_col(o), { es, d0, d1, d2 } = tools_layers(o.es);
    const dir = o.flip ? -1 : 1, tilt = dir * .13 * ease((es - .4) / .5) + Math.sin(t * 1.1) * .012, PY = -228;
    tools_drum(0, 292, 200, 30, 40, col, 8400, d0, .06);
    tools_drum(0, 256, 138, 21, 36, col, 8404, d0, .07);
    const colm = [[-42, 256], [42, 256], [27, -190], [-27, -190]];
    shade(colm, .08); mk(P.line(-42, 256, -27, -190), 6.5, col, 8408, d0); mk(P.line(42, 256, 27, -190), 6.5, col, 8409, d0);
    for (let k = -1; k <= 1; k++) mk(P.line(k * 15, 244, k * 9.5, -180), 3, col, 8411 + k, d1, .5);   // flutes
    mk(tools_ell(0, 254, 50, 13, 0, Math.PI), 5, col, 8413, d1);                                    // base collar
    const cap = P.rect(-58, -212, 116, 22); shade(cap, .1); mk(cap, 5.5, col, 8414, d0);            // capital
    mk(P.line(-24, -212, -14, PY - 4), 5, col, 8415, d1); mk(P.line(24, -212, 14, PY - 4), 5, col, 8416, d1);   // the fork
    mk(P.arc(0, PY, 104, -Math.PI / 2 - .34, -Math.PI / 2 + .34), 3.5, col, 8417, d2, .8);        // fixed tick plate
    for (let k = -3; k <= 3; k++) { const a = -Math.PI / 2 + k * .1, L = k === 0 ? 22 : 12; mk(P.line(Math.cos(a) * 104, PY + Math.sin(a) * 104, Math.cos(a) * (104 + L), PY + Math.sin(a) * (104 + L)), 3, col, 8421 + k, d2, .8) }
    c.save(); c.translate(0, PY); c.rotate(tilt);                                                   // the beam turns on the pivot
    const beam = [[-270, -7], [-40, -12], [40, -12], [270, -7], [270, 7], [40, 12], [-40, 12], [-270, 7]]; beam.push(beam[0]);
    shade(beam, .09); mk(beam, 6, col, 8430, d1);
    shade(P.circle(0, 0, 30), .12); mk(P.circle(0, 0, 30), 5.5, col, 8431, d1); tools_hole(P.circle(0, 0, 9)); mk(P.circle(0, 0, 9), 4, col, 8432, d1);
    mk(P.line(0, -30, 0, -96), 5, col, 8433, d1); mk(P.poly([[-9, -84], [0, -100], [9, -84]]), 4, col, 8434, d1);   // pointer
    for (const s of [-1, 1]) mk(P.circle(s * 262, 16, 11), 4.5, col, 8436 + s, d1);               // hanger rings
    c.restore();
    for (const s of [-1, 1]) {                                                                     // the pans hang straight down
      const K = s > 0 ? hot : col, hx = s * 262 * Math.cos(tilt) - 16 * Math.sin(tilt), hy = PY + s * 262 * Math.sin(tilt) + 16 * Math.cos(tilt), py = hy + 176, g = ease((es - .25) / .35), sd = s > 0 ? 50 : 0;
      mk(P.line(hx, hy + 8, hx - 84, py - 6), 3.5, K, 8440 + sd, g, .9); mk(P.line(hx, hy + 8, hx + 84, py - 6), 3.5, K, 8441 + sd, g, .9); mk(P.line(hx, hy + 8, hx, py - 26), 3.5, K, 8442 + sd, g, .7);
      const rim = tools_ell(hx, py, 100, 26), bot = P.quad(hx + 100, py, hx, py + 78, hx - 100, py);
      shade([...tools_ell(hx, py, 100, 26, Math.PI, 0), ...bot], .05); mk(bot, 6, K, 8443 + sd, g);
      shade(rim, .1); mk(rim, 5.5, K, 8444 + sd, g); mk(tools_ell(hx, py, 82, 16, .3, Math.PI - .3), 3, K, 8445 + sd, g, .5);
      if (s === dir) {                                                                             // the weight in the heavier pan
        const wb = [[hx - 36, py + 10], [hx + 36, py + 10], [hx + 26, py - 58], [hx - 26, py - 58]]; wb.push(wb[0]);
        shade(wb, .1); mk(wb, 5, K, 8446 + sd, d2); mk(tools_ell(hx, py - 58, 26, 8), 4, K, 8447 + sd, d2);
        shade(P.circle(hx, py - 76, 13), .1); mk(P.circle(hx, py - 76, 13), 4.5, K, 8448 + sd, d2); mk(P.line(hx - 20, py - 30, hx + 20, py - 30), 3, K, 8449 + sd, d2, .6);
      }
    }
  };

  // warning sign: rounded triangle plate with thickness, a rim band, hatched exclamation bar and dot, all in the accent (`tint`, default yellow) with a breathing glow
  ART.warning = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || 'yellow'] || ACC.yellow, es = o.es ?? 99, p = .8 + .2 * Math.sin(t * 5);
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    const V = [[0, -300], [300, 240], [-300, 240]], IC = [0, 63.5], RI = 176.5;
    const tri = ins => security_rpoly(V.map(([x, y]) => [IC[0] + (x - IC[0]) * (1 - ins / RI), IC[1] + (y - IC[1]) * (1 - ins / RI)]), 60 * (1 - ins / RI));
    const outer = tri(0), band = tri(36), back = outer.map(q => [q[0] + 14, q[1] + 12]), n = outer.length;
    shade(back, .04); mk(back.slice(Math.round(n * .05), Math.round(n * .71)), 5, col, 7900, d0, .6);   // the plate's thickness
    shade(outer, .06); glow(col, 22 * p, () => mk([...outer, outer[0]], 9, col, 7901, d0));
    mk([...band, band[0]], 5, col, 7902, d1, .85);                                             // the rim band
    const bar = security_rpoly([[-36, -172], [36, -172], [21, 52], [-21, 52]], 12);
    shade(bar, .02); mk([...bar, bar[0]], 7, col, 7903, d1);                                   // the exclamation bar
    for (let i = 0; i < 9; i++) { const y = -150 + i * 23, hw = 32 - i * 1.5; mk(P.line(-hw + 4, y + 9, hw - 4, y - 9), 3.5, col, 7910 + i, ease((es - .3 - i * .02) / .25), .8) }
    const dot = P.circle(0, 132, 34); shade(dot, .02); mk(dot, 6, col, 7920, d2); security_dot(0, 132, 25, col, d2 * .85);
    security_hatch(-200, 220, 278, 12, col, 7930, d1);
  };

  // question: a block-letter question mark — thick tube body with round start cap, 3-D extrusion (back contour and depth lines to lower right), a matching extruded dot, three emphasis flicks off the hook and a dashed shadow; it bobs gently; tint colours every stroke
  ART.question = (t, u, o = {}) => {
    const c = A.ctx, col = tools_col(o), { es, d0, d1, d2 } = tools_layers(o.es);
    tools_ground(-150, 190, 322, 8500, d1, .35);
    c.save(); c.translate(0, Math.sin(t * 1.4) * 5); c.rotate(Math.sin(t * .9) * .015);
    const R = 165, CY = -166, W = 76, DX = 22, DY = 26, ae = .62, ex = Math.cos(ae) * R, ey = CY + Math.sin(ae) * R;
    const cl = tools_resample([...P.arc(0, CY, R, Math.PI * 1.04, TAU + ae), ...tools_cubic([ex, ey], [ex - Math.sin(ae) * 80, ey + Math.cos(ae) * 80], [0, -16], [0, 44]).slice(1), ...P.line(0, 44, 0, 120).slice(1)], 9);
    const { left, right, tan } = tools_tube(cl, () => W), n = cl.length, p0 = cl[0];
    const aR = Math.atan2(right[0][1] - p0[1], right[0][0] - p0[0]), aB = Math.atan2(-tan[0][1], -tan[0][0]), dl = Math.atan2(Math.sin(aB - aR), Math.cos(aB - aR));
    const face = [...P.arc(p0[0], p0[1], W / 2, aR, aR + 2 * dl), ...left.slice(1), right[n - 1], ...right.slice(0, n - 1).reverse()];
    const back = face.map(([x, y]) => [x + DX, y + DY]);
    mk(back, 5, col, 8510, d0, .6);
    let area = 0; for (let i = 0; i < face.length - 1; i++) area += face[i][0] * face[i + 1][1] - face[i + 1][0] * face[i][1];
    for (let i = 0, k = 0; i < face.length - 1 && k < 12; i += 7) {                      // depth lines where the side faces lower right
      const a = face[i], b = face[i + 1], ex2 = b[0] - a[0], ey2 = b[1] - a[1], nx = area > 0 ? ey2 : -ey2, ny = area > 0 ? -ex2 : ex2;
      if (nx * DX + ny * DY > .4 * Math.hypot(nx, ny) * Math.hypot(DX, DY)) { mk(P.line(a[0], a[1], a[0] + DX, a[1] + DY), 4, col, 8520 + k, d1, .7); k++ }
    }
    shade(face, .07); mk(face, 6.5, col, 8511, d0);
    const DOT = P.circle(0, 226, 48);
    mk(DOT.map(([x, y]) => [x + DX, y + DY]), 5, col, 8540, d0, .6);
    for (let k = 0; k < 3; k++) { const a = .1 + k * .55, x = Math.cos(a) * 48, y = 226 + Math.sin(a) * 48; mk(P.line(x, y, x + DX, y + DY), 4, col, 8541 + k, d1, .7) }
    shade(DOT, .07); mk(DOT, 6.5, col, 8545, d0);
    for (let k = 0; k < 3; k++) { const a = -2.05 - k * .33, r0 = R + W / 2 + 26, r1 = r0 + 36 + (k === 1 ? 12 : 0); mk(P.line(Math.cos(a) * r0, CY + Math.sin(a) * r0, Math.cos(a) * r1, CY + Math.sin(a) * r1), 4.5, col, 8550 + k, d2, .55 + .3 * Math.max(0, Math.sin(t * 2.2 + k))) }
    c.restore();
  };

  // city: skyline in light 3/4 — five detailed blocks (water tank, setback tower with antenna, billboard roof, spire with beacon, arched-top block), individual windows with mullions and sills, shop doors with awnings, a street lamp, faint towers behind, birds; tint = colour of the lit windows and the blinking beacon (default white)
  ART.city = (t, u, o = {}) => {
    const col = o.col || WHITE, hot = ACC[o.tint || 'white'] || WHITE, { es, d0, d1, d2 } = places_layers(o.es), G = 250, DX = 26, DY = -16;
    // background towers
    [[-330, 90, 430], [-70, 100, 470], [190, 80, 330], [318, 100, 380]].forEach(([x, w, h], i) => { const d = ease((es - .05) / .3), b = P.rect(x, G - h, w, h); shade(b, .025); mk(b, 4, col, 10500 + i, d, .4);
      for (let r = 0; r < 4; r++) mk(P.line(x + 10, G - h + 40 + r * 60, x + w - 10, G - h + 40 + r * 60), 2.4, col, 10510 + i * 4 + r, d, .25) });
    // the five blocks, left to right
    const B = [[-395, 125, 300], [-262, 140, 520], [-115, 150, 380], [42, 170, 538], [222, 140, 260]];
    let sd = 10600;
    B.forEach(([x, w, h], i) => {
      const d = ease((es - i * .06) / .3), dd = ease((es - .2 - i * .05) / .3), top = G - h, arch = i === 4, springs = arch ? top + 60 : top;
      const side = [[x + w, springs], [x + w + DX, springs + DY], [x + w + DX, G + DY], [x + w, G]]; shade(side, .03); mk([...side, side[0]], 5, col, sd++, d, .9);
      for (let r = 0; r < Math.floor((h - 60) / 96); r++) mk(P.rect(x + w + 8, top + 50 + r * 96 + (arch ? 60 : 0), 9, 26), 2.4, col, sd++, dd, .45);
      let front;
      if (arch) front = [...P.line(x, G, x, springs), ...places_ell(x + w / 2, springs, w / 2, 60, Math.PI, TAU), ...P.line(x + w, springs, x + w, G), [x, G]];
      else front = P.rect(x, top, w, h);
      shade(front, .06); mk(front, 6.5, col, sd++, d);
      // windows
      const cols = Math.floor((w - 24) / 34), rows = Math.floor((h - (arch ? 110 : 66)) / 48), ox = x + (w - cols * 34 + 12) / 2, oy = top + (arch ? 72 : 36);
      for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) { const k = n1(sd + r * 7 + cc * 3), hotw = o.tint && k < .05, lit = k < .16 ? (hotw ? hot : PALE) : null;
        places_win(ox + cc * 34, oy + r * 48, 22, 28, col, sd, dd, .75, lit, hotw ? .6 : .2); sd += 4 }
      // roofs
      if (i === 0) { const tx = x + 40, ty = top - 58; mk(P.line(tx + 8, top, tx + 8, ty + 44), 3.5, col, sd++, dd); mk(P.line(tx + 42, top, tx + 42, ty + 44), 3.5, col, sd++, dd);
        const tank = [...P.line(tx, ty + 44, tx, ty + 6), ...places_ell(tx + 25, ty + 6, 25, 7, Math.PI, TAU), ...P.line(tx + 50, ty + 6, tx + 50, ty + 44), ...places_ell(tx + 25, ty + 44, 25, 7, 0, Math.PI)]; shade(tank, .07); mk(tank, 4.5, col, sd++, dd);
        mk([[tx - 4, ty + 8], [tx + 25, ty - 16], [tx + 54, ty + 8]], 4.5, col, sd++, dd); mk(places_ell(tx + 25, ty + 6, 25, 7), 3, col, sd++, dd, .6);
        mk(P.line(tx + 6, ty + 30, tx + 44, ty + 30), 2.4, col, sd++, dd, .4) }
      if (i === 1) { const ux = x + 22, uw = 96, uh = 70; const up = P.rect(ux, top - uh, uw, uh); shade(up, .06); mk(up, 5.5, col, sd++, d);
        for (let cc = 0; cc < 2; cc++) mk(P.rect(ux + 16 + cc * 40, top - uh + 20, 22, 28), 3.2, col, sd++, dd, .75);
        mk(P.line(ux + uw / 2, top - uh, ux + uw / 2, top - uh - 78), 4, col, sd++, dd); for (let k = 0; k < 3; k++) mk(P.line(ux + uw / 2 - 14 + k * 4, top - uh - 30 - k * 22, ux + uw / 2 + 14 - k * 4, top - uh - 30 - k * 22), 2.6, col, sd++, dd, .7) }
      if (i === 2) { const bx = x + 18, bw = w - 36, by = top - 74; mk(P.line(bx + 12, top, bx + 12, by + 60), 3.5, col, sd++, dd); mk(P.line(bx + bw - 12, top, bx + bw - 12, by + 60), 3.5, col, sd++, dd);
        const board = P.rect(bx, by, bw, 60); shade(board, .07); mk(board, 5, col, sd++, dd); places_hatch(board, 12, -.65, 2.2, col, sd, dd, .25, 24); sd += 24 }
      if (i === 3) { const cx = x + w / 2, cap = [[x + 14, top], [x + w - 14, top], [x + w - 40, top - 40], [x + 40, top - 40]]; shade(cap, .07); mk([...cap, cap[0]], 5.5, col, sd++, d);
        const pyr = [[x + 40, top - 40], [x + w - 40, top - 40], [cx, top - 90]]; shade(pyr, .05); mk([...pyr, pyr[0]], 5, col, sd++, d);
        mk(P.line(cx, top - 90, cx, top - 126), 4, col, sd++, dd); mk(P.line(cx - 10, top - 110, cx + 10, top - 110), 2.6, col, sd++, dd, .7);
        const on = Math.sin(t * 4) > 0; places_led(cx, top - 130, on ? 7 : 4, o.tint ? hot : PALE, on ? 22 : 6, d2 * (on ? 1 : .5)) }
      if (i === 4) { mk(places_ell(x + w / 2, springs, w / 2 - 14, 46, Math.PI, TAU), 3.2, col, sd++, dd, .6); mk(P.line(x + w / 2, top, x + w / 2, top + 22), 3.5, col, sd++, dd, .8) }
      // street level: a door, an awning
      if (i !== 3) { const dx = x + w / 2 - 22; mk(P.rect(dx, G - 62, 44, 62), 4.5, col, sd++, dd); mk(P.line(dx + 22, G - 62, dx + 22, G), 2.6, col, sd++, dd, .5); places_dot(dx + 16, G - 30, 2.5, col, dd);
        const aw = [[dx - 14, G - 72], [dx + 58, G - 72], [dx + 66, G - 90], [dx - 22, G - 90]]; shade(aw, .09); mk([...aw, aw[0]], 4, col, sd++, dd);
        for (let k = 1; k < 5; k++) mk(P.line(dx - 14 + k * 14.4, G - 72, dx - 21 + k * 17.6, G - 90), 2.4, col, sd++, dd, .5) }
      else { const dx = x + w / 2 - 40; mk(P.rect(dx, G - 80, 80, 80), 4.5, col, sd++, dd); mk(P.line(dx + 40, G - 80, dx + 40, G), 3, col, sd++, dd, .6); mk(P.line(dx, G - 62, dx + 80, G - 62), 2.6, col, sd++, dd, .5);
        for (let k = 0; k < 3; k++) mk(P.line(dx - 12 - k * 10, G - 4 - k * 6, dx + 92 + k * 10, G - 4 - k * 6), 3, col, sd++, dd, .6) }
    });
    // street, kerb, lamp, birds
    mk(P.line(-446, G, 412, G), 6.5, col, 11300, d0); mk(P.line(-446, G + 18, 412, G + 18), 3.5, col, 11301, d1, .5);
    for (let k = 0; k < 6; k++) mk(P.line(-420 + k * 150, G + 18, -410 + k * 150, G), 2.4, col, 11302 + k, d1, .35);
    mk(P.line(-430, G, -430, G - 190), 6, col, 11310, d1); mk(P.quad(-430, G - 190, -430, G - 232, -392, -1 + G - 226), 5, col, 11311, d1);
    const lamp = [[-402, G - 232], [-380, G - 232], [-376, G - 212], [-406, G - 212]]; shade(lamp, .1); mk([...lamp, lamp[0]], 4, col, 11312, d1);
    places_led(-391, G - 208, 5, PALE, 14, d2 * .8); mk(P.rect(-438, G - 40, 16, 6), 3, col, 11313, d1, .7);
    for (let k = 0; k < 3; k++) { const bx = -300 + k * 42 + Math.sin(t * .7 + k) * 6, by = -330 - k * 26 + Math.cos(t * .9 + k * 2) * 5, f = 6 + 4 * Math.sin(t * 6 + k * 2);
      mk([[bx - 14, by + f], [bx, by], [bx + 14, by + f]], 3, col, 11320 + k, d2, .7) }
  };

  // ---- objects family: shared helpers (prefix objects_) ---------------------------
  // elliptical arc path (P.arc is circular only); rot tilts the whole ellipse
  function objects_ell(cx, cy, rx, ry, a0 = 0, a1 = TAU, rot = 0) {
    const n = Math.max(8, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 10)), c = Math.cos(rot), s = Math.sin(rot);
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)), x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * c - y * s, cy + x * s + y * c] });
  }
  // closed rounded-rectangle path
  function objects_rr(x, y, w, h, r) {
    const q = Math.PI / 2, rr = Math.min(r, w / 2, h / 2);
    return [...P.arc(x + w - rr, y + rr, rr, -q, 0), ...P.arc(x + w - rr, y + h - rr, rr, 0, q), ...P.arc(x + rr, y + h - rr, rr, q, 2 * q), ...P.arc(x + rr, y + rr, rr, 2 * q, 3 * q), [x + w - rr, y]];
  }
  // resample a polyline every `step` px
  function objects_resample(pts, step) {
    const out = [pts[0]]; let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0); if (L === 0) continue;
      let s = step - carry; while (s <= L) { out.push([lerp(x0, x1, s / L), lerp(y0, y1, s / L)]); s += step }
      carry = L - (s - step);
    }
    return out;
  }
  // dashed marker stroke: each dash is its own mk() with seed+k (reserve ~40 seeds per call)
  function objects_dash(pts, w, col, seed, draw = 1, a = 1, dash = 20, gap = 14) {
    const rs = objects_resample(pts, 5), per = Math.max(2, Math.round(dash / 5)), gp = Math.max(1, Math.round(gap / 5)), n = rs.length;
    for (let i = 0, k = 0; i < n - 1 && k < 40; i += per + gp, k++) {
      const seg = rs.slice(i, Math.min(n, i + per + 1)); if (seg.length < 2) break;
      const dd = clamp((draw * n - i) / seg.length); if (dd <= 0) break;
      mk(seg, w, col, seed + k, dd, a);
    }
  }
  // small filled dot (rivet, eye, LED)
  function objects_dot(x, y, r, col, a = 1) { const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore() }
  // four-point sparkle (uses seed..seed+3)
  function objects_spark(x, y, r, col, seed, d, a = 1) {
    mk(P.line(x - r, y, x + r, y), 4, col, seed, d, a); mk(P.line(x, y - r, x, y + r), 4, col, seed + 1, d, a);
    const s = r * .42; mk(P.line(x - s, y - s, x + s, y + s), 2.5, col, seed + 2, d, a * .7); mk(P.line(x - s, y + s, x + s, y - s), 2.5, col, seed + 3, d, a * .7);
  }
  // dashed ground shadow under an object (uses seed..seed+39)
  function objects_ground(x0, x1, y, seed, d, a = .4) { objects_dash(P.line(x0, y, x1, y), 3.5, PALE, seed, d, a, 24, 18) }
  // the three draw-on layers of the brief: contour, details, colour (es=99 -> all complete)
  function objects_layers(es) { const e = es === undefined ? 99 : es; return { es: e, d0: ease(e / .35), d1: ease((e - .2) / .35), d2: ease((e - .4) / .3) } }
  // point on a parallelogram face: O + a*U + b*V
  function objects_face(O, U, V) { return (a, b) => [O[0] + U[0] * a + V[0] * b, O[1] + U[1] * a + V[1] * b] }
  // coin: a big coin standing on edge (reeded rim, inner ring, embossed currency glyph) leaning on a stack of four coins; tint = gold accent on the glyph and the glints
  ART.coin = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = ACC[o.tint || 'yellow'] || WHITE, { es, d0, d1, d2 } = objects_layers(o.es);
    objects_ground(-330, 340, 294, 3900, d0);
    // the stack: four coins lying flat, bottom one first (bottom rim at BASE+TH+RY = 280, on the shadow line)
    const SX = 150, RX = 200, RY = 66, TH = 44, BASE = 170;
    for (let i = 0; i < 4; i++) {
      const cy = BASE - i * TH, g = ease((es - i * .06) / .3), gd = ease((es - .2 - i * .04) / .3);
      const top = objects_ell(SX, cy, RX, RY), front = objects_ell(SX, cy, RX, RY, 0, Math.PI), frontB = objects_ell(SX, cy + TH, RX, RY, Math.PI, 0);
      shade([...front, ...frontB], .035);
      mk(frontB, 5.5, col, 3000 + i, g); mk(P.line(SX - RX, cy, SX - RX, cy + TH), 5.5, col, 3010 + i, g); mk(P.line(SX + RX, cy, SX + RX, cy + TH), 5.5, col, 3020 + i, g);
      shade(top, .07); mk(top, 6.5, col, 3030 + i, g);
      for (let k = 0; k < 14; k++) {                                     // reeded edge
        const a = Math.PI * (.08 + k * .84 / 13), x = SX + Math.cos(a) * RX, y0 = cy + Math.sin(a) * RY + 5;
        mk(P.line(x, y0, x, y0 + TH * .62), 2.5, col, 3040 + i * 14 + k, gd, .45);
      }
    }
    // the standing coin, in front, leaning a little on the stack
    c.save(); c.translate(-165, 70); c.rotate(.11);                     // top leans right, onto the stack
    const FX = 190, FY = 208, EX = 34;
    const face = objects_ell(0, 0, FX, FY), edge = objects_ell(EX, 0, FX, FY, -Math.PI / 2, Math.PI / 2);
    shade([...objects_ell(0, 0, FX, FY, -Math.PI / 2, Math.PI / 2), ...objects_ell(EX, 0, FX, FY, Math.PI / 2, -Math.PI / 2)], .03);
    mk(edge, 6.5, col, 3100, d0);
    for (let k = 0; k < 17; k++) {                                       // reeding across the visible edge band
      const a = -Math.PI * .44 + k * Math.PI * .88 / 16, x = Math.cos(a) * FX, y = Math.sin(a) * FY;
      mk(P.line(x + 3, y, x + EX - 3, y), 2.5, col, 3110 + k, d1, .5);
    }
    shade(face, .06); mk(face, 7, col, 3101, d0);
    mk(objects_ell(0, 0, FX * .84, FY * .84), 4.5, col, 3102, d1, .85);   // inner rim ring
    mk(objects_ell(0, 0, FX * .78, FY * .78), 2.5, col, 3103, d1, .35);   // and its bead line
    // embossed glyph: an S made of two arcs plus a bar (a hand-drawn currency sign, not text)
    const R = 44;
    mk(P.arc(0, -R, R, -Math.PI * .12, -Math.PI * 1.5), 7, hot, 3150, d2);
    mk(P.arc(0, R, R, -Math.PI / 2, Math.PI * .88), 7, hot, 3151, d2);
    mk(P.line(0, -2 * R - 24, 0, 2 * R + 24), 6, hot, 3152, d2);
    // glints on the polished rim (twinkle)
    const G = [[-150, -165, 26], [-210, -90, 15], [125, -212, 13]];
    glow(hot, 14, () => { G.forEach(([x, y, r], i) => objects_spark(x, y, r, hot, 3130 + i * 4, d2, .65 + .35 * Math.sin(t * 3 + i * 2.1))) });
    c.restore();
  };

  // clock: an alarm clock — round case with visible depth, glass bezel, 12 hour ticks + 60 minute ticks, two bells with a hammer, two splayed feet, hour hand white and a sweeping minute hand in tint (time passing); tint = minute hand colour
  ART.clock = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = ACC[o.tint || 'white'] || WHITE, { d0, d1, d2 } = objects_layers(o.es);
    const CX = 0, CY = 20, R = 280;
    objects_ground(-250, 250, 394, 3360, d0);
    // feet (behind the case)
    for (const s of [-1, 1]) {
      mk(P.line(s * 150, 258, s * 208, 372), 9, col, 3200 + (s + 1) / 2, d0);
      const pad = objects_ell(s * 215, 372, 40, 12); shade(pad, .06); mk(pad, 5, col, 3202 + (s + 1) / 2, d0);
    }
    // bells and their stems, the hammer between them
    for (const s of [-1, 1]) {
      const bx = s * 222, by = -246, br = 84, i = (s + 1) / 2;
      mk(P.line(bx + s * 6, by + 10, s * 178, -176), 12, col, 3210 + i, d0);          // stem into the case
      const dome = [...P.arc(bx, by, br, Math.PI, TAU), [bx + br, by]];
      shade(dome, .07); mk(dome, 7, col, 3212 + i, d0);
      const plate = objects_rr(bx - br - 4, by - 2, 2 * br + 8, 16, 7); shade(plate, .09); mk(plate, 5, col, 3214 + i, d1);
      mk(P.arc(bx, by, br * .72, Math.PI * 1.15, Math.PI * 1.55), 3.5, col, 3216 + i, d1, .5);   // highlight on the dome
      objects_dot(bx, by - br * .35, 6, col, .9 * d1);                                   // the bell's bolt
    }
    mk(P.line(0, -262, 0, -322), 8, col, 3220, d1); objects_dot(0, -330, 15, col, d1); mk(P.circle(0, -330, 15), 4, col, 3221, d1);
    // the case: depth ring behind, then the front
    const depth = P.arc(CX + 24, CY + 12, R, -Math.PI * .38, Math.PI * .66);
    shade([...depth, ...P.arc(CX, CY, R, Math.PI * .66, -Math.PI * .38)], .03); mk(depth, 6, col, 3230, d0, .8);
    const body = P.circle(CX, CY, R); shade(body, .05); mk(body, 7.5, col, 3231, d0);
    const bezel = P.circle(CX, CY, R - 38); shade(bezel, .035); mk(bezel, 5, col, 3232, d0, .9);
    // ticks: 60 minute ticks (thin) and 12 hour ticks (thick, quarters longer)
    for (let i = 0; i < 60; i++) {
      if (i % 5 === 0) continue;
      const a = i * TAU / 60 - Math.PI / 2, r0 = R - 56, r1 = R - 44;
      mk(P.line(CX + Math.cos(a) * r0, CY + Math.sin(a) * r0, CX + Math.cos(a) * r1, CY + Math.sin(a) * r1), 2.5, col, 3300 + i, d1, .55);
    }
    for (let i = 0; i < 12; i++) {
      const a = i * TAU / 12 - Math.PI / 2, q = i % 3 === 0, r0 = R - (q ? 76 : 66), r1 = R - 44;
      mk(P.line(CX + Math.cos(a) * r0, CY + Math.sin(a) * r0, CX + Math.cos(a) * r1, CY + Math.sin(a) * r1), q ? 7 : 5, col, 3260 + i, d1);
    }
    // glass glint
    mk(P.arc(CX, CY, R - 52, -Math.PI * .86, -Math.PI * .64), 4, col, 3272, d1, .45);
    mk(P.arc(CX, CY, R - 52, -Math.PI * .60, -Math.PI * .55), 4, col, 3273, d1, .45);
    // hands (same speeds as before: the minute hand sweeps visibly)
    const m = t * 1.4 - Math.PI / 2, h = t * .35 - Math.PI / 2;
    const hand = (a, len, tail, w, cc, seed, d) => {
      mk(P.line(CX - Math.cos(a) * tail, CY - Math.sin(a) * tail, CX + Math.cos(a) * len, CY + Math.sin(a) * len), w, cc, seed, d);
      const px = CX + Math.cos(a) * len, py = CY + Math.sin(a) * len, n = [-Math.sin(a), Math.cos(a)];
      mk(P.poly([[px - Math.cos(a) * 30 + n[0] * 14, py - Math.sin(a) * 30 + n[1] * 14], [px, py], [px - Math.cos(a) * 30 - n[0] * 14, py - Math.sin(a) * 30 - n[1] * 14]]), w * .7, cc, seed + 1, d);
    };
    hand(h, 132, 34, 12, col, 3280, d1);
    hand(m, 196, 40, 8, hot, 3282, d2);
    objects_dot(CX, CY, 14, col, d1); mk(P.circle(CX, CY, 21), 3.5, col, 3284, d1, .8);
  };

  // calendar: wall calendar with a spiral of six rings, header band, weekday dashes, a 7x5 grid of days with number ticks (month starts mid-week), page stack behind and a curled corner; tint = the circled day (only when tint is given)
  ART.calendar = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, hot = ACC[o.tint || 'red'] || ACC.red, { es, d0, d1, d2 } = objects_layers(o.es);
    const X0 = -320, Y0 = -190, W = 640, H = 490;
    objects_ground(-280, 300, 336, 3560, d0);
    // pages behind (stack thickness)
    for (let i = 2; i >= 1; i--) {
      const p = P.rect(X0 + i * 11, Y0 + i * 11, W, H); shade(p, .03);
      mk([...P.line(X0 + W + i * 11, Y0 + 40 + i * 11, X0 + W + i * 11, Y0 + H + i * 11), ...P.line(X0 + W + i * 11, Y0 + H + i * 11, X0 + 40 + i * 11, Y0 + H + i * 11)], 5, col, 3400 + i, d0, .55);
    }
    const CU = 70, body = P.poly([[X0, Y0], [X0 + W, Y0], [X0 + W, Y0 + H - CU], [X0 + W - CU, Y0 + H], [X0, Y0 + H]]); shade(body, .05);
    mk([...P.line(X0 + W - CU, Y0 + H, X0, Y0 + H), ...P.line(X0, Y0 + H, X0, Y0), ...P.line(X0, Y0, X0 + W, Y0), ...P.line(X0 + W, Y0, X0 + W, Y0 + H - CU)], 7.5, col, 3406, d0);   // outline, open where the corner lifts
    // header band
    const head = P.rect(X0, Y0, W, 88); shade(head, .1); mk(P.line(X0, Y0 + 88, X0 + W, Y0 + 88), 6, col, 3403, d0);
    mk(P.line(X0 + 40, Y0 + 44, X0 + 250, Y0 + 44), 6, col, 3404, d1, .8);           // the month name as a bold squiggle
    mk(P.line(X0 + 470, Y0 + 44, X0 + 600, Y0 + 44), 4, col, 3405, d1, .5);           // the year
    // spiral rings through punched holes
    for (let i = 0; i < 6; i++) {
      const x = -250 + i * 100, ring = objects_rr(x - 12, Y0 - 62, 24, 96, 12);
      mk(ring, 5.5, col, 3410 + i, ease((es - .05 * i) / .3)); mk(P.circle(x, Y0 + 20, 9), 3, col, 3420 + i, d1, .6);
    }
    // weekday dashes
    const cols = 7, rows = 5, GX = X0 + 24, GW = W - 48, GY = Y0 + 132, GH = H - 152, cw = GW / cols, rh = GH / rows;
    for (let i = 0; i < cols; i++) mk(P.line(GX + i * cw + cw * .25, Y0 + 110, GX + i * cw + cw * .75, Y0 + 110), 3.5, col, 3430 + i, d1, .6);
    // the grid
    for (let i = 0; i <= cols; i++) mk(P.line(GX + i * cw, GY, GX + i * cw, GY + GH), i === 0 || i === cols ? 4.5 : 3, col, 3440 + i, d1, i === 0 || i === cols ? .9 : .55);
    for (let j = 0; j <= rows; j++) mk(P.line(GX, GY + j * rh, GX + GW, GY + j * rh), j === 0 || j === rows ? 4.5 : 3, col, 3450 + j, d1, j === 0 || j === rows ? .9 : .55);
    // day numbers as little ticks (first two and last three cells empty: the month starts mid-week)
    let n = 0;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i; if (k < 2 || k > 31) continue;
      const x = GX + i * cw + 12, y = GY + j * rh + 12, two = n >= 9;
      mk(P.line(x, y, x + 4, y + 16), 2.5, col, 3460 + k, ease((es - .25 - k * .004) / .3), .5);
      if (two) mk(P.line(x + 12, y + 2, x + 20, y + 16), 2.5, col, 3500 + k, ease((es - .25 - k * .004) / .3), .5);
      n++;
    }
    // the circled day
    if (o.tint !== undefined) {
      const i = 4, j = 2, cx = GX + i * cw + cw / 2, cy = GY + j * rh + rh / 2, p = .85 + .15 * Math.sin(t * 3);
      glow(hot, 10, () => {
        mk(objects_ell(cx, cy, cw * .44, rh * .44, -.3, TAU - .1), 6, hot, 3540, d2, p);
        mk(objects_ell(cx + 3, cy - 2, cw * .40, rh * .42, .4, TAU + .2), 4, hot, 3541, d2, p * .7);
      });
    }
    // curled bottom-right corner: the corner region shows the page beneath, the lifted flap (its back, lit) curls over it
    const cx = X0 + W, cy = Y0 + H;
    shade([[cx - CU, cy], [cx, cy], [cx, cy - CU]], .03);                                       // knocks the grid out of the lifted corner
    mk([...P.quad(cx - 6, cy - CU - 8, cx - 50, cy - 36, cx - CU - 8, cy - 6)], 3, col, 3546, d1, .3);   // shadow the flap casts on the page
    const curl = [...P.quad(cx - CU, cy, cx - 6, cy - 6, cx, cy - CU), ...P.quad(cx, cy - CU, cx - 44, cy - 26, cx - CU, cy)];
    shade(curl, .16); mk([...curl, curl[0]], 5, col, 3545, d1);
  };

  // box: a sealed cardboard shipping box in isometric view — top with the flap seam, packing tape over it running down the side, a shipping label with a barcode on the front, "this way up" arrows on the side, dashed shadow; tint = tape colour
  ART.box = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, tape = (o.tint && ACC[o.tint]) || col, { d0, d1, d2 } = objects_layers(o.es);
    const T = [0, -210], L = [-330, -45], R = [330, -45], C = [0, 120], LB = [-330, 165], CB = [0, 330], RB = [330, 165];
    objects_dash([...P.line(LB[0] - 10, LB[1] + 14, CB[0], CB[1] + 16), ...P.line(CB[0], CB[1] + 16, RB[0] + 10, RB[1] + 14)], 3.5, PALE, 3790, d0, .4, 24, 18);
    // faces: top, left, right
    const top = P.poly([T, R, C, L]), lf = P.poly([L, C, CB, LB]), rf = P.poly([C, R, RB, CB]);
    shade(lf, .05); mk([...lf, lf[0]], 7, col, 3700, d0);
    shade(rf, .025); mk([...rf, rf[0]], 7, col, 3701, d0);
    shade(top, .09); mk([...top, top[0]], 7, col, 3702, d0);
    // the flap seam across the top (a gap plus the visible card thickness of one flap)
    const M1 = [(T[0] + L[0]) / 2, (T[1] + L[1]) / 2], M2 = [(C[0] + R[0]) / 2, (C[1] + R[1]) / 2];
    mk(P.line(M1[0], M1[1], M2[0], M2[1]), 4.5, col, 3703, d1, .9);
    mk(P.line(M1[0] - 7, M1[1] + 3.5, M2[0] - 7, M2[1] + 3.5), 3, col, 3704, d1, .45);
    mk(P.line(M1[0] - 7, M1[1] + 3.5, M1[0], M1[1]), 3, col, 3705, d1, .45);
    // short flap folds at the two short ends of the top
    mk(P.line(T[0], T[1], T[0] - 60, T[1] + 30), 3, col, 3706, d1, .4); mk(P.line(C[0], C[1], C[0] + 60, C[1] - 30), 3, col, 3707, d1, .4);
    // packing tape along the seam and down the right face (two edges + gloss ticks)
    const px = -17.9, py = 8.9;                                            // half tape width, in the top plane
    const tapeTop = [[M1[0] + px, M1[1] + py], [M2[0] + px, M2[1] + py], [M2[0] + px, M2[1] + py + 92], [M2[0] - px, M2[1] - py + 92], [M2[0] - px, M2[1] - py], [M1[0] - px, M1[1] - py]];
    shade(tapeTop, .06);
    mk(P.line(M1[0] + px, M1[1] + py, M2[0] + px, M2[1] + py), 5, tape, 3710, d2, .95);
    mk(P.line(M1[0] - px, M1[1] - py, M2[0] - px, M2[1] - py), 5, tape, 3711, d2, .95);
    mk(P.line(M2[0] + px, M2[1] + py, M2[0] + px, M2[1] + py + 92), 5, tape, 3712, d2, .95);
    mk(P.line(M2[0] - px, M2[1] - py, M2[0] - px, M2[1] - py + 92), 5, tape, 3713, d2, .95);
    mk(P.line(M2[0] + px, M2[1] + py + 92, M2[0] - px, M2[1] - py + 92), 4, tape, 3714, d2, .95);
    for (let i = 0; i < 5; i++) { const f = .12 + i * .18, x = lerp(M1[0], M2[0], f), y = lerp(M1[1], M2[1], f); mk(P.line(x - 6, y + 10, x + 10, y - 12), 3, tape, 3715 + i, d2, .5) }
    // shipping label on the left face: address lines and a barcode
    const fl = objects_face(L, [C[0] - L[0], C[1] - L[1]], [LB[0] - L[0], LB[1] - L[1]]);
    const lab = [fl(.12, .16), fl(.56, .16), fl(.56, .52), fl(.12, .52)]; shade(lab, .14); mk([...lab, lab[0]], 4.5, col, 3720, d1);
    for (let i = 0; i < 3; i++) { const a = fl(.17, .23 + i * .06), b = fl([.44, .38, .48][i], .23 + i * .06); mk(P.line(a[0], a[1], b[0], b[1]), 3, col, 3721 + i, d1, .7) }
    for (let i = 0; i < 9; i++) { const a = fl(.17 + i * .04, .40), b = fl(.17 + i * .04, .48); mk(P.line(a[0], a[1], b[0], b[1]), i % 3 === 1 ? 4 : 2.5, col, 3724 + i, d1, .8) }
    // "this way up" arrows on the right face
    const fr = objects_face(C, [R[0] - C[0], R[1] - C[1]], [CB[0] - C[0], CB[1] - C[1]]);
    for (let i = 0; i < 2; i++) {
      const a = .28 + i * .16, b0 = fr(a, .86), b1 = fr(a, .56), w1 = fr(a - .07, .66), w2 = fr(a + .07, .66);
      mk(P.line(b0[0], b0[1], b1[0], b1[1]), 4, col, 3740 + i * 3, d1, .8);
      mk(P.poly([w1, b1, w2]), 4, col, 3741 + i * 3, d1, .8);
    }
    const u0 = fr(.18, .9), u1 = fr(.54, .9); mk(P.line(u0[0], u0[1], u1[0], u1[1]), 4, col, 3746, d1, .8);
    // corner rivets of the card (little staple marks at the front vertical edge)
    for (let i = 0; i < 3; i++) objects_dot(C[0], C[1] + 40 + i * 60, 3.5, col, .6 * d1);
  };

  // book: an open hardcover seen from above — the two covers, the page block with its stacked edges, two bulging pages with a gutter, a picture box and lines of copy, a ribbon bookmark that sways
  ART.book = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { d0, d1, d2 } = objects_layers(o.es);
    objects_ground(-350, 350, 232, 3690, d0);
    // hard covers (a flat V), 34 px wider than the page block on each side
    const cover = P.poly([[-386, -185], [0, -165], [386, -185], [386, 178], [0, 202], [-386, 178]]);
    shade(cover, .04); mk([...cover, cover[0]], 7.5, col, 3600, d0);
    mk(P.line(0, -165, 0, 202), 5, col, 3601, d0, .7);                                   // spine crease
    // page block: stacked edges under each page, the side lines 7 px apart
    for (let k = 3; k >= 1; k--) {
      const y = k * 9, x = 353 + k * 7;
      mk([...P.quad(-352, 142 + y, -180, 100 + y, -8, 158 + y)], 3, col, 3602 + k, d1, .35 + .15 * (3 - k));
      mk([...P.quad(8, 158 + y, 180, 100 + y, 352, 142 + y)], 3, col, 3606 + k, d1, .35 + .15 * (3 - k));
      mk(P.line(-x, -140 + y, -x, 142 + y), 3, col, 3610 + k, d1, .4);
      mk(P.line(x, -140 + y, x, 142 + y), 3, col, 3614 + k, d1, .4);
    }
    // the two open pages
    const lp = [...P.quad(-352, -140, -180, -170, -8, -132), ...P.line(-8, -132, -8, 158), ...P.quad(-8, 158, -180, 100, -352, 142), ...P.line(-352, 142, -352, -140)];
    const rp = [...P.quad(352, -140, 180, -170, 8, -132), ...P.line(8, -132, 8, 158), ...P.quad(8, 158, 180, 100, 352, 142), ...P.line(352, 142, 352, -140)];
    shade(lp, .07); shade(rp, .07); mk([...lp, lp[0]], 6.5, col, 3620, d0); mk([...rp, rp[0]], 6.5, col, 3621, d0);
    mk([...P.quad(-352, -128, -180, -158, -8, -120)], 3, col, 3622, d1, .35);            // the page under the top one
    mk([...P.quad(352, -128, 180, -158, 8, -120)], 3, col, 3623, d1, .35);
    // left page: a picture box with a little landscape, then copy
    const bx = -318, by = -110, bw = 150, bh = 108; mk(P.rect(bx, by, bw, bh), 4, col, 3630, d1, .85);
    mk([...P.line(bx + 8, by + bh - 14, bx + 46, by + 40), ...P.line(bx + 46, by + 40, bx + 74, by + 74), ...P.line(bx + 74, by + 74, bx + 104, by + 30), ...P.line(bx + 104, by + 30, bx + bw - 8, by + bh - 14)], 3, col, 3631, d1, .7);
    mk(P.circle(bx + 112, by + 24, 9), 3, col, 3632, d1, .7);
    const rowL = (x0, x1, y, k, a = .7, w = 4) => mk(P.line(x0, y - (x0 + 180) * .05, x1, y - (x1 + 180) * .05), w, col, k, ease((d1 - .1 * ((y + 110) / 30)) / .7), a);
    for (let i = 0; i < 4; i++) rowL(-150, -40 - [10, 0, 30, 6][i], -104 + i * 26, 3640 + i);
    for (let i = 0; i < 4; i++) rowL(-318, -40 - [0, 24, 8, 60][i], 14 + i * 26, 3644 + i);
    // right page: a heading and copy
    const rowR = (x0, x1, y, k, a = .7, w = 4) => mk(P.line(x0, y - (180 - x0) * .05, x1, y - (180 - x1) * .05), w, col, k, ease((d1 - .1 * ((y + 110) / 30)) / .7), a);
    rowR(40, 200, -100, 3650, .95, 6);
    for (let i = 0; i < 8; i++) rowR(40, 318 - [0, 20, 6, 40, 0, 14, 60, 120][i], -64 + i * 26, 3651 + i);
    // curled corner on the right page
    mk([...P.quad(300, 146, 346, 132, 350, 96)], 4, col, 3660, d1, .8); mk([...P.quad(312, 144, 335, 128, 336, 108)], 3, col, 3661, d1, .5);
    // ribbon bookmark coming out of the gutter, swaying a touch
    const sw = Math.sin(t * 1.3) * 5, rib = [...P.quad(0, 150, 10 + sw, 200, 26 + sw, 236), ...P.line(26 + sw, 236, 8 + sw, 226), ...P.line(8 + sw, 226, 0 + sw, 244), ...P.quad(0 + sw, 244, -12 + sw, 200, -14, 150)];
    shade(rib, .12); mk([...rib, rib[0]], 4.5, col, 3670, d2);
  };

  // rocket: a cartoon rocket standing on its exhaust — curved nose cone with a tip, ribbed body with a seam and rivets, round porthole (glass ring in led colour), three fins, a flared nozzle, a flickering two-tone flame in tint with smoke puffs; led = porthole glass colour, tint = flame colour
  ART.rocket = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, glass = ACC[o.led || 'blue'] || ACC.blue, fire = ACC[o.tint || 'red'] || ACC.red, { d0, d1, d2 } = objects_layers(o.es);
    const fl = .7 + .3 * Math.sin(t * 14);
    // smoke puffs behind the flame
    for (const [sx, sy, r, k] of [[-108, 318, 30, 0], [118, 338, 26, 1], [-70, 372, 20, 2], [66, 380, 16, 3]]) {
      const x = sx + Math.sin(t * 1.7 + k) * 6; mk(P.arc(x, sy, r, Math.PI * .1 + k, Math.PI * 1.9 + k), 4, col, 3900 + k, d2, .45);
    }
    // side fins (behind the body)
    for (const s of [-1, 1]) {
      const fin = [...P.quad(s * 118, -10, s * 236, 52, s * 278, 246), ...P.line(s * 278, 246, s * 112, 186), ...P.line(s * 112, 186, s * 118, -10)];
      shade(fin, .05); mk(fin, 7, col, 3910 + (s + 1) / 2, d0);
      mk([...P.quad(s * 132, 40, s * 206, 90, s * 236, 200)], 3, col, 3912 + (s + 1) / 2, d1, .4);
    }
    // nozzle
    const noz = [...P.quad(-72, 182, -92, 230, -118, 256), ...P.line(-118, 256, 118, 256), ...P.quad(118, 256, 92, 230, 72, 182)];
    shade(noz, .04); mk(noz, 6.5, col, 3920, d0); mk(objects_ell(0, 256, 118, 12), 4, col, 3921, d1, .6);
    // body with the curved nose cone
    const body = [...P.quad(-126, -190, -96, -334, 0, -394), ...P.quad(0, -394, 96, -334, 126, -190), ...P.line(126, -190, 118, 184), ...P.line(118, 184, -118, 184), ...P.line(-118, 184, -126, -190)];
    shade(body, .06); mk(body, 7.5, col, 3922, d0);
    mk([...P.quad(-126, -190, 0, -160, 126, -190)], 5, col, 3923, d1);                    // nose ring
    mk([...P.quad(-124, -140, 0, -114, 124, -140)], 3, col, 3924, d1, .4);
    mk([...P.quad(-120, 60, 0, 88, 120, 60)], 5, col, 3925, d1);                          // lower band
    mk([...P.quad(-119, 110, 0, 136, 119, 110)], 3, col, 3926, d1, .4);
    mk(P.line(-66, -120, -62, 50), 3, col, 3927, d1, .35);                                 // panel seam
    mk(P.circle(0, -404, 8), 4, col, 3928, d1, .9);                                        // nose tip
    for (let i = 0; i < 5; i++) { objects_dot(-102 + i * 51, -176, 3.5, col, .7 * d1); objects_dot(-98 + i * 49, 74, 3.5, col, .7 * d1) }
    // porthole: bezel, rivets, glass in led colour with a glint
    const win = P.circle(0, -60, 64); shade(win, .09); mk(win, 7, col, 3930, d1);
    for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + .5; objects_dot(Math.cos(a) * 74, -60 + Math.sin(a) * 74, 3.5, col, .8 * d1) }
    glow(glass, 12, () => { mk(P.circle(0, -60, 48), 5, glass, 3931, d2); });
    mk(P.arc(0, -60, 34, -Math.PI * .85, -Math.PI * .45), 4, col, 3932, d2, .7);
    mk(P.arc(0, -60, 34, -Math.PI * .40, -Math.PI * .33), 4, col, 3933, d2, .7);
    // centre fin in front of the nozzle
    const cf = [...P.line(0, 70, 30, 240), ...P.line(30, 240, -30, 240), ...P.line(-30, 240, 0, 70)]; shade(cf, .08); mk(cf, 6, col, 3934, d0);
    // flame: outer tongue in fire colour with glow, inner core white
    c.save(); c.globalAlpha *= d2;
    glow(fire, 28 * fl, () => {
      mk([...P.quad(-74, 258, -30, 330 + 60 * fl, 0, 250 + 140 * fl), ...P.quad(0, 250 + 140 * fl, 30, 330 + 60 * fl, 74, 258)], 8, fire, 3940, 1, .95);
      mk([...P.quad(-46, 258, -20, 300 + 40 * fl, 0, 262 + 76 * fl), ...P.quad(0, 262 + 76 * fl, 20, 300 + 40 * fl, 46, 258)], 5, col, 3941, 1, .9);
    });
    c.restore();
  };

  // bulb: a large incandescent bulb — pear glass with glints, neck, screw base with threads and the contact tip, inside the glass stem, support wires and a coiled filament; flash = filament glows in tint with pulsing rays; tint = light colour
  ART.bulb = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, lit = ACC[o.tint || 'yellow'] || ACC.yellow, { es, d0, d1, d2 } = objects_layers(o.es), p =.7 + .3 * Math.sin(t * 3.2);
    const GY = -110, GR = 215, a0 = Math.PI * .36;
    // the glass
    const rx = Math.cos(a0) * GR, ry = GY + Math.sin(a0) * GR;               // where the globe meets the neck
    const globe = [...P.arc(0, GY, GR, Math.PI - a0, a0 + TAU), ...P.quad(rx, ry, 88, 118, 68, 148), ...P.line(68, 148, -68, 148), ...P.quad(-68, 148, -88, 118, -rx, ry)];
    shade(globe, .05); mk([...globe, globe[0]], 7.5, col, 4000, d0);
    mk(P.arc(0, GY, GR - 34, -Math.PI * .84, -Math.PI * .60), 4.5, col, 4001, d1, .5);   // glints on the glass
    mk(P.arc(0, GY, GR - 34, -Math.PI * .56, -Math.PI * .50), 4.5, col, 4002, d1, .5);
    mk(P.arc(0, GY, GR - 22, Math.PI * .12, Math.PI * .30), 3, col, 4003, d1, .3);
    // neck collar, screw base with threads, contact tip
    const collar = objects_rr(-76, 148, 152, 22, 8); shade(collar, .1); mk(collar, 5.5, col, 4010, d0);
    const base = P.poly([[-66, 170], [66, 170], [56, 276], [-56, 276]]); shade(base, .08); mk([...base, base[0]], 6.5, col, 4011, d0);
    for (let i = 0; i < 4; i++) { const y = 190 + i * 22, w = 64 - i * 2.4; mk([...P.quad(-w, y - 6, 0, y + 8, w, y - 2)], 4, col, 4012 + i, d1, .85) }
    const tip = [...P.line(-30, 276, 30, 276), ...P.quad(30, 276, 30, 300, 0, 302), ...P.quad(0, 302, -30, 300, -30, 276)]; shade(tip, .12); mk(tip, 5, col, 4020, d0);
    mk(P.line(-40, 276, 40, 276), 3.5, col, 4021, d1, .6);
    // inside: glass stem, support wires and the coiled filament
    mk([...P.line(-16, 150, -16, 30), ...P.quad(-16, 30, 0, 4, 16, 30), ...P.line(16, 30, 16, 150)], 4, col, 4030, d1, .75);
    mk([...P.line(-10, 30, -78, -50), ...P.line(-78, -50, -78, -66)], 3.5, col, 4031, d1, .8);
    mk([...P.line(10, 30, 78, -50), ...P.line(78, -50, 78, -66)], 3.5, col, 4032, d1, .8);
    const fil = []; for (let i = 0; i <= 22; i++) { const x = -78 + i * 156 / 22, sag = 18 * Math.sin(Math.PI * i / 22); fil.push([x, -66 + sag + (i % 2 ? 14 : -14) * (i > 0 && i < 22 ? 1 : 0)]) }
    const k = o.flash ? ease((es - .3) / .35) : d1;
    if (o.flash) {
      glow(lit, 34 * p, () => { mk(fil, 5.5, lit, 4040, k); mk(fil, 2.5, WHITE, 4041, k, .6) });
      for (let i = 0; i < 9; i++) {
        const a = -Math.PI * 1.1 + i * Math.PI * 1.2 / 8, r0 = GR + 26 + 6 * p, r1 = GR + 70 + 18 * p;
        mk(P.line(Math.cos(a) * r0, GY + Math.sin(a) * r0, Math.cos(a) * r1, GY + Math.sin(a) * r1), 5, lit, 4050 + i, ease((es - .35 - i * .02) / .3), .85);
      }
    } else mk(fil, 4, col, 4040, k, .85);
  };

  // magnifying glass: thick ring with inner bevel and glass edge, two catch-lights and a sparkle, ferrule collar with bands, tapered ribbed handle with lanyard hole; sways slowly
  ART.magnifier = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, es = o.es ?? 99;
    const d0 = ease(es / .35), d1 = ease((es - .2) / .35), d2 = ease((es - .4) / .3);
    c.save(); c.translate(Math.sin(t * 1.1) * 10, Math.sin(t * .7) * 4); c.rotate(Math.sin(t * .8) * .012);
    const cx = -60, cy = -70, R = 210, ang = Math.PI / 4, ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
    const at = (dist, off) => [cx + ux * dist + nx * off, cy + uy * dist + ny * off];
    const tip = at(520, 0);
    const handle = [at(250, -28), at(520, -22), ...P.arc(tip[0], tip[1], 22, ang - Math.PI / 2, ang + Math.PI / 2), at(250, 28)];
    shade(handle, .07); mk([...handle, handle[0]], 6.5, col, 8000, d0);                         // the handle
    for (let i = 0; i < 6; i++) { const a = at(322 + i * 30, -21), b = at(322 + i * 30, 21); mk(P.line(a[0], a[1], b[0], b[1]), 3, col, 8001 + i, d1, .5) }   // grip ribs
    { const a = at(262, 16), b = at(500, 14); mk(P.line(a[0], a[1], b[0], b[1]), 3, col, 8007, d1, .35) }
    { const h = at(500, 0); mk(P.circle(h[0], h[1], 7), 3, col, 8008, d1, .8) }                   // lanyard hole
    const collar = [at(200, -38), at(264, -38), at(264, 38), at(200, 38)]; shade(collar, .09); mk([...collar, collar[0]], 5.5, col, 8009, d0);   // the ferrule
    for (const dd of [222, 242]) { const a = at(dd, -36), b = at(dd, 36); mk(P.line(a[0], a[1], b[0], b[1]), 3.5, col, 8010 + dd, d1, .6) }
    const lens = P.circle(cx, cy, R); shade(lens, .035); mk(lens, 8, col, 8020, d0);            // the ring
    mk(P.circle(cx, cy, R - 26), 4.5, col, 8021, d1);                                            // inner bevel
    mk(P.circle(cx, cy, R - 40), 3, col, 8022, d1, .35);                                         // the glass edge
    mk(P.arc(cx, cy, R - 70, Math.PI * 1.08, Math.PI * 1.38), 5, col, 8023, d2, .65);            // catch-lights
    mk(P.arc(cx, cy, R - 96, Math.PI * 1.12, Math.PI * 1.25), 4, col, 8024, d2, .4);
    mk(P.line(cx + 96 - 14, cy - 96, cx + 96 + 14, cy - 96), 3, col, 8025, d2, .7); mk(P.line(cx + 96, cy - 96 - 14, cx + 96, cy - 96 + 14), 3, col, 8026, d2, .7);   // sparkle
    security_hatch(-220, 60, 168, 9, col, 8030, d1);
    c.restore();
  };

  // ---- tools family: shared helpers (prefix tools_) -------------------------------
  // tint handling: a named accent wins, else the forced colour, else white
  function tools_col(o) { const a = ACC[o.tint || 'white']; return a && a !== WHITE ? a : (o.col || WHITE) }
  // the three draw-on layers of the brief: contour, details, colour (es undefined -> complete)
  function tools_layers(es) { const e = es === undefined ? 99 : es; return { es: e, d0: ease(e / .35), d1: ease((e - .2) / .35), d2: ease((e - .4) / .3) } }
  // elliptical arc path (P.arc is circular only); rot tilts the whole ellipse
  function tools_ell(cx, cy, rx, ry, a0 = 0, a1 = TAU, rot = 0) {
    const n = Math.max(8, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) / 10)), cs = Math.cos(rot), sn = Math.sin(rot);
    return Array.from({ length: n }, (_, i) => { const a = lerp(a0, a1, i / (n - 1)), x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * cs - y * sn, cy + x * sn + y * cs] });
  }
  // closed rounded rectangle, clockwise from the top-right corner
  function tools_rr(x, y, w, h, r) {
    const q = Math.PI / 2, rr = Math.min(r, w / 2, h / 2);
    return [...P.arc(x + w - rr, y + rr, rr, -q, 0), ...P.arc(x + w - rr, y + h - rr, rr, 0, q), ...P.arc(x + rr, y + h - rr, rr, q, 2 * q), ...P.arc(x + rr, y + rr, rr, 2 * q, 3 * q), [x + w - rr, y]];
  }
  // closed stadium (a chain link seen flat): half-length hl, half-width hw, clockwise
  function tools_stadium(cx, cy, hl, hw) {
    const q = Math.PI / 2, a = hl - hw;
    return [...P.arc(cx - a, cy, hw, q, 3 * q), ...P.line(cx - a, cy - hw, cx + a, cy - hw).slice(1), ...P.arc(cx + a, cy, hw, -q, q).slice(1), ...P.line(cx + a, cy + hw, cx - a, cy + hw).slice(1), [cx - a, cy + hw]];
  }
  // a ring polygon (outer minus inner, both built clockwise) that shade() fills as a band only
  function tools_ring(outer, inner) { const inn = inner.slice().reverse(); return [...outer, outer[0], inn[0], ...inn, inn[0], outer[0]] }
  // cubic bezier sampled into n points
  function tools_cubic(p0, p1, p2, p3, n = 16) { return Array.from({ length: n }, (_, i) => { const s = i / (n - 1), m = 1 - s; return [m * m * m * p0[0] + 3 * m * m * s * p1[0] + 3 * m * s * s * p2[0] + s * s * s * p3[0], m * m * m * p0[1] + 3 * m * m * s * p1[1] + 3 * m * s * s * p2[1] + s * s * s * p3[1]] }) }
  // small filled dot (a LED, a rivet) and a black knock-out (a hole)
  function tools_dot(x, y, r, col, a = 1) { if (a <= 0) return; const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore() }
  function tools_hole(pts, a = 1) { if (a <= 0 || pts.length < 3) return; const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = '#000000'; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts) c.lineTo(p[0], p[1]); c.closePath(); c.fill(); c.restore() }
  // small filled bar (a progress segment)
  function tools_bar(x, y, w, h, col, a = 1) { if (a <= 0) return; const c = A.ctx; c.save(); c.globalAlpha *= a; c.fillStyle = col; c.fillRect(x, y, w, h); c.restore() }
  // resample a polyline every `step` px
  function tools_resample(pts, step) {
    const out = [pts[0]]; let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0); if (L === 0) continue;
      let s = step - carry; while (s <= L) { out.push([lerp(x0, x1, s / L), lerp(y0, y1, s / L)]); s += step }
      carry = L - (s - step);
    }
    const last = pts[pts.length - 1], e = out[out.length - 1]; if (Math.hypot(last[0] - e[0], last[1] - e[1]) > step * .3) out.push(last);
    return out;
  }
  // dashed marker stroke, dash by dash (uses seed..seed+39)
  function tools_dash(pts, w, col, seed, draw = 1, a = 1, dash = 20, gap = 14) {
    const rs = tools_resample(pts, 5), per = Math.max(2, Math.round(dash / 5)), gp = Math.max(1, Math.round(gap / 5)), n = rs.length;
    for (let i = 0, k = 0; i < n - 1 && k < 40; i += per + gp, k++) {
      const seg = rs.slice(i, Math.min(n, i + per + 1)); if (seg.length < 2) break;
      const dd = clamp((draw * n - i) / seg.length); if (dd <= 0) break;
      mk(seg, w, col, seed + k, dd, a);
    }
  }
  // dashed ground shadow under an object (uses seed..seed+39)
  function tools_ground(x0, x1, y, seed, d, a = .4) { tools_dash(P.line(x0, y, x1, y), 3.5, PALE, seed, d, a, 24, 18) }
  // a tube around a centreline: left/right offsets by half the width wf(s), s = 0..1 along the line; tan = unit tangents
  function tools_tube(cl, wf) {
    const n = cl.length, left = [], right = [], tan = [];
    for (let i = 0; i < n; i++) {
      const p0 = cl[Math.max(0, i - 1)], p1 = cl[Math.min(n - 1, i + 1)]; let tx = p1[0] - p0[0], ty = p1[1] - p0[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const hw = wf(i / (n - 1)) / 2; tan.push([tx, ty]);
      left.push([cl[i][0] - ty * hw, cl[i][1] + tx * hw]); right.push([cl[i][0] + ty * hw, cl[i][1] - tx * hw]);
    }
    return { left, right, tan };
  }
  // a wobbling line (a fold, a crease, a line of handwriting): sine offsets across the segment, tapered at both ends
  function tools_wiggle(x0, y0, x1, y1, amp, waves, ph = 0) {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(6, Math.round(L / 9)), nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    return Array.from({ length: n }, (_, i) => { const s = i / (n - 1), w = Math.sin(s * waves * TAU + ph) * amp * Math.sqrt(Math.sin(s * Math.PI)); return [lerp(x0, x1, s) + nx * w, lerp(y0, y1, s) + ny * w] });
  }
  // wobble an existing polyline along its normals (a fold that follows a curve)
  function tools_wigglePath(pts, amp, waves, ph = 0) {
    const n = pts.length;
    return pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty) || 1, s = i / (n - 1), w = Math.sin(s * waves * TAU + ph) * amp * Math.sqrt(Math.sin(s * Math.PI)); return [p[0] - ty / L * w, p[1] + tx / L * w] });
  }
  // four-point sparkle (uses seed..seed+3)
  function tools_spark(x, y, r, col, seed, d, a = 1) {
    if (a <= 0) return;
    mk(P.line(x - r, y, x + r, y), 4, col, seed, d, a); mk(P.line(x, y - r, x, y + r), 4, col, seed + 1, d, a);
    const s = r * .45; mk(P.line(x - s, y - s, x + s, y + s), 2.5, col, seed + 2, d, a * .7); mk(P.line(x - s, y + s, x + s, y - s), 2.5, col, seed + 3, d, a * .7);
  }
  // the big "no": a ring and its slash, drawn late (uses seed, seed+1)
  function tools_no(cx, cy, r, R, es, seed) { const g = ease((es - .3) / .3), k = r * .707; mk(P.circle(cx, cy, r), 16, R, seed, g, .95); mk(P.line(cx - k, cy + k, cx + k, cy - k), 16, R, seed + 1, g, .95) }
  // hatching: n short parallel strokes from (x0,y0) stepping (sx,sy), each `len` long at angle `ang` (uses seed..seed+n)
  function tools_hatch(x0, y0, sx, sy, n, len, ang, w, col, seed, d, a = .35) {
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    for (let i = 0; i < n; i++) mk(P.line(x0 + sx * i, y0 + sy * i, x0 + sx * i + dx, y0 + sy * i + dy), w, col, seed + i, d, a);
  }
  // a drum (a cylinder seen from slightly above): front face, then the top ellipse (uses seed..seed+3)
  function tools_drum(cx, yTop, rx, ry, h, col, seed, d, a = .07) {
    const front = [...tools_ell(cx, yTop, rx, ry, 0, Math.PI), ...tools_ell(cx, yTop + h, rx, ry, Math.PI, 0)];
    shade(front, a * .6); mk(tools_ell(cx, yTop + h, rx, ry, 0, Math.PI), 6, col, seed, d); mk(P.line(cx - rx, yTop, cx - rx, yTop + h), 6, col, seed + 1, d); mk(P.line(cx + rx, yTop, cx + rx, yTop + h), 6, col, seed + 2, d);
    const top = tools_ell(cx, yTop, rx, ry); shade(top, a * 1.6); mk(top, 6, col, seed + 3, d);
  }
  // a flat square coil: `turns` turns of a rounded-square spiral shrinking by dr per turn
  function tools_spiral(cx, cy, r0, dr, turns) {
    const n = Math.round(turns * 48), out = [];
    for (let i = 0; i <= n; i++) { const a = i / 48 * TAU, r = r0 - dr * i / 48, cs = Math.cos(a), sn = Math.sin(a), k = Math.pow(cs ** 4 + sn ** 4, -.25); out.push([cx + cs * k * r, cy + sn * k * r]) }
    return out;
  }
  // spur gear outline: N trapezoid teeth between root radius RR and tip radius RT, closed, tooth 0 centred on +x
  function tools_gearPath(RT, RR, N) {
    const p = TAU / N, out = [];
    for (let k = 0; k < N; k++) {
      const a = k * p;
      out.push(...P.line(Math.cos(a - .26 * p) * RR, Math.sin(a - .26 * p) * RR, Math.cos(a - .16 * p) * RT, Math.sin(a - .16 * p) * RT));
      out.push(...P.arc(0, 0, RT, a - .16 * p, a + .16 * p).slice(1));
      out.push(...P.line(Math.cos(a + .16 * p) * RT, Math.sin(a + .16 * p) * RT, Math.cos(a + .26 * p) * RR, Math.sin(a + .26 * p) * RR).slice(1));
      out.push(...P.arc(0, 0, RR, a + .26 * p, a + .74 * p).slice(1));
    }
    out.push(out[0]); return out;
  }
  // one gear at (cx,cy) turned by th: plate with its far edge peeking out lower right, rim ring, five windows (win) or four round holes, hub, bore with keyway (uses seed..seed+20)
  function tools_gear(cx, cy, RT, RR, N, th, hub, bore, win, col, seed, d0, d1) {
    const c = A.ctx; c.save(); c.translate(cx, cy); c.rotate(th);
    const out = tools_gearPath(RT, RR, N), ox = 12 * Math.cos(th) + 16 * Math.sin(th), oy = -12 * Math.sin(th) + 16 * Math.cos(th);
    mk(out.map(([x, y]) => [x + ox, y + oy]), 5, col, seed, d0, .55);
    shade(out, .05); mk(out, 6.5, col, seed + 1, d0);
    const rim = RR - 34; mk(P.circle(0, 0, rim), 4, col, seed + 2, d1, .8);
    if (win) {
      const r0 = hub + 24, r1 = rim - 24, W = 5, q = TAU / W;
      for (let k = 0; k < W; k++) {
        const a = k * q + q / 2, h1 = q * .34, h0 = q * .26;
        const w = [...P.arc(0, 0, r1, a - h1, a + h1), ...P.arc(0, 0, r0, a + h0, a - h0)]; w.push(w[0]);
        shade(w, 0); mk(w, 4, col, seed + 5 + k, d1, .9);
      }
    } else for (let k = 0; k < 4; k++) { const a = k * TAU / 4 + TAU / 8, r = (hub + rim) / 2, h = P.circle(Math.cos(a) * r, Math.sin(a) * r, (rim - hub) * .3); tools_hole(h); mk(h, 3.5, col, seed + 5 + k, d1, .9) }
    shade(P.circle(0, 0, hub), .1); mk(P.circle(0, 0, hub), 5.5, col, seed + 12, d1);
    const kw = .34, ky = bore + 11, xl = -Math.sin(kw) * bore, xr = Math.sin(kw) * bore;
    const arc = P.arc(0, 0, bore, -Math.PI / 2 + kw, 3 * Math.PI / 2 - kw), b = [...arc, [xl, -ky], [xr, -ky], arc[0]];
    tools_hole(b); mk(b, 4.5, col, seed + 13, d1);
    c.restore();
  }
  // gear: a 16-tooth spur gear (trapezoid teeth, plate thickness, rim ring, five cut-out windows, hub with bore and keyway) driving an 8-tooth pinion at lower right; both turn with t at the right ratio so the teeth stay meshed; tint colours every stroke
  ART.gear = (t, u, o = {}) => {
    const col = tools_col(o), { es, d0, d1 } = tools_layers(o.es);
    const N1 = 16, N2 = 8, RT1 = 270, RR1 = 232, RT2 = 138, RR2 = 104, PH = .52, D = 376;
    const x1 = -80, y1 = 0, x2 = x1 + Math.cos(PH) * D, y2 = y1 + Math.sin(PH) * D;
    const th = t * .4, th2 = -(N1 / N2) * th + PH * (1 + N1 / N2) + Math.PI + Math.PI / N2;
    tools_gear(x1, y1, RT1, RR1, N1, th, 78, 34, true, col, 8100, d0, d1);
    tools_gear(x2, y2, RT2, RR2, N2, th2, 44, 16, false, col, 8200, ease((es - .15) / .35), ease((es - .3) / .3));
  };

  // chain: interlocked links seen from the side (flat oval links alternating with links turned edge-on; the front bar of each edge-on link is drawn over its neighbours, the back bar hides behind them), hanging with a slight sag; count = links (2..6), no = one flat link snapped open in red with sparks and the tail dropping, tint colours the chain
  ART.chain = (t, u, o = {}) => {
    const c = A.ctx, col = tools_col(o), { es, d1 } = tools_layers(o.es), R = ACC.red;
    const n = Math.max(2, Math.min(6, o.count || 4)), STEP = 150, HL = 115, EO = 37, EI = 7, br = o.no ? (n === 3 ? 2 : (n - 2) % 2 === 0 ? n - 2 : n - 3) : -1;   // edge-on links: outer/inner half-width (wire 30, like the flat links); the snapped link is the last flat one for 3, else the flat one before the tail
    const total = (n - 1) * STEP + 2 * HL + (o.no ? 30 : 0), s = Math.min(1.3, 850 / total), SAG = .00036, q = Math.PI / 2;
    c.save(); c.scale(s, s); c.rotate(Math.sin(t * .8) * .012);
    const pose = i => { let x = (i - (n - 1) / 2) * STEP, y = SAG * x * x, a = Math.atan(2 * SAG * x); if (br >= 0 && (i > br || (i === br && br === n - 1))) { x += 30; y += 22; a += .09 + Math.sin(t * 1.7) * .02 } return { x, y, a } };   // the tail past the snap sags; a snapped last link sags itself
    const flat = i => i % 2 === 0, link = (i, fn) => { const p = pose(i); c.save(); c.translate(p.x, p.y); c.rotate(p.a); fn(ease((es - i * .06) / .32)); c.restore() };
    for (let i = 0; i < n; i++) if (!flat(i)) link(i, g => {                       // edge-on links sit behind
      const outer = tools_stadium(0, 0, HL, EO), inner = tools_stadium(0, 0, HL - 30, EI);
      shade(tools_ring(outer, inner), .06); mk(outer, 6, col, 8300 + i, g); mk(inner, 3.5, col, 8310 + i, g, .8);
    });
    for (let i = 0; i < n; i++) if (flat(i)) link(i, g => {                        // flat links over them
      const K = i === br ? R : col, a = HL - 55, b = HL - 30;
      if (i !== br) {
        const outer = tools_stadium(0, 0, HL, 55), inner = tools_stadium(0, 0, b, 25);
        shade(tools_ring(outer, inner), .07); mk(outer, 6.5, K, 8320 + i, g); mk(inner, 4.5, K, 8330 + i, g);
        mk(P.arc(-a, 0, 40, Math.PI * 1.12, Math.PI * 1.42), 3, K, 8340 + i, d1, .5);   // catch-light on the left cap
      } else {                                                                     // the snapped link: a C torn open at the top
        const G = 34;
        const outer = [...P.line(-G, -55, -a, -55), ...P.arc(-a, 0, 55, 3 * q, q).slice(1), ...P.line(-a, 55, a, 55).slice(1), ...P.arc(a, 0, 55, q, -q).slice(1), ...P.line(a, -55, G, -55).slice(1)];
        const inner = [...P.line(G - 4, -25, b, -25), ...P.arc(b, 0, 25, -q, q).slice(1), ...P.line(b, 25, -b, 25).slice(1), ...P.arc(-b, 0, 25, q, 3 * q).slice(1), ...P.line(-b, -25, -G + 4, -25).slice(1)];
        const jagL = [[-G, -55], [-G + 10, -45], [-G + 2, -35], [-G + 4, -25]], jagR = [[G, -55], [G - 8, -47], [G - 2, -36], [G - 4, -25]];
        shade([...outer, ...jagR.slice(1), ...inner.slice(1), ...jagL.slice(1).reverse()], .07);
        mk(outer, 6.5, K, 8320 + i, g); mk(inner, 4.5, K, 8330 + i, g); mk(jagL, 5, K, 8340 + i, g); mk(jagR, 5, K, 8350 + i, g);
        const g2 = ease((es - .4) / .3);                                           // the snap: sparks flying out of the gap
        mk(P.line(-8, -72, -24, -104), 4, R, 8360, g2, .9); mk(P.line(4, -70, 4, -110), 4, R, 8361, g2, .9); mk(P.line(16, -72, 34, -100), 4, R, 8362, g2, .9);
      }
    });
    for (let i = 0; i < n; i++) if (!flat(i)) link(i, g => {                       // the upper bar of each edge-on link passes in front
      const a = HL - EO, b = HL - EI;
      const top = [...P.arc(-a, 0, EO, Math.PI, 3 * q), ...P.line(-a, -EO, a, -EO).slice(1), ...P.arc(a, 0, EO, -q, 0).slice(1)];
      const tin = [...P.arc(b, 0, EI, 0, -q), ...P.line(b, -EI, -b, -EI).slice(1), ...P.arc(-b, 0, EI, 3 * q, Math.PI).slice(1)];
      shade([...top, ...tin], .06); mk(top, 6, col, 8370 + i, g); mk(tin, 3.5, col, 8380 + i, g, .8);
    });
    c.restore();
  };

  // tree: big deciduous tree — flared trunk with bark lines and a knot, three main branches forking into twigs, a canopy of five scalloped lobes with leaf-cluster texture and a hatched shadow side, grass tufts, dashed ground shadow; the canopy sways and a few leaves drift down
  ART.tree = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, { es, d0, d1, d2 } = places_layers(o.es);
    let sd = 12900;
    places_ground(-250, 250, 352, sd, d1, .35); sd += 40;
    for (let k = 0; k < 7; k++) { const gx = -230 + k * 76 + jit(k, 14), gy = 336 + jit(k + 9, 6); mk([[gx - 12, gy], [gx - 5, gy - 16], [gx, gy - 2], [gx + 6, gy - 20], [gx + 12, gy]], 2.6, col, sd++, d1, .7) }
    // trunk with root flare, bark, knot
    const trunk = [[-52, 330], ...P.quad(-52, 330, -36, 240, -28, 120), ...P.line(-28, 120, 28, 120), ...P.quad(28, 120, 38, 240, 56, 330), [56, 330]];
    shade(trunk, .07); mk(trunk, 6.5, col, sd++, d0);
    mk(P.quad(-52, 330, -80, 320, -118, 334), 5.5, col, sd++, d0); mk(P.quad(-44, 300, -70, 316, -82, 336), 4, col, sd++, d1, .8); mk(P.quad(56, 330, 84, 318, 122, 334), 5.5, col, sd++, d0); mk(P.quad(50, 302, 72, 318, 88, 336), 4, col, sd++, d1, .8);
    mk(P.line(-118, 334, 122, 334), 4.5, col, sd++, d0, .7);
    for (let k = 0; k < 5; k++) { const bx = -26 + k * 13; mk(P.quad(bx + 6, 320 - k * 4, bx + jit(k, 9), 220, bx + 4 + jit(k + 3, 6), 140 + k * 5), 2.6, col, sd++, d1, .38) }
    mk(places_ell(-6, 214, 9, 14, 0, TAU, .3), 2.8, col, sd++, d1, .7); mk(places_ell(-6, 214, 4, 7, 0, TAU, .3), 2.2, col, sd++, d1, .5);
    // canopy and branches sway together about the trunk top
    const sw = Math.sin(t * .8) * .014; c.save(); c.translate(0, 120); c.rotate(sw); c.translate(0, -120);
    const br = (x0, y0, x1, y1, w0, w1, seed) => { const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, bend = 26;
      const a = P.quad(x0 + nx * w0, y0 + ny * w0, (x0 + x1) / 2 + nx * (w0 + w1) / 2 + nx * bend, (y0 + y1) / 2 + ny * (w0 + w1) / 2 + ny * bend, x1 + nx * w1, y1 + ny * w1);
      const b = P.quad(x0 - nx * w0, y0 - ny * w0, (x0 + x1) / 2 - nx * (w0 + w1) / 2 + nx * bend, (y0 + y1) / 2 - ny * (w0 + w1) / 2 + ny * bend, x1 - nx * w1, y1 - ny * w1);
      shade([...a, ...b.slice().reverse()], .07); mk(a, 5, col, seed, d0); mk(b, 5, col, seed + 1, d0) };
    br(-20, 124, -150, -30, 20, 8, sd); sd += 2; br(4, 118, 30, -100, 18, 7, sd); sd += 2; br(22, 126, 150, -20, 18, 8, sd); sd += 2;
    for (const [x0, y0, x1, y1] of [[-100, 30, -190, -60], [-150, -30, -160, -120], [30, -100, -30, -170], [30, -100, 80, -170], [110, 20, 210, -40], [150, -20, 190, -120]]) mk(P.quad(x0, y0, (x0 + x1) / 2 + 14, (y0 + y1) / 2 - 10, x1, y1), 4, col, sd++, d1, .85);
    const lobes = [[0, -196, 250, 168, 11, .09], [-190, -60, 152, 118, 9, .1], [186, -70, 150, 114, 9, .1], [-132, -18, 118, 58, 7, .11], [120, -10, 124, 56, 7, .11]];
    lobes.forEach(([lx, ly, rx, ry, k, amp], i) => { const d = ease((es - .08 - i * .05) / .3), pts = places_scallop(lx, ly, rx, ry, k, amp, i * 1.3); shade(pts, .055); mk(pts, 6.5, col, sd++, d);
      for (let q = 0; q < 6; q++) { const a = n1(sd + q) * TAU, r = .25 + .5 * n1(sd + q + 7), px = lx + Math.cos(a) * rx * r, py = ly + Math.sin(a) * ry * r, ang = n1(sd + q + 3) * TAU;
        const cl = []; for (let j = 0; j <= 12; j++) { const b = ang + j / 12 * Math.PI * .9, rr = 16 + 6 * Math.abs(Math.sin(j * 1.05)); cl.push([px + Math.cos(b) * rr, py + Math.sin(b) * rr * .8]) } mk(cl, 2.6, col, sd + 10 + q, d, .45) }
      sd += 20;
      if (i >= 3) { places_hatch(pts, 15, -.75, 2.2, col, sd, ease((es - .3) / .3), .22, 30, ly + 8); sd += 30 } });
    places_hatch(places_scallop(-190, -60, 152, 118, 9, .1, 1.3), 15, -.75, 2.2, col, sd, ease((es - .3) / .3), .2, 30, -10); sd += 30;
    c.restore();
    // drifting leaves
    for (let k = 0; k < 3; k++) { const ph = (t * .32 + k * .37) % 1, lx = 120 + k * 60 - ph * 140 + Math.sin(t * 1.4 + k * 2) * 26, ly = 60 + ph * 270, ra = t * 1.6 + k, a = Math.sin(ph * Math.PI);
      const lf = places_ell(lx, ly, 12, 6, 0, TAU, ra); mk(lf, 2.6, col, sd++, d2, .75 * a); mk(P.line(lx - Math.cos(ra) * 10, ly - Math.sin(ra) * 10, lx + Math.cos(ra) * 10, ly + Math.sin(ra) * 10), 2, col, sd++, d2, .5 * a) }
  };

  // a communications satellite: boxed bus with lit top and side faces, blanket seams, a hatch and a sensor eye, two boomed solar wings gridded with cells on hinge joints, a whip antenna, a strut with a flange down to a dish with feed-horn tripod talking downward; `beam`/`tint` colour the downlink waves
  ART.satellite = (t, u, o = {}) => {
    const c = A.ctx, col = o.col || WHITE, wv = ACC[o.beam || o.tint || 'blue'];
    const d1 = ease(o.es / .35), d2 = ease((o.es - .2) / .35), d3 = ease((o.es - .45) / .3);
    c.save(); c.translate(0, Math.sin(t * .6) * 3);
    for (const s of [-1, 1]) { const B = s < 0 ? 6400 : 6430;
      const x0 = s < 0 ? -76 : 116;                                                                                // where the boom leaves the bus
      mk(P.line(x0, -6, s * 130, -6), 5, col, B, d1); mk(P.line(x0, 6, s * 130, 6), 5, col, B + 1, d1);            // the boom, two rails
      mk(P.circle(s * 140, 0, 11), 4, col, B + 2, d2);                                                              // hinge joint
      const pnl = [[s * 150, -86], [s * 372, -70], [s * 372, 70], [s * 150, 86]]; shade(pnl, .05); mk(data_closed(pnl), 6.5, col, B + 3, d1);   // solar wing
      for (let i = 1; i < 5; i++) { const f = i / 5, x = lerp(s * 150, s * 372, f);
        mk(P.line(x, lerp(-86, -70, f), x, lerp(86, 70, f)), 3, col, B + 4 + i, ease((o.es - .2 - i * .03) / .3), .8) }   // cell columns
      for (let j = 1; j < 3; j++) { const f = j / 3; mk(P.line(s * 150, lerp(-86, 86, f), s * 372, lerp(-70, 70, f)), 3, col, B + 10 + j, d2, .8) } }   // cell rows
    mk(P.line(0, 84, 0, 140), 6, col, 6470, d1); mk(P.line(-16, 96, 16, 96), 4, col, 6477, d2, .8);                // dish strut with its mounting flange, a visible neck under the bus
    const top = [[-76, -84], [-40, -120], [116, -120], [80, -84]], side = [[80, -84], [116, -120], [116, 48], [80, 84]];
    shade(side, .03); mk(data_closed(side), 6, col, 6460, d1); shade(top, .12); mk(data_closed(top), 6, col, 6461, d1);
    const face = P.rect(-76, -84, 156, 168); shade(face, .07); mk(face, 7, col, 6462, d1);                             // the bus
    mk(P.line(-76, -22, 80, -22), 3, col, 6463, d2, .5); mk(P.line(-76, 22, 80, 22), 3, col, 6464, d2, .5);            // blanket seams
    mk(P.rect(-54, -68, 56, 30), 3.5, col, 6465, d2, .8); mk(P.circle(38, 52, 16), 4, col, 6466, d2); mk(P.circle(38, 52, 6), 3, col, 6467, d2, .7);   // hatch, sensor eye
    mk(P.line(-30, -120, -30, -198), 4.5, col, 6468, d2); mk(P.circle(-30, -206, 8), 3.5, col, 6469, d2);              // whip antenna
    const dome = P.quad(-104, 196, 0, 40, 104, 196); shade(dome, .06); mk(dome, 6.5, col, 6471, d1);                   // the dish's back (apex y 118)
    const rim = data_ellipse(0, 196, 104, 28); shade(rim, .09); mk(rim, 5.5, col, 6472, d2);                          // its rim
    mk(P.line(-74, 216, 0, 262), 3.5, col, 6473, d2, .8); mk(P.line(74, 216, 0, 262), 3.5, col, 6474, d2, .8); mk(P.line(0, 224, 0, 262), 3.5, col, 6475, d2, .8);   // feed tripod
    mk(P.rect(-16, 258, 32, 22), 4, col, 6476, d2);                                                                    // the feed horn
    for (let i = 0; i < 3; i++) { const k = (t * .8 + i / 3) % 1;                                                      // downlink
      mk(P.arc(0, 240, 50 + k * 110, Math.PI * .22, Math.PI * .78), 5.5, wv, 6480 + i, 1, (1 - k) * .85 * d3) }
    c.restore();
  };

  // ---- camera --------------------------------------------------------------------
  // One grammar for the whole film: a dolly push-in that accelerates and peaks at the cut.
  function camera(s, u, dur) {
    const ctx = A.ctx, sh = s.shot || {}, [z0, z1] = sh.zoom || [1, 1.22], st = stage();
    const k = clamp(u / Math.max(dur, .1)) ** 1.55;                       // accelerating, never static
    const z = lerp(z0, z1, k), fx = (sh.focus || [st.x, st.y])[0], fy = (sh.focus || [st.x, st.y])[1];
    ctx.translate(fx, fy); ctx.scale(z, z); ctx.translate(-fx, -fy);
  }

  // ---- style hooks ---------------------------------------------------------------
  S.background = function () { const ctx = A.ctx; ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, A.W, A.H) };
  S.chrome = function () {};
  S.progress = function () {};

  const lex = w => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  // "at": a fraction of the shot, or the words it must land on. The words are matched on the same
  // folded character stream the contract validates against, so "It isn" finds "It isn't." and a
  // cue that matches nothing is reported instead of silently starting the drawing at zero.
  function cue(s, v, dur, dflt, tag) {
    if (typeof v === 'number') return v * dur;
    if (typeof v !== 'string') return dflt;
    const q = lex(v); if (!q || !s.words || !s.words.length) return dflt;
    const w = s.words.map(x => ({ k: lex(x.text), at: x.start - s.start }));
    for (let j = 0; j < w.length; j++) {
      let acc = '';
      for (let m = j; m < w.length && acc.length < q.length; m++) acc += w[m].k;
      if (acc.startsWith(q)) return Math.max(0, w[j].at - .1);
    }
    A.issues.push({ time: A.frameTime, error: 'Art cue matches no spoken words', text: `${tag || ''} "${v}"` });
    return dflt;
  }
  // motions an element can play across its moment, so a drawing acts instead of merely appearing
  function motion(kind, k, t) {
    const ctx = A.ctx, e = ease(k);
    if (kind === 'turn') { const w = .56 + .44 * e; ctx.transform(w, 0, 0, 1, 0, 0); ctx.rotate((1 - e) * -.1) }
    else if (kind === 'slide') ctx.translate(lerp(-180, 0, e), 0);
    else if (kind === 'rise') ctx.translate(0, lerp(150, 0, e));
    else if (kind === 'tap') ctx.translate(lerp(-90, 0, ease(Math.min(1, k * 2.4))) + Math.sin(t * 9) * 3 * (k > .4 ? 1 : 0), 0);
    else if (kind === 'shake') ctx.translate(Math.sin(t * 26) * 5 * (1 - e), Math.cos(t * 21) * 4 * (1 - e));
    else if (kind === 'walk') ctx.translate(lerp(-260, 0, e), Math.abs(Math.sin(k * 14)) * -9);
    else if (kind === 'pulse') { const z = 1 + .04 * Math.sin(t * 4.4); ctx.scale(z, z) }
    else if (kind === 'drift') ctx.translate(lerp(0, 60, e), lerp(0, -30, e));
  }
  function tableau(s, u, t, dur) {
    const ctx = A.ctx, a0 = ctx.globalAlpha;
    for (const e of (s.art || [])) {
      // "drawn" means on the page from the scene's first frame. A cue on a drawn element used to win over it and
      // the scene opened on nothing until the word arrived — measured as a 0.15 s black on a rented card.
      const at = e.drawn ? 0 : cue(s, e.at ?? 0, dur, 0, e.name + ' at'), out = e.until == null ? dur : cue(s, e.until, dur, dur, e.name + ' until');
      const gone = e.until == null ? dur : out + .26;                      // it overlaps its successor
      const eu = (u - at) / Math.max(out - at, .1);
      if (eu < 0 || u > gone) continue;                                   // frame zero already carries the drawing
      const fade = e.until != null ? 1 - ease((u - out) / .26) : 1;
      if (fade <= 0) continue;
      ctx.globalAlpha *= fade;
      // A drawing arrives over the previous one, and its opaque base would otherwise appear at full
      // strength before its own outline exists — a black hole for a third of a second. It comes up with
      // the stroke instead. Already-drawn elements are on the page at frame zero and skip it.
      if (!e.drawn) ctx.globalAlpha *= ease(clamp((u - at) / .2));
      const st = stage(); ctx.save(); ctx.translate(e.x ?? st.x, e.y ?? st.y); if (e.motion) motion(e.motion, clamp((u - at) / Math.max(e.motion_over || .7, .1)), t); const sc = e.size ?? 1; ctx.scale(sc, sc);
      const fn = ART[e.name]; if (fn) fn(t, clamp(eu), { ...e, es: e.drawn ? 99 : u - at, col: e.tint ? ACC[e.tint] : undefined });
      ctx.restore(); ctx.globalAlpha = a0;
    }
  }

  S.scene = function (s, u, t, i) {
    const ctx = A.ctx, dur = s.end - s.start;
    ctx.save(); camera(s, u, dur); dust(t); tableau(s, u, t, dur); ctx.restore();
    // whip: the outgoing frame smears horizontally and the brightness blooms through the cut
    if (s.enter === 'whip' && u < .12) {
      const k = 1 - u / .12, cv = ctx.canvas;
      if (!A.smearCv) A.smearCv = document.createElement('canvas');
      const sc = A.smearCv; if (sc.width !== cv.width) { sc.width = cv.width; sc.height = cv.height }
      const sx = sc.getContext('2d'); sx.setTransform(1, 0, 0, 1, 0, 0);
      sx.clearRect(0, 0, sc.width, sc.height); sx.drawImage(cv, 0, 0);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.filter = `blur(${7 * k}px)`;
      for (let j = 1; j <= 7; j++) { ctx.globalAlpha = .085 * k * (1 - j / 8); ctx.drawImage(sc, j * 20 * k, 0, A.W, A.H) }
      ctx.restore();
    }
    // flare: the accent floods the frame and the whites clip out, then the next scene hard-cuts in
    if (s.exit === 'flare' && u > dur - .34) {
      const k = ease((u - (dur - .34)) / .34), sh = s.shot || {}, st = stage();
      const fx = (sh.focus || [st.x, st.y])[0], fy = (sh.focus || [st.x, st.y])[1] - 55;
      ctx.save(); camera(s, u, dur);                                  // the bloom rides the same push-in
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = k;
      const r = lerp(90, 1150, k), g = ctx.createRadialGradient(fx, fy, 0, fx, fy, r);
      g.addColorStop(0, acc(s) + '9e'); g.addColorStop(.42, acc(s) + '4d'); g.addColorStop(1, acc(s) + '00');
      ctx.fillStyle = g; ctx.fillRect(0, 0, A.W, A.H); ctx.restore();
    }
  };

  // ---- captions: the only text in the film ---------------------------------------
  S.subtitle = function (s, t) {
    const group = (s.captions || []).find(c => t >= c.start && t < c.end); if (!group) return;
    const ctx = A.ctx, words = group.text.toUpperCase().split(' '), G = cap();
    ctx.font = `800 ${G.size}px Manrope`; ctx.textBaseline = 'alphabetic';
    const all = s.words || []; let base = all.findIndex(w => Math.abs(w.start - group.start) < .03);
    if (base < 0) base = all.findIndex(w => w.start >= group.start - .03); if (base < 0) base = 0;
    const at = i => (base + i < all.length ? all[base + i].start : group.end);
    let live = 0; for (let j = 0; j < words.length; j++) if (t >= at(j) - .02) live = j;
    const wid = words.map(w => ctx.measureText(w).width + G.track * (w.length - 1));
    let total = wid.reduce((a, b) => a + b, 0) + ctx.measureText(' ').width * (words.length - 1);
    let sc = 1; if (total > G.max) { sc = G.max / total; ctx.font = `800 ${G.size * sc}px Manrope`; total *= sc }
    if (words.length > 4) A.issues.push({ time: t, error: 'Caption block over four words', text: group.text });
    let x = A.W / 2 - total / 2; const sp = ctx.measureText(' ').width;
    words.forEach((w, j) => {
      ctx.fillStyle = j === live ? G.live : WHITE;                         // no outline, no shadow, no pop
      for (const ch of w) { ctx.fillText(ch, x, G.y); x += ctx.measureText(ch).width + G.track * sc }
      x += sp - G.track * sc;
    });
  };
  window.KEOU_SKETCH = { attach(api) { A = api }, ...S };
})();
