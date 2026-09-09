/* timeline-track - the incident timeline: three months, pins piling up, an amber date landing on a travelling marker */
window.KEOU_MODES['timeline-track'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P;
  var u = api.u, t = api.t, ease = api.ease, clamp = api.clamp;

  /* ---- geometry ------------------------------------------------------ */
  var X0 = 84, X1 = 796, SPAN = X1 - X0, TY = 396;   /* the track */
  var FT = 138, FB = TY - 48;                        /* faint time field above it */
  var stage = clamp(api.stage, 0, 1);
  var date = api.date || null;
  var caption = api.text || null;
  var finale = (api.stage >= 0.999 && !date);        /* shot 203: bare track, dims to outline */
  var months = (api.labels && api.labels.length === 3) ? api.labels : ['MAY', 'JUN', 'JUL'];
  /* fixed beats of the incident so every instance shows the same accumulation */
  var PINS = [0.05, 0.14, 0.24, 0.34, 0.44, 0.53, 0.62, 0.72, 0.80, 0.88, 0.94];

  function fade(a, fn) { var g = ctx.globalAlpha; ctx.globalAlpha = g * clamp(a, 0, 1); fn(); ctx.globalAlpha = g; }
  function mw(s, size) { ctx.font = '400 ' + size + 'px KeouMono'; return ctx.measureText(s).width; }

  /* ---- timing -------------------------------------------------------- */
  var dimOut = finale ? 1 - 0.55 * ease((u - 2.1) / 3.6) : 1;   /* 203 fades to outline only */
  var drawn = ease(clamp(u / 0.8));                             /* 017 the line draws itself */
  var railEnd = X0 + SPAN * drawn;
  var travel = ease(clamp((u - 0.45) / 1.05));                  /* marker eases into place */
  var mx = X0 + SPAN * stage * travel;
  var drop = finale ? 0 : ease(clamp((u - 0.95) / 0.8));        /* the amber pin falls */
  var breath = 0.5 + 0.5 * Math.sin(t * 1.7);
  var scanF = (t * 0.15) % 1, scanX = X0 + SPAN * scanF;

  /* ---- 1. the time field: month grid the scan wave travels through ---- */
  fade(dimOut * ease((u - 0.35) / 1.2), function () {
    for (var i = 0; i <= 24; i++) {
      var f = i / 24, x = X0 + SPAN * f;
      if (x > railEnd) break;
      var wave = Math.max(0, 1 - Math.abs(f - scanF) * 7);
      var past = (!finale && f <= stage) ? 0.05 : 0;
      fade(0.07 + past + 0.2 * wave * wave, function () {
        api.line(x, FT, x, FB, C.accent, i % 4 === 0 ? 1.6 : 1);
      });
    }
    fade(0.12, function () {
      api.line(X0, FT, Math.min(railEnd, X1), FT, C.accent, 1.4);
      api.line(X0, FB, Math.min(railEnd, X1), FB, C.accent, 1.4);
    });
  });

  /* ---- 2. rail ------------------------------------------------------- */
  fade(dimOut, function () {
    api.drawPath([[X0, TY], [X1, TY]], drawn, C.accent + (finale ? '3a' : '2e'), 4);
    if (!finale) {
      var bright = Math.min(mx, railEnd);
      if (bright > X0 + 1) api.drawPath([[X0, TY], [bright, TY]], 1, C.accent + 'cc', 5);
    }
    if (drawn > 0.02) api.line(X0, TY - 18, X0, TY + 18, C.accent + '99', 2.5);
    if (drawn > 0.985) api.line(X1, TY - 18, X1, TY + 18, C.accent + '99', 2.5);
  });

  /* ---- 3. tick marks (018) ------------------------------------------- */
  fade(dimOut, function () {
    for (var i = 0; i <= 24; i++) {
      var f = i / 24, x = X0 + SPAN * f;
      var a = ease((u - 0.55 - f * 0.5) / 0.5);
      if (a <= 0.01) continue;
      var major = (i % 4 === 0);
      fade(a * (major ? 0.85 : 0.45), function () {
        api.line(x, TY + 7, x, TY + (major ? 26 : 15), C.accent, major ? 2.5 : 1.5);
      });
    }
  });

  /* ---- 4. month bands and labels ------------------------------------- */
  fade(dimOut, function () {
    for (var m = 0; m < 3; m++) {
      var a = ease((u - 0.85 - m * 0.16) / 0.7);
      if (a <= 0.01) continue;
      var bs = X0 + SPAN * (m / 3) + 7, be = X0 + SPAN * ((m + 1) / 3) - 7, bc = (bs + be) / 2;
      var live = !finale && stage >= m / 3 && stage <= (m + 1) / 3 + (m === 2 ? 0.01 : 0);
      var col = live ? C.accent : C.muted;
      fade(a * (live ? 0.9 : 0.4), function () {
        api.line(bs, 450, be, 450, col, 2);
        api.line(bs, 432, bs, 450, col, 2);
        api.line(be, 432, be, 450, col, 2);
      });
      fade(a * (live ? 0.85 + 0.15 * breath : 0.55), function () {
        api.mono(months[m], bc, 500, 32, col, 'center', 200);
      });
    }
  });

  /* ---- 5. pins already behind us: the escalation piling up ------------ */
  fade(dimOut, function () {
    for (var i = 0; i < PINS.length; i++) {
      var p = PINS[i];
      if (!finale && p > stage - 0.015) break;
      var px = X0 + SPAN * p;
      if (px > railEnd) break;
      var a = ease((u - 1.1 - i * 0.1) / 0.6) * (0.34 + 0.26 * (0.5 + 0.5 * Math.sin(t * 1.3 - i * 0.9)));
      fade(a, function () {
        api.line(px, TY - 10, px, TY - 32, C.accent, 2);
        api.dot(px, TY - 35, 3.2, C.accent);
      });
    }
  });

  /* ---- 6. travelling scan on the rail --------------------------------- */
  if (scanX <= railEnd) {
    fade(0.55 * dimOut, function () { api.glow(scanX, TY, 48, C.accent); });
    fade(0.75 * dimOut, function () { api.line(scanX, TY - 16, scanX, TY + 16, C.accent, 1.5); });
  }

  /* ---- 7. marker + packets on the elapsed rail ------------------------ */
  if (!finale) {
    if (mx > X0 + 46) api.packets([[X0, TY], [Math.min(mx, railEnd), TY]], C.accent, 3, 0.2, 3.5);
    fade(0.45 + 0.5 * breath, function () { api.line(mx, TY - 38, mx, TY + 38, C.accent, 1.5); });
    api.glow(mx, TY, 34 + 6 * breath, C.accent);
    ctx.beginPath(); ctx.arc(mx, TY, 14, 0, Math.PI * 2);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5; ctx.stroke();
    api.dot(mx, TY, 6.5, C.accent);
  }

  /* ---- 8. the amber pin: stem, card, date, caption -------------------- */
  if (date && !finale) {
    var dSize = 31, cSize = 22;
    var dW = mw(date, dSize), cW = caption ? mw(caption, cSize) : 0;
    var cardW = Math.min(444, Math.max(dW, cW) + 62);
    var cardH = caption ? 104 : 68;
    var cardCX = Math.max(58 + cardW / 2, Math.min(822 - cardW / 2, mx));
    var cardBottom = 296, dy = -(1 - drop) * 84;
    var cardTop = cardBottom - cardH + dy, cardBot = cardBottom + dy;

    fade(drop, function () {   /* the stem draws downward onto the marker */
      api.drawPath([[cardCX, cardBot], [cardCX, 332], [mx, 358], [mx, TY - 20]], drop, P.amber + 'aa', 2.5);
    });

    var head = clamp((drop - 0.78) / 0.22);
    if (head > 0.01) {         /* the pin head, landed */
      fade(head, function () {
        api.glow(mx, TY, 26 + 7 * breath, P.amber);
        api.dot(mx, TY, 7, P.amber);
      });
      var rp = (t * 0.5) % 1;
      fade(head * (1 - rp) * 0.6, function () {
        ctx.beginPath(); ctx.arc(mx, TY, 13 + 26 * rp, 0, Math.PI * 2);
        ctx.strokeStyle = P.amber; ctx.lineWidth = 2; ctx.stroke();
      });
    }

    fade(drop, function () {
      fade(0.5, function () { api.glow(cardCX, cardBot, 52, P.amber); });
      api.box(cardCX - cardW / 2, cardTop, cardW, cardH, C.ink + 'f2', P.amber + 'aa', 3);
      api.line(cardCX - cardW / 2, cardBot, cardCX + cardW / 2, cardBot, P.amber, 3);
      api.mono(date, cardCX, cardTop + 45, dSize, P.amber, 'center', cardW - 34);
      if (caption) api.mono(caption, cardCX, cardTop + 80, cSize, C.white, 'center', cardW - 34);
    });
  }

  /* ---- 9. clock sweep 02:28 -> 04:01 (shot 091) ----------------------- */
  if (date && date.indexOf('UTC') >= 0 && stage >= 0.58 && stage <= 0.78) {
    var kx = 160, ky = 226, kr = 62;
    var ka = ease((u - 0.7) / 0.8);
    var q = ease(clamp((u - 1.3) / 4.6));
    var mins = 148 + 93 * q;                        /* 02:28 -> 04:01, as scripted */
    fade(ka, function () {
      ctx.beginPath(); ctx.arc(kx, ky, kr, 0, Math.PI * 2);
      ctx.fillStyle = C.ink + 'e0'; ctx.fill();
      ctx.strokeStyle = P.amber + '88'; ctx.lineWidth = 2; ctx.stroke();
      for (var i = 0; i < 12; i++) {
        var a = i * Math.PI / 6, r0 = kr - (i % 3 === 0 ? 15 : 8);
        api.line(kx + Math.cos(a) * r0, ky + Math.sin(a) * r0,
                 kx + Math.cos(a) * (kr - 4), ky + Math.sin(a) * (kr - 4),
                 P.amber + (i % 3 === 0 ? 'aa' : '55'), 2);
      }
      ctx.beginPath(); ctx.arc(kx, ky, kr - 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q);
      ctx.strokeStyle = P.amber + '66'; ctx.lineWidth = 3; ctx.stroke();
      var ma = (mins % 60) / 60 * Math.PI * 2 - Math.PI / 2;
      var ha = (mins % 720) / 720 * Math.PI * 2 - Math.PI / 2;
      api.line(kx, ky, kx + Math.cos(ha) * kr * 0.48, ky + Math.sin(ha) * kr * 0.48, P.amber, 5);
      api.line(kx, ky, kx + Math.cos(ma) * kr * 0.76, ky + Math.sin(ma) * kr * 0.76, P.amber, 3);
      api.glow(kx, ky, 16, P.amber);
      api.dot(kx, ky, 4, P.amber);
      var hh = Math.floor(mins / 60), mm = Math.floor(mins % 60);
      api.mono((hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ' UTC', kx, 330, 26, P.amber, 'center', 220);
    });
  }

  /* ---- 10. framing text ----------------------------------------------- */
  fade(ease(u / 0.9) * dimOut, function () {
    api.mono('INCIDENT TIMELINE', 26, 78, 26, finale ? C.muted : C.accent, 'left', 380);
  });
  fade(ease((u - 0.5) / 1) * 0.8, function () {
    api.mono('CONCEPTUAL TIMELINE / NOT LIVE TELEMETRY', 440, 594, 18, C.muted, 'center', 700);
  });
};
