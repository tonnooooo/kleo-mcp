/* Keou "picture" style — the Kleo cartoon and realistic looks. Several full-screen pictures per
   scene, cut on the narration like a short documentary: cover-fit + Ken Burns, a short crossfade
   on the cut, big fitted words for the point being made and karaoke subtitles underneath.
   No HUD, no corner marks, no progress bar, no drawn icons, no beats — the picture carries the
   scene. Portrait and landscape, deterministic, display only: every string comes from project.json. */
(function () {
  const S = {}; let A = null;

  // Accent table shared with the cinema style. NOTE: docs/PICTURE-STYLE.md §4 lists cyan #39d5ff
  // and red #ff3b5c (cinema.js still carries #2bb0ff / #ff3b3b); the specification wins here.
  const COL = { green: '#00ff88', cyan: '#39d5ff', red: '#ff3b5c', amber: '#ffb020' };
  const INK = '#0b0b0f', WHITE = '#ffffff', DARK = '#111111', POP = '#FFD23F';
  // A missing font file must never break a render: both stacks fall back to the bundled Manrope.
  const CARTOON = 'KleoCartoon, Manrope, sans-serif', REAL = 'KleoReal, Manrope, sans-serif';

  /* @kleo-pure picture-plan — pure planning, no canvas and no globals: shot timing from the
     narration, the shot grammar and the cover-fit + Ken Burns rect it plays, and caption line
     fitting against a measure function supplied by the caller. test/engine-picture.test.mjs evaluates this block
     on its own, so nothing in here may touch the page, the drawing surface or the project. */
  const SHOT_FADE = .35;                       // crossfade between two pictures of the same scene
  const PUNCH = .03, PUNCH_IN = .3;            // 3% scale punch on the incoming picture, gone in 0.3 s
  const MIN_SHOT = .8;                         // a picture nobody can see is not a picture
  const MOTIONS = ['in', 'out', 'left', 'right'];   // deprecated shot.motion, kept as an alias
  /* Shot grammar. A shot says what it is FOR (`shot_kind`), in story terms, and never how the
     camera moves; one table turns the ten story kinds into one camera move. The kinds, the moves,
     the strengths and the durations are the same table the planner and the validator carry
     (docs/PICTURE-STYLE.md §1a) — here only the RENDERER differs: this is still the stills path, so
     a move is played as Ken Burns on a photograph. Generated motion replaces that in a later phase
     and the grammar does not change with it: same kinds, same moves, same strengths.
     Direction names say how the PICTURE travels across the frame ("left" slides it leftwards),
     which is what the deprecated shot.motion always meant.
     zoom = 1 + hold + z[i] * strength; dx / dy = travel * strength, as a share of the width / height.
     `hold` is the crop a lateral or vertical move needs simply to have somewhere to travel, so it
     does NOT scale with strength: the strength scales the movement, not the framing. `cls` is the
     move class the sequencing rules count on (PUSH / LATERAL / VERTICAL / STILL) and `loud` marks
     the moves the validator allows at most twice per 40 s and never side by side. */
  const MOVES = {
    crash_zoom_in:   { hold: 0,   z: [0, .18], dx: 0,    dy: 0,   ease: 'crash', cls: 'PUSH',     loud: true,  legacy: 'in' },
    push_in:         { hold: 0,   z: [0, .10], dx: 0,    dy: 0,   ease: 'ease',  cls: 'PUSH',     loud: false, legacy: 'in' },
    push_in_dutch:   { hold: .01, z: [0, .12], dx: .05,  dy: 0,   ease: 'ease',  cls: 'PUSH',     loud: true,  legacy: 'in' },
    pull_out:        { hold: 0,   z: [.10, 0], dx: 0,    dy: 0,   ease: 'ease',  cls: 'PUSH',     loud: false, legacy: 'out' },
    track_left:      { hold: .04, z: [0, 0],   dx: -.06, dy: 0,   ease: 'ease',  cls: 'LATERAL',  loud: false, legacy: 'left' },
    track_right:     { hold: .04, z: [0, 0],   dx: .06,  dy: 0,   ease: 'ease',  cls: 'LATERAL',  loud: false, legacy: 'right' },
    track_alongside: { hold: .05, z: [0, 0],   dx: .10,  dy: 0,   ease: 'ease',  cls: 'LATERAL',  loud: false, legacy: 'right' },
    orbit_left:      { hold: .03, z: [0, .06], dx: -.08, dy: 0,   ease: 'ease',  cls: 'LATERAL',  loud: true,  legacy: 'left' },
    crane_down:      { hold: .05, z: [0, 0],   dx: 0,    dy: .10, ease: 'ease',  cls: 'VERTICAL', loud: false, legacy: null },
    static_hold:     { hold: 0,   z: [0, 0],   dx: 0,    dy: 0,   ease: 'ease',  cls: 'STILL',    loud: false, legacy: null },
  };
  // The ten kinds. `static_forced` is a routing rule, not a taste: the planner forces it whenever
  // the picture shows working hands, a crowd, legible signage, a mechanism or two people
  // interacting, because those four break under any camera move.
  const LEGACY_MOVE = { in: 'push_in', out: 'pull_out', left: 'track_left', right: 'track_right' };
  const pclamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, Number(x) || 0));
  const smooth = x => { x = pclamp(x); return x * x * (3 - 2 * x) };
  const pop = x => 1 - (1 - pclamp(x)) ** 4;
  const back = x => { x = pclamp(x); return 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2 };   // lands with a small overshoot
  const key = w => String(w == null ? '' : w).toLowerCase().replace(/[^a-z0-9%$]/g, '');
  // worker/keou/prepare.py (align_words) writes one s.words entry per *script* word and glues a
  // token with no letters ("—", "...") onto the entry before it, while a word such as "don't" or
  // "17,600" holds two spoken tokens of its own. So an entry may carry two words, one, or none,
  // and s.captions splits them apart again on whitespace. Everything that lines the narration up
  // with the script therefore compares this flat token stream, never entry against entry: one
  // merged entry in a long line used to shift every following word by one.
  const keys = w => String(w == null ? '' : w).toLowerCase().match(/[a-z0-9%$]+/g) || [];
  // Spoken tokens in order: `k` the token, `i` the s.words entry it came from, `start` that
  // entry's absolute time (the finest timing the timeline carries) or null when it has none.
  function flatten(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((w, i) => {
      const t = Number(w && w.start), start = Number.isFinite(t) ? t : null;
      for (const k of keys(w && w.text)) out.push({ k, i, start });
    });
    return out;
  }
  const STOPS = new Set('the a an and or of to in on at for with your you it is are was were be this that they them their one two not no but into from by as if so we he she its'.split(' '));

  // The pictures of one scene, always at least one (an empty shot renders as an accent gradient).
  function sceneShots(s) {
    const list = (s && Array.isArray(s.shots) && s.shots.length) ? s.shots : [{ image: s && s.image }];
    return list.map(x => (x && typeof x === 'object') ? x : {});
  }
  // DEPRECATED. The old camera field: what the shot asks for, else in / out / left / right by
  // index. A move picked by position says nothing about the shot, which is the whole reason the
  // grammar exists; it survives only so storyboards written before the grammar still render.
  function shotMotion(shot, index) {
    const m = shot && shot.motion;
    return MOTIONS.indexOf(m) >= 0 ? m : MOTIONS[(((index | 0) % 4) + 4) % 4];
  }
  // What picture n is FOR, resolved through the grammar to one camera move and its strength.
  // `shot_kind` wins; `shot.motion` is the deprecated alias; with neither, the old index rotation.
  // Pure: the same shot at the same index always resolves to the same move, on every worker.
  // What the shot asks the camera to do. The server resolved the story kind into a concrete move and its strength
  // before the storyboard was stored (src/shot-grammar.ts), so there is no grammar here to drift: a name and a number.
  // A storyboard written before the grammar carries the old in|out|left|right, or nothing, and still renders.
  function shotGrammar(shot, index) {
    const named = shot && typeof shot.motion === 'string' && Object.prototype.hasOwnProperty.call(MOVES, shot.motion)
      ? shot.motion : null;
    // The grammar (src/shot-grammar.ts) declares thirteen moves; this table draws ten. The three it does not draw —
    // orbit_right, crane_up, whip_pan — are mirrors no shot kind resolves to today, so nothing reaches here with one.
    // If one ever does, a picture that holds still is a picture; `MOVES[move].cls` on an unknown name is a TypeError
    // thrown from inside the frame loop, on a machine that has already been paid for and after every picture was drawn.
    const move = (named || LEGACY_MOVE[shotMotion(shot, index)]) in MOVES ? (named || LEGACY_MOVE[shotMotion(shot, index)]) : 'static_hold';
    const raw = shot && typeof shot.strength === 'number' && isFinite(shot.strength) ? shot.strength : null;
    const strength = raw === null ? 1 : Math.min(1, Math.max(0, raw));
    return { kind: null, move, strength, cls: MOVES[move].cls, loud: MOVES[move].loud };
  }
  // Relative start of every picture inside the scene, in seconds. A shot with an `at` cuts when
  // that word is spoken (s.words carries absolute word times, s.start the scene start); the rest
  // share what is left evenly. Always strictly increasing, never shorter than one readable
  // picture, and the last picture always keeps room before the scene ends.
  function shotStarts(s, shots, dur) {
    const n = shots.length, starts = new Array(n).fill(null);
    starts[0] = 0; if (n < 2) return starts;
    const span = Math.max(Number(dur) || 0, .1), min = Math.min(MIN_SHOT, span / n);
    const said = flatten(s && s.words), base = Number(s && s.start) || 0;
    if (said.length) shots.forEach((sh, i) => {
      if (!i || !sh || !sh.at) return;
      const toks = keys(sh.at); if (!toks.length) return;      // `at` is quoted from the same script
      for (let j = 0; j + toks.length <= said.length; j++)
        if (toks.every((tk, m) => said[j + m].k === tk) && said[j].start !== null) {
          starts[i] = Math.max(0, said[j].start - base - .12); break;
        }
    });
    for (let i = 1; i < n; i++) if (starts[i] === null) {          // even split up to the next anchored cut
      let j = i; while (j < n && starts[j] === null) j++;
      const end = j < n ? starts[j] : span, from = starts[i - 1], gaps = j - i + 1;
      for (let m = i; m < j; m++) starts[m] = from + (end - from) * (m - i + 1) / gaps;
    }
    for (let i = 1; i < n; i++) starts[i] = Math.max(starts[i], starts[i - 1] + min);   // readable
    for (let i = n - 1; i > 0; i--) starts[i] = Math.min(starts[i], span - (n - i) * min);   // inside the scene
    return starts;
  }
  const shotFade = ub => pop(pclamp(ub / SHOT_FADE));               // alpha of the incoming picture
  const shotPunch = ub => 1 + PUNCH * (1 - smooth(pclamp(ub / PUNCH_IN)));
  // Ken Burns progress of the picture that started `ub` seconds ago. A picture is on screen until
  // the next one has finished fading over it, so its move runs over span + SHOT_FADE: the outgoing
  // picture keeps travelling under the crossfade instead of freezing on its last frame, which read
  // as a stutter. The last picture of a scene has nothing after it and lands exactly on the cut.
  const shotProgress = (ub, span, hasNext) => pclamp(ub / (Math.max(Number(span) || 0, .1) + (hasNext ? SHOT_FADE : 0)));
  // Cover-fit + Ken Burns rect for a picture of iw×ih on a W×H frame at shot progress p (0..1),
  // playing `move` at `strength` (0..1, 1 = the full amplitude of the table; default 1).
  // The rect always covers the frame: the drift is clamped to the overflow the zoom leaves on
  // that side, so an edge of the frame is never empty whatever the picture's shape. A deprecated
  // motion name ('in' | 'out' | 'left' | 'right') is accepted and renders exactly as it always did.
  function kenBurns(move, iw, ih, W, H, p, punch, strength) {
    const m = Object.prototype.hasOwnProperty.call(MOVES, move) ? move : (LEGACY_MOVE[move] || 'push_in');
    const M = MOVES[m], k = strength === undefined || strength === null ? 1 : pclamp(strength);
    p = pclamp(p); const sp = smooth(p), pu = Math.max(1, Number(punch) || 1);
    const e = M.ease === 'crash' ? pop(p) : p;      // a crash zoom lands most of its travel at once
    const zoom = (1 + M.hold + (M.z[0] + (M.z[1] - M.z[0]) * e) * k) * pu;
    const cover = Math.max(W / iw, H / ih) * zoom, w = iw * cover, h = ih * cover;
    const ox = Math.max(0, (w - W) / 2), oy = Math.max(0, (h - H) / 2);
    // Half of the travel on each side of centre, never further than the overflow the zoom leaves
    // on that side (an edge of the frame is never empty). A move with no travel gives a plain 0.
    const pan = (t, over) => t ? Math.sign(t) * Math.min(over, Math.abs(t) / 2) * (2 * sp - 1) : 0;
    const panX = pan(M.dx * k * W, ox), panY = pan(M.dy * k * H, oy);
    return { x: W / 2 + panX - w / 2, y: H / 2 + panY - h / 2, w, h, zoom, panX, panY, ox, oy,
             move: m, cls: M.cls, strength: k, motion: M.legacy };
  }
  // Break `value` into at most `lines` lines no wider than `width`, shrinking the size from
  // `size` down to `min`. `measure(text, size)` is the caller's text measurement.
  function fitLines(value, measure, width, lines, size, min, step) {
    const parts = String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean);
    let s = Math.max(min, size), out = [], w = 0;
    if (!parts.length) return { size: s, lines: [], width: 0, fits: true };
    for (; ;) {
      out = []; let cur = '';
      for (const word of parts) {
        const next = cur ? cur + ' ' + word : word;
        if (cur && measure(next, s) > width) { out.push(cur); cur = word } else cur = next;
      }
      if (cur) out.push(cur);
      w = out.reduce((a, l) => Math.max(a, measure(l, s)), 0);
      if ((out.length <= lines && w <= width) || s <= min) break;
      s = Math.max(min, s - (step || 3));
    }
    return { size: s, lines: out, width: w, fits: out.length <= lines && w <= width + .5 };
  }
  // Word-level timing for one caption group: the groups and s.words come from the same aligned
  // script, so the group's spoken tokens are a contiguous run of the scene's. Anchor on the start
  // time, then on the text; with no match the words carry no time and the caller highlights the
  // key word instead. A written token that says nothing ("—") never gets a time of its own, so it
  // cannot steal the karaoke highlight from the word beside it.
  function groupWords(words, group) {
    const gw = String((group && group.text) || '').split(/\s+/).filter(Boolean);
    const all = flatten(words), need = [];
    gw.forEach((w, m) => { for (const k of keys(w)) need.push({ k, m }) });
    const runs = j => j >= 0 && need.length > 0 && j + need.length <= all.length && need.every((n, m) => all[j + m].k === n.k);
    let at = -1; const gs = Number(group && group.start);
    if (Number.isFinite(gs)) for (let j = 0; j < all.length; j++)      // a group always opens on an entry
      if ((!j || all[j].i !== all[j - 1].i) && all[j].start !== null && Math.abs(all[j].start - gs) < 1e-6) { at = j; break }
    if (!runs(at)) { at = -1; for (let j = 0; j + need.length <= all.length; j++) if (runs(j)) { at = j; break } }
    const times = new Array(gw.length).fill(null);
    // Backwards: when one written word holds several spoken tokens it takes the first one's time.
    if (at >= 0) for (let m = need.length - 1; m >= 0; m--) times[need[m].m] = all[at + m].start;
    return gw.map((text, m) => ({ text, start: times[m] }));
  }
  // Without word timings, colour the same word the cinema style would: the scene keyword when it
  // is in the group, else the longest word that carries meaning.
  function keyWord(value, hl) {
    const ws = String(value || '').split(/\s+/).filter(Boolean), h = key(hl);
    let k = h ? ws.find(w => key(w) === h) : null;
    if (!k) k = ws.filter(w => !STOPS.has(key(w)) && key(w).length >= 4).sort((a, b) => b.length - a.length)[0];
    return k || '';
  }
  /* @end picture-plan */

  const isReal = () => (A.project && A.project.look) === 'realistic';
  const family = () => isReal() ? REAL : CARTOON;
  const accent = s => COL[s && s.accent] || COL.green;

  // Portrait safe areas: 180 px of platform chrome at the top, 420 px at the bottom.
  // Landscape: 90 / 150. Nothing is drawn outside them.
  function geo() {
    const W = A.W, H = A.H, p = H > W;
    return p
      ? {
        W, H, p, safeTop: 180, safeBottom: 420,
        capY: Math.round(H * .36), capMax: Math.round(W * .84), capSize: 104, capMin: 54, capX: W / 2,
        subY: H - 500, subMax: Math.round(W * .84), subSize: 58, subMin: 34,
        chapX: 60, chapY: 234, chapSize: 30,
        closeY: Math.round(H * .40), btnY: Math.round(H * .58), btnH: 96, btnSize: 40, btnMin: 360,
        brandY: 234, brandSize: 26, brandX: W - 60, brandAlign: 'right'   // opposite the chapter pill: the bottom belongs to the subtitles
      }
      : {
        W, H, p, safeTop: 90, safeBottom: 150,
        capY: H - 300, capMax: Math.round(W * .52), capSize: 76, capMin: 40, capX: 96,
        subY: H - 150, subMax: Math.round(W * .60), subSize: 46, subMin: 28,
        chapX: 72, chapY: 138, chapSize: 26,
        closeY: Math.round(H * .34), btnY: Math.round(H * .56), btnH: 78, btnSize: 34, btnMin: 300,
        brandY: H - 158, brandSize: 22, brandX: W - 72, brandAlign: 'right'
      };
  }

  /* ---- text ---------------------------------------------------------------- */
  // One place sets the font, so the tracking of the realistic look can never leak into the next
  // string. letterSpacing is a Chromium extension: where it is missing the type simply has none.
  function setFont(size, weight, tracking) {
    const ctx = A.ctx; ctx.font = `${weight} ${size}px ${family()}`;
    try { ctx.letterSpacing = (tracking > 0 ? tracking.toFixed(2) : '0') + 'px' } catch (e) { /* not supported */ }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  function spacingOff() { try { A.ctx.letterSpacing = '0px' } catch (e) { } }
  const measurer = (weight, track) => (value, size) => { setFont(size, weight, size * track); return A.ctx.measureText(value).width };
  function widths(ws) { const ctx = A.ctx, sp = ctx.measureText(' ').width; return { sp, each: ws.map(w => ctx.measureText(w).width) } }
  function rr(x, y, w, h, r) { const ctx = A.ctx; ctx.beginPath(); ctx.roundRect(x, y, w, h, r) }
  function outline(o) {
    const ctx = A.ctx; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.miterLimit = 2;
    ctx.strokeStyle = o.strokeColor || DARK; ctx.lineWidth = o.stroke;
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = o.size * .26; ctx.shadowOffsetY = o.size * .08;
  }
  // One line of words. The outline of the still words is drawn first, so a heavy stroke never
  // bites into the fill of the word beside it; a word that is being spoken carries its own
  // outline inside its scale. `x` is the left edge unless the line is centred or right aligned.
  function drawWords(ws, x, y, o) {
    const ctx = A.ctx; setFont(o.size, o.weight, o.tracking || 0);
    const { sp, each } = widths(ws), total = each.reduce((a, w) => a + w, 0) + sp * (ws.length - 1);
    const left = o.align === 'center' ? x - total / 2 : o.align === 'right' ? x - total : x;
    const at = []; let cx = left; for (const w of each) { at.push(cx); cx += w + sp }
    const hot = ws.map((w, i) => o.hot ? !!o.hot(w, i) : false);
    const grew = i => hot[i] && o.grow > 1 ? o.grow : 1;
    if (o.band > 0) {                                     // a dark plate no larger than the line itself
      const pad = o.size * .30; ctx.save(); ctx.fillStyle = `rgba(0,0,0,${o.band})`;
      rr(left - pad, y - o.size * .92, total + pad * 2, o.size * 1.34, o.size * .26); ctx.fill(); ctx.restore();
    }
    if (o.stroke > 0) {
      ctx.save(); outline(o); ws.forEach((w, i) => { if (grew(i) === 1) ctx.strokeText(w, at[i], y) }); ctx.restore();
    }
    ws.forEach((w, i) => {
      const g = grew(i); ctx.save();
      if (g !== 1) { const mid = at[i] + each[i] / 2; ctx.translate(mid, y); ctx.scale(g, g); ctx.translate(-mid, -y) }
      if (o.stroke > 0) { if (g !== 1) { outline(o); ctx.strokeText(w, at[i], y) } }
      else { ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = o.size * .30; ctx.shadowOffsetY = o.size * .09 }
      ctx.shadowBlur = o.stroke > 0 ? 0 : ctx.shadowBlur;   // the outline already carries the drop shadow
      ctx.fillStyle = hot[i] ? (o.hi || POP) : (o.color || WHITE); ctx.fillText(w, at[i], y);
      ctx.restore();
    });
    return { left, total };
  }

  /* ---- chrome -------------------------------------------------------------- */
  S.background = function (t) { const ctx = A.ctx, G = geo(); ctx.fillStyle = INK; ctx.fillRect(0, 0, G.W, G.H) };
  // No progress bar in this style: the pictures give the pace.
  S.progress = function (t) { };
  // Optional chapter label, top left inside the safe area. Cartoon: an accent pill that pops in.
  // Realistic: light tracked capitals behind a thin accent rule, fading in.
  S.chrome = function (s, i, t) {
    if (!s.chapter) return;
    const ctx = A.ctx, G = geo(), acc = accent(s), u = t - (Number(s.start) || 0), value = String(s.chapter);
    if (!isReal()) {
      setFont(G.chapSize, 700, 0);
      const w = ctx.measureText(value).width, padX = G.chapSize * .8, h = G.chapSize * 1.9;
      const a = pop(u / .24), sc = .84 + .16 * a + .06 * Math.sin(Math.PI * pclamp(u / .24));
      ctx.save(); ctx.globalAlpha *= Math.min(1, u / .12);
      ctx.translate(G.chapX, G.chapY); ctx.scale(sc, sc); ctx.translate(-G.chapX, -G.chapY);
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
      ctx.fillStyle = acc; rr(G.chapX, G.chapY - h * .68, w + padX * 2, h, h / 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.fillStyle = DARK; ctx.fillText(value, G.chapX + padX, G.chapY);
      ctx.restore();
    } else {
      const size = G.chapSize, a = pop(u / .3);
      ctx.save(); ctx.globalAlpha *= a; ctx.translate((1 - a) * -10, 0);
      ctx.fillStyle = acc; ctx.fillRect(G.chapX, G.chapY - size * 1.02, 3, size * 1.3);
      setFont(size, 500, 4);
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText(value.toUpperCase(), G.chapX + 20, G.chapY);
      ctx.restore();
    }
    spacingOff();
  };

  /* ---- the pictures -------------------------------------------------------- */
  function paint(s, shot, index, p, alpha, punch) {
    const ctx = A.ctx, G = geo(), img = shot && shot.image && A.images ? A.images[shot.image] : null;
    ctx.save(); ctx.globalAlpha *= pclamp(alpha);
    if (img && img.width && img.height) {
      // A static_forced shot holds absolutely still: not even the 3% entrance punch of a cut,
      // because it is static precisely so that hands, a crowd or signage do not move.
      const g = shotGrammar(shot, index), still = g.move === 'static_hold';
      const r = kenBurns(g.move, img.width, img.height, G.W, G.H, p, still ? 1 : punch, g.strength);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';   // 4x upscale: 'high' costs frames and shows no difference
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
    } else {                                              // no picture: a quiet accent-to-black wash
      const acc = accent(s), g = ctx.createLinearGradient(0, 0, 0, G.H);
      g.addColorStop(0, acc + '5c'); g.addColorStop(.55, acc + '1a'); g.addColorStop(1, INK + '00');
      ctx.fillStyle = INK; ctx.fillRect(0, 0, G.W, G.H);
      ctx.fillStyle = g; ctx.fillRect(0, 0, G.W, G.H);
    }
    ctx.restore();
  }
  // Flat dim, a bottom gradient for the subtitles, a top gradient only while something is written
  // up there, and a light vignette. Drawn once, over both pictures of a crossfade.
  // Four full-frame fills at 2160x3840 (one of them a radial gradient) cost more per frame than the
  // picture itself, and they never change: each of the two variants is painted once into an offscreen
  // canvas and then blitted. Same pixels, deterministic, ~1 composite instead of ~4 fills.
  const veils = new Map();
  function veilLayer(W, H, topOn) {
    const k = W + 'x' + H + ':' + (topOn ? 1 : 0);
    let c = veils.get(k);
    if (c) return c;
    c = (typeof OffscreenCanvas === 'function') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(0, 0, W, H);
    const gb = x.createLinearGradient(0, H * .5, 0, H);
    gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,.65)');
    x.fillStyle = gb; x.fillRect(0, H * .5, W, H * .5);
    if (topOn) {
      const gt = x.createLinearGradient(0, 0, 0, H * .3);
      gt.addColorStop(0, 'rgba(0,0,0,.35)'); gt.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gt; x.fillRect(0, 0, W, H * .3);
    }
    const v = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .42, W / 2, H / 2, Math.max(W, H) * .72);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.35)');
    x.fillStyle = v; x.fillRect(0, 0, W, H);
    veils.set(k, c);
    return c;
  }
  function veil(G, topOn) {
    A.ctx.drawImage(veilLayer(G.W, G.H, !!topOn), 0, 0);
  }

  /* ---- the words on the picture -------------------------------------------- */
  function captionOf(s, shot, index) {
    const own = shot && shot.caption ? String(shot.caption) : '';
    const value = own || (index === 0 ? String(s.title || '') : '');
    if (!value.trim()) return null;
    return { text: value, hl: String((own ? shot.hl : s.hl) || '') };
  }
  // The caption of the current picture: fitted, at most three lines, never over the subtitles.
  // Cartoon: heavy outlined type with a small tilt that pops in. Realistic: tracked capitals that
  // rise into place under a growing accent rule.
  function caption(s, cap, u, G, middle) {
    const ctx = A.ctx, real = isReal(), acc = accent(s);
    const weight = real ? 700 : 800, track = real ? .04 : 0;
    const value = real ? cap.text.toUpperCase() : cap.text;
    const hl = new Set(String(cap.hl || '').split(/\s+/).map(key).filter(Boolean));
    const f = fitLines(value, measurer(weight, track), G.capMax, 3, G.capSize, G.capMin);
    if (!f.lines.length) return;
    if (!f.fits) A.issues.push({ time: A.frameTime, error: 'Caption does not fit the safe area', text: cap.text });
    const lh = f.size * 1.14, height = f.lines.length * lh;
    const subTop = G.subY - G.subSize * 1.2 - G.subSize * .92;          // room for two subtitle lines
    let bottom = middle ? G.closeY + height / 2 : (G.p ? G.capY + height / 2 : G.capY);
    bottom = Math.min(bottom, subTop - 30);
    const top = Math.max(bottom - height, G.safeTop + f.size * .2);
    const x = middle || G.p ? G.W / 2 : G.capX, align = (middle || G.p) ? 'center' : 'left';
    ctx.save();
    if (!real) {
      const a = pop(u / .18), sc = 1.15 - .15 * a, cx = x, cy = top + height / 2;
      ctx.globalAlpha *= Math.min(1, u / .1);
      ctx.translate(cx, cy); ctx.rotate(-2 * Math.PI / 180); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    } else {
      const a = pop(u / .25); ctx.globalAlpha *= a; ctx.translate(0, (1 - a) * 20);
    }
    let last = null;
    f.lines.forEach((ln, i) => {
      last = drawWords(ln.split(' '), x, top + i * lh + f.size * .86, {
        size: f.size, weight, tracking: f.size * track, align, color: WHITE, hi: real ? acc : POP,
        hot: w => hl.has(key(w)), stroke: real ? 0 : Math.max(6, f.size * .11), strokeColor: DARK
      });
    });
    if (real && last) {                                    // the accent rule grows under the last line
      const g = pop(u / .3), h = Math.max(4, f.size * .07);
      ctx.fillStyle = acc; ctx.fillRect(last.left, top + (f.lines.length - 1) * lh + f.size * 1.16, last.total * g, h);
    }
    ctx.restore(); spacingOff();
  }

  /* ---- closing ------------------------------------------------------------- */
  function button(s, u, G) {
    const ctx = A.ctx, real = isReal(), value = String(s.button || 'Subscribe');
    const text = real ? value.toUpperCase() : value, weight = real ? 600 : 800, track = real ? G.btnSize * .06 : 0;
    setFont(G.btnSize, weight, track);
    const w = ctx.measureText(text).width, pw = Math.max(w + G.btnSize * 3, G.btnMin), ph = G.btnH;
    const x = G.W / 2 - pw / 2, y = G.btnY - ph / 2, a = pop((u - .35) / .3);
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha *= a;
    if (!real) {
      const b = .78 + .22 * back(pclamp((u - .35) / .42));
      ctx.translate(G.W / 2, G.btnY); ctx.scale(b, b); ctx.translate(-G.W / 2, -G.btnY);
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 8;
      ctx.fillStyle = POP; rr(x, y, pw, ph, ph / 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.fillStyle = DARK;
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.35)'; rr(x, y, pw, ph, ph / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2.5; rr(x, y, pw, ph, ph / 2); ctx.stroke();
      ctx.fillStyle = WHITE;
    }
    setFont(G.btnSize, weight, track);
    ctx.fillText(text, G.W / 2 - ctx.measureText(text).width / 2, G.btnY + G.btnSize * .35);
    ctx.restore(); spacingOff();
  }
  function brand(s, u, G) {
    const value = String((A.project && A.project.brand) || '').trim(); if (!value) return;
    const ctx = A.ctx, real = isReal(), a = pop((u - .55) / .4); if (a <= 0) return;
    ctx.save(); ctx.globalAlpha *= a * .82;
    setFont(G.brandSize, real ? 500 : 700, real ? G.brandSize * .16 : 0);
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 12;
    const w = ctx.measureText(value).width;
    ctx.fillStyle = WHITE; ctx.fillText(value, G.brandAlign === 'right' ? G.brandX - w : G.brandX - w / 2, G.brandY);
    ctx.restore(); spacingOff();
  }

  /* ---- scene --------------------------------------------------------------- */
  S.scene = function (s, u, t, i) {
    const G = geo(), dur = Math.max(s.end - s.start, .1), shots = sceneShots(s), starts = shotStarts(s, shots, dur);
    let k = 0; for (let j = 0; j < starts.length; j++) if (u >= starts[j]) k = j;
    const span = j => Math.max((j + 1 < starts.length ? starts[j + 1] : dur) - starts[j], .1);
    const ub = u - starts[k], a = k ? shotFade(ub) : 1, last = k + 1 >= starts.length;
    if (k && a < 1) paint(s, shots[k - 1], k - 1, shotProgress(u - starts[k - 1], span(k - 1), true), 1, 1);   // the outgoing picture stays underneath, still moving
    // The punch belongs to a cut *inside* a scene: the first picture of a scene arrives on a hard
    // cut from the scene before and must not be shoved 3% out of frame on its opening frame.
    paint(s, shots[k], k, shotProgress(ub, span(k), !last), a, k ? shotPunch(ub) : 1);
    const cap = s.kind === 'closing' ? null : captionOf(s, shots[k], k);
    veil(G, !!(cap || s.chapter));
    S.chrome(s, i, t);
    if (s.kind === 'closing') {
      const title = captionOf(s, shots[k], 0) || { text: String(s.title || ''), hl: String(s.hl || '') };
      // A closing may hold two shots. Words that change on the cut have to play their entrance
      // from that cut, or they swap in mid-air; words that stay keep the scene clock so the
      // entrance is not replayed under the viewer.
      const before = k ? (captionOf(s, shots[k - 1], 0) || { text: '' }).text : title.text;
      if (title.text.trim()) caption(s, title, before === title.text ? u : ub, G, true);
      button(s, u, G); brand(s, u, G);
    } else if (cap) caption(s, cap, ub, G, false);
    spacingOff();
  };

  /* ---- subtitles ----------------------------------------------------------- */
  // Karaoke from the caption groups and the word timings the timeline carries. Two lines at most,
  // just above the bottom safe area. Cartoon: outlined type, the spoken word pops in the Kleo
  // yellow. Realistic: lighter type on a plate no wider than the line, spoken word in the accent.
  S.subtitle = function (s, t) {
    const group = (s.captions || []).find(c => t >= c.start && t < c.end); if (!group) return;
    const ctx = A.ctx, G = geo(), real = isReal(), acc = accent(s);
    const weight = real ? 600 : 800, track = real ? .02 : 0;
    const f = fitLines(group.text, measurer(weight, track), G.subMax, 2, G.subSize, G.subMin);
    if (!f.lines.length) return;
    if (f.lines.length > 2) A.issues.push({ time: t, error: 'Caption exceeds two lines', text: group.text });
    const timed = groupWords(s.words, group);
    let spoken = -1; for (let i = 0; i < timed.length; i++) if (timed[i].start !== null && t >= timed[i].start) spoken = i;
    const fallback = spoken < 0 ? key(keyWord(group.text, s.hl)) : '';
    const grow = spoken >= 0 ? 1 + .12 * pop((t - timed[spoken].start) / .12) : 1;   // the spoken word swells, the fallback keyword does not
    let n = 0;
    f.lines.forEach((ln, i) => {
      const ws = ln.split(' '), base = n; n += ws.length;
      drawWords(ws, G.W / 2, G.subY - (f.lines.length - 1 - i) * f.size * 1.24, {
        size: f.size, weight, tracking: f.size * track, align: 'center', color: WHITE, hi: real ? acc : POP,
        hot: (w, j) => spoken >= 0 ? (base + j) === spoken : (!!fallback && key(w) === fallback),
        grow, stroke: real ? 0 : Math.max(5, f.size * .14), strokeColor: DARK, band: real ? .42 : 0
      });
    });
    spacingOff();
  };

  window.KEOU_PICTURE = { attach(api) { A = api }, ...S };
})();
