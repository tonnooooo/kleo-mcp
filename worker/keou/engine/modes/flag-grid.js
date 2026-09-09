/* flag-grid - the CTF benchmark: every challenge is one flag in a dense field, and a wave of them was never captured */
window.KEOU_MODES['flag-grid'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P;
  var u = api.u, t = api.t, ease = api.ease, clamp = api.clamp;

  /* ---- geometry ------------------------------------------------------ */
  var GX = 44, GY = 176, GW = 520, GH = 350;          /* the flag field */
  var COLS = 37, ROWS = 25, SLOTS = COLS * ROWS;      /* 925 slots, one glyph per challenge */
  var CW = GW / COLS, CH = GH / ROWS;
  var RX = 604, RW = 226, RCX = RX + RW / 2;          /* the column beside the field */
  var N = Math.max(1, Math.min(SLOTS, api.count || SLOTS));
  var RED = Math.max(0, Math.min(N, api.total || 0));
  var late = api.stage >= 0.35 && RED > 0;            /* shots 052-054: the unsolved wave */
  var L = (api.labels && api.labels.length === 3) ? api.labels
        : (late ? ['NEVER SOLVED', 'BY ANYONE', ''] : ['FIND', 'EXPLOIT', 'CAPTURE']);

  function fade(a, fn) { var g = ctx.globalAlpha; ctx.globalAlpha = g * clamp(a, 0, 1); fn(); ctx.globalAlpha = g; }

  /* one flag glyph: pole plus pennant, the pennant tip breathes so nothing is ever still */
  function flag(x, y, h, w, color, alpha, lw, wave) {
    if (alpha <= 0.012) return;
    var g = ctx.globalAlpha; ctx.globalAlpha = g * Math.min(1, alpha);
    var top = y - h * 0.5;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, y + h * 0.5);
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, top);
    ctx.lineTo(x + w + wave, top + h * 0.25);
    ctx.lineTo(x, top + h * 0.5);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
    ctx.globalAlpha = g;
  }

  function bracket(x, y, w, h, len, color, a) {
    fade(a, function () {
      api.line(x, y, x + len, y, color, 2); api.line(x, y, x, y + len, color, 2);
      api.line(x + w - len, y, x + w, y, color, 2); api.line(x + w, y, x + w, y + len, color, 2);
      api.line(x, y + h - len, x, y + h, color, 2); api.line(x, y + h, x + len, y + h, color, 2);
      api.line(x + w - len, y + h, x + w, y + h, color, 2); api.line(x + w, y + h - len, x + w, y + h, color, 2);
    });
  }

  /* ---- which flags were never captured -------------------------------
     Deterministic scatter: shuffle the slots once, take api.total of them,
     then order that selection into a left-to-right wave.                */
  var rankOf = null;
  if (late) {
    var order = new Array(N), i, j, sw;
    for (i = 0; i < N; i++) order[i] = i;
    for (i = N - 1; i > 0; i--) {
      j = Math.min(i, Math.floor(api.rnd(i, 17) * (i + 1)));
      sw = order[i]; order[i] = order[j]; order[j] = sw;
    }
    var chosen = order.slice(0, RED);
    chosen.sort(function (a, b) {
      var ka = (a % COLS) / COLS * 0.74 + Math.floor(a / COLS) / ROWS * 0.26 + api.rnd(a, 5) * 0.07;
      var kb = (b % COLS) / COLS * 0.74 + Math.floor(b / COLS) / ROWS * 0.26 + api.rnd(b, 5) * 0.07;
      return ka - kb;
    });
    rankOf = new Array(N);
    for (i = 0; i < N; i++) rankOf[i] = -1;
    for (i = 0; i < RED; i++) rankOf[chosen[i]] = i;
  }

  /* the red wave and the red counter share one progress curve, so the number always matches the field */
  var WD = 1.6, WS = 4.2;
  var wp = clamp((u - WD) / WS), redFront = RED * (1 - Math.pow(1 - wp, 3));

  /* ---- 1. the field frame -------------------------------------------- */
  bracket(GX - 12, GY - 12, GW + 24, GH + 24, 26, C.accent + (late ? '55' : '77'), ease(u / 0.5) * 0.9);
  fade(ease((u - 0.2) / 0.8) * 0.16, function () {
    for (var k = 0; k <= 4; k++) api.line(GX + GW * k / 4, GY - 4, GX + GW * k / 4, GY - 12, C.accent, 1.5);
  });

  /* ---- 2. the field itself: one flag per challenge, pouring in -------- */
  var scanF = (t * 0.13) % 1;
  var pour = late ? 0.5 : 1;
  for (var c = 0; c < N; c++) {
    var col = c % COLS, row = (c - col) / COLS;
    var born = (row * 0.042 + api.rnd(c, 1) * 0.2 + col * 0.003) * pour;
    var a = ease(clamp((u - 0.12 - born) / 0.4));
    if (a <= 0.02) continue;
    var cx = GX + col * CW + CW * 0.34, cy = GY + row * CH + CH * 0.5 - (1 - a) * 20;
    var sh = 0.5 + 0.5 * Math.sin(t * 1.15 + api.rnd(c, 2) * 6.283 + row * 0.22);
    var band = Math.max(0, 1 - Math.abs(col / COLS - scanF) * 9);
    var wave = Math.sin(t * 2.1 + api.rnd(c, 3) * 6.283) * 0.9;
    var rk = rankOf ? rankOf[c] : -1;
    var ra = rk >= 0 ? clamp((redFront - rk) / 5) : 0;
    if (ra < 0.99) flag(cx, cy, 10, 6.2, C.accent,
      a * (1 - ra) * ((late ? 0.2 : 0.3) + 0.2 * sh + band * band * 0.5), 1.5, wave);
    if (ra > 0.01) {
      if (ra < 0.9) fade(a * ra * 0.5, function () { api.glow(cx, cy, 13, P.red); });
      flag(cx, cy, 10, 6.2, P.red, a * ra * (0.55 + 0.4 * sh), 1.8, wave);
    }
  }

  /* ---- 3. the scan travelling through the field ----------------------- */
  var sx = GX + GW * scanF;
  fade(ease((u - 0.6) / 0.8) * 0.5, function () { api.glow(sx, GY + GH / 2, 60, C.accent); });
  fade(ease((u - 0.6) / 0.8) * 0.55, function () { api.line(sx, GY - 4, sx, GY + GH + 4, C.accent, 1.5); });

  /* ---- 4. the true count, locking in above the field ------------------ */
  fade(ease(u / 0.7), function () { api.mono(api.date || 'THE BENCHMARK', GX, 62, 24, C.accent, 'left', 300); });
  api.counter(N, GX, 150, 70, C.accent, late ? 0.05 : 0.25, late ? 0.7 : 1.5, 'left');
  fade(ease((u - (late ? 0.5 : 1.4)) / 0.7), function () {
    api.mono(api.text || 'CHALLENGES', 188, 144, 26, C.white, 'left', 220);
  });
  fade(ease((u - 0.35) / 0.8) * 0.35, function () {
    api.drawPath([[GX, 165], [GX + 300, 165]], ease((u - 0.35) / 0.8), C.accent, 1.5);
  });

  /* ---- 5a. early: find -> exploit -> capture --------------------------- */
  if (!late) {
    var BH = 104, ys = [150, 294, 438];
    for (var s = 0; s < 3; s++) {
      var top = ys[s], gy = top + 40, sa = ease((u - 0.55 - s * 0.34) / 0.6);
      if (sa <= 0.01) continue;
      (function (s, top, gy, sa) {
        fade(sa, function () {
          api.box(RX, top, RW, BH, C.ink + 'bb', C.accent + '3a', 3);
          api.line(RX, top, RX + 46, top, C.accent + 'aa', 2.5);
          var pulse = 0.5 + 0.5 * Math.sin(t * 1.5 - s * 1.1);

          if (s === 0) {                       /* FIND: a lens sweeping three lines of code */
            for (var k = 0; k < 3; k++) {
              var ly = gy - 15 + k * 15, lw2 = [46, 62, 34][k];
              api.line(RCX - 44, ly, RCX - 44 + lw2, ly, C.accent + '4d', 3);
            }
            var lx = RCX + Math.sin(t * 0.85) * 34, hit = Math.max(0, 1 - Math.abs(lx - RCX - 4) / 24);
            fade(0.35 + 0.65 * hit, function () {
              api.line(RCX - 44, gy, RCX + 18, gy, C.accent, 3.5);
            });
            fade(0.55 + 0.45 * pulse, function () { api.glow(lx, gy, 26, C.accent); });
            ctx.beginPath(); ctx.arc(lx, gy, 18, 0, Math.PI * 2);
            ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5; ctx.stroke();
            api.line(lx + 13, gy + 13, lx + 25, gy + 25, C.accent, 3.5);
            api.dot(lx, gy, 2.5 + 2 * hit, C.accent);

          } else if (s === 1) {                /* EXPLOIT: the barrier splits along a crack */
            var ph = (t * 0.42) % 1, cf = ease(clamp(ph / 0.4));
            var open = ease(clamp((ph - 0.34) / 0.34)) * (1 - clamp((ph - 0.86) / 0.14));
            var gap = 5 * open, wy = gy - 24, WH = 46, HW = 44;
            for (var side = 0; side < 2; side++) {
              var wx = side ? RCX + gap : RCX - gap - HW;
              ctx.beginPath(); ctx.rect(wx, wy, HW, WH);
              ctx.strokeStyle = C.accent + '77'; ctx.lineWidth = 2.5; ctx.stroke();
              for (var b = 1; b < 3; b++) api.line(wx, wy + b * WH / 3, wx + HW, wy + b * WH / 3, C.accent + '33', 1.5);
              api.line(wx + (side ? HW * 0.55 : HW * 0.45), wy, wx + (side ? HW * 0.55 : HW * 0.45), wy + WH / 3, C.accent + '33', 1.5);
              api.line(wx + (side ? HW * 0.35 : HW * 0.6), wy + WH * 2 / 3, wx + (side ? HW * 0.35 : HW * 0.6), wy + WH, C.accent + '33', 1.5);
            }
            var crack = [[RCX + 5, wy - 5], [RCX - 7, wy + 13], [RCX + 8, wy + 25], [RCX - 6, wy + 37], [RCX + 4, wy + WH + 5]];
            fade(1 - clamp((ph - 0.86) / 0.14), function () {
              api.drawPath(crack, cf, C.accent, 4);
              api.glow(RCX, wy + WH * cf, 20 + 8 * open, C.accent);
              for (var q = 0; q < 4; q++) {
                var d = open * (10 + q * 6), sg = q % 2 ? 1 : -1;
                api.dot(RCX + sg * d, wy + 10 + q * 11, 2.6, C.accent);
              }
            });

          } else {                             /* CAPTURE: the flag goes up the pole */
            var ph3 = (t * 0.33) % 1, rise = ease(clamp(ph3 / 0.34)), unf = ease(clamp((ph3 - 0.26) / 0.32));
            var base = gy + 26, px = RCX - 15;
            api.line(px - 20, base, px + 22, base, C.accent + '77', 2.5);
            api.line(px, base, px, base - 54 * rise, C.accent, 3);
            if (unf > 0.02) {
              fade(unf, function () {
                var ty = base - 54;
                ctx.beginPath(); ctx.moveTo(px, ty);
                ctx.lineTo(px + (40 + Math.sin(t * 2.4) * 3) * unf, ty + 11);
                ctx.lineTo(px, ty + 22); ctx.closePath();
                ctx.fillStyle = C.accent; ctx.fill();
              });
              fade(unf * (0.4 + 0.6 * pulse), function () { api.glow(px + 12, base - 44, 26, C.accent); });
            }
          }
          api.mono(L[s], RCX, top + 92, 24, C.white, 'center', RW - 26);
        });
      })(s, top, gy, sa);

      if (s < 2) {
        var la = ease((u - 0.85 - s * 0.34) / 0.5);
        fade(la * 0.8, function () { api.drawPath([[RCX, top + BH], [RCX, top + BH + 40]], la, C.accent + 'aa', 2.5); });
        if (la > 0.9) {
          api.packets([[RCX, top + BH], [RCX, top + BH + 40]], C.accent, 2, 0.55, 3.5, s * 0.3);
          fade(0.8, function () {
            api.line(RCX - 6, top + BH + 32, RCX, top + BH + 40, C.accent, 2);
            api.line(RCX + 6, top + BH + 32, RCX, top + BH + 40, C.accent, 2);
          });
        }
      }
    }
  }

  /* ---- 5b. late: the flags nobody ever took --------------------------- */
  if (late) {
    var ra2 = ease(clamp((u - 0.5) / 0.7));
    bracket(RX - 6, 172, RW + 12, 322, 22, P.red + '77', ra2 * 0.85);

    /* an uncaptured flag, struck through on a loop */
    fade(ra2, function () {
      var fx = RCX - 20, fy = 234;
      flag(fx, fy, 82, 50, C.muted, 0.8 + 0.2 * (0.5 + 0.5 * Math.sin(t * 1.3)), 5, Math.sin(t * 1.9) * 2.4);
      var sp = (t / 3.2) % 1, sf = ease(clamp(sp / 0.26));
      fade(1 - clamp((sp - 0.74) / 0.26), function () {
        api.strike(fx - 26, fy + 32, fx + 48, fy - 30, sf, P.red, 6);
        if (sf < 0.985) api.glow(fx - 26 + 74 * sf, fy + 32 - 62 * sf, 15, P.red);
      });
    });

    /* the tally racing up beside the wave, then locking */
    fade(ease((u - WD) / 0.7) * 0.9, function () { api.glow(RCX, 348, 96, P.red); });
    api.counter(RED, RCX, 376, 100, P.red, WD, WS, 'center');
    fade(ease((u - 2.4) / 0.9), function () {
      api.mono(L[0], RCX, 428, 27, P.red, 'center', RW - 12);
    });
    fade(ease((u - 3.1) / 0.9), function () {
      api.mono(L[1], RCX, 466, 27, C.white, 'center', RW - 12);
    });

    /* the count is carried out of the field */
    fade(0.3 + 0.6 * wp, function () {
      api.packets([[GX + GW + 8, 336], [RX - 14, 352]], P.red, 3, 0.4, 3.6);
    });
  }

  /* ---- 6. footer ------------------------------------------------------ */
  fade(ease((u - 0.6) / 1) * 0.85, function () {
    api.mono('CONCEPTUAL DIAGRAM / NOT LIVE TELEMETRY', 440, 596, 18, C.muted, 'center', 700);
  });
};
