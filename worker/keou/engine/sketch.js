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
  // stick figure: circular head, two dot eyes, a single-curve mouth
  ART.figure = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .40);
    mk(P.circle(0, -210, 96), 6, col, 11, d);
    c.save(); c.fillStyle = col; c.globalAlpha *= d;
    c.beginPath(); c.arc(-34, -228, 8.5, 0, TAU); c.fill(); c.beginPath(); c.arc(34, -228, 8.5, 0, TAU); c.fill(); c.restore();
    mk(o.frown ? P.quad(-38, -160, 0, -186, 38, -160) : P.quad(-38, -172, 0, -146, 38, -172), 5.5, col, 12, d);
    mk(P.line(0, -114, 0, 96), 6, col, 13, d);
    mk(P.line(0, 96, -66, 236), 6, col, 14, d); mk(P.line(0, 96, 66, 236), 6, col, 15, d);
    // arms: the reaching one goes wherever the object is, the other hangs
    const [rx, ry] = o.reach || [150, -30];
    mk(P.quad(0, -66, rx * .55, -66 + ry * .3, rx, ry), 6, col, 16, d);
    mk(P.quad(0, -66, -58, 10, -74, 78), 6, col, 17, d);
  };
  // an open hand of four separate fingers plus a thumb, holding whatever sits at the origin
  // a closed hand seen from the back, gripping whatever sits to +x of the wrist
  ART.hand = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .34), s = o.flip ? -1 : 1;
    // Four fingers that reach the edge of the silhouette and a thumb below it. The earlier version drew
    // three short lines inside the outline, which at any real size read as a rock, not a hand.
    const sil = [...P.line(s * -96, -62, s * -96, 66),
                 ...P.quad(s * -96, -62, s * -10, -86, s * 76, -74),
                 ...P.quad(s * 76, -74, s * 138, -48, s * 146, 4),
                 ...P.quad(s * 146, 4, s * 136, 62, s * 82, 94),
                 ...P.quad(s * 82, 94, s * 6, 114, s * -96, 66)];
    shade(sil, .07); mk([...sil, sil[0]], 9, col, 21, d);
    for (let i = 0; i < 4; i++) { const y = -50 + i * 40;
      mk(P.line(s * (128 - i * 6), y, s * (16 - i * 6), y + 6), 6.5, col, 23 + i, d, .9) }
    mk(P.quad(s * -50, 74, s * 34, 128, s * 104, 88), 9, col, 27, d);
  };
  // the hotel key card, seen face-on; x-ray reveals the chip and its aerial
  ART.keycard = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .38), w = 300, h = 190;
    const body = P.rect(-w / 2, -h / 2, w, h);
    if (o.xray) { c.save(); c.globalAlpha *= .5; shade(body, .10); c.restore() } else shade(body, .05);
    mk(body, 6, col, 31, d);
    mk(P.rect(-w / 2 + 20, -h / 2 + 22, w - 108, 30), 4.5, col, 32, d);                  // the magnetic stripe
    mk(P.poly([[w / 2 - 40, h / 2 - 34], [w / 2 - 40, h / 2 - 62], [w / 2 - 16, h / 2 - 48]]), 4.5, col, 35, d);
    if (!o.xray) {                                                                        // the property's mark
      mk(P.arc(-w / 2 + 74, h / 2 - 48, 30, Math.PI, TAU), 4.5, col, 36, d);
      mk(P.line(-w / 2 + 40, h / 2 - 48, -w / 2 + 108, h / 2 - 48), 4.5, col, 37, d);
      mk(P.line(-w / 2 + 74, h / 2 - 78, -w / 2 + 74, h / 2 - 90), 4.5, col, 38, d);
      mk(P.line(-w / 2 + 140, h / 2 - 70, -w / 2 + 226, h / 2 - 70), 4, col, 39, d, .8);
      mk(P.line(-w / 2 + 140, h / 2 - 44, -w / 2 + 200, h / 2 - 44), 4, col, 40, d, .8) }
    if (o.xray) {                                                                          // dashed cut-line, then the chip
      const x = ease((o.es - .22) / .3); c.save(); c.setLineDash([13, 11]); c.strokeStyle = col; c.globalAlpha *= .85 * x; c.lineWidth = 3;
      c.strokeRect(-w / 2 + 34, -h / 2 + 30, w - 68, h - 60); c.setLineDash([]); c.restore();
      const g = ease((o.es - .42) / .45), pulse = .72 + .28 * Math.sin(t * 5.2), R = ACC.red;
      if (g > 0) {
        glow(R, 34 * pulse, () => { mk(P.rect(-46, -34, 92, 68), 5, R, 41, g, g * pulse); });
        for (let i = 0; i < 10; i++) { const a2 = i * TAU / 10 + .21, r0 = 52, r1 = 52 + (58 + n1(i) * 46) * g;
          mk(P.line(Math.cos(a2) * r0, Math.sin(a2) * r0 * .68, Math.cos(a2) * r1, Math.sin(a2) * r1 * .68), 3.4, R, 50 + i, 1, g * pulse) }
        c.save(); c.fillStyle = R;                                                          // sparks drifting up-right
        for (let i = 0; i < 12; i++) { const ph = (t * .7 + n1(i + 3)) % 1; c.globalAlpha = (1 - ph) * .8 * g;
          c.beginPath(); c.arc(jit(i, 130) + ph * 70, jit(i + 60, 90) - ph * 130, 2.6, 0, TAU); c.fill() } c.restore();
      }
    } else { mk(P.arc(w / 2 - 52, -h / 2 + 90, 16, -1.2, 1.2), 4.5, col, 33, d); mk(P.arc(w / 2 - 52, -h / 2 + 90, 28, -1.2, 1.2), 4.5, col, 34, d) }
  };
  // hotel door in three-quarter view with the reader plate and its LED
  ART.door = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42);
    // a door that swings while you watch, rather than two drawings cut together
    const open = clamp(o.open_to != null ? lerp(o.open || 0, o.open_to, ease(o.es / (o.swing_over || .7))) : (o.open || 0));
    const W2 = 210, H2 = 340, sw = W2 * (1 - open * .78);                                   // the leaf narrows as it swings
    mk(P.rect(-W2 - 28, -H2 - 28, (W2 + 28) * 2, (H2 + 28) * 2), 5, col, 60, d, .55);       // frame
    const leaf = [[-W2, -H2], [sw, -H2 - open * 34], [sw, H2 + open * 34], [-W2, H2]];
    if (open > .05) {                                                                    // the room beyond, and its edge
      const gap = [[sw, -H2 - open * 34], [W2, -H2 + 16], [W2, H2 - 16], [sw, H2 + open * 34]];
      shade(gap, .06); mk([...gap, gap[0]], 5, col, 68, d, .9);                          // the wedge, closed
      mk(P.line(sw, -H2 - open * 34, sw, H2 + open * 34), 6, col, 69, d, .95);             // the leaf's open edge
      mk(P.line(sw + 10, H2 + open * 26, W2 - 8, H2 - 20), 4, col, 70, d, .6) }            // light on the floor
    shade(leaf, .12); mk([...leaf, leaf[0]], 6.5, col, 61, d);
    mk(P.rect(-W2 + 34, -H2 + 46, (sw + W2) - 68, 150), 4, col, 62, d);                     // upper panel
    mk(P.rect(-W2 + 34, -H2 + 250, (sw + W2) - 68, 200), 4, col, 63, d);                    // lower panel
    const rx = sw - 62;
    mk(P.rect(rx - 26, -104, 52, 108), 5, col, 64, d);                                      // reader plate
    mk(P.line(rx - 14, -18, rx + 14, -18), 3.5, col, 66, d);                                // card slot
    mk(P.line(rx - 6, 62, rx - 6, 96), 5.5, col, 67, d);                                    // handle stem
    mk(P.quad(rx - 6, 96, rx + 30, 104, rx + 48, 88), 6.5, col, 65, d);                     // lever handle
    if (o.led) { const L = ACC[o.led] || ACC.green, p = .6 + .4 * Math.sin(t * 6);
      glow(L, 26 * p, () => { const c = A.ctx; c.save(); c.fillStyle = L; c.globalAlpha *= p * d; c.beginPath(); c.arc(rx, -78, 9, 0, TAU); c.fill(); c.restore() }) }
  };
  // macro on the reader: plate edge, slot and the LED that says everything is fine
  ART.reader = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .40);
    mk(P.line(-470, -560, -470, 470), 5, col, 70, d, .9);                                  // the door's edge behind it
    mk(P.line(-470, 30, -180, 30), 4, col, 74, d, .8);
    const plate = P.rect(-190, -330, 380, 560); shade(plate, .06); mk(plate, 7, col, 71, d);
    mk(P.rect(-150, -290, 300, 480), 3.5, col, 75, d, .95);                                // inner bevel
    mk(P.line(-120, -196, 120, -196), 5, col, 72, d);                                      // the card slot
    mk(P.line(-120, -176, 120, -176), 3, col, 76, d);
    mk(P.rect(-118, 120, 236, 30), 5, col, 73, d);                                         // the maker's strip
    const L = ACC[o.led || 'green'], g = ease((o.es - .25) / .35), p = .55 + .45 * Math.sin(t * 5.5);
    if (g > 0) { mk(P.circle(0, -30, 34), 4, col, 80, d, .8);
      glow(L, (o.flare ? 150 : 46) * p, () => { c.save(); c.fillStyle = L; c.globalAlpha *= g * p; c.beginPath(); c.arc(0, -30, 24 + (o.flare ? 46 * p : 0), 0, TAU); c.fill(); c.restore() }) }
  };
  // a phone held against the card, writing it; blue field arcs
  ART.phone = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .38);
    const body = P.rect(-130, -250, 260, 500); shade(body, .05); mk(body, 6, col, 81, d);
    mk(P.line(-34, -218, 34, -218), 4, col, 82, d);
    mk(P.rect(-96, -170, 192, 300), 3.5, col, 83, d);
    const B = ACC.blue, g = ease((o.es - .3) / .35);
    if (g > 0) for (let k = 0; k < 3; k++) { const ph = (t * .9 + k / 3) % 1;
      mk(P.arc(150, 0, 60 + ph * 150, -.95, .95), 5, B, 90 + k, 1, (1 - ph) * g) }
  };
  // a corridor of doors receding: the scale shot
  ART.corridor = (t, u, o = {}) => { const col = o.col || WHITE, n = 6;
    mk(P.line(-560, 360, 560, 150), 5.5, col, 101, ease(o.es / .3));
    mk(P.line(-560, -470, 560, -240), 5.5, col, 102, ease(o.es / .3));
    for (let j = 0; j < n; j++) { const i = n - 1 - j;                                   // back to front
      const d = ease((o.es - .08 - i * .07) / .28); if (d <= 0) continue;
      const k = i / (n - 1), x = lerp(-450, 380, k ** 1.25), s = lerp(1.25, .38, k ** .8);
      const w = 210 * s, h = 470 * s, y = lerp(50, -30, k);
      const face = P.rect(x - w / 2, y - h / 2, w, h); shade(face, .10); mk(face, 6.5 * s + 1.6, col, 110 + i, d);
      mk(P.line(x - w / 2 + 12 * s, y + h / 2 - 8, x + w / 2 - 12 * s, y + h / 2 - 8), 3 * s + 1, col, 140 + i, d, .9);
      const L = ACC[o.led || 'green'], p = .5 + .5 * Math.sin(t * 5 + i);
      glow(L, 22 * s * p, () => { const c = A.ctx; c.save(); c.fillStyle = L; c.globalAlpha *= d * p; c.beginPath(); c.arc(x + w / 2 - 16 * s, y, 8 * s + 3, 0, TAU); c.fill(); c.restore() });
    }
  };
  // a hand-drawn tag on a dashed leader, the way the reference prices the cable
  ART.tag = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.col || 'yellow'], d = ease(o.es / .28), txt = (o.text || '').toUpperCase();
    c.save(); c.font = `800 60px Manrope`; const w = c.measureText(txt).width + 62; c.restore();
    shade(P.rect(-w / 2, -46, w, 92), .05); mk(P.rect(-w / 2, -46, w, 92), 5, col, 121, d);
    c.save(); c.globalAlpha *= d; c.fillStyle = col; c.font = `800 60px Manrope`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, 0, 4); c.restore();
    if (o.leader) { const g = ease((o.es - .2) / .3); c.save(); c.setLineDash([12, 10]); c.strokeStyle = col; c.globalAlpha *= .8 * g; c.lineWidth = 3;
      c.beginPath(); c.moveTo(w / 2, 10); c.lineTo(w / 2 + 150 * g, 120 * g); c.stroke(); c.setLineDash([]); c.restore() }
  };
  ART.room = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .45);           // the room seen from its doorway
    mk(P.line(-520, -520, -300, -300), 4, col, 130, d, .8); mk(P.line(520, -520, 300, -300), 4, col, 135, d, .8);
    mk(P.line(-520, 560, -300, 340), 4, col, 136, d, .8); mk(P.line(520, 560, 300, 340), 4, col, 137, d, .8);
    mk(P.rect(-300, -300, 600, 640), 5, col, 138, d, 1);                                   // the far wall
    const bed = [[-250, 120], [180, 60], [300, 190], [-140, 280]];                         // bed in perspective
    shade(bed, .12); mk([...bed, bed[0]], 6, col, 131, d);
    mk(P.poly([[-250, 120], [-250, 44], [-96, 20], [-96, 96]]), 5, col, 132, d);           // headboard
    mk(P.poly([[-206, 96], [-96, 78], [-52, 128], [-162, 148]]), 4.5, col, 133, d);        // pillow
    mk(P.rect(150, -80, 120, 96), 4, col, 134, d);                                         // a framed print
    mk(P.line(-300, 340, 300, 340), 4, col, 139, d);
  };

  // --- objects the words ask for -------------------------------------------------
  ART.writer = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .4);   // the card writer
    const body = P.rect(-210, -140, 420, 280); shade(body, .05); mk(body, 6.5, col, 141, d);
    mk(P.rect(-170, -104, 180, 110), 4, col, 142, d);                                   // screen
    mk(P.line(-150, -70, -50, -70), 3.5, col, 143, d, .9); mk(P.line(-150, -40, -80, -40), 3.5, col, 144, d, .9);
    for (let k = 0; k < 3; k++) { const q = 36 + k * 26;                                 // an open coil, not a lens
      mk([...P.line(60 - q, -104 + q * .5, 60 - q, -104 - q * .5), ...P.line(60 - q, -104 - q * .5, 60 + q, -104 - q * .5),
          ...P.line(60 + q, -104 - q * .5, 60 + q, -104 + q * .5), ...P.line(60 + q, -104 + q * .5, 60 - q + 26, -104 + q * .5)], 5, col, 145 + k, d, .95) }
    mk(P.circle(-120, 74, 24), 5, col, 149, d);                                          // button
    const R = ACC[o.beam || 'red'], g = ease((o.es - .3) / .35);
    if (g > 0) for (let k = 0; k < 3; k++) { const ph = (t * 1.1 + k / 3) % 1;          // the field goes up, to the card
      mk(P.arc(60, -104, 92 + ph * 130, -Math.PI / 2 - 1, -Math.PI / 2 + 1), 5, R, 150 + k, 1, (1 - ph) * g) } };
  ART.blank = (t, u, o = {}) => { const col = o.col || WHITE, w = 320, h = 205, n = o.count || 2;
    for (let i = 0; i < n; i++) { const d = ease((o.es - i * .22) / .34); if (d <= 0) continue;
      const c = A.ctx; c.save(); c.translate((i - (n - 1) / 2) * 250, (i - (n - 1) / 2) * -78); c.rotate((i - (n - 1) / 2) * .16);
      const body = P.rect(-w / 2, -h / 2, w, h); shade(body, .06); mk(body, 6.5, col, 160 + i * 5, d);
      mk(P.line(-w / 2 + 24, -h / 2 + 36, w / 2 - 84, -h / 2 + 36), 4.5, col, 162 + i * 5, d);
      if (o.chip) { const R = ACC[o.chip], g = ease((o.es - .25 - i * .22) / .3);        // the forged chip inside
        glow(R, 20, () => { mk(P.rect(-52, -34, 104, 72), 5, R, 164 + i * 5, g, .95) });
        for (let k = 0; k < 6; k++) { const a2 = k * TAU / 6 + .3;
          mk(P.line(Math.cos(a2) * 60, Math.sin(a2) * 44, Math.cos(a2) * 104, Math.sin(a2) * 76), 3.4, R, 170 + i * 7 + k, g, .85) } }
      c.restore() } };
  ART.crowbar = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .38);   // nothing was forced
    const body = [[-372, 168], [-352, 200], [-286, 176],
      ...P.quad(-286, 176, -60, 72, 178, -52), ...P.quad(178, -52, 296, -108, 330, -26),
      ...P.quad(330, -26, 336, 40, 262, 66), [232, 96], [206, 40], [176, 66],
      ...P.quad(150, 22, 250, -6, 280, -30), ...P.quad(280, -30, 250, -74, 162, -88),
      ...P.quad(162, -88, -70, 36, -300, 140), [-368, 150]];
    shade(body, .08); mk([...body, body[0]], 7, col, 170, d);
    mk(P.line(-470, 244, 470, 208), 5, col, 176, d, .9);                                // the carpet it lies on
    if (o.no) { const g = ease((o.es - .3) / .3), R = ACC[o.no_col || 'white'];
      mk(P.circle(-40, 20, 400), 14, R, 178, g, .95); mk(P.line(-323, 303, 243, -263), 14, R, 179, g, .95) } };
  ART.bell = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .38);   // no alarm
    const left = [...P.quad(-206, 158, -198, 54, -150, 4), ...P.quad(-150, 4, -140, -132, 0, -196)];
    const right = left.map(([x, y]) => [-x, y]).reverse();
    const body = [...left, ...right];
    shade(body, .09); mk([...body, [-206, 158]], 8, col, 180, d);
    mk(P.arc(0, 158, 206, 0, Math.PI).map(([x, y]) => [x, 158 + (y - 158) * .3]), 8, col, 182, d);   // the rim, in perspective
    mk(P.line(0, -196, 0, -228), 7, col, 183, d); mk(P.circle(0, -252, 28), 7, col, 184, d);         // stem and knob
    c.save(); c.globalAlpha *= d; mk(P.line(0, 120, 0, 176), 6, col, 187, d); c.restore();           // the clapper, hanging still
    mk(P.circle(0, 196, 26), 7, col, 188, d);
    if (o.no) { const g = ease((o.es - .3) / .3), R = ACC[o.no_col || 'white'];
      mk(P.circle(0, -10, 320), 14, R, 185, g, .95); mk(P.line(-226, 216, 226, -236), 14, R, 186, g, .95) } };
  ART.hotels = (t, u, o = {}) => { const col = o.col || WHITE, n = 3;                     // thirteen thousand of them
    const H = [420, 560, 340], W = [190, 210, 170], X = [-300, 0, 290];
    for (let i = 0; i < n; i++) { const d = ease((o.es - i * .1) / .3); if (d <= 0) continue;
      const b = P.rect(X[i] - W[i] / 2, 200 - H[i], W[i], H[i]); shade(b, .10); mk(b, 6, col, 190 + i, d);
      for (let r = 0; r < Math.floor(H[i] / 90); r++) for (let q = 0; q < 3; q++)
        mk(P.rect(X[i] - W[i] / 2 + 22 + q * (W[i] - 60) / 3, 230 - H[i] + 40 + r * 90, 32, 40), 3, col, 200 + i * 9 + r * 3 + q, d, .9);
      if (i === 1) { mk(P.rect(X[i] - 74, 200 - H[i] - 62, 148, 46), 5, col, 230, d);
        const L = ACC[o.led || 'yellow'], pl = .6 + .4 * Math.sin(t * 4 + i);
        glow(L, 20 * pl, () => { const c = A.ctx; c.save(); c.fillStyle = L; c.globalAlpha *= d * pl; c.fillRect(X[i] - 58, 200 - H[i] - 50, 116, 22); c.restore() }) } }
    mk(P.line(-470, 200, 470, 200), 5, col, 231, ease(o.es / .3)) };
  ART.globe = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .42), R = 250;
    mk(P.circle(0, 0, R), 6.5, col, 240, d);
    for (const f of [.45, .82]) { mk(P.arc(0, 0, R, 0, Math.PI).map(([x, y]) => [x, y * f]), 4, col, 241 + f * 10, d, .9);
      mk(P.arc(0, 0, R, Math.PI, TAU).map(([x, y]) => [x, y * f]), 4, col, 243 + f * 10, d, .9) }
    for (let k = -1; k <= 1; k++) { const w = Math.abs(k) === 1 ? .42 : 1;
      mk(P.circle(0, 0, R).map(([x, y]) => [x * w + k * 0, y]), 4, col, 250 + k, d, .9) }
    const L = ACC[o.led || 'yellow'], g = ease((o.es - .3) / .4);
    for (let i = 0; i < 7; i++) { const a2 = i * 1.9 + t * .12, rr = R * (.2 + .62 * n1(i));
      const x = Math.cos(a2) * rr, y = Math.sin(a2 * .7) * rr * .72, pl = .5 + .5 * Math.sin(t * 5 + i);
      glow(L, 16 * pl, () => { c.save(); c.fillStyle = L; c.globalAlpha *= g * pl; c.beginPath(); c.arc(x, y, 9, 0, TAU); c.fill(); c.restore() }) } };
  // a close-up face: eyebrows and pupils, so an expression actually reads
  ART.face = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .42), m = o.mood || 'worried';
    mk(P.circle(0, 0, 300), 7, col, 260, d);
    for (const sx of [-1, 1]) { mk(P.circle(sx * 110, -30, 46), 5.5, col, 262 + sx, d);
      c.save(); c.fillStyle = col; c.globalAlpha *= d;
      const dx = m === 'scared' ? 0 : Math.sin(t * .9) * 12;
      c.beginPath(); c.arc(sx * 110 + dx, -30 + (m === 'scared' ? -6 : 0), m === 'scared' ? 12 : 17, 0, TAU); c.fill(); c.restore();
      const br = m === 'scared' ? [[sx * 62, -142], [sx * 158, -104]] : m === 'worried' ? [[sx * 64, -136], [sx * 156, -98]] : [[sx * 64, -116], [sx * 156, -116]];
      mk(P.line(br[0][0], br[0][1], br[1][0], br[1][1]), 7, col, 266 + sx, d) }
    if (m === 'scared') { mk(P.circle(0, 122, 52).map(([x, y]) => [x * .72, y]), 6, col, 270, d) }
    else if (m === 'worried') { mk(P.quad(-84, 132, 0, 100, 84, 132), 6.5, col, 271, d) }
    else mk(P.quad(-84, 108, 0, 146, 84, 108), 6.5, col, 272, d);
    if (o.sweat) { const g = ease((o.es - .35) / .3), dy = ease((o.es - .35) / 1.1) * 90;
      const c2 = A.ctx; c2.save(); c2.translate(228, -110 + dy);
      mk([...P.quad(0, -46, 30, 4, 0, 42), ...P.quad(0, 42, -30, 4, 0, -46)], 6, col, 273, g, .95); c2.restore() } };
  // the stranger: the same rig, drawn as a dashed outline so it reads as someone who was not seen
  ART.intruder = (t, u, o = {}) => { const c = A.ctx, col = o.col || PALE, d = ease(o.es / .42);
    c.save(); c.globalAlpha *= .8;
    ART.figure(t, u, { ...o, col, es: o.es, reach: o.reach || [150, -60], frown: true });
    c.restore();
    mk(P.quad(-168, -300, 0, -338, 168, -300), 7, col, 280, d);                           // hat brim
    mk(P.quad(-96, -300, 0, -392, 96, -300), 7, col, 281, d);                             // crown
    mk(P.quad(-74, -60, 0, -10, 74, -60), 6, col, 282, d);                                // coat collar
    mk(P.line(-74, -60, -96, 150), 6, col, 283, d); mk(P.line(74, -60, 96, 150), 6, col, 284, d) };

  // someone was here: a trail of prints from the door, and the case they went through
  ART.footprints = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || 'red'], n = o.count || 4;
    for (let i = 0; i < n; i++) { const d = ease((o.es - .1 - i * .16) / .3); if (d <= 0) continue;
      const k = n > 1 ? i / (n - 1) : 0, x = lerp(-200, 300, k), y = lerp(230, -60, k ** 1.2), sc = lerp(1, .8, k), sx = i % 2 ? 1 : -1;
      c.save(); c.translate(x + sx * 26 * sc, y); c.scale(sc, sc); c.rotate(-.5 + k * .35);
      mk([...P.quad(-10, 30, -26, 6, -22, -16), ...P.quad(-22, -16, -18, -44, 2, -44),
          ...P.quad(2, -44, 22, -40, 20, -8), ...P.quad(20, -8, 14, 20, -10, 30)], 7, col, 290 + i, d, .9);
      mk(P.circle(2, 52, 15), 7, col, 300 + i, d, .8); c.restore() } };
  ART.suitcase = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .45);
    const top = [[-190, 10], [150, -40], [250, 40], [-96, 96]];                            // the open mouth
    const front = [[-96, 96], [250, 40], [250, 130], [-96, 190]];                          // and the body under it
    const side = [[-190, 10], [-96, 96], [-96, 190], [-190, 100]];
    shade(front, .14); shade(side, .09); shade(top, .07);
    mk([...front, front[0]], 6.5, col, 311, d); mk([...side, side[0]], 6, col, 312, d); mk([...top, top[0]], 6, col, 310, d);
    const lid = [[-190, 10], [150, -40], [216, -190], [-138, -142]];                       // lid standing open behind
    shade(lid, .07); mk([...lid, lid[0]], 6, col, 313, d);
    for (let i = 0; i < 3; i++) mk(P.line(-150 + i * 30, 46 - i * 10, 170 + i * 10, -4 - i * 12), 4.5, col, 314 + i, d, .8);
    mk(P.circle(-152, -12, 11), 4.5, col, 318, d); mk(P.circle(178, -60, 11), 4.5, col, 319, d);
    mk(P.line(-40, 130, -40, 190), 5, col, 320, d, .9) };                                  // the latch

  // ---- art: the general alphabet -------------------------------------------------
  // The nineteen drawings above were the hotel film's own world. These are the words every other
  // explainer needs: a person, a machine, a place, a number, an idea. One drawing per spoken phrase
  // only works if the phrase has a drawing, so the vocabulary has to be wide enough to say things.

  // many small people: scale, "everyone", a market, a population
  ART.crowd = (t, u, o = {}) => { const col = o.col || WHITE, n = Math.min(12, o.count || 9);
    // "led" is the one person picked out of the crowd. "tint" colours the whole crowd, which is a
    // different sentence: everybody, versus one of them.
    const one = o.led ? ACC[o.led] : null, mid = Math.floor(n / 2);
    for (let i = 0; i < n; i++) { const r = Math.floor(i / 4), c2 = i % 4, x = (c2 - 1.5) * 138 + (r % 2 ? 38 : -38), y = r * 196 - 150;
      const cc = one && i === mid ? one : col, w = one && i === mid ? 6 : 5, d = ease((o.es - i * .05) / .3);
      mk(P.circle(x, y - 44, 28), w, cc, 300 + i, d);
      mk(P.line(x, y - 16, x, y + 48), w, cc, 340 + i, d);
      mk(P.line(x, y + 48, x - 22, y + 94), w, cc, 380 + i, d); mk(P.line(x, y + 48, x + 22, y + 94), w, cc, 420 + i, d);
      mk(P.line(x - 32, y + 8, x + 32, y + 8), w, cc, 460 + i, d) } };

  // two forearms clasped: a deal, a partnership, trust given
  ART.handshake = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .4);
    const grip = [...P.quad(-40, -46, 0, -60, 44, -40), ...P.quad(44, -40, 60, 0, 40, 44), ...P.quad(40, 44, 0, 60, -40, 46), ...P.quad(-40, 46, -58, 0, -40, -46)];
    shade(grip, .07);
    mk(P.line(-250, -74, -46, -40), 9, col, 500, d); mk(P.line(-250, 30, -44, 40), 9, col, 501, d);
    mk(P.line(250, -74, 46, -40), 9, col, 502, d); mk(P.line(250, 30, 44, 40), 9, col, 503, d);
    mk([...grip, grip[0]], 8, col, 504, d);
    for (let i = 0; i < 3; i++) mk(P.line(-30 + i * 24, -34, -36 + i * 24, 34), 5, col, 505 + i, d) };

  // an eye: being watched, surveillance, privacy; "no" strikes it out
  ART.eye = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .38);
    const lid = [...P.quad(-230, 0, 0, -150, 230, 0), ...P.quad(230, 0, 0, 150, -230, 0)];
    shade(lid, .05); mk([...lid, lid[0]], 7, col, 520, d);
    mk(P.circle(0, 0, 78), 6, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 521, d);
    c.save(); c.fillStyle = col; c.globalAlpha *= d; c.beginPath(); c.arc(0, 0, 34, 0, TAU); c.fill(); c.restore();
    mk(P.arc(-22, -22, 16, Math.PI, TAU), 4, col, 522, d, .7);
    if (o.no) mk(P.line(-210, 130, 210, -130), 9, ACC.red, 523, ease((o.es - .3) / .3)) };

  // a brain: thinking, learning, a model
  ART.brain = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .45);
    const sh = [...P.quad(-160, 40, -180, -110, -40, -140), ...P.quad(-40, -140, 60, -172, 150, -100), ...P.quad(150, -100, 200, -10, 130, 80), ...P.quad(130, 80, 0, 140, -160, 40)];
    shade(sh, .06); mk([...sh, sh[0]], 7, col, 540, d);
    mk(P.line(-10, -140, -6, 120), 5, col, 541, d, .8);
    for (let i = 0; i < 4; i++) { const s = i < 2 ? -1 : 1, k = i % 2;
      mk(P.quad(s * 26, -90 + k * 90, s * 110, -70 + k * 84, s * 44, -10 + k * 92), 4.5, col, 542 + i, d, .85) } };

  // a robot: automation, an agent, a machine that decides
  ART.robot = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .42), eye = ACC[o.led || o.tint || 'white'];
    mk(P.line(0, -230, 0, -186), 5, col, 560, d); mk(P.circle(0, -244, 15), 5, col, 561, d);
    const head = P.rect(-110, -186, 220, 160); shade(head, .06); mk(head, 7, col, 562, d);
    c.save(); c.fillStyle = eye; c.globalAlpha *= d * (.7 + .3 * Math.sin(t * 3.4));
    c.beginPath(); c.arc(-42, -112, 18, 0, TAU); c.fill(); c.beginPath(); c.arc(42, -112, 18, 0, TAU); c.fill(); c.restore();
    mk(P.line(-46, -60, 46, -60), 5, col, 563, d);
    const body = P.rect(-92, -12, 184, 168); shade(body, .05); mk(body, 7, col, 564, d);
    mk(P.line(-92, 40, -170, 90), 6, col, 565, d); mk(P.line(92, 40, 170, 90), 6, col, 566, d);
    mk(P.rect(-56, 30, 112, 60), 4.5, col, 567, d, .8) };

  // a laptop: the computer anything happens on
  ART.laptop = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .4);
    const scr = P.rect(-190, -180, 380, 250); shade(scr, .05); mk(scr, 7, col, 580, d);
    for (let i = 0; i < 4; i++) mk(P.line(-150, -140 + i * 46, -150 + (240 - i * 44), -140 + i * 46), 4.5, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 581 + i, d, .8);
    const base = P.poly([[-240, 92], [240, 92], [200, 130], [-200, 130]]); shade(base, .07); mk([...base, base[0]], 7, col, 585, d);
    mk(P.line(-60, 111, 60, 111), 5, col, 586, d) };

  // a rack of servers: where the data actually lives
  ART.server = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .44), led = ACC[o.led || 'green'];
    const body = P.rect(-140, -230, 280, 460); shade(body, .05); mk(body, 7, col, 600, d);
    for (let i = 0; i < 4; i++) { const y = -180 + i * 110; mk(P.rect(-112, y, 224, 74), 5, col, 601 + i, d);
      c.save(); c.fillStyle = led; c.globalAlpha *= d * (.45 + .55 * Math.abs(Math.sin(t * 2.2 + i))); c.beginPath(); c.arc(76, y + 37, 9, 0, TAU); c.fill(); c.restore();
      mk(P.line(-88, y + 37, 20, y + 37), 4, col, 610 + i, d, .7) } };

  // a router: the box the signal comes out of
  ART.router = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .38), wv = ACC[o.beam || o.tint || 'blue'];
    const body = P.rect(-160, 20, 320, 96); shade(body, .06); mk(body, 7, col, 620, d);
    mk(P.line(-100, -110, -80, 20), 6, col, 621, d); mk(P.line(100, -110, 80, 20), 6, col, 622, d);
    for (let i = 0; i < 3; i++) mk(P.line(-70 + i * 60, 68, -46 + i * 60, 68), 5, col, 623 + i, d, .8);
    if (o.beam || o.tint) for (let i = 0; i < 3; i++) { const k = (t * .8 + i / 3) % 1, r = 70 + k * 190;
      mk(P.arc(0, -6, r, Math.PI * 1.18, Math.PI * 1.82), 5, wv, 630 + i, 1, (1 - k) * .85) } };

  // a security camera on its mount: someone is recording
  ART.camera = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .4), sw = Math.sin(t * .7) * .12;
    mk(P.line(180, -190, 180, -110), 7, col, 640, d); mk(P.line(120, -190, 240, -190), 7, col, 641, d);
    c.save(); c.translate(180, -100); c.rotate(sw);
    const body = P.poly([[-200, -50], [70, -50], [70, 54], [-200, 54]]); shade(body, .06); mk([...body, body[0]], 7, col, 642, d);
    mk(P.circle(-200, 2, 46), 6, col, 643, d); mk(P.circle(-200, 2, 22), 5, ACC[o.led || 'red'], 644, d);
    mk(P.rect(10, -74, 40, 24), 4.5, col, 645, d);
    c.restore() };

  // a microchip: silicon, the thing itself
  ART.chip = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .4), R = 130;
    const body = P.rect(-R, -R, R * 2, R * 2); shade(body, .07); mk(body, 7, col, 660, d);
    mk(P.rect(-64, -64, 128, 128), 5, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 661, d);
    for (let i = 0; i < 4; i++) for (const s of [-1, 1]) { const p = -78 + i * 52;
      mk(P.line(p, s * R, p, s * (R + 46)), 5.5, col, 662 + i, d); mk(P.line(s * R, p, s * (R + 46), p), 5.5, col, 670 + i, d) } };

  // a USB stick on its cable: the thing you plug in without thinking
  ART.usb = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .38);
    const body = P.rect(-40, -40, 190, 80); shade(body, .07); mk(body, 7, col, 690, d);
    const tip = P.rect(-108, -26, 70, 52); shade(tip, .1); mk(tip, 6, col, 691, d);
    mk(P.line(-92, -10, -54, -10), 4, col, 692, d, .8); mk(P.line(-92, 10, -54, 10), 4, col, 693, d, .8);
    mk(P.quad(150, 0, 250, 40, 250, 160), 7, col, 694, d) };

  // a car, side on
  ART.car = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42);
    const body = [...P.line(-250, 60, -210, 60), ...P.quad(-210, 60, -190, -20, -110, -30), ...P.quad(-110, -30, -20, -96, 90, -84), ...P.quad(90, -84, 190, -70, 240, 10), ...P.line(240, 10, 250, 60), ...P.line(250, 60, -250, 60)];
    shade(body, .06); mk(body, 7.5, col, 700, d);
    mk(P.quad(-100, -30, -30, -80, 40, -78), 5, col, 701, d); mk(P.line(50, -80, 50, -30), 5, col, 702, d);
    mk(P.circle(-140, 66, 52), 7, col, 703, d); mk(P.circle(150, 66, 52), 7, col, 704, d);
    mk(P.circle(-140, 66, 20), 4.5, col, 705, d, .8); mk(P.circle(150, 66, 20), 4.5, col, 706, d, .8) };

  // a padlock; "open" swings the shackle up and out
  ART.lock = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .4), c = A.ctx;
    const op = clamp(o.open ?? (o.no ? 1 : 0));
    const body = P.rect(-110, -20, 220, 190); shade(body, .07); mk(body, 8, col, 720, d);
    c.save(); c.translate(0, -20); c.rotate(op * .5); c.translate(op * 26, -op * 18);
    mk(P.arc(0, 0, 72, Math.PI, TAU), 9, col, 721, d); mk(P.line(-72, 0, -72, 12), 9, col, 722, d); mk(P.line(72, 0, 72, 12), 9, col, 723, d);
    c.restore();
    mk(P.circle(0, 58, 24), 6, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 724, d);
    mk(P.line(0, 78, 0, 120), 7, col, 725, d) };

  // a key
  ART.key = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .36);
    mk(P.circle(-150, 0, 74), 8, col, 740, d); mk(P.circle(-150, 0, 30), 5, col, 741, d);
    mk(P.line(-76, 0, 210, 0), 9, col, 742, d);
    mk(P.line(150, 0, 150, 56), 8, col, 743, d); mk(P.line(196, 0, 196, 42), 8, col, 744, d) };

  // a shield: the defence; "no" cracks it, "flash" ticks it
  ART.shield = (t, u, o = {}) => { const col = ACC[o.tint || 'white'] === WHITE ? (o.col || WHITE) : ACC[o.tint], d = ease(o.es / .42);
    const sh = [...P.line(-150, -170, 150, -170), ...P.quad(150, -170, 150, 60, 0, 200), ...P.quad(0, 200, -150, 60, -150, -170)];
    shade(sh, .06); mk([...sh, sh[0]], 8, col, 760, d);
    if (o.flash) { const g = ease((o.es - .3) / .35); mk(P.poly([[-62, 0], [-14, 54], [76, -60]]), 11, ACC.green, 761, g) }
    if (o.no) { const g = ease((o.es - .3) / .35); mk(P.poly([[-10, -170], [34, -30], [-24, 10], [18, 200]]), 8, ACC.red, 762, g) } };

  // a bug: malware, the thing in the machine
  ART.bug = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || 'white'] === WHITE ? (o.col || WHITE) : ACC[o.tint], d = ease(o.es / .4), w = Math.sin(t * 6) * 8;
    const body = [...P.arc(0, 0, 96, 0, TAU)]; shade(body, .08); mk(body, 7, col, 780, d);
    mk(P.line(-96, -40, -96, -40), 6, col, 781, d);
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) { const y = -46 + i * 46;
      mk(P.quad(s * 88, y, s * 150, y - 18 + w, s * 176, y + 34), 5.5, col, 782 + i, d) }
    mk(P.circle(0, -104, 40), 6, col, 790, d);
    mk(P.quad(-24, -134, -46, -190, -70, -204), 5, col, 791, d); mk(P.quad(24, -134, 46, -190, 70, -204), 5, col, 792, d);
    mk(P.line(0, -96, 0, 96), 4.5, col, 793, d, .7) };

  // a fingerprint: identity, biometrics, the thing you cannot change
  ART.fingerprint = (t, u, o = {}) => { const col = ACC[o.tint || 'white'] === WHITE ? (o.col || WHITE) : ACC[o.tint], d = ease(o.es / .5);
    for (let i = 0; i < 6; i++) { const r = 34 + i * 30, g = ease((o.es - i * .06) / .3);
      mk(P.arc(0, 0, r, Math.PI * (.86 + i * .02), Math.PI * (2.2 - i * .03)), 5.5, col, 800 + i, g);
      if (i % 2) mk(P.arc(0, 0, r, Math.PI * .2, Math.PI * .62), 5, col, 810 + i, g, .8) } };

  // an envelope: mail, the message that arrives
  ART.envelope = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .38);
    const body = P.rect(-220, -140, 440, 280); shade(body, .06); mk(body, 7.5, col, 820, d);
    mk(P.poly([[-220, -140], [0, 30], [220, -140]]), 7, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 821, d);
    mk(P.line(-220, 140, -60, -6), 5, col, 822, d, .75); mk(P.line(220, 140, 60, -6), 5, col, 823, d, .75) };

  // a signal: radio, a beacon, something broadcasting whether you asked or not
  ART.signal = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || o.beam || 'blue'], d = ease(o.es / .3);
    c.save(); c.fillStyle = col; c.globalAlpha *= d; c.beginPath(); c.arc(0, 0, 22, 0, TAU); c.fill(); c.restore();
    for (let i = 0; i < 4; i++) { const k = (t * .9 + i / 4) % 1, r = 40 + k * 240, a2 = (1 - k) * .9 * d;
      mk(P.arc(0, 0, r, -Math.PI * .34, Math.PI * .34), 6, col, 840 + i, 1, a2);
      mk(P.arc(0, 0, r, Math.PI * .66, Math.PI * 1.34), 6, col, 850 + i, 1, a2) } };

  // a line chart: it went up, or with "flip" it went down
  ART.chart = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .34), line = ACC[o.tint || (o.flip ? 'red' : 'green')];
    mk(P.line(-230, 170, 230, 170), 6, col, 860, d); mk(P.line(-230, 170, -230, -180), 6, col, 861, d);
    const ys = o.flip ? [-140, -60, -80, 30, 120] : [120, 30, 60, -60, -150];
    const pts = ys.map((y, i) => [-210 + i * 108, y]);
    const path = pts.slice(1).flatMap((p, i) => P.line(pts[i][0], pts[i][1], p[0], p[1]));
    mk(path, 8, line, 862, ease(o.es / .7));
    const g = ease((o.es - .5) / .3); if (g > 0) { c.save(); c.fillStyle = line; c.globalAlpha *= g; c.beginPath(); c.arc(pts[4][0], pts[4][1], 15, 0, TAU); c.fill(); c.restore() } };

  // a network: nodes and the edges between them
  ART.graph = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, hot = ACC[o.tint || 'white'];
    const N = [[0, -160], [-190, -20], [190, -20], [-110, 170], [120, 170]], E = [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4], [1, 2]];
    E.forEach(([a2, b], i) => mk(P.line(N[a2][0], N[a2][1], N[b][0], N[b][1]), 5, col, 880 + i, ease((o.es - i * .04) / .3), .8));
    N.forEach((p, i) => { const d = ease((o.es - i * .05) / .28), on = o.tint && i === 0;
      c.save(); c.fillStyle = '#000'; c.globalAlpha *= d; c.beginPath(); c.arc(p[0], p[1], 40, 0, TAU); c.fill(); c.restore();
      mk(P.circle(p[0], p[1], 40), 6.5, on ? hot : col, 890 + i, d) }) };

  // a folder: the files, the archive, whatever was taken
  ART.folder = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .38);
    const tab = P.poly([[-220, -140], [-70, -140], [-30, -100], [220, -100]]);
    const body = [...tab, ...P.line(220, -100, 220, 150), ...P.line(220, 150, -220, 150), ...P.line(-220, 150, -220, -140)];
    shade(body, .06); mk(body, 7.5, col, 900, d);
    mk(P.line(-220, -60, 220, -60), 5, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 901, d, .8) };

  // a cloud: someone else's computer
  ART.cloud = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42);
    const sh = [...P.arc(-120, 20, 80, Math.PI, TAU), ...P.arc(-10, -30, 105, Math.PI * 1.05, TAU * .98), ...P.arc(120, 14, 84, Math.PI * .96, TAU), ...P.line(204, 20, -200, 20)];
    shade(sh, .06); mk([...sh, sh[0]], 7.5, col, 920, d) };

  // a window of code: the thing under the interface
  ART.code = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .4), hot = ACC[o.tint || 'white'];
    const body = P.rect(-250, -170, 500, 340); shade(body, .05); mk(body, 7, col, 940, d);
    mk(P.line(-250, -108, 250, -108), 5, col, 941, d);
    for (let i = 0; i < 3; i++) mk(P.circle(-212 + i * 40, -139, 12), 4, col, 942 + i, d, .8);
    const w = [300, 210, 380, 160, 260, 330];
    w.forEach((ww, i) => mk(P.line(-208, -66 + i * 42, -208 + ww, -66 + i * 42), 6, i === 2 && o.tint ? hot : col, 950 + i, ease((o.es - i * .05) / .3), .85)) };

  // a balance: the trade-off, the choice, the cost against the benefit
  ART.scale = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .44), tilt = (o.flip ? -1 : 1) * .16 * ease((o.es - .4) / .5);
    const c = A.ctx; mk(P.line(0, -170, 0, 180), 8, col, 970, d); mk(P.line(-90, 180, 90, 180), 8, col, 971, d);
    c.save(); c.translate(0, -170); c.rotate(tilt);
    mk(P.line(-220, 0, 220, 0), 8, col, 972, d);
    for (const s of [-1, 1]) { mk(P.line(s * 200, 0, s * 200, 56), 5, col, 973 + s, d);
      const pan = P.arc(s * 200, 56, 78, .12, Math.PI - .12);
      mk(pan, 6.5, s < 0 ? col : ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 976 + s, d) }
    c.restore() };

  // the warning triangle
  ART.warning = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || 'yellow'], d = ease(o.es / .36), p = .8 + .2 * Math.sin(t * 5);
    const tri = P.poly([[0, -180], [200, 165], [-200, 165]]);
    shade(tri, .06); glow(col, 22 * p, () => mk([...tri, tri[0]], 9, col, 990, d));
    mk(P.line(0, -80, 0, 62), 11, col, 991, ease((o.es - .2) / .25));
    c.save(); c.fillStyle = col; c.globalAlpha *= ease((o.es - .38) / .2); c.beginPath(); c.arc(0, 116, 13, 0, TAU); c.fill(); c.restore() };

  // a question mark: the thing nobody checked
  ART.question = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || 'white'] === WHITE ? (o.col || WHITE) : ACC[o.tint], d = ease(o.es / .5);
    mk([...P.arc(0, -96, 92, Math.PI * 1.06, TAU * .96), ...P.quad(88, -74, 60, 10, 0, 56), ...P.line(0, 56, 0, 96)], 12, col, 1000, d);
    c.save(); c.fillStyle = col; c.globalAlpha *= ease((o.es - .4) / .22); c.beginPath(); c.arc(0, 168, 17, 0, TAU); c.fill(); c.restore() };

  // a skyline: a city, a country, everywhere at once
  ART.city = (t, u, o = {}) => { const col = o.col || WHITE, hs = [230, 330, 180, 400, 260, 150], lit = ACC[o.tint || 'white'];
    hs.forEach((h, i) => { const x = -300 + i * 106, w = 92, d = ease((o.es - i * .05) / .3);
      const b = P.rect(x, 200 - h, w, h); shade(b, .05); mk(b, 6.5, col, 1020 + i, d);
      for (let r = 0; r < Math.floor(h / 70); r++) for (let cc = 0; cc < 2; cc++)
        mk(P.rect(x + 18 + cc * 40, 220 - h + r * 66, 26, 30), 3.5, (o.tint && i === 3 && r === 1) ? lit : col, 1030 + i * 8 + r * 2 + cc, d, .65) });
    mk(P.line(-320, 200, 340, 200), 6, col, 1080, ease(o.es / .3)) };

  // money
  ART.coin = (t, u, o = {}) => { const col = ACC[o.tint || 'yellow'], d = ease(o.es / .38);
    for (let i = 2; i >= 0; i--) { const y = 70 - i * 44, g = ease((o.es - (2 - i) * .09) / .3);
      mk(P.circle(0, y, 118), 7, col, 1100 + i, g); mk(P.arc(0, y, 118, .2, Math.PI - .2), 5, col, 1110 + i, g, .5) }
    mk(P.circle(0, -18, 46), 6, col, 1120, d); mk(P.line(0, -84, 0, 48), 6, col, 1121, d) };

  // a clock: time passing, and how little of it there is
  ART.clock = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .4), hot = ACC[o.tint || 'white'];
    const face = P.circle(0, 0, 190); shade(face, .05); mk(face, 8, col, 1140, d);
    for (let i = 0; i < 12; i++) { const a2 = i * TAU / 12 - Math.PI / 2;
      mk(P.line(Math.cos(a2) * 158, Math.sin(a2) * 158, Math.cos(a2) * 178, Math.sin(a2) * 178), i % 3 ? 4 : 6, col, 1150 + i, d) }
    const m = t * 1.4, h = t * .35, c = A.ctx;
    mk(P.line(0, 0, Math.cos(m - Math.PI / 2) * 148, Math.sin(m - Math.PI / 2) * 148), 9, hot, 1170, d);
    mk(P.line(0, 0, Math.cos(h - Math.PI / 2) * 96, Math.sin(h - Math.PI / 2) * 96), 12, col, 1171, d);
    c.save(); c.fillStyle = col; c.globalAlpha *= d; c.beginPath(); c.arc(0, 0, 12, 0, TAU); c.fill(); c.restore() };

  // a calendar: the date it happened, the deadline, the day nobody noticed
  ART.calendar = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .4), hot = ACC[o.tint || 'red'];
    const body = P.rect(-210, -160, 420, 340); shade(body, .05); mk(body, 7.5, col, 1190, d);
    mk(P.line(-210, -78, 210, -78), 6, col, 1191, d);
    mk(P.line(-130, -200, -130, -140), 7, col, 1192, d); mk(P.line(130, -200, 130, -140), 7, col, 1193, d);
    for (let r = 0; r < 3; r++) for (let cc = 0; cc < 4; cc++) { const x = -160 + cc * 106, y = -40 + r * 76, on = o.tint !== undefined && r === 1 && cc === 2;
      mk(P.rect(x, y, 62, 46), on ? 6 : 4, on ? hot : col, 1200 + r * 4 + cc, ease((o.es - .1 - r * .05) / .3), on ? 1 : .6) } };

  // a parcel: the thing that arrives, the container, the supply chain
  ART.box = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42);
    const top = P.poly([[-180, -60], [0, -150], [180, -60], [0, 30]]);
    shade(top, .09); mk([...top, top[0]], 7, col, 1220, d);
    const l = P.poly([[-180, -60], [0, 30], [0, 190], [-180, 100]]); shade(l, .05); mk([...l, l[0]], 7, col, 1221, d);
    const r = P.poly([[180, -60], [0, 30], [0, 190], [180, 100]]); shade(r, .03); mk([...r, r[0]], 7, col, 1222, d);
    mk(P.line(-90, -105, 90, -15), 5, ACC[o.tint || 'white'] === WHITE ? col : ACC[o.tint], 1223, d, .8) };

  // an open book: the rule, the law, the manual nobody read
  ART.book = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42);
    const lp = [...P.quad(-240, -110, -120, -140, -8, -96), ...P.line(-8, -96, -8, 130), ...P.quad(-8, 130, -120, 92, -240, 120), ...P.line(-240, 120, -240, -110)];
    const rp = [...P.quad(240, -110, 120, -140, 8, -96), ...P.line(8, -96, 8, 130), ...P.quad(8, 130, 120, 92, 240, 120), ...P.line(240, 120, 240, -110)];
    shade(lp, .05); shade(rp, .05); mk([...lp, lp[0]], 7, col, 1240, d); mk([...rp, rp[0]], 7, col, 1241, d);
    for (let i = 0; i < 3; i++) { const y = -50 + i * 44;
      mk(P.line(-206, y, -46, y - 8), 4.5, col, 1242 + i, d, .7); mk(P.line(46, y - 8, 206, y), 4.5, col, 1250 + i, d, .7) } };

  // a rocket: a launch, growth, something leaving the ground
  ART.rocket = (t, u, o = {}) => { const c = A.ctx, col = o.col || WHITE, d = ease(o.es / .42), f = ACC[o.tint || 'red'];
    const body = [...P.quad(0, -230, 86, -60, 78, 90), ...P.line(78, 90, -78, 90), ...P.quad(-78, 90, -86, -60, 0, -230)];
    shade(body, .06); mk([...body, body[0]], 7.5, col, 1260, d);
    mk(P.circle(0, -76, 40), 6, ACC[o.led || 'blue'], 1261, d);
    mk(P.poly([[-78, 20], [-160, 130], [-78, 106]]), 7, col, 1262, d); mk(P.poly([[78, 20], [160, 130], [78, 106]]), 7, col, 1263, d);
    const fl = .7 + .3 * Math.sin(t * 14);
    c.save(); c.globalAlpha *= d; glow(f, 26 * fl, () => { mk([...P.quad(-52, 96, 0, 130 + 110 * fl, 52, 96)], 8, f, 1264, 1, .95) }); c.restore() };

  // the idea
  ART.bulb = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42), lit = ACC[o.tint || 'yellow'], p = .7 + .3 * Math.sin(t * 3.2);
    const g = [...P.arc(0, -40, 130, Math.PI * 1.02, TAU * .98), ...P.quad(128, -20, 92, 74, 62, 110), ...P.line(62, 110, -62, 110), ...P.quad(-62, 110, -92, 74, -128, -20)];
    shade(g, .05); mk([...g, g[0]], 7.5, col, 1280, d);
    mk(P.rect(-58, 110, 116, 76), 6, col, 1281, d); mk(P.line(-58, 146, 58, 146), 4.5, col, 1282, d, .7);
    if (o.flash) { const k = ease((o.es - .3) / .35);
      glow(lit, 30 * p, () => mk([...P.quad(-36, -20, 0, 40, 36, -20)], 7, lit, 1283, k));
      for (let i = 0; i < 8; i++) { const a2 = -Math.PI + i * Math.PI / 7;
        mk(P.line(Math.cos(a2) * 160, -40 + Math.sin(a2) * 160, Math.cos(a2) * (200 + 24 * p), -40 + Math.sin(a2) * (200 + 24 * p)), 5, lit, 1290 + i, k, .85) } } };

  // looking closer than anyone did at the time
  ART.magnifier = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .4), sw = Math.sin(t * 1.1) * 16;
    const c = A.ctx; c.save(); c.translate(sw, 0);
    const lens = P.circle(-40, -50, 140); shade(lens, .04); mk(lens, 9, col, 1300, d);
    mk(P.circle(-40, -50, 118), 4, col, 1301, d, .5);
    mk(P.line(58, 48, 190, 180), 15, col, 1302, d); mk(P.arc(-96, -104, 62, Math.PI * 1.05, Math.PI * 1.45), 5, col, 1303, d, .6);
    c.restore() };

  // how it works: the mechanism, turning whether you watch it or not
  ART.gear = (t, u, o = {}) => { const c = A.ctx, col = ACC[o.tint || 'white'] === WHITE ? (o.col || WHITE) : ACC[o.tint], d = ease(o.es / .45), n = 9;
    c.save(); c.rotate(t * .55);
    mk(P.circle(0, 0, 130), 8, col, 1320, d); mk(P.circle(0, 0, 52), 6, col, 1321, d);
    for (let i = 0; i < n; i++) { const a2 = i * TAU / n, cx = Math.cos(a2), cy = Math.sin(a2);
      mk(P.poly([[cx * 104 - cy * 30, cy * 104 + cx * 30], [cx * 176 - cy * 22, cy * 176 + cx * 22], [cx * 176 + cy * 22, cy * 176 - cx * 22], [cx * 104 + cy * 30, cy * 104 - cx * 30]]), 6.5, col, 1330 + i, d) }
    c.restore() };

  // links: a chain of blocks, a dependency, something that only holds while every link does
  ART.chain = (t, u, o = {}) => { const col = ACC[o.tint || 'white'] === WHITE ? (o.col || WHITE) : ACC[o.tint], n = Math.min(6, o.count || 4);
    // A link is 2:1 and every other one stands end over end; they overlap by a third, which is the only
    // thing that makes a chain read as a chain rather than a row of eggs.
    const step = 118;
    for (let i = 0; i < n; i++) { const x = (i - (n - 1) / 2) * step, d = ease((o.es - i * .07) / .3), br = o.no && i === n - 2;
      const c = A.ctx, up = i % 2 === 1; c.save(); c.translate(x, 0); if (up) c.rotate(Math.PI / 2);
      const L = 92, W2 = 44;
      const ring = [...P.arc(-L + W2, 0, W2, Math.PI / 2, Math.PI * 1.5), ...P.line(-L + W2, -W2, L - W2, -W2),
                    ...P.arc(L - W2, 0, W2, -Math.PI / 2, Math.PI / 2), ...P.line(L - W2, W2, -L + W2, W2)];
      mk([...ring, ring[0]], 9, br ? ACC.red : col, 1350 + i, br ? d * .5 : d);
      mk(P.arc(-L + W2, 0, W2 - 13, Math.PI / 2, Math.PI * 1.5), 4, br ? ACC.red : col, 1370 + i, d, .35);
      c.restore();
      if (br) mk(P.line(x - 46, -54, x + 46, 54), 8, ACC.red, 1360, ease((o.es - .35) / .3)) } };

  // a tree: nature, growth, the thing that takes years
  ART.tree = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .45), sw = Math.sin(t * .8) * .03, c = A.ctx;
    mk(P.line(0, 230, 0, 40), 10, col, 1380, d);
    mk(P.quad(0, 150, -60, 120, -96, 60), 6, col, 1381, d, .8); mk(P.quad(0, 120, 66, 86, 104, 30), 6, col, 1382, d, .8);
    c.save(); c.rotate(sw);
    const cn = [...P.arc(-96, 0, 96, Math.PI * .9, TAU), ...P.arc(10, -70, 128, Math.PI * 1.02, TAU * .96), ...P.arc(110, 10, 92, Math.PI * .9, TAU * 1.02), ...P.line(200, 22, -190, 12)];
    shade(cn, .06); mk([...cn, cn[0]], 7, col, 1383, d); c.restore() };

  // a satellite: the thing overhead that is always talking
  ART.satellite = (t, u, o = {}) => { const col = o.col || WHITE, d = ease(o.es / .42), wv = ACC[o.beam || o.tint || 'blue'];
    const body = P.rect(-56, -70, 112, 150); shade(body, .07); mk(body, 7, col, 1400, d);
    for (const s of [-1, 1]) { const p = P.rect(s * 74 - (s < 0 ? 128 : 0), -56, 128, 120); shade(p, .05); mk(p, 6, col, 1402 + s, d);
      for (let i = 0; i < 2; i++) mk(P.line(s * 74 - (s < 0 ? 128 : 0), -16 + i * 40, s * 74 + (s < 0 ? 0 : 128), -16 + i * 40), 4, col, 1410 + i * 2 + (s > 0 ? 1 : 0), d, .6) }
    mk(P.arc(0, 110, 62, 0, Math.PI), 7, col, 1420, d); mk(P.line(0, 80, 0, 112), 5, col, 1421, d);
    for (let i = 0; i < 3; i++) { const k = (t * .8 + i / 3) % 1;
      mk(P.arc(0, 116, 80 + k * 150, Math.PI * .18, Math.PI * .82), 5, wv, 1430 + i, 1, (1 - k) * .8) } };

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
      const at = cue(s, e.at ?? 0, dur, 0, e.name + ' at'), out = e.until == null ? dur : cue(s, e.until, dur, dur, e.name + ' until');
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
