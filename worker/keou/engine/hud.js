/* Keou "hud" layer — what is drawn OVER a film when its treatment decided the film has a layer.
   The grammar is src/graphics.ts (mirrored by worker/keou/contract.py): a line along an edge with a state per
   scene, a readout of labelled values in a corner, a stamp in a corner, one card per scene at most, cinema
   subtitles. Nothing here decides what a film shows; picture.js calls draw() and subtitle() only when
   project.graphics exists, and every element is drawn from the project's own words and colour.
   Every frame is a pure function of (scene, time): the renderer splits one video across parallel workers. */
(function () {
  'use strict';
  let A = null;   // the film.js api: ctx, W, H, project, timeline, issues

  /* @kleo-pure hud-plan — pure planning, no canvas and no globals: where each element sits, what shape
     a line takes in each state, when a card starts. test/engine-hud.test.mjs evaluates this block alone. */
  const STATES = ['steady', 'pulse', 'square', 'broken', 'flat', 'off'];
  const pclamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, Number(x) || 0));
  const smooth = x => { x = pclamp(x); return x * x * (3 - 2 * x) };
  const keys = w => String(w == null ? '' : w).toLowerCase().match(/[a-z0-9%$]+/g) || [];
  function flatten(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((w, i) => {
      const t = Number(w && w.start), start = Number.isFinite(t) ? t : null;
      for (const k of keys(w && w.text)) out.push({ k, i, start });
    });
    return out;
  }
  // A deterministic 0-1 noise from two integers: the "broken" line jags the same way on every worker.
  function noise(a, b) { let h = (a * 374761393 + b * 668265263) >>> 0; h = (h ^ (h >>> 13)) * 1274126177 >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296 }
  // Safe areas: the same numbers the picture style keeps clear of platform chrome (portrait 180/420, landscape 90/150).
  function safe(W, H) { const p = H > W; return { p, top: p ? 180 : 90, bottom: p ? 420 : 150, side: p ? 60 : 96 } }
  // Where an element lives, in frame pixels. Sizes scale with the height so 1080p and 4K draw the same picture.
  function layout(kind, where, W, H) {
    const s = safe(W, H), u = H / 2160;
    if (kind === 'line') return { x0: s.side, x1: W - s.side, y: where === 'top' ? s.top + 46 * u : H - s.bottom * .58, amp: 26 * u, width: Math.max(2, Math.round(3.4 * u)) };
    const size = Math.round((kind === 'readout' ? 40 : 34) * u), lead = Math.round(size * 1.45);
    const right = /right$/.test(where), bottom = /^bottom/.test(where);
    return { size, lead, x: right ? W - s.side : s.side, align: right ? 'right' : 'left', y: bottom ? H - s.bottom - 12 * u : s.top + size * 1.3, up: bottom };
  }
  // The shape of a line in one state at one moment: n samples of vertical offset (-1..1, times amp).
  function lineShape(state, t, n) {
    const out = new Array(n).fill(0);
    if (state === 'pulse') { const c = (t * .32) % 1.4 - .2; for (let i = 0; i < n; i++) { const x = i / (n - 1), d = (x - c) / .035; out[i] = -Math.exp(-d * d) } }
    else if (state === 'square') { const shift = t * 1.1; for (let i = 0; i < n; i++) { const x = i / (n - 1) * 24 + shift; out[i] = (Math.floor(x) % 2 === 0) ? -1 : 0 } }
    else if (state === 'broken') { const k = Math.floor(t * 9); for (let i = 0; i < n; i++) { const seg = Math.floor(i / 6); out[i] = (noise(seg, k) - .5) * (noise(seg + 97, k >> 1) > .45 ? 1.6 : .2) } }
    return out;   // steady and flat: a straight line; off: not drawn at all
  }
  const lineAlpha = state => state === 'off' ? 0 : state === 'flat' ? .38 : state === 'steady' ? .78 : .92;
  // When each card of a scene starts, in seconds from the scene start: on its anchor word (s.words carries
  // absolute times, s.start the scene start), else at the scene start. Never past the scene's end.
  function cardTimes(s, cards, dur) {
    const said = flatten(s && s.words), base = Number(s && s.start) || 0, span = Math.max(Number(dur) || 0, .1);
    return (Array.isArray(cards) ? cards : []).map(c => {
      const toks = keys(c && c.at); let at = 0;
      if (toks.length) for (let j = 0; j + toks.length <= said.length; j++)
        if (toks.every((tk, m) => said[j + m].k === tk) && said[j].start !== null) { at = Math.max(0, said[j].start - base - .08); break }
      const hold = pclamp(c && c.hold, 1.2, 4) || 2.2;
      return { at: Math.min(at, Math.max(0, span - .6)), hold: Math.min(hold, Math.max(.6, span - at)) };
    });
  }
  // The same colour with an alpha, from "#rrggbb".
  function tint(hex, a) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '')); if (!m) return `rgba(255,255,255,${a})`; return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` }
  /* @end hud-plan */

  const MONO = 'KeouMono, monospace', CAPS = 'KleoReal, Manrope, sans-serif';
  const prevScene = i => (A && A.timeline && A.timeline.scenes && i > 0) ? A.timeline.scenes[i - 1] : null;
  const hudOf = s => (s && s.hud && typeof s.hud === 'object' && !Array.isArray(s.hud)) ? s.hud : {};
  const fade = u => smooth(u / .35);
  function setFont(family, size, weight, tracking) {
    const ctx = A.ctx; ctx.font = `${weight} ${size}px ${family}`;
    try { ctx.letterSpacing = (tracking > 0 ? tracking.toFixed(2) : '0') + 'px' } catch (e) { /* not supported */ }
    ctx.textBaseline = 'alphabetic';
  }
  function spacingOff() { try { A.ctx.letterSpacing = '0px' } catch (e) { } }

  /* ---- the line ------------------------------------------------------------ */
  function drawLine(el, state, t, alpha, accent) {
    if (!state || state === 'off' || alpha <= 0) return;
    const ctx = A.ctx, L = layout('line', el.edge, A.W, A.H), n = 160, ys = lineShape(state, t, n);
    ctx.save(); ctx.globalAlpha *= alpha * lineAlpha(state);
    ctx.strokeStyle = accent; ctx.lineWidth = L.width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = tint(accent, .55); ctx.shadowBlur = L.width * 3;
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = L.x0 + (L.x1 - L.x0) * i / (n - 1), y = L.y + ys[i] * L.amp; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) }
    ctx.stroke(); ctx.restore();
  }
  /* ---- the readout and the stamp ------------------------------------------- */
  function drawReadout(el, values, before, u, accent) {
    const ctx = A.ctx, L = layout('readout', el.corner, A.W, A.H), rows = el.rows || [];
    if (!rows.length) return;
    setFont(MONO, L.size, 400, 0);
    const labelW = Math.max(...rows.map(r => ctx.measureText(r + '  ').width));
    const total = rows.length * L.lead, y0 = L.up ? L.y - total + L.lead : L.y;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = L.size * .5;
    rows.forEach((label, r) => {
      const v = Array.isArray(values) ? String(values[r] == null ? '' : values[r]) : '';
      const was = Array.isArray(before) ? String(before[r] == null ? '' : before[r]) : v;
      const y = y0 + r * L.lead;
      ctx.textAlign = 'left';
      const width = labelW + ctx.measureText(v).width, x = L.align === 'right' ? L.x - width : L.x;
      ctx.globalAlpha = .78; ctx.fillStyle = accent; ctx.fillText(label, x, y);
      ctx.globalAlpha = v === was ? .96 : .96 * fade(u); ctx.fillStyle = '#ffffff'; ctx.fillText(v, x + labelW, y);
    });
    ctx.restore(); spacingOff();
  }
  function drawStamp(el, text, before, u, accent) {
    if (!text) return;
    const ctx = A.ctx, L = layout('stamp', el.corner, A.W, A.H);
    setFont(CAPS, L.size, 500, L.size * .16);
    ctx.save(); ctx.globalAlpha *= (text === before ? .85 : .85 * fade(u));
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = L.size * .5;
    ctx.textAlign = 'left'; const w = ctx.measureText(String(text).toUpperCase()).width;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillText(String(text).toUpperCase(), L.align === 'right' ? L.x - w : L.x, L.y);
    ctx.fillStyle = accent; ctx.fillRect(L.align === 'right' ? L.x - w - 14 * (A.H / 2160) - 3 : L.x - 14 * (A.H / 2160), L.y - L.size * .95, 3, L.size * 1.15);
    ctx.restore(); spacingOff();
  }
  /* ---- the cards ----------------------------------------------------------- */
  // Returns the dim the card asks for (0-1), so the caller can paint it under everything else.
  function cardAt(s, u, dur) {
    const cards = Array.isArray(s.cards) ? s.cards : []; if (!cards.length) return null;
    const times = cardTimes(s, cards, dur);
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i], w = times[i], from = w.at, to = w.at + w.hold;
      if (u >= from && u < to) { const a = Math.min(smooth((u - from) / .25), smooth((to - u) / .25)); return { text: String(c.text || ''), a } }
    }
    return null;
  }
  function drawCard(card, accent) {
    const ctx = A.ctx, W = A.W, H = A.H, u = H / 2160;
    ctx.save(); ctx.globalAlpha *= card.a;
    ctx.fillStyle = 'rgba(0,0,0,.58)'; ctx.fillRect(0, 0, W, H);
    let size = Math.round(150 * u); const maxW = W * .78, text = card.text.toUpperCase();
    setFont(CAPS, size, 600, size * .14);
    while (ctx.measureText(text).width > maxW && size > 40 * u) { size = Math.round(size * .92); setFont(CAPS, size, 600, size * .14) }
    ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = size * .25;
    ctx.fillStyle = '#ffffff'; ctx.fillText(text, W / 2, H / 2 + size * .36);
    ctx.fillStyle = accent; ctx.fillRect(W / 2 - 60 * u, H / 2 + size * .62, 120 * u, Math.max(2, 4 * u));
    ctx.restore(); spacingOff();
  }

  /* ---- the entry points picture.js calls ----------------------------------- */
  const HUD = {
    attach(api) { A = api },
    // Everything of the layer for one frame: the card's dim first, then the persistent elements, then the card.
    draw(s, u, t, i, G, g) {
      const accent = (g && g.accent) || '#ffffff', hud = hudOf(s), was = hudOf(prevScene(i)), dur = Math.max((s.end - s.start) || 0, .1);
      const card = cardAt(s, u, dur);
      if (card) { A.ctx.save(); A.ctx.globalAlpha *= card.a; A.ctx.fillStyle = 'rgba(0,0,0,.58)'; A.ctx.fillRect(0, 0, A.W, A.H); A.ctx.restore() }
      for (const el of (g && Array.isArray(g.hud)) ? g.hud : []) {
        const now = hud[el.id], before = was[el.id];
        if (el.kind === 'line') {
          const state = typeof now === 'string' ? now : (typeof before === 'string' ? before : 'steady');
          const prev = typeof before === 'string' ? before : state;
          if (prev !== state && u < .35) { drawLine(el, prev, t, 1 - fade(u), accent); drawLine(el, state, t, fade(u), accent) }
          else drawLine(el, state, t, 1, accent);
        } else if (el.kind === 'readout') drawReadout(el, Array.isArray(now) ? now : (Array.isArray(before) ? before : []), Array.isArray(before) ? before : null, u, accent);
        else if (el.kind === 'stamp') drawStamp(el, typeof now === 'string' ? now : (typeof before === 'string' ? before : ''), typeof before === 'string' ? before : null, u, accent);
      }
      if (card) { A.ctx.save(); A.ctx.globalAlpha = 1; drawCard({ ...card }, accent); A.ctx.restore() }
    },
    // Cinema subtitles: thin, white, lowercase, at most two lines, no plate, no karaoke.
    subtitle(s, t, G) {
      const group = (s.captions || []).find(c => t >= c.start && t < c.end); if (!group) return;
      const ctx = A.ctx, size = Math.round(G.subSize * .78), maxW = G.subMax, text = String(group.text || '').toLowerCase();
      setFont(CAPS, size, 400, size * .02);
      const words = text.split(/\s+/).filter(Boolean), lines = []; let cur = '';
      for (const w of words) { const trial = cur ? cur + ' ' + w : w; if (ctx.measureText(trial).width <= maxW || !cur) cur = trial; else { lines.push(cur); cur = w } }
      if (cur) lines.push(cur);
      if (lines.length > 2) { A.issues.push({ time: t, error: 'Caption exceeds two lines', text: group.text }); lines.length = 2 }
      ctx.save(); ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = size * .35; ctx.shadowOffsetY = size * .06;
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      lines.forEach((ln, i) => ctx.fillText(ln, G.W / 2, G.subY - (lines.length - 1 - i) * size * 1.3));
      ctx.restore(); spacingOff();
    },
    STATES, layout, lineShape, cardTimes, tint,
  };
  window.KEOU_HUD = HUD;
})();
