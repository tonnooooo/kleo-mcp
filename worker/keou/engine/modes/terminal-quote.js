/* terminal-quote - the verbatim agent message, typed out alone in one terminal pane */
window.KEOU_MODES['terminal-quote'] = function (api) {
  var ctx = api.ctx, C = api.C, P = api.P, u = api.u, t = api.t;
  var A = C.accent, RED = P.red, MUT = C.muted, INK = C.ink;
  var ease = api.ease, clamp = api.clamp;

  var stage = typeof api.stage === 'number' ? api.stage : 0;
  var late = stage >= 0.5;                 // the late beat: the same line, quoted, quieter
  var chrome = late ? 0.5 : 1;             // the surrounding frame dims further

  var FALLBACK = late ? ['POSTED BY', 'AN AGENT', 'VERBATIM']
                      : ['AGENT MESSAGE', 'NO HUMAN', 'VERBATIM'];
  var L = (api.labels && api.labels.length === 3) ? api.labels : FALLBACK;
  var QUOTE = (api.text && api.text.length) ? api.text : FALLBACK[2];
  var HEAD = L[0] + ' · ' + L[1] + ' · ' + L[2];

  var fade = function (a, fn) {
    a = clamp(a, 0, 1); if (a <= 0.004) return;
    ctx.save(); ctx.globalAlpha *= a; fn(); ctx.restore();
  };
  var breath = 0.5 + 0.5 * Math.sin(t * 0.8);      // faint phosphor breathing

  /* ---------- pane geometry ---------- */
  var PX = 22, PY = 38, PW = 836, PH = 546;
  var PR = PX + PW, PB = PY + PH;
  var BAR = PY + 58, FOOT = PB - 46;               // title bar rule / status rule
  var MIDY = (BAR + FOOT) / 2;
  var QMAX = 736;

  /* ---------- the quote: measure, and lay it on two lines only at a real space ---------- */
  var measure = function (s, size) { ctx.font = '400 ' + size + 'px KeouMono'; return ctx.measureText(s).width; };
  var fitSize = function (s, room, hi, lo) {
    var size = hi;
    while (size > lo && measure(s, size) > room) size--;
    return size;
  };

  var cut = -1, best = 1e9;
  for (var i = 1; i < QUOTE.length - 1; i++) {
    if (QUOTE.charAt(i) !== ' ') continue;
    var worst = Math.max(i, QUOTE.length - i - 1);
    if (worst < best) { best = worst; cut = i; }
  }
  var oneSize = fitSize(QUOTE, QMAX, 54, 18);
  var twoSize = 0;
  if (cut > 0) twoSize = Math.min(fitSize(QUOTE.slice(0, cut), QMAX, 62, 18),
                                  fitSize(QUOTE.slice(cut + 1), QMAX, 62, 18));
  var split = cut > 0 && oneSize < 40 && twoSize >= oneSize + 8;
  var size = split ? twoSize : oneSize;
  var lines = split ? [QUOTE.slice(0, cut), QUOTE.slice(cut + 1)] : [QUOTE];
  var starts = split ? [0, cut + 1] : [0];

  var CPS = 26, DELAY = 0.4;
  var shown = api.typed(QUOTE, CPS, DELAY).length;
  var typing = shown < QUOTE.length;
  var progress = clamp(shown / Math.max(1, QUOTE.length), 0, 1);
  var curLine = (split && shown >= cut + 1) ? 1 : 0;
  var CW = size * 0.58, CH = size * 0.94;
  var LH = size * 1.36;

  /* ---------- near-black ground with a drifting phosphor raster ---------- */
  ctx.save();
  ctx.fillStyle = INK; ctx.fillRect(0, 0, 880, 620);
  fade(0.85 * chrome, function () {
    var off = (t * 2.4) % 6;
    ctx.fillStyle = A + '12';
    for (var y = -6; y < 620; y += 6) ctx.fillRect(0, y + off, 880, 1);
  });

  /* ---------- the agent behind the message: a large, slow hexagon watermark ---------- */
  fade((late ? 0.07 : 0.14) * ease(u / 1.2), function () {
    var rot = t * 0.02, r = 172 + breath * 6;
    api.glow(440, MIDY, 210, A);
    api.hex(440, MIDY, r, A, 3, 0, rot);
    api.hex(440, MIDY, r * 0.44, A, 2.5, 0.24 + 0.24 * breath, rot);
  });

  /* ---------- the pane ---------- */
  fade(chrome, function () {
    ctx.save();
    ctx.globalAlpha *= 0.42 + 0.5 * breath;
    ctx.beginPath(); ctx.roundRect(PX, PY, PW, PH, 3);
    ctx.strokeStyle = A; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    api.line(PX, BAR, PR, BAR, A + '3a', 1.5);
    api.line(PX, FOOT, PR, FOOT, A + '26', 1.5);
    for (var d = 0; d < 3; d++)
      api.dot(PX + 26 + d * 21, PY + 29, 5.5, (!late && d === 0) ? RED : A + '3a');
  });

  /* ---------- header line, from the scene labels ---------- */
  fade(ease((u - 0.1) / 0.7) * (late ? 0.62 : 0.95), function () {
    api.mono(HEAD, PX + 98, PY + 37, 21, MUT, 'left', 588);
  });

  /* ---------- early: no human touched this keyboard ---------- */
  if (!late) {
    var hx = PR - 70, hy = PY + 30;
    fade(ease((u - 0.5) / 0.6) * 0.9, function () {
      ctx.save();
      ctx.translate(hx, hy); ctx.scale(0.82, 0.82);
      ctx.beginPath();
      ctx.moveTo(-4, -21); ctx.quadraticCurveTo(0, -25, 4, -21);
      ctx.lineTo(4, -7); ctx.quadraticCurveTo(6, -9, 8.5, -7); ctx.lineTo(8.5, -4);
      ctx.quadraticCurveTo(10.5, -6, 13, -4); ctx.lineTo(13, -1);
      ctx.quadraticCurveTo(15, -3, 17, -1); ctx.lineTo(17, 11);
      ctx.quadraticCurveTo(17, 20, 8, 20); ctx.lineTo(-3, 20);
      ctx.quadraticCurveTo(-9, 20, -11, 14); ctx.lineTo(-15, 3);
      ctx.quadraticCurveTo(-16.5, -1, -12.5, -2.5);
      ctx.quadraticCurveTo(-8.5, -4, -6.5, 0); ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fillStyle = INK; ctx.fill();
      ctx.strokeStyle = MUT; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
    });
    api.strike(hx - 22, hy - 20, hx + 22, hy + 20, ease((u - 1.05) / 0.5), RED, 4.5);
  } else {
    /* late: a quiet quotation mark, this line is being cited */
    fade(0.3 + 0.25 * breath, function () {
      for (var q = 0; q < 2; q++) {
        var qx = PR - 66 + q * 20;
        ctx.beginPath();
        ctx.moveTo(qx, PY + 20); ctx.lineTo(qx + 11, PY + 20);
        ctx.lineTo(qx + 6, PY + 38); ctx.lineTo(qx - 3, PY + 38);
        ctx.closePath();
        ctx.fillStyle = MUT; ctx.fill();
      }
    });
  }

  /* ---------- the quote itself, typed, verbatim ---------- */
  fade(0.22 + 0.16 * breath, function () { api.glow(440, MIDY, late ? 176 : 208, RED); });

  var widest = 0;
  for (var mi = 0; mi < lines.length; mi++) widest = Math.max(widest, measure(lines[mi], size));

  for (var li = 0; li < lines.length; li++) {
    var fw = measure(lines[li], size);
    var lx = 440 - (fw + CW) / 2;
    var ly = MIDY - (lines.length - 1) * LH / 2 + li * LH + size * 0.34;
    var vis = lines[li].slice(0, clamp(shown - starts[li], 0, lines[li].length));
    var w = api.mono(vis, lx, ly, size, RED, 'left', QMAX);
    if (li === curLine && (typing || api.cursorOn())) {
      ctx.fillStyle = RED;
      ctx.fillRect(lx + w + size * 0.06, ly - size * 0.78, CW, CH);
    }
    if (li === lines.length - 1) {
      var settled = ease((u - DELAY - QUOTE.length / CPS - 0.3) / 0.9);
      api.drawPath([[440 - widest / 2, ly + size * 0.56], [440 + widest / 2, ly + size * 0.56]], settled, RED + '66', 2.5);
    }
  }

  /* ---------- a very slow scanline across the pane ---------- */
  ctx.save();
  ctx.beginPath(); ctx.rect(PX + 2, PY + 2, PW - 4, PH - 4); ctx.clip();
  var span = PH + 200, sy = PY - 100 + ((t / (late ? 11 : 8)) % 1) * span;
  var g = ctx.createLinearGradient(0, sy - 70, 0, sy + 70);
  g.addColorStop(0, A + '00'); g.addColorStop(0.5, A + (late ? '12' : '1c')); g.addColorStop(1, A + '00');
  ctx.fillStyle = g; ctx.fillRect(PX, sy - 70, PW, 140);
  ctx.globalAlpha *= 0.5; api.line(PX, sy, PR, sy, A + '40', 1);
  ctx.restore();

  /* ---------- status strip: the line arriving, character by character ---------- */
  fade(chrome, function () {
    var rate = late ? 1.1 : 4.5;
    for (var b = 0; b < 12; b++) {
      var on = (Math.floor(t * rate) + b) % 12 < 4;
      api.box(PX + 28 + b * 14, FOOT + 19, 9, 7, on ? A + 'aa' : A + '25', null, 1);
    }
    var x0 = PX + 224, x1 = api.date ? PR - 214 : PR - 32;
    api.line(x0, FOOT + 23, x1, FOOT + 23, A + '22', 3);
    api.line(x0, FOOT + 23, x0 + (x1 - x0) * progress, FOOT + 23, A + 'aa', 3);
    api.dot(x0 + (x1 - x0) * progress, FOOT + 23, typing ? 4.5 : 3, typing ? A : A + '66');
  });
  if (api.date) fade(ease((u - 0.6) / 0.7), function () {
    api.mono(api.date, PR - 30, FOOT + 30, 20, P.amber, 'right', 190);
  });

  ctx.restore();
};
