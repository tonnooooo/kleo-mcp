/* Keou "cinema" style — full-bleed cyber-glass motion graphics rebuilt from the
   channel's reference film: one hero visual per beat, kinetic type, lower title
   lockup with an accent bar, keyword-highlighted captions, chapter label and corner
   brackets. Works in 16:9 and 9:16 (Shorts safe area). Deterministic; display only. */
(function () {
  const S = {}; let A = null; const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = x => 1 - (1 - clamp(x)) ** 4, eio = x => { x = clamp(x); return x < .5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2 };
  const lerp = (a, b, t) => a + (b - a) * t;
  const COL = { green: '#00ff88', cyan: '#2bb0ff', red: '#ff3b3b', amber: '#ffb020' };
  const INK = '#050607', WHITE = '#eef2f5', PALE = '#c9d3d9', MUTED = '#6b7681', DIM = '#2a3238';
  const STOP = new Set('the a an and or of to in on at for with your you it is are was were be this that they them their one two not no but into from by as if so we he she its'.split(' '));

  // ---- geometry per orientation ---------------------------------------------
  function geo() {
    const W = A.W, H = A.H, p = H > W;
    return p ? { W, H, p, hero: [540, 880, 780, 820], safe: 390, label: [60, 215, 24], brackets: [40, 170, 1040, 1440], lockupY: 1230, lockupSize: 52, capY: 1400, capSize: 48, capMax: 860, progY: 1462 }
             : { W, H, p, hero: [960, 440, 1100, 520], safe: 860, label: [72, 68, 20], brackets: [64, 60, 1856, 1000], lockupY: 640, lockupSize: 44, capY: H - 44, capSize: 38, capMax: 1500, progY: H - 62 };
  }
  const stroke = (c, w) => { A.ctx.strokeStyle = c; A.ctx.lineWidth = w; A.ctx.lineCap = 'round'; A.ctx.lineJoin = 'round' };
  const glowOn = (c, b) => { A.ctx.shadowColor = c; A.ctx.shadowBlur = b }; const glowOff = () => { A.ctx.shadowBlur = 0 };
  function rr(x, y, w, h, r) { A.ctx.beginPath(); A.ctx.roundRect(x, y, w, h, r) }
  function spaced(text, x, y, size, color, align, tracking, font = 'Manrope', weight = 700) {
    const ctx = A.ctx; ctx.font = `${weight} ${size}px ${font}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const chars = [...text]; const w = chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + tracking * (chars.length - 1);
    let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x; ctx.fillStyle = color;
    for (const c of chars) { ctx.fillText(c, cx, y); cx += ctx.measureText(c).width + tracking } return w;
  }

  // ---- chrome ------------------------------------------------------------------
  S.background = function (t) {
    const ctx = A.ctx, { W, H } = geo();
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * .5, H * .45, 10, W * .5, H * .45, Math.max(W, H) * .8); g.addColorStop(0, '#0b1210'); g.addColorStop(1, INK); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = .07; stroke('#8fb3a6', 1.2);                  // drifting diagonal light streaks
    for (let i = -6; i < 14; i++) { const o = ((t * 14) % 260) + i * 260; ctx.beginPath(); ctx.moveTo(o - H * .55, 0); ctx.lineTo(o, H); ctx.stroke() }
    ctx.restore();
    for (let y = 0; y < H; y += 5) { ctx.fillStyle = '#ffffff03'; ctx.fillRect(0, y, W, 1) }
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .45, W / 2, H / 2, Math.max(W, H) * .75); v.addColorStop(0, '#00000000'); v.addColorStop(1, '#000000aa'); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  };
  S.chrome = function (s, i, t) {
    const ctx = A.ctx, G = geo(), acc = COL[s.accent || 'green'];
    const [lx, ly, ls] = G.label; ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(lx + 5, ly - ls * .35, 4, 0, TAU); ctx.fill();
    spaced(((s.chapter) || '').toUpperCase(), lx + 22, ly, ls, MUTED, 'left', ls * .28, 'Manrope', 700);
    const [bx0, by0, bx1, by1] = G.brackets, L = 60; stroke('#ffffff14', 2);
    for (const [x, y, dx, dy] of [[bx0, by0, 1, 1], [bx1, by0, -1, 1], [bx0, by1, 1, -1], [bx1, by1, -1, -1]]) { ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke() }
  };
  S.progress = function (t) { const G = geo(); const w = (G.brackets[2] - G.brackets[0]) * clamp(t / A.timeline.duration); A.line(G.brackets[0], G.progY, G.brackets[0] + w, G.progY, '#00ff8866', 2) };

  // ---- icons (unit box, centred at 0,0, roughly -0.5..0.5) -----------------------
  const I = {};
  I.coffee = (t, acc) => { const c = A.ctx; stroke(WHITE, .022); rr(-.22, -.08, .44, .34, .08); c.stroke(); c.beginPath(); c.arc(.28, .08, .1, -1.3, 1.3); c.stroke(); c.beginPath(); c.moveTo(-.34, .3); c.lineTo(.34, .3); c.stroke();
    stroke(acc, .016); for (let k = 0; k < 3; k++) { c.beginPath(); for (let j = 0; j <= 10; j++) { const y = -.12 - j * .034, x = -.1 + k * .1 + Math.sin(j * .9 + t * 3 + k) * .025; j ? c.lineTo(x, y) : c.moveTo(x, y) } c.save(); c.globalAlpha *= .8; c.stroke(); c.restore() } };
  I.desk = (t, acc) => { const c = A.ctx; stroke(WHITE, .02); c.beginPath(); c.moveTo(-.5, .1); c.lineTo(-.1, -.12); c.lineTo(.5, .02); c.lineTo(.1, .25); c.closePath(); c.stroke(); for (const [x, y] of [[-.5, .1], [.1, .25], [.5, .02]]) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + .22); c.stroke() }
    rr(-.2, -.42, .34, .26, .02); c.stroke(); stroke(acc, .012); rr(-.17, -.39, .28, .2, .01); c.save(); c.globalAlpha *= .5 + .3 * Math.sin(t * 2); c.stroke(); c.restore(); c.beginPath(); c.moveTo(-.03, -.16); c.lineTo(-.03, -.08); c.stroke() };
  I.hoodie = (t, acc) => { const c = A.ctx; stroke(WHITE, .022); c.beginPath(); c.moveTo(-.34, .5); c.quadraticCurveTo(-.42, -.1, -.1, -.46); c.quadraticCurveTo(0, -.52, .1, -.46); c.quadraticCurveTo(.42, -.1, .34, .5); c.stroke();
    c.beginPath(); c.moveTo(-.2, .5); c.quadraticCurveTo(-.26, .05, -.03, -.28); c.quadraticCurveTo(0, -.32, .03, -.28); c.quadraticCurveTo(.26, .05, .2, .5); c.stroke(); stroke(acc, .014); c.beginPath(); c.moveTo(-.12, .1); c.lineTo(.12, .1); c.save(); c.globalAlpha *= .4; c.stroke(); c.restore() };
  I.keyboard = (t, acc) => { const c = A.ctx; stroke(WHITE, .012); for (let r = 0; r < 4; r++) for (let k = 0; k < 10; k++) { const x = -.45 + k * .09 + r * .03, y = -.18 + r * .1; rr(x, y, .07, .07, .01); c.stroke() } stroke(acc, .012); const k = Math.floor(t * 6) % 10, r = Math.floor(t * 1.5) % 4; rr(-.45 + k * .09 + r * .03, -.18 + r * .1, .07, .07, .01); c.stroke() };
  I.hand = (t, acc) => { const c = A.ctx; stroke(WHITE, .024); c.beginPath(); c.moveTo(-.22, .48); c.lineTo(-.26, .05); c.quadraticCurveTo(-.26, -.05, -.18, -.05); c.lineTo(-.18, -.3); c.quadraticCurveTo(-.18, -.4, -.1, -.4); c.quadraticCurveTo(-.02, -.4, -.02, -.3); c.lineTo(-.02, -.42); c.quadraticCurveTo(-.02, -.5, .06, -.5); c.quadraticCurveTo(.14, -.5, .14, -.42); c.lineTo(.14, -.34); c.quadraticCurveTo(.14, -.42, .22, -.42); c.quadraticCurveTo(.3, -.42, .3, -.32); c.lineTo(.3, .1); c.quadraticCurveTo(.3, .35, .1, .48); c.closePath(); c.stroke() };
  I.bug = (t, acc) => { const c = A.ctx; stroke(acc, .022); c.beginPath(); c.ellipse(0, .05, .22, .3, 0, 0, TAU); c.stroke(); c.beginPath(); c.arc(0, -.32, .12, 0, TAU); c.stroke(); c.beginPath(); c.moveTo(0, -.25); c.lineTo(0, .35); c.stroke(); for (const s of [-1, 1]) for (let k = 0; k < 3; k++) { c.beginPath(); c.moveTo(s * .2, -.1 + k * .16); c.lineTo(s * .42, -.2 + k * .18 + Math.sin(t * 8 + k) * .02); c.stroke() } };
  I.alarm = (t, acc) => { const c = A.ctx; stroke(acc, .024); c.beginPath(); c.arc(0, .1, .3, Math.PI, TAU); c.stroke(); rr(-.4, .1, .8, .12, .03); c.stroke(); glowOn(acc, 18 * (.5 + .5 * Math.sin(t * 6))); for (let k = 0; k < 5; k++) { const a = Math.PI + k * Math.PI / 4; c.beginPath(); c.moveTo(Math.cos(a) * .38, .1 + Math.sin(a) * .38); c.lineTo(Math.cos(a) * .5, .1 + Math.sin(a) * .5); c.stroke() } glowOff() };
  I.shield = (t, acc) => { const c = A.ctx; stroke(acc, .024); c.beginPath(); c.moveTo(0, -.48); c.lineTo(.4, -.3); c.lineTo(.36, .1); c.quadraticCurveTo(.25, .38, 0, .5); c.quadraticCurveTo(-.25, .38, -.36, .1); c.lineTo(-.4, -.3); c.closePath(); c.stroke(); stroke(WHITE, .03); c.beginPath(); c.moveTo(-.16, 0); c.lineTo(-.04, .14); c.lineTo(.2, -.14); c.stroke() };
  I.radar = (t, acc) => { const c = A.ctx; stroke('#ffffff33', .01); for (const r of [.16, .32, .48]) { c.beginPath(); c.arc(0, 0, r, 0, TAU); c.stroke() } const a = t * 1.4; const g = c.createRadialGradient(0, 0, 0, 0, 0, .48); g.addColorStop(0, acc + '99'); g.addColorStop(1, acc + '00'); c.fillStyle = g; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, .48, a - .9, a); c.closePath(); c.fill(); stroke(acc, .014); c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * .48, Math.sin(a) * .48); c.stroke(); c.fillStyle = acc; c.beginPath(); c.arc(.2, -.18, .02, 0, TAU); c.fill() };
  I.car = (t, acc, o = {}) => { const c = A.ctx;
    if (o.drive) { for (let k = 0; k < 4; k++) { const ph = ((t * 2.2 + k * .27) % 1); c.save(); c.globalAlpha *= (1 - ph) * .7; stroke(WHITE, .014); c.beginPath(); c.moveTo(-.42 - ph * .25, -.16 + k * .07); c.lineTo(-.30 - ph * .25, -.16 + k * .07); c.stroke(); c.restore() } }
    stroke(WHITE, .02);
    c.beginPath(); c.moveTo(-.5, .04); c.lineTo(-.5, -.06); c.lineTo(-.34, -.08); c.lineTo(-.18, -.27); c.lineTo(.17, -.27); c.lineTo(.33, -.08); c.lineTo(.5, -.06); c.lineTo(.5, .04);
    c.lineTo(.4, .04); c.arc(.3, .04, .1, 0, Math.PI, true); c.lineTo(-.2, .04); c.arc(-.3, .04, .1, 0, Math.PI, true); c.closePath(); c.stroke();
    c.beginPath(); c.moveTo(-.14, -.08); c.lineTo(-.03, -.24); c.lineTo(.12, -.24); c.lineTo(.19, -.08); c.stroke();
    for (const x of [-.3, .3]) { c.beginPath(); c.arc(x, .06, .09, 0, TAU); c.stroke(); c.fillStyle = WHITE; c.beginPath(); c.arc(x, .06, .02, 0, TAU); c.fill(); if (o.rolling || o.drive) { const a = t * 9; c.beginPath(); c.moveTo(x + Math.cos(a) * .05, .06 + Math.sin(a) * .05); c.lineTo(x + Math.cos(a) * .085, .06 + Math.sin(a) * .085); c.stroke() } }
    c.fillStyle = o.lit ? acc : WHITE; c.beginPath(); c.arc(.47, -.03, .022, 0, TAU); c.fill();
    if (o.lit) { c.save(); glowOn(acc, 30); stroke(acc, .016); c.globalAlpha *= .85; c.beginPath(); c.moveTo(.5, -.04); c.lineTo(.56, -.07); c.moveTo(.5, -.02); c.lineTo(.56, .01); c.stroke(); c.restore() } };
  I.keyfob = (t, acc, o = {}) => { const c = A.ctx; stroke(WHITE, .022); rr(-.15, -.28, .3, .5, .07); c.stroke(); c.beginPath(); c.arc(0, -.36, .06, 0, TAU); c.stroke(); c.fillStyle = acc; rr(-.08, -.14, .16, .07, .03); c.fill(); rr(-.08, .0, .16, .07, .03); c.fill();
    if (o.dead) { stroke(COL.red, .03); c.beginPath(); c.moveTo(-.3, .32); c.lineTo(.3, -.36); c.stroke() } else for (let k = 0; k < 3; k++) { const ph = (t * .9 + k / 3) % 1; c.save(); c.globalAlpha *= (1 - ph); stroke(acc, .014); c.beginPath(); c.arc(.22, -.1, .12 + ph * .3, -.6, .6); c.stroke(); c.restore() } };
  I.house = (t, acc, o = {}) => { const c = A.ctx; stroke(WHITE, .02); c.beginPath(); c.moveTo(-.42, .42); c.lineTo(-.42, -.05); c.lineTo(0, -.42); c.lineTo(.42, -.05); c.lineTo(.42, .42); c.closePath(); c.stroke(); rr(.06, .1, .2, .32, .02); c.stroke(); rr(-.3, -.1, .22, .14, .02); c.stroke(); if (o.key) { c.save(); c.translate(-.17, .27); c.scale(.3, .3); I.keyfob(t, acc); c.restore() } };
  I.amplifier = (t, acc, o = {}) => { const c = A.ctx; stroke(o.color || WHITE, .022); rr(-.3, -.12, .6, .38, .05); c.stroke(); c.beginPath(); c.moveTo(.18, -.12); c.lineTo(.26, -.46); c.stroke(); c.fillStyle = acc; c.beginPath(); c.arc(-.14, .07, .04, 0, TAU); c.fill(); for (let k = 0; k < 3; k++) { const ph = (t * 1.1 + k / 3) % 1; c.save(); c.globalAlpha *= (1 - ph); stroke(acc, .014); c.beginPath(); c.arc(.26, -.46, .1 + ph * .32, -.7, .7); c.stroke(); c.restore() } if (o.dead) { stroke(COL.red, .03); c.beginPath(); c.moveTo(-.4, .4); c.lineTo(.4, -.45); c.stroke() } };
  I.pouch = (t, acc, o = {}) => { const c = A.ctx; stroke(WHITE, .022); rr(-.3, -.2, .6, .55, .1); c.stroke(); c.beginPath(); c.moveTo(-.3, -.2); c.lineTo(-.1, -.4); c.lineTo(.3, -.2); c.stroke(); c.setLineDash([.04, .04]); stroke(acc, .012); c.beginPath(); c.arc(0, .08, .42 + Math.sin(t * 4) * .01, 0, TAU); c.stroke(); c.setLineDash([]); if (o.key) { c.save(); c.translate(0, .08); c.scale(.5, .5); I.keyfob(t, acc, { dead: true }); c.restore() } };
  I.lock = (t, acc, o = {}) => { const c = A.ctx; stroke(WHITE, .024); rr(-.3, -.05, .6, .5, .06); c.stroke(); c.beginPath(); c.arc(0, -.12, .2, Math.PI, o.open ? Math.PI * 1.6 : TAU); c.stroke(); c.fillStyle = acc; c.beginPath(); c.arc(0, .18, .06, 0, TAU); c.fill() };
  I.timer = (t, acc, o = {}) => { const c = A.ctx, k = ease((o.u || 0) / (o.fill || 1.4)), r = .42;
    if (k >= 1) { c.save(); c.globalAlpha *= .35 + .3 * Math.sin(t * 9); stroke(COL.red, .05); c.beginPath(); c.arc(0, 0, .5, 0, TAU); c.stroke(); c.restore() }
    stroke('#ffffff33', .03); c.beginPath(); c.arc(0, 0, r, 0, TAU); c.stroke();
    stroke(acc, .04); c.beginPath(); c.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + TAU * k); c.stroke();
    // text inside a scaled context: draw it unscaled, or Chrome quantises the glyph advances to zero
    const px = c.getTransform().a; c.save(); c.scale(1 / px, 1 / px); c.font = `800 ${Math.round(.24 * px)}px Manrope`; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillStyle = WHITE; c.fillText('< 30s', 0, .085 * px); c.restore() };
  function stick(c, pose, t, col, w = .05) {
    stroke(col, w); const bob = .01 * Math.sin(t * 2.4), hip = [0, .02 + bob], sh = [0, -.22 + bob], head = [0, -.34 + bob];
    const seg = (a, b) => { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke() };
    c.beginPath(); c.arc(head[0], head[1], .085, 0, TAU); c.stroke(); seg(sh, hip);
    const run = pose === 'run', ph = t * TAU * (run ? 3.2 : 1.6);
    const lg = run ? [[.18 * Math.sin(ph), .40], [.18 * Math.sin(ph + Math.PI), .40]] : [[-.11, .42], [.11, .42]];
    for (const f of lg) { seg(hip, f); c.beginPath(); c.moveTo(f[0], f[1]); c.lineTo(f[0] + .05, f[1]); c.stroke() }
    let arms;
    if (pose === 'alarm') arms = [[[-.2, -.42], [-.13, -.3]], [[.2, -.42], [.13, -.3]]];
    else if (pose === 'point') arms = [[[-.08, -.05], [-.09, -.15]], [[.3, -.3], [.17, -.24]]];
    else if (pose === 'think') arms = [[[-.08, -.05], [-.09, -.15]], [[.02, -.3], [.12, -.18]]];
    else if (run) arms = [[[-.15 * Math.sin(ph) - .04, -.1], [-.1, -.16]], [[.15 * Math.sin(ph) + .04, -.1], [.1, -.16]]];
    else arms = [[[-.11, -.02], [-.09, -.12]], [[.11, -.02], [.09, -.12]]];
    for (const [hand, el] of arms) { seg([sh[0], sh[1] + .02], el); seg(el, hand) }
    return { hand: arms[1][0], head };
  }
  I.figure = (t, acc, o = {}) => { const c = A.ctx; const f = stick(c, o.pose || 'idle', t, WHITE); if (o.pose === 'alarm') { stroke(acc, .02); for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(f.head[0], f.head[1], .14 + k * .06 + ((t * 1.2) % 1) * .05, -2.4, -.7); c.stroke() } } };
  I.thief = (t, acc, o = {}) => { const c = A.ctx; const f = stick(c, o.pose || 'point', t, COL.red); c.save(); c.translate(f.hand[0] + .1, f.hand[1] - .02); c.scale(.5, .5); I.amplifier(t, COL.red, { dead: o.dead, color: COL.red }); c.restore() };
  I.person = (t, acc, o = {}) => { const c = A.ctx; stroke(o.color || WHITE, .05); c.beginPath(); c.arc(0, -.2, .17, 0, TAU); c.stroke(); c.beginPath(); c.moveTo(-.32, .45); c.quadraticCurveTo(-.32, .05, 0, .05); c.quadraticCurveTo(.32, .05, .32, .45); c.stroke() };
  I.phone = (t, acc, o = {}) => { const c = A.ctx; stroke(WHITE, .022); rr(-.2, -.42, .4, .84, .07); c.stroke(); c.beginPath(); c.moveTo(-.07, -.36); c.lineTo(.07, -.36); c.stroke();
    const k = ease(((t * .8) % 1.6) / .3); c.save(); c.globalAlpha *= k; c.fillStyle = acc + '33'; rr(-.16, -.28 + (1 - k) * -.06, .32, .13, .03); c.fill(); stroke(acc, .012); rr(-.16, -.28 + (1 - k) * -.06, .32, .13, .03); c.stroke(); c.fillStyle = acc; c.beginPath(); c.arc(-.1, -.215 + (1 - k) * -.06, .018, 0, TAU); c.fill(); stroke(WHITE, .012); c.beginPath(); c.moveTo(-.06, -.225 + (1 - k) * -.06); c.lineTo(.1, -.225 + (1 - k) * -.06); c.moveTo(-.06, -.195 + (1 - k) * -.06); c.lineTo(.04, -.195 + (1 - k) * -.06); c.stroke(); c.restore();
    for (let i = 0; i < 3; i++) { stroke('#ffffff33', .012); c.beginPath(); c.moveTo(-.14, -.05 + i * .1); c.lineTo(.14, -.05 + i * .1); c.stroke() } };
  I.wave = (t, acc, o = {}) => { const c = A.ctx; c.fillStyle = acc; c.beginPath(); c.arc(0, .2, .04, 0, TAU); c.fill(); for (let k = 0; k < 4; k++) { const ph = (t * .7 + k / 4) % 1; c.save(); c.globalAlpha *= (1 - ph) * .95; stroke(o.dead ? COL.red : acc, .022); c.beginPath(); c.arc(0, .2, .1 + ph * .45, -2.5, -.64); c.stroke(); c.restore() } if (o.dead) { stroke(COL.red, .035); c.beginPath(); c.moveTo(-.3, .32); c.lineTo(.3, -.3); c.stroke() } };
  I.clock = (t, acc, o = {}) => { const c = A.ctx; stroke(WHITE, .024); c.beginPath(); c.arc(0, 0, .42, 0, TAU); c.stroke(); for (let i = 0; i < 12; i++) { const a = i * TAU / 12; c.beginPath(); c.moveTo(Math.cos(a) * .36, Math.sin(a) * .36); c.lineTo(Math.cos(a) * .4, Math.sin(a) * .4); c.stroke() } const m = t * 2.8, h = t * .23; stroke(acc, .03); c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(m) * .32, Math.sin(m) * .32); c.stroke(); stroke(WHITE, .04); c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(h) * .2, Math.sin(h) * .2); c.stroke(); c.fillStyle = acc; c.beginPath(); c.arc(0, 0, .03, 0, TAU); c.fill() };
  I.check = (t, acc) => { const c = A.ctx; stroke(acc, .06); c.beginPath(); c.moveTo(-.3, 0); c.lineTo(-.08, .24); c.lineTo(.34, -.28); c.stroke() };
  I.cross = (t, acc) => { const c = A.ctx; stroke(COL.red, .06); c.beginPath(); c.moveTo(-.28, -.28); c.lineTo(.28, .28); c.moveTo(.28, -.28); c.lineTo(-.28, .28); c.stroke() };
  function icon(name, cx, cy, size, t, acc, opt = {}, a = 1) { const c = A.ctx; if (!I[name]) return; c.save(); c.translate(cx, cy); c.scale(size, size); c.globalAlpha *= a; const gc = name === 'thief' ? COL.red : (name === 'figure' || name === 'person') ? '#ffffff' : acc; glowOn(gc, name === 'figure' || name === 'thief' ? 6 : 14 / size * 8); I[name](t, acc, opt); glowOff(); c.restore() }

  // ---- beats ---------------------------------------------------------------------
  function typeFit(b, size, hw, hh, ctx) {                              // lines and fitted font size of a type beat
    const words = b.text.toUpperCase().split(' '), font = b.mono ? 'KeouMono' : 'Manrope', ic = b.icon ? size * (words.length <= 2 ? .34 : .26) + 24 : 0, fs0 = b.mono ? size * .16 : size * .2;
    ctx.font = `800 ${fs0}px ${font}`; let w0 = 0;
    for (const w of words) w0 = Math.max(w0, ctx.measureText(w).width + fs0 * .06 * ([...w].length - 1));
    const r = Math.min(1, hw / (w0 * 1.1), (hh - ic) / (words.length * fs0 * 1.1));
    return { words, font, fs: fs0 * r, ic, half: w0 * r * .5 };
  }
  const IW = { thief: .76, car: .6, amplifier: .56, keyfob: .55, figure: .5 };   // icons that draw past the unit box
  const iw = nm => IW[nm] || .5;
  function extent(b, G, size, ctx) {                                    // half-width of what a beat draws at scale 1
    const hw = G.hero[2], hh = G.hero[3];
    switch (b.kind) {
      case 'icon': return size * (b.size || .78) * iw(b.name);
      case 'split': return hw * .26 + size * .38 * Math.max(iw(b.items[0]), iw(b.items[1]));
      case 'grid': { const m = b.items.length; return (m - 1) / 2 * Math.min(hw / m, 330) + size * .28 * Math.max(iw(b.items[0]), iw(b.items[m - 1])) }
      case 'type': return typeFit(b, size, hw, hh, ctx).half;
      case 'terminal': return Math.min(hw * .94, 900) / 2;
      case 'steps': { const m = b.items.length, bw = Math.min(200, (hw - (m - 1) * 60) / m); return (m * bw + (m - 1) * 60) / 2 }
      case 'people': case 'bars': return hw * .46;
      case 'timeline': return hw * .42 + (b.icons ? 150 * Math.max(iw(b.icons[0]), iw(b.icons[b.icons.length - 1])) : 20);
      case 'dialog': return Math.min(hw * .78, 700) / 2 + 18;
      case 'cta': return Math.min(hw, 760) / 2;
    }
    return hw / 2;
  }
  function beat(b, s, k, ub, bd, t, G, n = 1) {
    const ctx = A.ctx, acc = COL[s.accent || 'green'], [hx, hy, hw, hh] = G.hero;
    const first = k === 0, last = k === n - 1;
    const enter = first ? 1 : ease(ub / (b.slam ? .1 : .16));                  // every beat is a cut, not a fade
    const exit = last ? 1 : 1 - ease((ub - (bd - .1)) / .1);                   // the last beat holds until the next scene
    const a = enter * exit;
    const T = clamp(bd / 1.6, .3, 1);                                          // reveal delays shrink with the beat: a 0.8 s shot still lands its payload
    const size = Math.min(hw, hh), room = (G.safe - 8) / Math.max(extent(b, G, size, ctx), 1);   // 8 px of glow margin
    const punch = (ub > 1.3 ? .11 * ease((ub - 1.3) / .14) : 0) + (ub > 2.6 ? .09 * ease((ub - 2.6) / .14) : 0) + .035 * clamp(ub / Math.max(bd, .1));
    const scale = Math.min(lerp(.94, 1, enter) + punch, room);                 // the punch-in stops at the safe area
    if (ub < .1) { ctx.save(); ctx.globalAlpha *= (1 - ub / .1) * .28; ctx.fillStyle = acc; ctx.fillRect(0, hy - hh * .6, G.W, hh * 1.2); ctx.restore() }
    ctx.save(); ctx.translate(hx, hy); ctx.scale(scale, scale); ctx.translate(-hx, -hy); ctx.globalAlpha *= a;
    switch (b.kind) {
      case 'icon': { const sz = size * (b.size || .78), drive = b.fx === 'drive';
        const q = drive ? clamp(ub / Math.max(bd - .1, .3)) : 0, dx = q * q * hw * 1.1, ia = 1;   // drive: the car accelerates and is physically out of frame right at the cut
        icon(b.name, hx + dx, hy - (b.label ? 40 : 0), sz, t, acc, { lit: b.fx === 'lit' || drive, dead: b.fx === 'dead', key: b.fx === 'key', open: b.fx === 'open', drive, pose: ['alarm', 'point', 'run', 'think'].includes(b.fx) ? b.fx : undefined, u: ub, fill: Math.min(1.4, bd * .8) }, ia);
        if (b.label) { const la = ease((ub - .7 * T) / .22); ctx.save(); ctx.globalAlpha *= la; ctx.translate(0, (1 - la) * 14); spaced(b.label.toUpperCase(), hx, hy + sz * .5 + 30, 26, acc, 'center', 5); ctx.restore() } break; }
      case 'split': { const [l, r] = b.items, sz = size * .38, gap = hw * .26;
        icon(l, hx - gap, hy, sz, t, acc, {}); const aa = ease((ub - .5 * T) / .25); ctx.save(); ctx.globalAlpha *= aa; stroke(acc, 6); glowOn(acc, 16); ctx.beginPath(); ctx.moveTo(hx - 48, hy); ctx.lineTo(hx + 40, hy); ctx.moveTo(hx + 18, hy - 20); ctx.lineTo(hx + 40, hy); ctx.lineTo(hx + 18, hy + 20); ctx.stroke(); glowOff(); ctx.restore();
        ctx.save(); ctx.globalAlpha *= ease((ub - .55 * T) / .2); icon(r, hx + gap, hy, sz, t, acc, { lit: b.fx === 'lit', dead: b.fx === 'dead', open: b.fx === 'open' }); ctx.restore();
        if (b.label) { const la = ease((ub - .9 * T) / .22); ctx.save(); ctx.globalAlpha *= la; spaced(b.label.toUpperCase(), hx, hy + sz * .6 + 40, 26, acc, 'center', 5); ctx.restore() } break; }
      case 'grid': { const m = b.items.length, sz = size * .28, gap = Math.min(hw / m, 330);
        b.items.forEach((nm, i) => { const ia = ease((ub - i * .3 * T) / .22); ctx.save(); ctx.globalAlpha *= ia; ctx.translate(0, (1 - ia) * 20); icon(nm, hx + (i - (m - 1) / 2) * gap, hy, sz, t, acc, {}); ctx.restore(); if (i < m - 1) { ctx.save(); ctx.globalAlpha *= ease((ub - (i + .65) * .3 * T) / .2); ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(hx + (i - (m - 1) / 2) * gap + gap / 2, hy, 6, 0, TAU); ctx.fill(); ctx.restore() } });
        if (b.label) { const la = ease((ub - m * .3 * T) / .22); ctx.save(); ctx.globalAlpha *= la; spaced(b.label.toUpperCase(), hx, hy + sz * .6 + 40, 26, acc, 'center', 5); ctx.restore() } break; }
      case 'type': { const { words, font, fs, ic } = typeFit(b, size, hw, hh, ctx), nw = words.length, slam = !!b.slam, sk = slam ? ease(ub / .14) : 1;
        if (slam && ub < .35) { ctx.save(); ctx.globalAlpha *= (1 - ub / .35) * .35; ctx.fillStyle = acc; ctx.fillRect(-hw, -hh, hw * 4, hh * 6); ctx.restore(); ctx.translate((Math.sin(ub * 90) * 9) * (1 - ub / .35), (Math.cos(ub * 70) * 6) * (1 - ub / .35)) }
        if (slam) { const over = lerp(Math.min(1.35, room), 1, sk); ctx.translate(hx, hy); ctx.scale(over, over); ctx.translate(-hx, -hy) }
        const lh = fs * 1.1, top = hy - (nw * lh + ic) / 2;
        if (b.icon) { const isz = ic - 24; icon(b.icon, hx, top + isz / 2, isz, t, acc, { lit: b.fx === 'lit', dead: b.fx === 'dead', open: b.fx === 'open', key: b.fx === 'key' }) }   // the picture above the words, slammed with them
        words.forEach((w, i) => { const wa = slam ? 1 : ease((ub - i * .12 * T) / .3), hl = w === (b.hl || '').toUpperCase(); ctx.save(); ctx.globalAlpha *= wa; glowOn(hl ? acc : '#ffffff', 22); spaced(w, hx, top + ic + i * lh + lh / 2 + fs * .36 + (1 - wa) * 18, fs, hl ? acc : WHITE, 'center', fs * .06, font, 800); glowOff(); ctx.restore() });
        break; }
      case 'terminal': { const w = Math.min(hw * .94, 900), h = 70 + (b.lines.length) * 52 + 30, x = hx - w / 2, y = hy - h / 2; ctx.fillStyle = '#0a0f0d'; rr(x, y, w, h, 12); ctx.fill(); stroke(acc + '66', 2); rr(x, y, w, h, 12); ctx.stroke();
        spaced(b.label || 'PROMPT', x + 26, y + 34, 16, MUTED, 'left', 4);
        const chars = b.lines.reduce((q, ln) => q + ln.length + 4, 0), cps = Math.max(40, chars / Math.max(bd * .65, .1));   // finish typing inside the beat
        let budget = Math.max(0, Math.floor((ub - .2 * T) * cps)), yy = y + 92;
        b.lines.forEach((ln, i) => { const shown = ln.slice(0, Math.max(0, budget)); budget -= ln.length + 4; A.mono('› ' + shown, x + 26, yy + i * 52, 26, i === 0 ? WHITE : acc, 'left'); if (budget >= -3 && budget < 0 && Math.floor(ub * 2.5) % 2 === 0) { ctx.fillStyle = acc; ctx.fillRect(x + 40 + ctx.measureText('› ' + shown).width, yy + i * 52 - 24, 12, 30) } });
        if (b.enter !== false) { rr(x + w - 130, y + h - 60, 104, 38, 6); stroke(acc, 2); ctx.stroke(); spaced('ENTER', x + w - 78, y + h - 34, 15, acc, 'center', 3) } break; }
      case 'steps': { const m = b.items.length, bw = Math.min(200, (hw - (m - 1) * 60) / m), gap = 60, x0 = hx - (m * bw + (m - 1) * gap) / 2;
        b.items.forEach((it, i) => { const lit = i < (b.lit ?? 0), sa = ease((ub - i * .22 * T) / .35), x = x0 + i * (bw + gap), y = hy - bw / 2; ctx.save(); ctx.globalAlpha *= sa;
          ctx.fillStyle = lit ? acc + '18' : '#0a0f0d'; rr(x, y, bw, bw, 14); ctx.fill(); stroke(lit ? acc : '#ffffff33', 2.5); if (lit) glowOn(acc, 22); rr(x, y, bw, bw, 14); ctx.stroke(); glowOff();
          spaced(`0${i + 1}`, x + 18, y + 34, 18, lit ? acc : MUTED, 'left', 3); ctx.font = `800 ${Math.min(30, bw * .16)}px Manrope`; ctx.textAlign = 'center'; ctx.fillStyle = lit ? WHITE : PALE; ctx.fillText(it.toUpperCase(), x + bw / 2, y + bw * .62);
          if (i < m - 1) { ctx.setLineDash([10, 12]); stroke('#ffffff44', 3); ctx.beginPath(); ctx.moveTo(x + bw + 10, hy); ctx.lineTo(x + bw + gap - 10, hy); ctx.stroke(); ctx.setLineDash([]) } ctx.restore() }); break; }
      case 'people': { const m = Math.min(b.total, 12), cell = Math.min(110, hw / m), x0 = hx - (m * cell) / 2 + cell / 2;
        for (let i = 0; i < m; i++) { const lit = i < b.lit, pa = ease((ub - i * .07 * T) / .3), x = x0 + i * cell; ctx.save(); ctx.globalAlpha *= pa; if (lit) { const g = ctx.createRadialGradient(x, hy - 20, 5, x, hy - 20, cell * .7); g.addColorStop(0, acc + '55'); g.addColorStop(1, acc + '00'); ctx.fillStyle = g; ctx.fillRect(x - cell, hy - cell - 20, cell * 2, cell * 2) } icon('person', x, hy - 20, cell * .85, t, acc, { color: lit ? acc : (i === m - 1 && b.last ? WHITE : '#ffffff44') }); ctx.restore() }
        stroke('#ffffff22', 2); ctx.beginPath(); ctx.moveTo(hx - hw * .46, hy + 60); ctx.lineTo(hx + hw * .46, hy + 60); ctx.stroke();
        if (b.label) spaced(b.label.toUpperCase(), hx, hy + 105, 22, PALE, 'center', 5); break; }
      case 'bars': { const m = b.labels.length, max = Math.max(...b.values), bw = Math.min(150, hw / (m * 1.8)), gap = bw * .8, x0 = hx - (m * bw + (m - 1) * gap) / 2, base = hy + hh * .28, top = hy - hh * .32, rise = Math.min(1.1, bd * .55), stg = Math.min(.2, bd * .1);
        b.labels.forEach((lb, i) => { const p = ease((ub - i * stg) / rise), v = b.values[i] / max * p, x = x0 + i * (bw + gap), h = (base - top) * v, col = i === m - 1 ? acc : '#ffffff55'; ctx.fillStyle = col; if (i === m - 1) glowOn(acc, 24); rr(x, base - h, bw, h, 8); ctx.fill(); glowOff();
          const num = (p >= .98 || ub >= bd - .25) ? b.values[i] : Math.round(b.values[i] * p);           // the true figure is on screen before the cut
          spaced(String(num), x + bw / 2, base - h - 16, 26, i === m - 1 ? acc : PALE, 'center', 2, 'KeouMono', 700); spaced(lb.toUpperCase(), x + bw / 2, base + 36, 17, MUTED, 'center', 3) });
        stroke('#ffffff22', 2); ctx.beginPath(); ctx.moveTo(hx - hw * .46, base); ctx.lineTo(hx + hw * .46, base); ctx.stroke(); break; }
      case 'timeline': { const m = b.labels.length, x0 = hx - hw * .42, x1 = hx + hw * .42, y = hy, kf = ease(ub / Math.min(1.2, bd * .6)); stroke('#ffffff33', 3); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); stroke(acc, 3); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (x1 - x0) * kf, y); ctx.stroke();
        b.labels.forEach((lb, i) => { const x = x0 + (x1 - x0) * i / (m - 1), on = kf >= i / (m - 1) - .01; if (b.icons) icon(b.icons[i], x, y - 135, 150, t, acc, {}, on ? 1 : .35); ctx.fillStyle = on ? acc : '#ffffff44'; if (on) glowOn(acc, 18); ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.fill(); glowOff(); spaced(`0${i + 1}`, x, y - 30, 15, MUTED, 'center', 3); spaced(lb.toUpperCase(), x, y + 44, 18, on ? WHITE : MUTED, 'center', 3) });
        for (let q = 0; q < 3; q++) { const ph = (t * .5 + q / 3) % 1; ctx.save(); ctx.fillStyle = acc; ctx.globalAlpha *= .8; ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * ph, y, 5, 0, TAU); ctx.fill(); ctx.restore() } break; }
      case 'dialog': { const m = b.count || 3, w = Math.min(hw * .78, 700), h = 120, step = h + 16; for (let i = 0; i < m; i++) { const da = ease((ub - i * .28 * T) / (.3 * T)), x = hx - w / 2 + (i - (m - 1) / 2) * 18, y = hy - (m * step) / 2 + i * step; ctx.save(); ctx.globalAlpha *= da; ctx.fillStyle = '#0a0f0d'; rr(x, y, w, h, 12); ctx.fill(); stroke(i === m - 1 ? acc : '#ffffff44', 2.5); if (i === m - 1) glowOn(acc, 18); rr(x, y, w, h, 12); ctx.stroke(); glowOff(); A.mono(b.text, x + w / 2, y + h / 2 + 14, 40, i === m - 1 ? WHITE : PALE, 'center'); ctx.restore() } break; }
      case 'cta': { const w = Math.min(hw, 760), x = hx - w / 2; const ba = ease(ub / .35); ctx.save(); ctx.globalAlpha *= ba; ctx.fillStyle = COL.red; glowOn(COL.red, 30); rr(hx - 170, hy - 150, 340, 74, 10); ctx.fill(); glowOff(); ctx.font = `800 30px Manrope`; ctx.textAlign = 'center'; ctx.fillStyle = WHITE; ctx.fillText('SUBSCRIBE', hx, hy - 103); ctx.restore();
        ctx.fillStyle = '#0a0f0d'; rr(x, hy - 30, w, 150, 12); ctx.fill(); stroke('#ffffff33', 2); rr(x, hy - 30, w, 150, 12); ctx.stroke(); spaced((b.label || 'ADD A COMMENT').toUpperCase(), x + 24, hy + 6, 16, MUTED, 'left', 4);
        (b.toggles || []).forEach((tg, i) => { const tw = 200, tx = x + 24 + i * (tw + 20), ty = hy + 40, on = i === 0 && Math.floor(t * 1.5) % 2 === 0; ctx.fillStyle = on ? acc + '22' : '#ffffff08'; rr(tx, ty, tw, 56, 28); ctx.fill(); stroke(on ? acc : '#ffffff33', 2); rr(tx, ty, tw, 56, 28); ctx.stroke(); ctx.font = `700 22px Manrope`; ctx.textAlign = 'center'; ctx.fillStyle = on ? acc : PALE; ctx.fillText(tg, tx + tw / 2, ty + 36) }); break; }
    }
    ctx.restore();
  }

  function lockup(s, u, dur, G) {
    if (!s.title || G.p) return;                                  // portrait: captions only, no second text line
    const ctx = A.ctx, acc = COL[s.accent || 'green'], start = dur * .35, a = ease((u - start) / .3); if (a <= 0) return;
    const text = s.title.toUpperCase(), hl = (s.hl || '').toUpperCase(), fs = G.lockupSize; ctx.font = `800 ${fs}px Manrope`;
    const words = text.split(' '), sp = ctx.measureText(' ').width, w = words.reduce((acc2, wd) => acc2 + ctx.measureText(wd).width, 0) + sp * (words.length - 1);
    let x = G.W / 2 - w / 2 + 22, y = G.lockupY; ctx.save(); ctx.globalAlpha *= a; ctx.translate((1 - a) * -24, 0);
    ctx.fillStyle = COL.cyan; ctx.fillRect(x - 40, y - fs * .82, 6, fs * 1.0);
    for (const wd of words) { ctx.fillStyle = wd.replace(/[^A-Z0-9%$]/g, '') === hl.replace(/[^A-Z0-9%$]/g, '') ? acc : WHITE; ctx.textAlign = 'left'; ctx.fillText(wd, x, y); x += ctx.measureText(wd).width + sp } ctx.restore();
  }

  const lex = w => w.toLowerCase().replace(/[^a-z0-9%$]/g, '');
  function beatStarts(s, beats, dur) {                                   // relative start of each beat, in seconds
    const n = beats.length, starts = new Array(n).fill(null); starts[0] = 0;
    if (s.words && s.words.length) {
      const words = s.words.map(w => ({ k: lex(w.text), start: w.start - s.start }));
      beats.forEach((b, i) => { if (i === 0 || !b.at) return; const toks = b.at.split(/\s+/).map(lex).filter(Boolean);
        for (let j = 0; j + toks.length <= words.length; j++) { if (toks.every((tk, m) => words[j + m].k === tk)) { starts[i] = Math.max(0, words[j].start - .12); break } } });
    }
    for (let i = 1; i < n; i++) if (starts[i] === null) {                // fill gaps evenly up to the next anchor
      let j = i; while (j < n && starts[j] === null) j++; const end = j < n ? starts[j] : dur, from = starts[i - 1], gaps = j - i + 1;
      for (let m = i; m < j; m++) starts[m] = from + (end - from) * (m - i + 1) / gaps; }
    for (let i = 1; i < n; i++) starts[i] = Math.max(starts[i], starts[i - 1] + .8);    // never shorter than a beat a viewer can read
    return starts;
  }
  S.scene = function (s, u, t, i) {
    const G = geo(); s._index = i; S.chrome(s, i, t);
    const beats = (s.beats && s.beats.length) ? s.beats : (s.kind === 'closing' ? [{ kind: 'cta', label: 'ADD A COMMENT', toggles: [s.button || 'SUBSCRIBE', A.project.brand] }] : []);
    const dur = s.end - s.start; if (!beats.length) { lockup(s, u, dur, G); return }
    const starts = beatStarts(s, beats, dur); let k = 0; for (let j = 0; j < starts.length; j++) if (u >= starts[j]) k = j;
    const bd = (k + 1 < starts.length ? starts[k + 1] : dur) - starts[k], ub = u - starts[k];
    beat(beats[k], s, k, ub, bd, t, G, beats.length);
    lockup(s, u, dur, G);
  };
  S.subtitle = function (s, t) {
    const group = (s.captions || []).find(c => t >= c.start && t < c.end); if (!group) return;
    const G = geo(), ctx = A.ctx, fs = G.capSize; ctx.font = `800 ${fs}px Manrope`;
    const words = group.text.split(' '), hl = (s.hl || '').toLowerCase();
    let key = words.find(w => w.toLowerCase().replace(/[^a-z0-9%$]/g, '') === hl.replace(/[^a-z0-9%$]/g, '')); if (!key) key = words.filter(w => !STOP.has(w.toLowerCase().replace(/[^a-z]/g, '')) && w.replace(/[^a-z]/gi, '').length >= 4).sort((a, b) => b.length - a.length)[0];
    const lines = A.wrap(group.text, fs, G.capMax, 800); if (lines.length > 2) A.issues.push({ time: t, error: 'Caption exceeds two lines', text: group.text });
    lines.forEach((ln, j) => { const ws = ln.split(' '), sp = ctx.measureText(' ').width, w = ws.reduce((a, x) => a + ctx.measureText(x).width, 0) + sp * (ws.length - 1); let x = G.W / 2 - w / 2, y = G.capY - (lines.length - 1 - j) * fs * 1.2;
      ctx.save(); ctx.shadowColor = '#000'; ctx.shadowBlur = 18; for (const wd of ws) { ctx.fillStyle = wd === key ? COL.green : WHITE; ctx.textAlign = 'left'; ctx.fillText(wd, x, y); x += ctx.measureText(wd).width + sp } ctx.restore() });
  };
  window.KEOU_CINEMA = { attach(api) { A = api }, ...S };
})();
