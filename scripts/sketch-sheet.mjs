/* Draws every sketch drawing on GitHub's machine — never the owner's PC — so a change to the art can be
   LOOKED AT before a card is rented: one strip per drawing (two draw-on stages, the finished drawing, the
   drawing with its options) and one contact sheet of all of them. Output: out/sketch-sheet/. */
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const SRC = readFileSync("worker/keou/engine/sketch.js", "utf8").replace("const ART = {};", "const ART = {}; window.__ART = ART;");
const names = [...SRC.matchAll(/^\s*ART\.(\w+)\s*=/gm)].map((m) => m[1]);
// the option that changes each drawing most, so the sheet shows both faces of it
const OPTS = { bell: { no: true }, blank: { chip: "green", count: 4 }, box: { tint: "yellow" }, bug: { tint: "red" }, bulb: { flash: true, tint: "yellow" },
  calendar: { tint: "blue" }, camera: { led: "red" }, chain: { count: 5, no: true }, chart: { tint: "green" }, chip: { tint: "red" }, city: { tint: "blue" },
  clock: { tint: "red" }, code: { tint: "blue" }, coin: { tint: "yellow" }, corridor: { led: "red" }, crowbar: { no: true }, crowd: { count: 8, led: "red" },
  door: { open: 1, led: "green" }, envelope: { tint: "yellow" }, eye: { no: true, tint: "red" }, face: { mood: "scared", sweat: true }, figure: { frown: true, reach: [200, -80] },
  fingerprint: { tint: "green" }, folder: { tint: "yellow" }, footprints: { count: 6, tint: "red" }, gear: { tint: "blue" }, globe: { led: "green" }, graph: { tint: "green" },
  hand: { flip: true }, hotels: { led: "red" }, intruder: { reach: [-160, -60] }, keycard: { xray: true }, laptop: { tint: "blue" }, lock: { open: 1, tint: "red" },
  question: { tint: "yellow" }, reader: { led: "red", flare: true }, robot: { led: "red" }, rocket: { led: "green" }, router: { beam: "blue", led: "green" },
  satellite: { beam: "blue" }, scale: { flip: true, tint: "green" }, server: { led: "red" }, shield: { flash: true, tint: "green" }, signal: { beam: "red" },
  tag: { text: "AIRPORT FREE WIFI", leader: true }, usb: { xray: true }, warning: { tint: "red" }, writer: { beam: "blue" } };
mkdirSync("out/sketch-sheet", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 2700, height: 1080 } });
page.on("pageerror", (e) => { console.error("PAGE ERROR", e); process.exitCode = 1 });
await page.setContent(`<body style="margin:0;background:#000"><canvas id="c" width="2700" height="1080"></canvas></body>`);
await page.addScriptTag({ content: SRC });
await page.evaluate(() => {
  const c = document.getElementById("c"); window.__ctx = c.getContext("2d");
  window.KEOU_SKETCH.attach({ ctx: window.__ctx, W: 1080, H: 1080, issues: [] });
  window.__cell = (name, state, x, y, size, w, h) => {
    const ctx = window.__ctx; ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h);
    // the caption band: 78 % of a 9:16 frame is 420 design px under a drawing parked at the stage default
    ctx.save(); ctx.strokeStyle = "#3a3a3a"; ctx.setLineDash([10, 10]); ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(x, y + (h / 2 + 420 * size)); ctx.lineTo(x + w, y + (h / 2 + 420 * size)); ctx.stroke(); ctx.restore();
    ctx.translate(x + w / 2, y + h / 2); ctx.scale(size, size);
    const fn = window.__ART[name]; if (fn) fn(0.7, 0.5, { ...state });
    ctx.restore();
    ctx.fillStyle = "#777"; ctx.font = "26px sans-serif"; ctx.fillText(`${name} ${JSON.stringify(state)}`, x + 16, y + 36);
  };
});
for (const n of names) {
  await page.evaluate(({ n, o }) => {
    const ctx = window.__ctx; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 2700, 1080);
    window.__cell(n, { es: 0.18 }, 0, 0, 0.5, 540, 540);
    window.__cell(n, { es: 0.42 }, 0, 540, 0.5, 540, 540);
    window.__cell(n, { es: 99 }, 540, 0, 1, 1080, 1080);
    window.__cell(n, { es: 99, ...o }, 1620, 0, 1, 1080, 1080);
    ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 2; ctx.strokeRect(540, 0, 1080, 1080); ctx.strokeRect(1620, 0, 1080, 1080); ctx.strokeRect(0, 0, 540, 540); ctx.strokeRect(0, 540, 540, 540);
  }, { n, o: OPTS[n] || {} });
  writeFileSync(`out/sketch-sheet/${n}.png`, await page.screenshot({ type: "png" }));
}
// the contact sheet: everything at a third, six per row
const COLS = 6, CELL = 360, rows = Math.ceil(names.length / COLS);
await page.setViewportSize({ width: COLS * CELL, height: rows * CELL });
await page.evaluate(({ W, H }) => { const c = document.getElementById("c"); c.width = W; c.height = H; window.__ctx = c.getContext("2d"); window.KEOU_SKETCH.attach({ ctx: window.__ctx, W: 1080, H: 1080, issues: [] }) }, { W: COLS * CELL, H: rows * CELL });
await page.evaluate(({ names, COLS, CELL }) => {
  const ctx = window.__ctx; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, COLS * CELL, Math.ceil(names.length / COLS) * CELL);
  names.forEach((n, i) => { const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, CELL, CELL); ctx.clip(); ctx.translate(x + CELL / 2, y + CELL / 2 + 10); ctx.scale(1 / 3, 1 / 3);
    const fn = window.__ART[n]; if (fn) fn(0.7, 0.5, { es: 99 }); ctx.restore();
    ctx.fillStyle = "#666"; ctx.font = "20px sans-serif"; ctx.fillText(n, x + 10, y + 26); ctx.strokeStyle = "#222"; ctx.strokeRect(x, y, CELL, CELL) });
}, { names, COLS, CELL });
writeFileSync("out/sketch-sheet/_all.png", await page.screenshot({ type: "png" }));
await browser.close();
console.log(`${names.length} drawings → out/sketch-sheet/`);
