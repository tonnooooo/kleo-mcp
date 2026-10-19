// Kleo Studio — the web app. No framework: a small element builder, one state object, the JSON API of the
// kleo-studio Worker (src/studio/index.ts). Add ?demo=1 to the address to see the whole app on fake data.
//
// Pages: Create (chat with Kleo) · Video · Image · Audio · Apps · Library. Desktop: a top bar; phones: a tab bar.

const DEMO = new URLSearchParams(location.search).has("demo");
const DEMO_FREE = new URLSearchParams(location.search).get("demo") === "free"; // ?demo=free: an account that never paid
const DEMO_GUEST = new URLSearchParams(location.search).get("demo") === "guest"; // ?demo=guest: a visitor, not signed in
const IS_TOUCH = matchMedia("(hover: none)").matches;

// ── tiny DOM helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
/** replaceChildren that skips null/false and flattens arrays (the DOM would print "null"). */
function fill(el, ...kids) {
  if (!el) return el;
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
  return el;
}
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M9.5 4v16"/>',
  compose: '<path d="M12 20h8"/><path d="M15.8 4.2a2.5 2.5 0 0 1 3.5 3.5L8 19l-4.5 1 1-4.5Z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="3.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m21 15-4.5-4.5L8 19"/>',
  sound: '<path d="M11 5 6.5 9H3.5v6h3L11 19Z"/><path d="M15.5 8.6a5 5 0 0 1 0 6.8M18.4 6a8.8 8.8 0 0 1 0 12"/>',
  mute: '<path d="M11 5 6.5 9H3.5v6h3L11 19Z"/><path d="m22 9-6 6M16 9l6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  frame: '<rect x="4" y="6" width="16" height="12" rx="2.5"/>',
  hd: '<path d="M6 3.5h12l4 5.5-10 11.5L2 9Z"/><path d="M2 9h20M9.5 3.5 12 9l2.5-5.5M12 9v11.5"/>',
  dl: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  share: '<path d="M12 3v12M7.5 7 12 2.8 16.5 7"/><path d="M6 11H5a1 1 0 0 0-1 1v7.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V12a1 1 0 0 0-1-1h-1"/>',
  redo: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  wand: '<path d="m4 20 10.5-10.5M13 5.5l1.5-3 1.5 3 3 1.5-3 1.5-1.5 3-1.5-3-3-1.5Z"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 12.2A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.8L17.5 7M9 7V4.5h6V7"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9Z"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  bag: '<path d="M5 8h14l-1 12H6Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10.5 18.5h3"/>',
  flame: '<path d="M12 21c4 0 6.5-2.6 6.5-6.2 0-3.6-2.8-5.9-4.3-9.8-1 2.6-2.4 3.7-3.7 4.4C10 7.6 9.3 6.3 9 5c-2 2.4-3.5 5.6-3.5 9.6C5.5 18.3 8 21 12 21Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  cup: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 3.5c-.5 1 .5 1.8 0 3M12 3.5c-.5 1 .5 1.8 0 3"/>',
  play: '<path d="M8 5.5v13l10.5-6.5Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8Z"/>',
  chat: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5Z"/>',
  apps: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
  lips: '<path d="M3 12c2.5-3 5-4.5 6.5-4.5 1 0 1.8.6 2.5 1.2.7-.6 1.5-1.2 2.5-1.2 1.5 0 4 1.5 6.5 4.5-2.5 3.5-5.5 5-9 5s-6.5-1.5-9-5Z"/><path d="M3 12h18"/>',
  run: '<circle cx="14" cy="4.5" r="2"/><path d="m8 21 3-6 3 2v4M6 12l3-4 4 1 3 3 3 1M11 9l-1 6"/>',
  shirt: '<path d="m8 3-5 3 2 4 2-1v12h10V9l2 1 2-4-5-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3Z"/>',
  library: '<rect x="3" y="3" width="7" height="18" rx="2"/><rect x="14" y="3" width="7" height="11" rx="2"/><path d="M14 18h7M14 21h7"/>',
};
function icon(name, size = 20, sw = 1.9) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size);
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", sw);
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = P[name] || "";
  return s;
}
function bolt(size = 14) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("aria-hidden", "true");
  s.classList.add("bolt");
  s.innerHTML = '<path fill="currentColor" d="M13.2 2.3 4.6 13.4a.8.8 0 0 0 .6 1.3h6l-1 7a.5.5 0 0 0 .9.4l8.6-11.1a.8.8 0 0 0-.6-1.3h-6l1-7a.5.5 0 0 0-.9-.4Z"/>';
  return s;
}
const googleLogo = () => h("span", { html: '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>' });
const microsoftLogo = () => h("span", { html: '<svg width="19" height="19" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>' });
const appleLogo = () => h("span", { html: '<svg width="18" height="20" viewBox="0 0 814 1000" aria-hidden="true"><path fill="currentColor" d="M788 341c-6 4-108 61-108 189 0 148 130 200 134 201-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-165-40c-77 0-104 41-167 41s-106-58-156-129C43 785 0 651 0 523c0-205 133-314 265-314 70 0 128 46 172 46 42 0 107-49 187-49 31 0 140 3 212 106zM540 150c31-37 54-89 54-140 0-7-1-14-2-20-51 2-112 34-149 77-28 32-55 85-55 137 0 8 1 16 2 18 3 1 9 1 14 1 46 0 103-31 136-73z"/></svg>' });
const SOCIAL = { google: { label: "Google", logo: googleLogo }, apple: { label: "Apple", logo: appleLogo }, microsoft: { label: "Microsoft", logo: microsoftLogo } };
const socialList = () => (S.config?.social || (S.config?.google ? ["google"] : [])).filter((k) => SOCIAL[k]);

const store = {
  get(k, d) { try { const v = localStorage.getItem("kleo." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kleo." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("err", !!err); t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), Math.max(2800, String(msg).length * 55));
}
const spinner = (size = 16) => h("span", { class: "spin", style: { borderColor: "rgba(127,127,127,.35)", borderTopColor: "currentColor", width: size + "px", height: size + "px" } });
const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s * 10) / 10}s`);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────
const S = {
  config: null, me: null, chats: [], chat: null, messages: [], gens: new Map(), view: "chat",
  mode: store.get("mode", "video"), settings: store.get("settings", {}), imageSettings: store.get("imageSettings", {}),
  agent: store.get("agent", true), attachments: [], busy: false,
  // the Video and Image pages keep their own form while you move around
  page: { video: { prompt: "", refs: [], preset: null }, image: { prompt: "", refs: [] } },
  feeds: {},
};
const model = (key) => S.config.models.find((m) => m.key === key) || S.config.models.find((m) => m.key === S.config.defaultModel);
// FREE RESOLUTIONS (15 October 2026): an account that never paid makes 480p; 720p and 1080p show a lock and open Get credits.
const RES_ALL = ["480p", "720p", "1080p"];
const freeRes = () => (S.me && !S.me.paid && Array.isArray(S.me.freeResolutions) ? S.me.freeResolutions : null);
const resLocked = (r) => { const f = freeRes(); return !!f && !f.includes(r); };
const resNote = () => { const f = freeRes() || []; return `${RES_ALL.filter((r) => !f.includes(r)).join(" and ")} unlock with your first credit pack. Free credits make ${f.join(" and ")} videos.`; };
/** The resolutions shown for a model: a free account sees every one, the locked ones with a lock. */
const resList = (m) => (freeRes() && allowed(m.key) ? RES_ALL : m.resolutions);
function fix(s, images = 0, clips = { videos: 0, audios: 0 }) {
  let m = model(s.model);
  const hasClips = clips.videos + clips.audios > 0;
  if (hasClips && m.family !== "seedance") m = model("seedance-2.5");
  if (clips.videos > 0 && (s.videoRole === "edit" || s.videoRole === "extend")) m = model("seedance-2.5");
  const out = { model: m.key };
  out.duration = m.durations.includes(Number(s.duration)) ? Number(s.duration) : m.defaultDuration;
  out.resolution = m.resolutions.includes(s.resolution) ? s.resolution : m.defaultResolution;
  if (resLocked(out.resolution)) out.resolution = m.resolutions.find((r) => !resLocked(r)) || out.resolution;
  out.aspect = m.aspects.includes(s.aspect) ? s.aspect : "16:9";
  out.audio = s.audio !== false;
  out.imageRole = images === 0 ? "none" : images === 1 && !hasClips ? (s.imageRole === "reference" ? "reference" : "first_frame") : "reference";
  out.videoRole = clips.videos ? (s.videoRole === "edit" || s.videoRole === "extend" ? s.videoRole : "reference") : "none";
  return out;
}
const price = (s) => model(s.model).prices[s.resolution]?.[s.duration] ?? 1;
const allowed = (key) => !S.me || S.me.allowed.includes(key);
const imodel = (key) => S.config.imageModels.find((m) => m.key === key) || S.config.imageModels.find((m) => m.key === S.config.defaultImageModel);
function ifix(s) {
  let m = imodel(s.model);
  if (m.paused) m = imodel(S.config.defaultImageModel);
  return { model: m.key, aspect: m.aspects.includes(s.aspect) ? s.aspect : "1:1", quality: m.qualities.includes(s.quality) ? s.quality : m.defaultQuality, count: m.counts.includes(Number(s.count)) ? Number(s.count) : 1 };
}
const iprice = (s) => imodel(s.model).prices[s.quality]?.[s.count] ?? 1;
const iallowed = (key) => !S.me || (S.me.allowedImages || []).includes(key);
const tallowed = (key) => !S.me || (S.me.allowedTools || []).includes(key);
const tool = (key) => (S.config.tools || []).find((t) => t.key === key);
const isImage = (p) => p?.kind === "image";
const RATIOS = { "16:9": [34, 19, "YouTube"], "9:16": [19, 34, "TikTok · Reels"], "1:1": [26, 26, "Square"], "4:3": [30, 23, "Classic"], "3:4": [23, 30, "Portrait"], "21:9": [38, 16, "Cinema"], "4:5": [24, 30, "Instagram"], "2:3": [21, 31, "Poster"], "3:2": [31, 21, "Photo"] };
const clipCount = (list) => ({ videos: list.filter((a) => a.kind === "video").length, audios: list.filter((a) => a.kind === "audio").length });
const picCount = (list) => list.filter((a) => (a.kind || "image") === "image").length;

// ── API ──────────────────────────────────────────────────────────────────────────────────────────────────────────
class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
async function api(path, opts = {}) {
  if (DEMO) return demoApi(path, opts);
  const init = { method: opts.method || "GET", headers: { "x-kleo": "1" }, credentials: "same-origin" };
  if (opts.raw) { init.body = opts.raw; Object.assign(init.headers, opts.headers || {}); }
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["content-type"] = "application/json"; }
  let res;
  try { res = await fetch(path, init); } catch { throw new ApiError("You seem to be offline.", 0, "offline"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || "Something went wrong.", res.status, data.code);
  return data;
}
function handleError(e) {
  if (e?.code === "signin") { S.me = null; renderAuth("signin", true); return; }
  if (e?.code === "locked" || e?.code === "credits") { toast(e.message, true); setTimeout(() => openBuy(), 350); return; }
  toast(e?.message || "Something went wrong.", true);
}
function setCredits(n) {
  if (!S.me || typeof n !== "number" || n === S.me.credits) return;
  S.me.credits = n;
  for (const el of document.querySelectorAll("[data-credits]")) { el.textContent = S.me.admin ? "∞" : n; el.parentElement?.classList.remove("bump"); void el.offsetWidth; el.parentElement?.classList.add("bump"); }
}

/** Uploads one file (pictures are shrunk to 2048 px first). Answers { id, kind, duration, local }. */
async function uploadFile(f) {
  if (!S.me && !DEMO) { requireAccount(); throw new Error("Create a free account to upload."); }
  const isPic = f.type.startsWith("image/");
  if (f.type.startsWith("video/") && f.size > 60 * 1048576) throw new Error("That video is too big (60 MB max).");
  if (f.type.startsWith("audio/") && f.size > 15 * 1048576) throw new Error("That sound is too big (15 MB max).");
  let body = f, headers = { "content-type": f.type || "application/octet-stream" };
  if (isPic) { const { blob, w, h: hh } = await shrink(f); body = blob; headers = { "content-type": blob.type, "x-width": String(w), "x-height": String(hh) }; }
  const local = URL.createObjectURL(f);
  const r = DEMO ? demoUpload(local, isPic ? "image" : f.type.startsWith("video/") ? "video" : "audio") : await api("/api/uploads", { method: "POST", raw: body, headers });
  return { id: r.id, kind: r.kind || "image", duration: r.duration ?? null, local };
}
/** The first frame of a video file, as a JPEG at the video's own size (Character Swap redraws it). */
async function firstFrame(file) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
  await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("Kleo couldn't read that video. Use an MP4 or MOV.")); });
  await new Promise((ok) => { v.onseeked = ok; v.currentTime = 0.001; setTimeout(ok, 1500); });
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
  URL.revokeObjectURL(v.src);
  if (!blob) throw new Error("Kleo couldn't read the first frame of that video.");
  return new File([blob], "first-frame.jpg", { type: "image/jpeg" });
}
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
    if (blob) return { blob, w: c.width, h: c.height };
  } catch { /* fall through: send the file as it is */ }
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Use a JPG, PNG or WebP picture.");
  return { blob: file, w: 0, h: 0 };
}
function pickFile(accept, multiple, cb) {
  const i = h("input", { type: "file", accept, multiple: multiple || null, style: { display: "none" } });
  i.addEventListener("change", () => { cb([...i.files]); i.remove(); });
  document.body.append(i); i.click();
}

// ── boot & routing ───────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  applyTheme();
  try { S.config = await api("/api/config"); } catch { fill($("#app"), h("div", { class: "boot" }, h("p", {}, "Kleo can't load right now. Please refresh."))); return; }
  const q = new URLSearchParams(location.search);
  if (location.pathname === "/reset" && q.get("t")) return renderReset(q.get("t"));
  // ONE ACCOUNT EVERYWHERE (19 October 2026, src/connect.ts): an assistant sent this browser here to sign in. The request
  // is kept across the sign-in (Google comes back to "/"), then finished by connectView.
  if (location.pathname === "/connect" && (q.get("r") || q.get("m"))) {
    store.set("connect", { r: q.get("r") || null, m: q.get("m") || null, at: Date.now() });
    history.replaceState(null, "", "/connect");
  }
  const err = q.get("signin_error"), linked = q.get("linked");
  // A new Google account that started without the free credits (one gift per person, src/abuse.ts).
  if (q.get("gift") === "none") { history.replaceState(null, "", "/"); setTimeout(() => toast(S.config.noGift || "Free credits are one per person.", true), 300); }
  if (err || linked) {
    history.replaceState(null, "", "/");
    const who = (k) => SOCIAL[k]?.label || "That account";
    const msg = linked ? `${who(linked)} is now connected — use it to sign in next time.`
      : err === "day_full" ? "Kleo is full for new accounts today. Please come back tomorrow."
      : err === "address_full" ? "Too many new accounts from this connection today."
      : err === "address_blocked" ? "No new accounts can be opened from this connection for now. Sign in to the account you already have."
      : /^taken_/.test(err) ? `That ${who(err.slice(6))} account already belongs to another Kleo account.`
      : /^claimed_/.test(err) ? `This e-mail already has a Kleo account. Sign in to it with your password or Kleo key, then connect ${who(err.slice(8))} from Account.`
      : err === "cancelled" ? "Sign-in was cancelled." : `${who(err)} sign-in didn't finish. Please try again.`;
    setTimeout(() => toast(msg, !linked), 300);
  }
  try { S.me = await api("/api/me"); } catch (e) { if (!(e.code === "signin" || e.status === 401)) return handleError(e); S.me = null; }
  if (S.me && location.pathname === "/" && pendingConnect()) history.replaceState(null, "", "/connect");
  await enter();
}
const pendingConnect = () => { const p = store.get("connect", null); return p && Date.now() - p.at < 30 * 60e3 ? p : null; };
function connectCard(title, text, ...extra) {
  return h("div", { class: "connect-card" }, h("div", { class: "logo-orb" }, h("img", { src: "/kleo-mark.svg", alt: "Kleo" })), h("h1", {}, title), h("p", {}, text), ...extra);
}
/** /connect: the signed-in account finishes an assistant's connection (or takes in its old anonymous account). */
async function connectView() {
  const pend = pendingConnect();
  if (!pend) {
    setView("connect-view", connectCard("This link has expired", "Go back to your assistant and connect Kleo again.", h("button", { class: "btn btn-primary", onclick: () => go("/") }, "Open Kleo")));
    return;
  }
  if (!S.me) { S.connecting = true; renderAuth("signin", true); return; }
  setView("connect-view", connectCard("Connecting Kleo…", "One moment.", spinner(22)));
  try {
    const r = await api("/api/connect", { method: "POST", body: { r: pend.r, m: pend.m } });
    store.set("connect", null); S.connecting = false;
    if (r.url) { location.href = r.url; return; }
    try { S.me = await api("/api/me"); setCredits(S.me.credits); } catch { /* later */ }
    setView("connect-view", connectCard("Kleo is connected", `${r.merged ? `Your ${r.merged} credits and your videos are now in this account. ` : ""}Go back to your assistant and ask again: it uses the same credits as this app.`,
      h("button", { class: "btn btn-primary", onclick: () => go("/") }, "Open Kleo")));
  } catch (e) {
    if (e.code === "anonymous") {
      // Signed in with a bare Kleo key: sign in with Google or an e-mail instead; the key's account is merged then.
      try { await api("/api/auth/signout", { method: "POST" }); } catch { /* the cookie goes anyway */ }
      S.me = null; S.connecting = true; renderAuth("signin", true); return;
    }
    store.set("connect", null); S.connecting = false;
    setView("connect-view", connectCard("Kleo couldn't connect", e.message || "Please try again from your assistant.", h("button", { class: "btn btn-primary", onclick: () => go("/") }, "Open Kleo")));
  }
}
/** Visitors browse everything; the account is asked for at the first Generate (or Sign in). */
function requireAccount(mode = "signup") { renderAuth(mode, true); return false; }
const signedIn = () => !!S.me;
async function enter() {
  S.settings = fix(S.settings);
  if (S.me && !allowed(S.settings.model)) S.settings = fix({ ...S.settings, model: S.me.allowed[0] });
  S.imageSettings = ifix(S.imageSettings);
  if (S.me && !iallowed(S.imageSettings.model) && S.me.allowedImages?.length) S.imageSettings = ifix({ ...S.imageSettings, model: S.me.allowedImages[0] });
  renderShell();
  loadChats();
  await route();
}
const PAGES = [
  { key: "chat", path: "/", label: "Create", ic: "chat" },
  { key: "explore", path: "/explore", label: "Explore", ic: "sparkle" },
  { key: "video", path: "/video", label: "Video", ic: "film" },
  { key: "image", path: "/image", label: "Image", ic: "photo" },
  { key: "audio", path: "/audio", label: "Audio", ic: "music" },
  { key: "apps", path: "/apps", label: "Apps", ic: "apps" },
  { key: "library", path: "/library", label: "Library", ic: "library" },
];
async function route() {
  const p = location.pathname;
  closeLayer();
  // A "Generate" button on kleooai.com opens the app with its prompt (?prompt=…&aspect=…): the form is filled, nothing
  // is charged until the person taps Generate. The parameters leave the address bar at once.
  const q = new URLSearchParams(location.search);
  const pre = (q.get("prompt") || "").slice(0, 4000);
  if (pre || q.get("aspect")) {
    if (p === "/video" || p === "/image") S.page[p.slice(1)].prompt = pre;
    else if (p === "/") S.prefill = pre;
    if (q.get("aspect") && RATIOS[q.get("aspect")]) S.settings = fix({ ...S.settings, aspect: q.get("aspect") });
    q.delete("prompt"); q.delete("aspect");
    history.replaceState(null, "", p + (q.toString() ? `?${q}` : ""));
  }
  if (p === "/connect") return show("chat", () => connectView());
  if (p === "/explore") return show("explore", () => exploreView());
  if (p === "/account") return show("account", () => accountView());
  const m = p.match(/^\/c\/(c_[a-z0-9]+)/);
  const app = p.match(/^\/apps\/([a-z0-9-]+)/);
  if (m) return show("chat", () => openChat(m[1]));
  if (p === "/video") return show("video", () => generatorView("video"));
  if (p === "/image") return show("image", () => generatorView("image"));
  if (p === "/audio") return show("audio", () => audioView());
  if (app) return show("apps", () => appView(app[1]));
  if (p === "/apps") return show("apps", () => appsView());
  if (p === "/library") return show("library", () => libraryView());
  return show("chat", () => newChat());
}
function show(key, render) {
  S.view = key;
  for (const b of document.querySelectorAll("[data-page]")) b.classList.toggle("on", b.dataset.page === key);
  render();
}
function go(path) {
  const target = DEMO ? path + (path.includes("?") ? "&" : "?") + "demo=1" : path;
  if (location.pathname + location.search !== target) history.pushState(null, "", target);
  route();
}
addEventListener("popstate", () => S.me && route());
addEventListener("focus", async () => {
  if (!S.me || DEMO) return;
  try { const me = await api("/api/me"); const before = S.me.credits; S.me = me; S.me.credits = before; setCredits(me.credits); } catch { /* later */ }
});

// ── auth screens ─────────────────────────────────────────────────────────────────────────────────────────────────
const AUTH_WALL = [
  ["dragon-rider-cat:w", "raccoons-pizza-run:t", "koi-supra-night:w", "corgi-knight-cathedral:t", "venice-high-water-kleo:w"],
  ["mechs-in-snow:t", "tether-film:w", "kitten-knight-black-dragon:w", "octopus-facts:t", "apex-film:w"],
  ["signal-delay:w", "street-reel:t", "made-in-kleo-ai-queen:w", "venice-whale:t", "puppy-knight:w"],
  ["kitten-knight-living-room:t", "diver-bowling:w", "the-wake-trailer:w", "corgi-knight-arrival:t", "knights-and-goblins:w"],
];
function authFrame(title, sub, ...content) {
  // The left half (desktop only) is a slowly drifting wall of the team's films, each in its own small rounded tile:
  // small enough that the preview files stay sharp (the owner, 18 Oct: one big video looked grainy and cut).
  const wall = h("div", { class: "auth-wall", "aria-hidden": "true" }, AUTH_WALL.map((col, n) =>
    h("div", { class: `aw-col aw-${n}` }, h("div", { class: "aw-track" }, [...col, ...col].map((x) => {
      const [slug, f] = x.split(":");
      return h("div", { class: `aw-tile ${f === "t" ? "tall" : "wide"}` }, loopVideo(`${GALLERY}/${slug}-p.mp4`, `${GALLERY}/${slug}.jpg`));
    })))));
  fill($("#app"), h("div", { class: "auth" },
    h("div", { class: "auth-media" }, wall, h("div", { class: "auth-media-tx" }, h("img", { src: "/kleo-mark.svg", alt: "" }),
      h("b", {}, "Every frame you see here was made with Kleo."), h("span", {}, "Seedance 2.5, Veo 3.1, FLUX.2 and whole Kleo films, in one place."))),
    h("div", { class: "auth-side" }, h("div", { class: "auth-card" },
      h("div", { class: "logo-orb" }, h("img", { src: "/kleo-mark.svg", alt: "Kleo" })), h("h1", {}, title), h("p", { class: "sub" }, sub), ...content))));
}
function busyButton(btn) { const old = btn.textContent; btn.disabled = true; fill(btn, spinner(18)); return () => { btn.disabled = false; btn.textContent = old; }; }
// Cloudflare Turnstile on sign-up (only when the server has a site key): the bot check behind the free credits.
let turnstileLoad = null;
function loadTurnstile() {
  turnstileLoad ??= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = () => ok(window.turnstile);
    s.onerror = () => { turnstileLoad = null; no(new Error("The human check didn't load. Check your connection and try again.")); };
    document.head.append(s);
  });
  return turnstileLoad;
}
function renderAuth(mode = "signup", fromApp = false) {
  let showKey = false;
  // Once Google sign-in is on, new accounts are opened with Google only (STUDIO_SIGNUP): the e-mail form is for signing in.
  const googleOnly = mode === "signup" && S.config?.signup === "google" && socialList().includes("google");
  let checkToken = "", checkId = null, checkWaiters = [];
  const tokenReady = () => checkToken ? Promise.resolve(checkToken) : new Promise((ok) => { checkWaiters.push(ok); setTimeout(() => ok(checkToken), 15000); });
  const check = mode === "signup" && !googleOnly && S.config?.turnstile ? h("div", { class: "human-check" }) : null;
  const email = h("input", { class: "input", type: "email", placeholder: "E-mail", autocomplete: "email", inputmode: "email", autocapitalize: "off" });
  const pass = h("input", { class: "input", type: "password", placeholder: mode === "signup" ? "Password (8+ characters)" : "Password", autocomplete: mode === "signup" ? "new-password" : "current-password" });
  const key = h("input", { class: "input", placeholder: "Paste your Kleo key", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const err = h("div", { class: "auth-err" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, mode === "signup" ? "Create account" : "Sign in");
  const keyBox = h("div", { style: { display: "none" } }, key);
  let made = null;
  const form = h("form", { onsubmit: async (ev) => {
    ev.preventDefault(); err.textContent = "";
    const restore = busyButton(submit);
    try {
      if (showKey) await api("/api/auth/key", { method: "POST", body: { key: key.value } });
      else {
        if (check && mode === "signup") await tokenReady();
        made = await api(mode === "signup" ? "/api/auth/signup" : "/api/auth/signin", { method: "POST", body: { email: email.value, password: pass.value, turnstile: checkToken } });
      }
      S.me = await api("/api/me");
      S.feeds = {};
      await enter();
      if (mode === "signup" && !showKey) toast(made?.note || `Welcome! You have ${S.me.credits} free credits.`, !!made?.note);
    } catch (e) {
      err.textContent = e.message; restore();
      if (check && checkId !== null) { checkToken = ""; window.turnstile?.reset(checkId); }
    }
  } }, email, pass, keyBox, check, err, submit);
  // Google only: the form appears just for "I have a Kleo key" (an account that already exists).
  if (googleOnly) form.style.display = "none";
  if (check) loadTurnstile().then((t) => {
    checkId = t.render(check, { sitekey: S.config.turnstile, theme: "auto", size: "flexible", appearance: "interaction-only",
      callback: (v) => { checkToken = v; checkWaiters.splice(0).forEach((ok) => ok(v)); }, "expired-callback": () => { checkToken = ""; }, "error-callback": () => { checkToken = ""; } });
  }).catch((e) => { err.textContent = e.message; });
  const toggleKey = h("button", { type: "button", onclick: () => {
    showKey = !showKey;
    if (googleOnly) form.style.display = showKey ? "" : "none";
    keyBox.style.display = showKey ? "" : "none"; email.style.display = pass.style.display = showKey ? "none" : "";
    if (check) check.style.display = showKey ? "none" : "";
    submit.textContent = showKey ? "Sign in with key" : mode === "signup" ? "Create account" : "Sign in";
    toggleKey.textContent = showKey ? "Use e-mail instead" : "I have a Kleo key";
    (showKey ? key : email).focus();
  } }, "I have a Kleo key");
  authFrame(S.connecting ? "Connect Kleo to your assistant" : mode === "signup" ? "Create with Kleo" : "Welcome back",
    S.connecting ? "Sign in or create your free account. Your credits are the same here and in Grok, Claude or ChatGPT." : "Videos, pictures, voices and films — just by chatting.",
    mode === "signup" ? h("div", { class: "gift" }, bolt(15), `${S.config?.freeCredits ?? 5} free credits to start`) : null,
    socialList().length ? [h("div", { class: "socials" }, socialList().map((k) => h("a", { class: `btn social social-${k}`, href: `/auth/${k}` }, SOCIAL[k].logo(), `Continue with ${SOCIAL[k].label}`))), googleOnly ? null : h("div", { class: "or" }, "or use e-mail")] : null,
    form,
    h("div", { class: "auth-switch" },
      mode === "signup" ? ["Already have an account? ", h("button", { type: "button", onclick: () => renderAuth("signin") }, "Sign in")]
        : ["New here? ", h("button", { type: "button", onclick: () => renderAuth("signup") }, "Create an account")]),
    h("div", { class: "auth-switch small" }, toggleKey, mode === "signin" ? [" · ", h("button", { type: "button", onclick: () => renderForgot(email.value) }, "Forgot password?")] : null),
    h("div", { class: "auth-switch small" }, h("button", { type: "button", onclick: () => enter() }, fromApp ? "← Keep looking around" : "Look around first")),
    h("div", { class: "auth-foot" }, "By continuing you agree to the ", h("a", { href: "https://kleooai.com/terms.html", target: "_blank" }, "Terms"), " and ",
      h("a", { href: "https://kleooai.com/privacy.html", target: "_blank" }, "Privacy Policy"), "."));
  setTimeout(() => (IS_TOUCH ? null : email.focus()), 50);
}
function renderForgot(prefill = "") {
  if (!S.config?.emailReset) {
    authFrame("Forgot your password?", "Write to us from the e-mail of your account and we'll get you back in.",
      h("a", { class: "btn btn-primary", href: "mailto:hello@kleooai.com?subject=Kleo%20password%20reset" }, "Write to hello@kleooai.com"),
      h("div", { class: "auth-switch" }, h("button", { type: "button", onclick: () => renderAuth("signin") }, "Back to sign in")));
    return;
  }
  const email = h("input", { class: "input", type: "email", placeholder: "E-mail", autocomplete: "email", value: prefill });
  const err = h("div", { class: "auth-err" });
  const btn = h("button", { class: "btn btn-primary", type: "submit" }, "Send me a link");
  authFrame("Forgot your password?", "We'll e-mail you a link to choose a new one.",
    h("form", { onsubmit: async (ev) => {
      ev.preventDefault(); err.textContent = "";
      const restore = busyButton(btn);
      try {
        await api("/api/auth/forgot", { method: "POST", body: { email: email.value } });
        authFrame("Check your e-mail", "If an account uses that address, a link is on its way. It works for one hour.",
          h("div", { class: "auth-switch" }, h("button", { type: "button", onclick: () => renderAuth("signin") }, "Back to sign in")));
      } catch (e) { err.textContent = e.message; restore(); }
    } }, email, err, btn),
    h("div", { class: "auth-switch" }, h("button", { type: "button", onclick: () => renderAuth("signin") }, "Back to sign in")));
  email.focus();
}
function renderReset(token) {
  const pass = h("input", { class: "input", type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
  const err = h("div", { class: "auth-err" });
  const btn = h("button", { class: "btn btn-primary", type: "submit" }, "Save and sign in");
  authFrame("Choose a new password", "Then you're straight back in.",
    h("form", { onsubmit: async (ev) => {
      ev.preventDefault(); err.textContent = "";
      const restore = busyButton(btn);
      try {
        await api("/api/auth/reset", { method: "POST", body: { token, password: pass.value } });
        history.replaceState(null, "", "/");
        S.me = await api("/api/me"); await enter(); toast("Password changed. Other sessions are signed out and your Kleo key is new: reconnect your AI assistant with it (Account)");
      } catch (e) { err.textContent = e.message; restore(); }
    } }, pass, err, btn));
  pass.focus();
}

// ── shell: top bar (desktop), tab bar (phone) ────────────────────────────────────────────────────────────────────
function renderShell() {
  const nav = h("header", { class: "nav" },
    h("div", { class: "brand", onclick: () => go("/") }, h("img", { src: "/kleo-mark.svg", alt: "" }), "Kleo"),
    h("nav", { class: "nav-tabs", "aria-label": "Main" }, PAGES.map((p) => h("button", { class: "nav-tab", "data-page": p.key, onclick: () => go(p.path) },
      icon(p.ic, 17), p.label, p.isNew ? h("span", { class: "new" }, "NEW") : null))),
    h("div", { class: "nav-right" }, h("a", { class: "btn btn-quiet btn-sm nav-plugin", href: "https://kleooai.com/mcp/", target: "_blank", rel: "noopener" }, icon("plug", 16), "Install plugin"), S.me ? [
      h("button", { class: "credits-pill", onclick: () => openBuy(), "aria-label": "Credits" }, bolt(15), h("span", { "data-credits": "" }, S.me.admin ? "∞" : S.me.credits)),
      h("button", { class: "avatar avatar-btn", "aria-label": "Account", onclick: openAccount }, (S.me.name || S.me.email || "K")[0].toUpperCase())] : [
      h("button", { class: "btn btn-quiet btn-sm", onclick: () => requireAccount("signin") }, "Sign in"),
      h("button", { class: "btn btn-cta btn-sm", onclick: () => requireAccount("signup") }, "Start free")]));
  const tabs = h("nav", { class: "tabbar", "aria-label": "Main" }, PAGES.map((p) => h("button", { "data-page": p.key, onclick: () => go(p.path) }, icon(p.ic, 22), p.label)));
  fill($("#app"), h("div", { class: "frame" }, nav, h("div", { class: "views" }, h("section", { class: "view", id: "view" })), tabs));
}
const viewEl = () => $("#view");
function setView(cls, ...kids) { const v = viewEl(); v.className = `view ${cls || ""}`; v.scrollTop = 0; fill(v, ...kids); return v; }

// ── Create: the chat with Kleo ───────────────────────────────────────────────────────────────────────────────────
function chatShell() {
  if ($("#scroll") && viewEl().classList.contains("chat-view") && viewEl().classList.contains("no-side") === !S.me) return;
  const side = h("aside", { class: "chat-side", id: "chat-side" },
    h("button", { class: "nav-item", onclick: () => { closeChatSide(); go("/"); } }, icon("compose", 19), "New chat"),
    h("div", { class: "side-label" }, "Chats"),
    h("div", { class: "chats", id: "chats" }));
  const main = h("div", { class: "chat-main" },
    S.me ? h("div", { class: "chat-top" }, h("button", { class: "mini", onclick: openChatSide }, icon("side", 15), "Chats")) : null,
    h("div", { class: "scroll", id: "scroll" }, h("div", { class: "col", id: "col" })),
    h("div", { class: "dock", id: "dock" }, composer()));
  // Visitors have no chats: the page gets the whole width instead of an empty list.
  setView("chat-view" + (S.me ? "" : " no-side"), S.me ? side : null, main);
  renderChats();
}
function openChatSide() { $("#chat-side")?.classList.add("open"); const s = h("div", { class: "side-scrim", onclick: closeChatSide }); viewEl().append(s); S.sideScrim = s; }
function closeChatSide() { $("#chat-side")?.classList.remove("open"); S.sideScrim?.remove(); S.sideScrim = null; }
async function loadChats() {
  if (!S.me) { S.chats = []; renderChats(); return; }
  try { S.chats = (await api("/api/chats")).chats; } catch { S.chats = []; }
  renderChats();
}
function renderChats() {
  const box = $("#chats"); if (!box) return;
  fill(box, S.chats.length ? S.chats.map((c) => h("div", { class: "chat-item" + (S.chat?.id === c.id ? " on" : ""), role: "button", tabindex: "0",
    onclick: () => { closeChatSide(); go(`/c/${c.id}`); }, onkeydown: (e) => e.key === "Enter" && go(`/c/${c.id}`) },
    h("span", {}, c.title || "Untitled"),
    h("button", { class: "del", title: "Delete chat", "aria-label": "Delete chat", onclick: async (e) => {
      e.stopPropagation();
      if (!(await ask({ title: "Delete this chat?", text: "Your videos and pictures stay in the Library.", ok: "Delete", danger: true }))) return;
      try { await api(`/api/chats/${c.id}`, { method: "DELETE" }); S.chats = S.chats.filter((x) => x.id !== c.id); renderChats(); if (S.chat?.id === c.id) go("/"); } catch (er) { handleError(er); }
    } }, icon("trash", 16)))) : h("div", { class: "empty-chats" }, "Your chats will show up here."));
}
function newChat() {
  chatShell();
  S.chat = null; S.messages = [];
  renderMessages(); renderChats();
  if (!IS_TOUCH) $("#prompt")?.focus();
}
async function openChat(id) {
  chatShell();
  if (S.chat?.id !== id) { S.chat = { id }; S.messages = []; fill($("#col"), h("div", { class: "hero" }, h("span", { class: "spin dark", style: { margin: "0 auto" } }))); }
  renderChats();
  try {
    const r = await api(`/api/chats/${id}`);
    S.chat = r.chat; S.messages = r.messages;
    for (const m of S.messages) collectGens(m);
    renderMessages(true); renderChats();
  } catch (e) { if (e.status === 404) { toast("That chat is gone.", true); go("/"); } else handleError(e); }
}
function collectGens(m) {
  for (const g of [m.generation, ...(m.generations || [])].filter(Boolean)) { S.gens.set(g.id, g); if (g.status === "running") watch(g.id); }
}

const IDEAS = {
  video: [
    { a: "v-product", ic: "bag", c: "#ff9500", t: "Cinematic product shot", p: "A sleek black wireless earbud case opening slowly on a wet reflective surface, macro lens, soft rim light, slow orbit, premium commercial look, subtle whoosh sound." },
    { a: "v-tiktok", ic: "phone", c: "#ff2d55", t: "Scroll-stopping TikTok hook", p: "A vertical POV shot running through a neon night market in Tokyo, handheld energy, steam and lights, fast and exciting, upbeat ambience." },
    { a: "v-animate", ic: "photo", c: "#007aff", t: "Animate a photo", p: "", photo: true },
    { a: "v-anime", ic: "flame", c: "#af52de", t: "Anime fight scene", p: "Two anime warriors clash on a rooftop at sunset, dramatic speed lines, wind in their hair, dynamic camera swing, epic music swell." },
    { a: "v-travel", ic: "globe", c: "#30b0c7", t: "Dreamy travel clip", p: "Drone shot gliding over turquoise water toward a tiny island with one palm tree at golden hour, gentle waves, calm ambient sound." },
    { a: "v-cafe4", ic: "cup", c: "#a2845e", t: "Cozy café ad", p: "Close-up of latte art being poured in a warm sunlit café, steam rising, shallow depth of field, slow push-in, soft jazz in the background." },
  ],
  image: [
    { a: "i-product", ic: "bag", c: "#ff9500", t: "Product photo", p: "A minimalist perfume bottle on a travertine pedestal, soft morning light through palm leaves, beige and sage palette, studio product photography, crisp reflections." },
    { a: "i-thumb", ic: "star", c: "#ff2d55", t: "YouTube thumbnail", p: "A shocked young creator pointing at a giant glowing golden trophy, bold rim light, vibrant teal and orange background, high contrast YouTube thumbnail style, big empty space on the right." },
    { a: "i-edit", ic: "photo", c: "#007aff", t: "Edit my photo", p: "", photo: true },
    { a: "i-poster", ic: "text", c: "#af52de", t: "Poster with text", p: "A retro 70s travel poster of the Amalfi coast, sun-faded colors, bold title text \"AMALFI\" at the top, grainy print texture." },
    { a: "i-character", ic: "user", c: "#30b0c7", t: "Character design", p: "Full-body character sheet of a friendly cyberpunk courier girl with a yellow jacket and a robot cat, front and side views, clean white background, 3D animated film style." },
    { a: "i-album", ic: "layers", c: "#a2845e", t: "Album cover", p: "An album cover: a lone astronaut sitting on a crescent moon fishing for stars, dreamy pastel gradient sky, painterly texture, square composition." },
  ],
};
function renderMessages(jump = false) {
  const col = $("#col"); if (!col) return;
  col.classList.toggle("wide", !S.messages.length && S.mode !== "image");
  if (!S.messages.length && S.mode !== "image") {
    fill(col, homeView());
    if (S.prefill) { const t = $("#prompt"); if (t) { t.value = S.prefill; autosize(t); updateSend(); t.focus(); } S.prefill = ""; }
    return;
  }
  if (!S.messages.length) {
    const img = S.mode === "image";
    fill(col, h("div", { class: "hero" },
      h("div", { class: "logo-orb" }, h("img", { src: "/kleo-mark.svg", alt: "" })),
      h("h1", {}, img ? "What should we picture?" : "What do you want to create?"),
      h("p", {}, S.agent ? "Tell Kleo your idea, drop a photo or a clip, or tap an example." : img ? "Describe your picture and hit Generate." : "Describe your video and hit Generate."),
      h("div", { class: "idea-grid three" }, IDEAS[S.mode].map(ideaCard)),
      h("div", { class: "steps", style: { justifyContent: "center", marginTop: "22px" } },
        h("button", { class: "mini", onclick: () => go("/apps") }, icon("apps", 15), "Face swap, talking photos & more in Apps")),
      showcaseStrip("Made by the Kleo team")));
    if (S.prefill) { const t = $("#prompt"); if (t) { t.value = S.prefill; autosize(t); updateSend(); t.focus(); } S.prefill = ""; }
    return;
  }
  fill(col, S.messages.map(messageEl));
  if (jump) requestAnimationFrame(() => { const s = $("#scroll"); if (!s) return; s.style.scrollBehavior = "auto"; s.scrollTop = s.scrollHeight; s.style.scrollBehavior = ""; });
}
// ── Home (18 October 2026, the owner: "fai tipo Higgsfield"): big video banners of what Kleo does best, the tools as
// tiles, a start-free card for visitors, ideas one tap away, and the team's films. The chat box stays docked below.
const MEDIA_APP = "https://media.kleooai.com/app";
const GALLERY = "https://media.kleooai.com/gallery";
const HOME_BANNERS = [
  { t: "Character Swap", s: "Put your character in any video", badge: "Pro", v: `${MEDIA_APP}/home-swap.mp4`, p: `${MEDIA_APP}/home-swap.jpg`, go: () => go("/apps/character-swap") },
  { t: "Kleo Film", s: "A whole narrated film from one message", badge: "New", v: `${GALLERY}/tether-film-p.mp4`, p: `${GALLERY}/tether-film.jpg`, go: () => startFilm() },
  { t: "Seedance 2.5", s: "Cinematic video from one sentence", badge: "Top", v: `${GALLERY}/koi-supra-night-p.mp4`, p: `${GALLERY}/koi-supra-night.jpg`, go: () => go("/video") },
];
// Each tile is just its picture in motion and two lines under it (the owner, 18 Oct: "come Higgsfield: video pulito,
// niente sopra, scrive solo sotto").
const HOME_TILES = [
  { t: "Video", s: "Seedance 2.5 and Veo 3.1", art: () => artVideo(loop("kitten-knight-black-dragon")), go: () => go("/video") },
  { t: "Image", s: "FLUX.2, Seedream and Nano Banana", art: () => artImg(still("venice-high-water-kleo"), "kb"), go: () => go("/image") },
  { t: "Photo Character Swap", s: "Your character in any photo", art: () => xfade(pic("photoswap3-a"), pic("photoswap3-b")), go: () => go("/apps/photo-character-swap") },
  { t: "Talking Photo", s: "Make any portrait speak", art: () => artImg(pic("speaker"), "kb"), go: () => go("/apps/talking-photo") },
  { t: "Motion Control", s: "Copy any dance or move", art: () => artVideo(loop("kitten-knight-jump")), go: () => go("/apps/motion-control") },
  { t: "Kleo in Claude & ChatGPT", s: "Make videos inside your AI chat", art: () => artVideo(loop("kleo-x-claude-ad")), href: "https://kleooai.com/mcp/" },
];
/** Two pictures that slowly dissolve into each other: the before and after of a swap, with nothing drawn on top. */
function xfade(a, b) { return h("div", { class: "art-xfade" }, artImg(a), artImg(b, "xf-b")); }
/** An idea as a picture card: what it makes, its name; a tap fills the box below. */
function ideaCard(i) {
  return h("button", { class: "idea-card", onclick: () => useIdea(i), "aria-label": i.t },
    h("img", { src: `${MEDIA_APP}/ideas2/${i.a}.jpg`, alt: "", loading: "lazy", decoding: "async" }),
    h("span", { class: "em", style: { background: i.c } }, icon(i.ic, 16, 2)),
    h("b", {}, i.t));
}
function homeView() {
  const banner = (b) => h("button", { class: "hb", onclick: b.go, "aria-label": `${b.t}: ${b.s}` },
    h("div", { class: "hb-media" }, loopVideo(b.v, b.p)),
    h("b", {}, b.t), h("span", {}, b.s));
  const tile = (x) => h(x.href ? "a" : "button", { class: "ht", ...(x.href ? { href: x.href, target: "_blank", rel: "noopener" } : { onclick: x.go }) },
    h("div", { class: "ht-media art-media" }, x.art()),
    h("div", { class: "ht-tx" }, h("b", {}, x.t), h("span", {}, x.s)));
  const promo = S.me ? null : h("div", { class: "home-promo" },
    loopVideo(`${GALLERY}/apex-film-p.mp4`, `${GALLERY}/apex-film.jpg`),
    h("div", { class: "home-promo-tx" },
      h("h2", {}, "Start free", h("br"), h("em", {}, "5 credits on us")),
      h("ul", {}, ["Videos with Seedance 2.5 and Veo 3.1", "Pictures, voices and music", "Whole films from one message"].map((x) => h("li", {}, icon("check", 16, 2.6), x))),
      h("button", { class: "btn btn-cta", onclick: () => requireAccount("signup") }, "Create my free account")));
  // A soft glow of the team's films behind the page (a blurred still: no video decoding for a background).
  return h("div", { class: "home" },
    h("div", { class: "home-glow", "aria-hidden": "true" }, h("i", { style: { backgroundImage: `url(${GALLERY}/koi-supra-night.jpg)` } }), h("i", { style: { backgroundImage: `url(${GALLERY}/tether-film.jpg)` } })),
    h("div", { class: "home-banners" }, HOME_BANNERS.map(banner)),
    h("div", { class: "home-row" + (promo ? "" : " solo") }, promo, h("div", { class: "home-tiles" }, HOME_TILES.map(tile))),
    h("div", { class: "home-ideas" }, h("h2", {}, "What do you want to create?"),
      h("div", { class: "idea-grid" }, IDEAS.video.map(ideaCard))),
    showcaseStrip("Made by the Kleo team"));
}
function useIdea(i) {
  if (i.photo) return pickFiles();
  const t = $("#prompt"); t.value = i.p; autosize(t); updateSend(); t.focus();
}
function scrollDown() { requestAnimationFrame(() => { const s = $("#scroll"); if (s) s.scrollTop = s.scrollHeight; }); }
// What the person attached, as small rounded tiles above their message: a clip is its first frame with a play mark,
// never the full-size video player it used to be (the owner, 19 Oct: "immagini messe lì a cazzo").
function attachThumb(a) {
  if (a.kind === "video") return h("div", { class: "att-tile", title: "Video" }, h("video", { src: a.url + "#t=0.1", muted: true, playsinline: true, preload: "metadata" }), h("span", { class: "att-kind" }, icon("play", 12, 2.4)));
  if (a.kind === "audio") return h("div", { class: "att-tile audio", title: "Sound" }, icon("music", 26));
  return h("div", { class: "att-tile", title: "Picture" }, h("img", { src: a.url, alt: "Attached picture", loading: "lazy" }));
}
/** A long prompt shows its first lines; one tap shows all of it. */
function promptBubble(text) {
  const b = h("div", { class: "bubble" + (text.length > 320 ? " long" : "") }, text);
  if (text.length > 320) {
    const more = h("button", { class: "bubble-more", onclick: () => { const open = b.classList.toggle("open"); more.textContent = open ? "Show less" : "Show more"; } }, "Show more");
    return h("div", { class: "bubble-wrap" }, b, more);
  }
  return b;
}
function messageEl(m) {
  if (m.role === "user") {
    return h("div", { class: "msg user", "data-msg": m.id },
      m.attachments?.length ? h("div", { class: "attach-row" }, m.attachments.map(attachThumb)) : null,
      m.text ? promptBubble(m.text) : null);
  }
  const body = h("div", { class: "body" });
  if (m.typing) body.append(h("div", { class: "typing" }, h("i"), h("i"), h("i")));
  else if (m.text) body.append(h("div", { class: "text" }, m.text));
  if (m.proposal) body.append(proposalEl(m));
  if (m.generation) body.append(genEl(m.generation.id));
  return h("div", { class: "msg bot", "data-msg": m.id }, h("img", { class: "mark", src: "/kleo-mark.svg", alt: "Kleo" }), body);
}

// The setting pills of a card (and the menus behind them), for a video or a picture.
const durOptions = (s) => model(s.model).durations.map((d) => ({ label: `${d} seconds`, value: d, on: d === s.duration, cost: price({ ...s, duration: d }) }));
const resOptions = (s) => { const m = model(s.model); return resList(m).map((r) => {
  const locked = resLocked(r) || !m.resolutions.includes(r);
  return { label: r === "1080p" ? "1080p · Full HD" : r === "720p" ? "720p · HD" : "480p · Draft", value: r, on: r === s.resolution, locked, note: resNote(), cost: locked ? undefined : price({ ...s, resolution: r }) };
}); };
const qualOptions = (s) => imodel(s.model).qualities.map((q) => ({ label: q === "4K" ? "4K · Ultra" : q === "2K" ? "2K · High" : "1K · Standard", value: q, on: q === s.quality, cost: iprice({ ...s, quality: q }) }));
const countOptions = (s) => imodel(s.model).counts.map((c) => ({ label: c === 1 ? "1 picture" : `${c} pictures`, value: c, on: c === s.count, cost: iprice({ ...s, count: c }) }));
function settingPills(s, onChange, kind = "video") {
  const pill = (ic, label, fn) => fn ? h("button", { class: "pill", onclick: fn }, icon(ic, 15), label) : h("span", { class: "pill" }, icon(ic, 15), label);
  if (kind === "image") {
    const m = imodel(s.model);
    return h("div", { class: "pills" },
      pill("photo", m.name, () => openImageModelPicker(s, onChange)),
      pill("frame", s.aspect, () => openAspect(m.aspects, s.aspect, (a) => onChange({ ...s, aspect: a }))),
      m.qualities.length > 1 ? pill("hd", s.quality, (e) => openMenu(e.currentTarget, qualOptions(s), (v) => onChange({ ...s, quality: v }))) : null,
      pill("layers", `×${s.count}`, (e) => openMenu(e.currentTarget, countOptions(s), (v) => onChange({ ...s, count: v }))));
  }
  const m = model(s.model);
  return h("div", { class: "pills" },
    pill("film", m.name, () => openModelPicker(s, onChange)),
    pill("clock", `${s.duration}s`, (e) => openMenu(e.currentTarget, durOptions(s), (v) => onChange({ ...s, duration: v }))),
    pill("hd", s.resolution, (e) => openMenu(e.currentTarget, resOptions(s), (v) => onChange({ ...s, resolution: v }))),
    s.imageRole === "first_frame" ? pill("photo", "From photo", null) : pill("frame", s.aspect, () => openAspect(m.aspects, s.aspect, (a) => onChange({ ...s, aspect: a }))),
    pill(s.audio ? "sound" : "mute", s.audio ? "Sound" : "Silent", () => onChange({ ...s, audio: !s.audio })));
}
const FILM_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 300];
const fmtLen = (d) => (d >= 60 ? `${d / 60} min` : `${d}s`);
function filmCardEl(m) {
  const p = m.proposal;
  let s = { ...p.settings };
  let quote = p.quote || null;
  let cost = p.credits || null;
  let editing = false;
  const wrap = h("div", { class: "card film-card", "data-proposal": m.id });
  const requote = async () => {
    if (DEMO) { cost = s.product === "animatic" ? (s.duration <= 20 ? 5 : 10) : Math.max(10, Math.ceil(s.duration / 1.5)); draw(); return; }
    try { quote = await api("/api/film/quote", { method: "POST", body: { settings: s } }); cost = quote.credits_for_choice; } catch { cost = null; }
    draw();
  };
  const set = (patch) => { s = { ...s, ...patch }; if (s.product === "animatic" && s.duration > 60) s.duration = 60; p.settings = s; cost = null; draw(); requote(); };
  const pill = (ic, label, fn) => h("button", { class: "pill", onclick: fn }, icon(ic, 15), label);
  const draw = () => {
    const gens = (m.generations || []).map((g) => S.gens.get(g.id) || g);
    const filmLocked = quote && s.product === "film" && !quote.film.allowed;
    fill(wrap,
      h("div", { class: "card-h" }, h("span", { class: "eyebrow" }, icon("film", 13, 2.2), s.product === "animatic" ? "Kleo animatic" : "Kleo film"),
        h("span", { class: "film-tag" }, "Script · voice · music · 4K")),
      h("div", { class: "card-title" }, p.title),
      editing ? h("textarea", { "aria-label": "Brief", oninput: (e) => { p.prompt = e.target.value; } }, p.prompt) : h("div", { class: "card-prompt clamp" }, p.prompt),
      h("div", { class: "pills" },
        pill(s.style === "animation" ? "sparkle" : "film", s.style === "animation" ? "Animation" : "Realistic", () => set({ style: s.style === "animation" ? "realistic" : "animation" })),
        pill("frame", s.format === "9:16" ? "9:16 Short" : "16:9 YouTube", () => set({ format: s.format === "9:16" ? "16:9" : "9:16" })),
        pill("clock", fmtLen(s.duration), (e) => openMenu(e.currentTarget, FILM_LENGTHS.filter((d) => s.product === "film" || d <= 60).map((d) => ({ label: fmtLen(d), value: d, on: d === s.duration })), (v) => set({ duration: v }))),
        pill("layers", s.product === "animatic" ? "Animatic" : "Full film", () => set({ product: s.product === "animatic" ? "film" : "animatic" })),
        pill(s.music ? "music" : "mute", s.music ? "Music" : "No music", () => set({ music: !s.music })),
        pill("text", s.subtitles ? "Subtitles" : "No subtitles", () => set({ subtitles: !s.subtitles })),
        pill("globe", s.language === "it" ? "Italiano" : "English", () => set({ language: s.language === "it" ? "en" : "it" }))),
      filmLocked ? h("p", { class: "film-note" }, icon("lock", 14), ` A full film unlocks with your first credit pack. The animatic (drawn frames with camera moves) works with any credits — ${quote.animatic.credits} credits.`) : null,
      h("div", { class: "card-f" },
        h("button", { class: "btn btn-cta btn-grow", disabled: cost === null, onclick: (e) => (filmLocked ? openBuy("A full Kleo film unlocks with your first credit pack.") : generateFromProposal(m, s, e.currentTarget)) },
          filmLocked ? icon("lock", 17) : null, gens.length ? "Make it again" : s.product === "animatic" ? "Make the animatic" : "Make the film", h("span", { class: "cost" }, bolt(14), cost ?? "…")),
        h("button", { class: "btn btn-quiet", onclick: () => { editing = !editing; draw(); } }, editing ? "Done" : "Edit")),
      h("div", { class: "cta-note", style: { textAlign: "left", padding: "0 16px 12px" } }, s.product === "animatic" ? "Ready in about 15–20 minutes." : "Ready in about 25–35 minutes. You can close the page — it keeps going."),
      gens.map((g) => genEl(g.id)));
  };
  draw();
  if (cost === null) requote();
  wrap.redraw = draw;
  return wrap;
}
function proposalEl(m) {
  if (m.proposal?.kind === "film") return filmCardEl(m);
  const p = m.proposal;
  const img = isImage(p);
  let s = img ? ifix(p.settings) : { ...fix(p.settings, p.imageIds?.length || 0), preset: p.settings?.preset };
  let editing = false, expanded = false;
  const wrap = h("div", { class: "card", "data-proposal": m.id });
  const draw = () => {
    const gens = (m.generations || []).map((g) => S.gens.get(g.id) || g);
    const long = p.prompt.length > 220;
    const cost = img ? iprice(s) : (p.credits && !gens.length && JSON.stringify(s) === JSON.stringify(p.settings) ? p.credits : price(s));
    const lockd = img ? !iallowed(s.model) : !allowed(s.model);
    fill(wrap,
      h("div", { class: "card-h" }, h("span", { class: "eyebrow" }, icon(img ? "photo" : "sparkle", 13, 2.2), gens.length ? (img ? "Your pictures" : "Your video") : "Ready to generate")),
      h("div", { class: "card-title" }, p.title),
      editing ? h("textarea", { "aria-label": "Prompt", oninput: (e) => { p.prompt = e.target.value; } }, p.prompt)
        : h("div", { class: "card-prompt" + (expanded ? "" : " clamp") }, p.prompt),
      !editing && long ? h("button", { class: "more", onclick: () => { expanded = !expanded; draw(); } }, expanded ? "Less" : "More") : null,
      p.imageIds?.length ? h("div", { class: "card-thumbs" }, p.imageIds.map((id) => h("img", { src: DEMO ? demoUploads.get(id)?.url : `/media/u/${id}`, alt: "" }))) : null,
      settingPills(s, (ns) => { s = img ? ifix(ns) : { ...fix(ns, p.imageIds?.length || 0), preset: s.preset }; p.settings = s; draw(); }, img ? "image" : "video"),
      h("div", { class: "card-f" },
        h("button", { class: "btn btn-cta btn-grow", onclick: (e) => generateFromProposal(m, s, e.currentTarget) },
          lockd ? icon("lock", 17) : null, gens.length ? "Generate again" : "Generate", h("span", { class: "cost" }, bolt(14), cost)),
        h("button", { class: "btn btn-quiet", onclick: () => { editing = !editing; draw(); if (editing) wrap.querySelector("textarea")?.focus(); } }, editing ? "Done" : "Edit")),
      gens.map((g) => genEl(g.id)));
  };
  draw();
  wrap.redraw = draw;
  return wrap;
}
async function generateFromProposal(m, s, btn) {
  const img = isImage(m.proposal);
  if (img ? !iallowed(s.model) : !allowed(s.model)) return openLocked(img ? imodel(s.model) : model(s.model), img);
  btn.disabled = true; fill(btn, spinner(18));
  try {
    const r = await api("/api/generate", { method: "POST", body: { proposalId: m.id, prompt: m.proposal.prompt, settings: s } });
    setCredits(r.credits);
    S.gens.set(r.generation.id, r.generation); watch(r.generation.id);
    const fresh = r.messages.find((x) => x.id === m.id);
    m.generations = fresh?.generations || [...(m.generations || []), r.generation];
    for (const g of m.generations) if (!S.gens.has(g.id)) S.gens.set(g.id, g);
    $(`[data-proposal="${m.id}"]`)?.redraw();
    $(`[data-gen="${r.generation.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) { handleError(e); $(`[data-proposal="${m.id}"]`)?.redraw(); }
}

// ── one generation inside a chat ─────────────────────────────────────────────────────────────────────────────────
const cssRatio = (a) => (a || "16:9").replace(":", " / ");
function elapsed(g, t) {
  const tick = () => { const sec = Math.max(0, Math.floor((Date.now() - Date.parse(g.createdAt)) / 1000)); t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };
  tick(); const id = setInterval(() => (t.isConnected ? tick() : clearInterval(id)), 1000);
}
function failedEl(g, el) {
  el.append(h("div", { class: "clip-fail" }, h("div", { class: "x" }, icon("x", 16, 2.4)),
    h("div", {}, h("p", {}, g.error || "This one couldn't be made."), g.refunded ? h("div", { class: "refund" }, icon("check", 14, 2.6), `${g.credits} credits refunded`) : null,
      h("div", { style: { marginTop: "10px" } }, h("button", { class: "btn btn-quiet btn-sm", onclick: () => remix(g) }, icon("redo", 16), "Try again")))));
  return el;
}
function genEl(id) {
  const g = S.gens.get(id);
  if (!g) return h("div");
  if (g.kind === "image") return picturesEl(g);
  if (g.kind === "tool") return h("div", { class: "pics n1", "data-gen": g.id, style: { maxWidth: "360px" } }, resultCard(g));
  if (g.kind === "film") return filmEl(g);
  return clipEl(g);
}
function clipEl(g) {
  const s = g.settings || {};
  const shape = s.aspect === "9:16" || s.aspect === "3:4" ? "portrait" : s.aspect === "1:1" ? "square" : "";
  const ratio = s.imageRole === "first_frame" || s.videoRole === "edit" || s.videoRole === "extend" ? "16 / 10" : cssRatio(s.aspect);
  const el = h("div", { class: `clip ${shape}`, "data-gen": g.id });
  if (g.status === "running") {
    const t = h("span", { class: "t" }); elapsed(g, t);
    el.append(h("div", { class: "clip-media", style: { aspectRatio: ratio } }, h("div", { class: "shimmer" }),
      h("div", { class: "clip-status" }, h("div", {}, h("b", {}, "Generating…"), h("span", {}, `${g.modelName} · usually 1–4 min`)), h("div", { class: "row-gap" }, t, h("span", { class: "spin" })))));
    return el;
  }
  if (g.status === "failed") return failedEl(g, el);
  el.append(h("div", { class: "clip-media", style: { aspectRatio: ratio } }, h("video", { src: g.video + "#t=0.05", controls: true, playsinline: true, loop: true, preload: "metadata" })),
    h("div", { class: "clip-bar" },
      h("span", { class: "meta" }, `${g.modelName} · ${s.duration}s · ${s.resolution}`),
      h("a", { class: "icon-btn", href: DEMO ? g.video : `${g.video}?dl=1`, download: `kleo-${g.id}.mp4`, title: "Download", "aria-label": "Download" }, icon("dl", 19)),
      h("button", { class: "icon-btn", title: "Share", "aria-label": "Share", onclick: () => share(g) }, icon("share", 19)),
      h("button", { class: "icon-btn", title: "Remix", "aria-label": "Remix", onclick: () => remix(g) }, icon("wand", 19))));
  return el;
}
function filmEl(g) {
  const s = g.settings || {};
  const el = h("div", { class: `clip ${s.format === "9:16" ? "portrait" : ""}`, "data-gen": g.id });
  const ratio = (s.format || "16:9").replace(":", " / ");
  if (g.status === "running") {
    const pr = g.progress || {};
    const pct = Math.max(2, Math.min(99, Number(pr.percent) || 0));
    el.append(h("div", { class: "clip-media", style: { aspectRatio: ratio } }, h("div", { class: "shimmer" }),
      h("div", { class: "clip-status", style: { flexDirection: "column", alignItems: "stretch", gap: "8px" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px" } }, h("b", {}, pr.label || "Starting your film"), h("span", {}, `${Math.round(pct)}%`)),
        h("div", { class: "progress" }, h("i", { style: { width: `${pct}%` } })),
        h("span", {}, `${g.modelName} · ${fmtLen(s.duration || 30)}${pr.eta_min ? ` · about ${pr.eta_min} min left` : ""}`))));
    return el;
  }
  if (g.status === "failed") return failedEl(g, el);
  el.append(h("div", { class: "clip-media", style: { aspectRatio: ratio } }, h("video", { src: g.video + "#t=0.05", controls: true, playsinline: true, preload: "metadata" })),
    h("div", { class: "clip-bar" },
      h("span", { class: "meta" }, `${g.modelName} · ${fmtLen(s.duration || 30)} · 4K`),
      h("a", { class: "icon-btn", href: DEMO ? g.video : `${g.video}?dl=1`, download: `kleo-film-${g.id}.mp4`, title: "Download", "aria-label": "Download" }, icon("dl", 19)),
      h("button", { class: "icon-btn", title: "Share", "aria-label": "Share", onclick: () => share(g) }, icon("share", 19))));
  return el;
}
function picturesEl(g) {
  const s = g.settings || {};
  const n = g.status === "done" ? g.outputs.length : g.count || s.count || 1;
  const el = h("div", { class: `pics n${Math.min(n, 4)}`, "data-gen": g.id });
  if (g.status === "running") {
    const t = h("span", { class: "t" }); elapsed(g, t);
    el.append(h("div", { class: "pics-grid" }, Array.from({ length: n }, () => h("div", { class: "pic", style: { aspectRatio: cssRatio(s.aspect) } }, h("div", { class: "shimmer" })))),
      h("div", { class: "pics-bar" }, h("span", { class: "spin dark" }), h("span", { class: "meta" }, `${g.modelName} · painting ${n > 1 ? `${n} pictures` : "your picture"}…`), t));
    return el;
  }
  if (g.status === "failed") return failedEl(g, el);
  el.append(h("div", { class: "pics-grid" }, g.outputs.map((o) => h("button", { class: "pic", style: { aspectRatio: cssRatio(s.aspect) }, onclick: () => viewOutput(g, o) },
      h("img", { src: o.url, alt: g.prompt.slice(0, 80), loading: "lazy" })))),
    h("div", { class: "pics-bar" },
      h("span", { class: "meta" }, `${g.modelName} · ${s.aspect} · ${s.quality}`, g.refunded ? " · some failed, refunded" : ""),
      g.outputs.length === 1 ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => animate(g.outputs[0]) }, icon("play", 15), "Animate") : null,
      h("button", { class: "icon-btn", title: "Remix", "aria-label": "Remix", onclick: () => remix(g) }, icon("wand", 19))));
  return el;
}
function refreshGen(id) {
  for (const old of document.querySelectorAll(`[data-gen="${id}"]`)) old.replaceWith(genEl(id));
  for (const old of document.querySelectorAll(`[data-result="${id}"]`)) old.replaceWith(resultCard(S.gens.get(id)));
}
async function share(g, out) {
  try {
    const { url } = DEMO ? { url: out ? out.url : g.video } : await api(`/api/generations/${g.id}/share`, { method: "POST", body: out ? { upload: out.upload } : {} });
    if (navigator.share && IS_TOUCH) { await navigator.share({ title: "Made with Kleo", url }).catch(() => {}); return; }
    await navigator.clipboard.writeText(url); toast("Link copied — valid for 30 days");
  } catch (e) { handleError(e); }
}
function setMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode; store.set("mode", mode);
  for (const b of document.querySelectorAll(".modes button")) b.classList.toggle("on", b.dataset.mode === mode);
  const t = $("#prompt"); if (t) t.placeholder = mode === "image" ? "Describe your picture…" : "Describe your video…";
  drawAttachments(); drawChips(); updateSend();
  if (S.view === "chat" && !S.messages.length) renderMessages();
}
function remix(g) {
  closeLayer();
  if (g.kind === "tool") return go(`/apps/${g.model}`);
  if (g.kind === "film") return go(g.chatId ? `/c/${g.chatId}` : "/");
  const kind = g.kind === "image" ? "image" : "video";
  const page = S.page[kind];
  page.prompt = g.prompt.replace(/\nCamera: .*$|\nEffect: .*$|\nStyle: .*$/s, "");
  page.refs = [];
  if (kind === "image") { S.imageSettings = ifix({ ...S.imageSettings, ...g.settings }); store.set("imageSettings", S.imageSettings); }
  else { S.settings = fix({ ...S.settings, ...g.settings }); store.set("settings", S.settings); page.preset = g.settings?.preset || null; }
  go(`/${kind}`);
  toast("Prompt is back in the box — change anything");
}
/** A finished picture becomes the start frame of a new video. */
function animate(o) {
  closeLayer();
  const page = S.page.video;
  page.refs = [{ id: o.upload, local: o.url, kind: "image" }];
  page.prompt = "";
  S.settings = fix({ ...S.settings, imageRole: "first_frame" }, 1); store.set("settings", S.settings);
  go("/video");
  toast("Picture added as the first frame — describe the motion");
}
function useAsReference(o, kind = "image") {
  closeLayer();
  const page = S.page[kind];
  if (page.refs.length >= 6) return toast("Up to 6 references.", true);
  page.refs.push({ id: o.upload, local: o.url, kind: o.type || "image" });
  go(`/${kind}`);
  toast("Added as a reference");
}

// polling of running generations
const watching = new Set();
let pollTimer = null;
function watch(id) {
  watching.add(id);
  if (!pollTimer) pollTimer = setInterval(poll, 4000);
}
async function poll() {
  if (!watching.size) { clearInterval(pollTimer); pollTimer = null; return; }
  for (const id of [...watching]) {
    try {
      const r = await api(`/api/generations/${id}`);
      const before = S.gens.get(id);
      S.gens.set(id, r.generation);
      // The page lists (Video, Image, an app, Library) hold the generation as it was when sent: swap in the fresh one,
      // or the next redraw (after another Generate) shows a finished picture as still in progress.
      for (const list of Object.values(S.feeds)) if (Array.isArray(list)) { const i = list.findIndex((x) => x.id === id); if (i >= 0) list[i] = r.generation; }
      if (r.generation.status !== "running") {
        watching.delete(id);
        setCredits(r.credits);
        refreshGen(id);
        if (r.generation.status === "done") toast(`${r.generation.modelName || "Your creation"} is ready ✨`);
      } else if (!before) refreshGen(id);
    } catch (e) { if (e.code === "signin") { watching.clear(); return handleError(e); } }
  }
}

// ── the chat composer ────────────────────────────────────────────────────────────────────────────────────────────
const ACCEPT_ALL = "image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav";
function composer() {
  const ta = h("textarea", { id: "prompt", rows: "1", placeholder: S.mode === "image" ? "Describe your picture…" : "Describe your video…", "aria-label": "Describe what to create",
    oninput: (e) => { autosize(e.target); updateSend(); },
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !IS_TOUCH && !e.isComposing) { e.preventDefault(); submit(); } },
    onpaste: (e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (files.length) { e.preventDefault(); addFiles(files); } } });
  const modes = h("div", { class: "modes", role: "tablist" },
    [["video", "film", "Video"], ["image", "photo", "Image"]].map(([k, ic, label]) => h("button", { role: "tab", "data-mode": k, class: S.mode === k ? "on" : "", onclick: () => setMode(k) }, icon(ic, 16), label)));
  const box = h("div", { class: "composer", id: "composer",
    ondragover: (e) => { e.preventDefault(); box.classList.add("drag"); }, ondragleave: () => box.classList.remove("drag"),
    ondrop: (e) => { e.preventDefault(); box.classList.remove("drag"); addFiles([...(e.dataTransfer?.files || [])]); } },
    h("div", { class: "att", id: "att" }), ta,
    h("div", { class: "tools" },
      h("button", { class: "plus", title: "Add pictures or clips", "aria-label": "Add pictures or clips", onclick: pickFiles }, icon("plus", 20, 2.1)),
      h("div", { class: "chips", id: "chips" }),
      h("button", { class: "agent-toggle", id: "agent", title: "Kleo agent: chat first, then generate", onclick: toggleAgent }, h("span", { class: "lbl-text" }, "Agent"), h("span", { class: "switch" + (S.agent ? " on" : "") })),
      h("div", { id: "send-slot" })));
  setTimeout(() => { drawChips(); updateSend(); drawAttachments(); }, 0);
  return [h("div", { class: "modes-row" }, modes), box, h("div", { class: "hint" }, "Kleo can make mistakes. Everything is generated by AI models.")];
}
function autosize(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + "px"; }
function pickFiles() { pickFile(S.mode === "image" ? "image/*" : ACCEPT_ALL, true, addFiles); }
function toggleAgent() {
  S.agent = !S.agent; store.set("agent", S.agent);
  $("#agent .switch")?.classList.toggle("on", S.agent);
  updateSend(); if (!S.messages.length) renderMessages();
  toast(S.agent ? "Agent on — chat first, then generate" : "Agent off — your prompt goes straight to the model");
}
function drawChips() {
  const box = $("#chips"); if (!box) return;
  if (S.mode === "image") {
    const s = S.imageSettings = ifix(S.imageSettings);
    const m = imodel(s.model);
    const set = (ns) => { S.imageSettings = ifix(ns); store.set("imageSettings", S.imageSettings); drawChips(); updateSend(); };
    fill(box,
      h("button", { class: "chip model", onclick: () => openImageModelPicker(s, set) }, h("span", { class: "dot" }), m.name, icon("down", 14, 2.2)),
      h("button", { class: "chip", onclick: () => openAspect(m.aspects, s.aspect, (a) => set({ ...s, aspect: a })) }, icon("frame", 16), s.aspect),
      m.qualities.length > 1 ? h("button", { class: "chip", onclick: (e) => openMenu(e.currentTarget, qualOptions(s), (v) => set({ ...s, quality: v })) }, icon("hd", 16), s.quality) : null,
      h("button", { class: "chip", onclick: (e) => openMenu(e.currentTarget, countOptions(s), (v) => set({ ...s, count: v })) }, icon("layers", 16), `×${s.count}`));
    return;
  }
  const s = S.settings = fix(S.settings, picCount(S.attachments), clipCount(S.attachments));
  const m = model(s.model);
  const set = (ns) => { S.settings = fix(ns, picCount(S.attachments), clipCount(S.attachments)); store.set("settings", S.settings); drawChips(); updateSend(); };
  fill(box,
    h("button", { class: "chip model", onclick: () => openModelPicker(s, set) }, h("span", { class: "dot" }), m.name, icon("down", 14, 2.2)),
    s.imageRole === "first_frame" ? null : h("button", { class: "chip", onclick: () => openAspect(m.aspects, s.aspect, (a) => set({ ...s, aspect: a })) }, icon("frame", 16), s.aspect),
    h("button", { class: "chip", onclick: (e) => openMenu(e.currentTarget, durOptions(s), (v) => set({ ...s, duration: v })) }, icon("clock", 16), `${s.duration}s`),
    h("button", { class: "chip", onclick: (e) => openMenu(e.currentTarget, resOptions(s), (v) => set({ ...s, resolution: v })) }, icon("hd", 16), s.resolution),
    h("button", { class: "chip", title: s.audio ? "Sound on" : "Sound off", "aria-label": s.audio ? "Sound on" : "Sound off", onclick: () => set({ ...s, audio: !s.audio }) }, icon(s.audio ? "sound" : "mute", 16)));
}
function currentCost() { return S.mode === "image" ? iprice(ifix(S.imageSettings)) : price(fix(S.settings, picCount(S.attachments), clipCount(S.attachments))); }
function currentLocked() { return S.mode === "image" ? !iallowed(ifix(S.imageSettings).model) : !allowed(fix(S.settings, picCount(S.attachments), clipCount(S.attachments)).model); }
function updateSend() {
  const slot = $("#send-slot"); if (!slot) return;
  const text = $("#prompt")?.value.trim() || "";
  const ready = (text || (S.attachments.length && S.mode === "video")) && !S.busy && !S.attachments.some((a) => !a.id);
  if (S.agent) fill(slot, h("button", { class: "send", disabled: !ready, "aria-label": "Send", onclick: submit }, S.busy ? spinner(16) : icon("up", 20, 2.4)));
  else {
    const hasVid = S.attachments.some((a) => a.kind === "video");
    fill(slot, h("button", { class: "gen-btn", disabled: !ready, onclick: submit }, currentLocked() ? icon("lock", 15) : null, h("span", { class: "lbl-text" }, "Generate"), h("span", { class: "cost" }, bolt(14), hasVid ? "…" : currentCost())));
  }
}
async function addFiles(files) {
  const room = 6 - S.attachments.length;
  if (room <= 0) return toast("Up to 6 files.", true);
  for (const f of files.slice(0, room)) {
    if (S.mode === "image" && !f.type.startsWith("image/")) { toast("Pictures only in Image mode.", true); continue; }
    const a = { local: URL.createObjectURL(f), id: null, kind: f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "image" };
    S.attachments.push(a); drawAttachments(); drawChips(); updateSend();
    try { const r = await uploadFile(f); Object.assign(a, { id: r.id, kind: r.kind, duration: r.duration }); }
    catch (e) { S.attachments = S.attachments.filter((x) => x !== a); handleError(e.message ? e : new Error("That file couldn't be added.")); }
    drawAttachments(); drawChips(); updateSend();
  }
  if (!IS_TOUCH) $("#prompt")?.focus();
}
function drawAttachments() {
  const box = $("#att"); if (!box) return;
  const s = fix(S.settings, picCount(S.attachments), clipCount(S.attachments));
  const onePic = picCount(S.attachments) === 1 && !clipCount(S.attachments).videos && !clipCount(S.attachments).audios;
  fill(box, S.attachments.map((a) => h("div", { class: "thumb" },
    a.kind === "audio" ? h("div", { class: "ref audio", style: { width: "64px", height: "64px", borderRadius: "14px" } }, icon("music", 22))
      : a.kind === "video" ? h("video", { src: a.local, muted: true, playsinline: true, style: { width: "64px", height: "64px", borderRadius: "14px", objectFit: "cover" } })
      : h("img", { src: a.local, alt: "" }),
    !a.id ? h("div", { class: "busy" }, h("span", { class: "spin" })) : null,
    a.id ? h("button", { class: "role", onclick: () => {
      if (S.mode === "image" || a.kind === "audio") return toast(a.kind === "audio" ? "Kleo uses this sound as a voice or music reference." : "The picture model edits or follows your pictures.");
      if (a.kind === "video") {
        const order = ["reference", "edit", "extend"];
        S.settings = fix({ ...S.settings, videoRole: order[(order.indexOf(s.videoRole) + 1) % 3] }, picCount(S.attachments), clipCount(S.attachments)); store.set("settings", S.settings);
        drawAttachments(); drawChips(); updateSend();
        return toast({ reference: "The clip guides motion and style", edit: "Kleo edits this clip (say what to change)", extend: "Kleo continues this clip" }[S.settings.videoRole]);
      }
      if (!onePic) return toast("With several files, pictures are references.");
      S.settings = fix({ ...S.settings, imageRole: s.imageRole === "first_frame" ? "reference" : "first_frame" }, 1); store.set("settings", S.settings);
      drawAttachments(); drawChips(); toast(S.settings.imageRole === "first_frame" ? "The video will start from this picture" : "The picture guides the look (character, product, style)");
    } }, a.kind === "video" ? ({ reference: "Reference", edit: "Edit", extend: "Extend" }[s.videoRole] || "Reference") : a.kind === "audio" ? "Sound" : S.mode === "image" ? "Reference" : s.imageRole === "first_frame" ? "Start frame" : "Reference") : null,
    h("button", { class: "x", "aria-label": "Remove", onclick: () => { S.attachments = S.attachments.filter((x) => x !== a); drawAttachments(); drawChips(); updateSend(); } }, icon("x", 12, 3)))));
}
async function submit() {
  if (!signedIn()) return requireAccount();
  const t = $("#prompt");
  const text = t.value.trim();
  const img = S.mode === "image";
  if ((!text && (img || !S.attachments.length)) || S.busy || S.attachments.some((a) => !a.id)) return;
  const imageIds = S.attachments.map((a) => a.id);
  const settings = img ? ifix(S.imageSettings) : fix(S.settings, picCount(S.attachments), clipCount(S.attachments));
  if (!S.agent && currentLocked()) return openLocked(img ? imodel(settings.model) : model(settings.model), img);
  const atts = S.attachments.map((a) => ({ id: a.id, url: a.local, kind: a.kind }));
  S.busy = true; updateSend();
  const tempUser = { id: "tmp-u", role: "user", text, attachments: atts };
  const tempBot = { id: "tmp-b", role: "assistant", typing: true };
  S.messages.push(tempUser); if (S.agent) S.messages.push(tempBot);
  t.value = ""; autosize(t);
  S.attachments = []; drawAttachments(); drawChips();
  renderMessages(); scrollDown();
  try {
    const r = S.agent
      ? await api("/api/chat", { method: "POST", body: { chatId: S.chat?.id, text, imageIds, mode: S.mode, settings: fix(S.settings, picCount(atts), clipCount(atts)), imageSettings: ifix(S.imageSettings) } })
      : await api("/api/generate", { method: "POST", body: { chatId: S.chat?.id, kind: S.mode, prompt: text, settings, imageIds } });
    S.messages = S.messages.filter((m) => m !== tempUser && m !== tempBot);
    for (const m of r.messages) { collectGens(m); if (m.role === "user" && atts.length) m.attachments = atts; }
    S.messages.push(...r.messages);
    if (r.generation) { S.gens.set(r.generation.id, r.generation); watch(r.generation.id); setCredits(r.credits); }
    const isNew = !S.chat || S.chat.id !== r.chat.id;
    S.chat = r.chat;
    if (isNew) history.replaceState(null, "", `/c/${r.chat.id}${DEMO ? "?demo=1" : ""}`);
    S.chats = [r.chat, ...S.chats.filter((c) => c.id !== r.chat.id)];
    renderChats(); renderMessages(); scrollDown();
  } catch (e) {
    S.messages = S.messages.filter((m) => m !== tempUser && m !== tempBot);
    t.value = text; autosize(t);
    renderMessages(); handleError(e);
  } finally { S.busy = false; updateSend(); }
}

// ── Video and Image pages: a settings panel and your results ─────────────────────────────────────────────────────
const INSPO = [
  { url: "https://kleooai.com/samples/shot-dunes.mp4", t: "Desert rider at golden hour", p: "A lone rider crosses golden dunes at sunset, wind lifting sand into the light, wide drone shot slowly pushing in, warm cinematic grade, soft desert wind sound." },
  { url: "https://kleooai.com/samples/realistic-tether.mp4", t: "Astronaut on a tether", p: "An astronaut floats outside a space station on a thin tether, Earth glowing below, slow rotation, helmet reflections, quiet breathing in the suit." },
  { url: "https://kleooai.com/samples/animation-octopus.mp4", t: "Curious octopus", p: "A playful cartoon octopus explores a colorful coral reef, big expressive eyes, bubbles rising, bright animated film style, cheerful underwater sounds." },
  { url: "https://kleooai.com/samples/shot-moon.mp4", t: "Moonrise over the sea", p: "A giant full moon rises over a calm sea at night, silver light on the water, slow push-in, peaceful ambient waves." },
];
function generatorView(kind) {
  const isVid = kind === "video";
  const page = S.page[kind];
  const ta = h("textarea", { placeholder: isVid ? "Describe the scene: who, what happens, where, camera…" : "Describe the picture: subject, setting, light, style…", "aria-label": "Prompt",
    oninput: (e) => { page.prompt = e.target.value; refreshCta(); } }, page.prompt);
  const refsBox = h("div", { class: "refs" });
  const settingsBox = h("div", { class: "field" });
  const presetBox = h("div", { class: "field" });
  const ctaBox = h("div", { class: "cta-wrap" });
  const modelBox = h("div");
  const feed = h("div");
  const pics = () => picCount(page.refs), clips = () => clipCount(page.refs);
  const vs = () => (S.settings = fix(S.settings, pics(), clips()));
  const is = () => (S.imageSettings = ifix(S.imageSettings));
  const setV = (ns) => { S.settings = fix(ns, pics(), clips()); store.set("settings", S.settings); draw(); };
  const setI = (ns) => { S.imageSettings = ifix(ns); store.set("imageSettings", S.imageSettings); draw(); };
  let exact = null;
  const askPrice = debounce(async () => {
    if (!S.me || !isVid || !page.refs.some((r) => r.kind === "video") || page.refs.some((r) => !r.id)) { exact = null; return; }
    try { exact = (await api("/api/price", { method: "POST", body: { imageIds: page.refs.map((r) => r.id), settings: vs() } })).credits; } catch { exact = null; }
    refreshCta();
  }, 300);
  function drawModel() {
    const m = isVid ? model(vs().model) : imodel(is().model);
    fill(modelBox, h("div", { class: "field" }, h("div", { class: "field-h" }, "Model"),
      h("button", { class: "model-card", onclick: () => (isVid ? openModelPicker(vs(), setV) : openImageModelPicker(is(), setI)) },
        h("span", { class: "mi", style: { background: isVid ? "linear-gradient(135deg,#ffb23e,#ff6a3d)" : "linear-gradient(135deg,#64d2ff,#5e5ce6)" } }, icon(isVid ? "film" : "photo", 20)),
        h("span", { class: "mt" }, h("b", {}, m.name, m.badge ? h("span", { class: "badge" }, m.badge) : null), h("span", {}, m.blurb)), icon("down", 18))));
  }
  function drawRefs() {
    const s = isVid ? vs() : null;
    fill(refsBox, page.refs.map((r) => h("div", { class: "ref" + (r.kind === "audio" ? " audio" : "") },
      r.kind === "video" ? h("video", { src: r.local, muted: true, playsinline: true }) : r.kind === "audio" ? icon("music", 26) : h("img", { src: r.local, alt: "" }),
      r.kind !== "image" ? h("span", { class: "kind" }, icon(r.kind === "video" ? "film" : "sound", 12, 2.2)) : null,
      !r.id ? h("div", { class: "busy" }, h("span", { class: "spin" })) : null,
      isVid && r.id ? h("button", { class: "role", onclick: () => {
        if (r.kind === "video") { const o = ["reference", "edit", "extend"]; setV({ ...s, videoRole: o[(o.indexOf(s.videoRole) + 1) % 3] }); return; }
        if (r.kind === "image" && pics() === 1 && !clips().videos && !clips().audios) setV({ ...s, imageRole: s.imageRole === "first_frame" ? "reference" : "first_frame" });
      } }, r.kind === "video" ? { reference: "Reference", edit: "Edit it", extend: "Extend it" }[s.videoRole] : r.kind === "audio" ? "Sound" : s.imageRole === "first_frame" ? "Start frame" : "Reference") : null,
      h("button", { class: "x", "aria-label": "Remove", onclick: () => { page.refs = page.refs.filter((x) => x !== r); draw(); } }, icon("x", 11, 3)))),
      page.refs.length < 6 ? h("button", { class: "ref-add", onclick: () => pickFile(isVid ? ACCEPT_ALL : "image/*", true, addRefs) },
        h("span", {}, icon("plus", 22), isVid ? "Add" : "Add photo")) : null);
  }
  async function addRefs(files) {
    for (const f of files.slice(0, 6 - page.refs.length)) {
      const r = { local: URL.createObjectURL(f), id: null, kind: f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "image" };
      if (!isVid && r.kind !== "image") { toast("Pictures only here.", true); continue; }
      page.refs.push(r); draw();
      try { const u = await uploadFile(f); Object.assign(r, { id: u.id, kind: u.kind, duration: u.duration }); }
      catch (e) { page.refs = page.refs.filter((x) => x !== r); handleError(e); }
      draw();
    }
  }
  const seg = (options, current, pick) => h("div", { class: "seg2" }, options.map((o) => h("button", { class: (o.value === current ? "on" : "") + (o.locked ? " locked" : ""), onclick: () => (o.locked ? openBuy(o.note) : pick(o.value)) },
    o.label, o.locked ? h("span", { class: "c" }, icon("lock", 12)) : o.cost !== undefined ? h("span", { class: "c" }, bolt(9), o.cost) : null)));
  function drawSettings() {
    if (isVid) {
      const s = vs(), m = model(s.model);
      const fromPhoto = s.imageRole === "first_frame" || s.videoRole === "edit" || s.videoRole === "extend";
      fill(settingsBox,
        fromPhoto ? null : [h("div", { class: "field-h" }, "Format"), seg(m.aspects.slice(0, 4).map((a) => ({ value: a, label: a })), s.aspect, (a) => setV({ ...s, aspect: a })),
          m.aspects.length > 4 ? h("button", { class: "mini", style: { alignSelf: "flex-start" }, onclick: () => openAspect(m.aspects, s.aspect, (a) => setV({ ...s, aspect: a })) }, icon("frame", 14), "More formats") : null],
        s.videoRole === "edit" ? null : [h("div", { class: "field-h" }, "Length"), seg(m.durations.map((d) => ({ value: d, label: `${d}s`, cost: price({ ...s, duration: d }) })), s.duration, (d) => setV({ ...s, duration: d }))],
        h("div", { class: "field-h" }, "Quality"), seg(resList(m).map((r) => { const locked = resLocked(r) || !m.resolutions.includes(r); return { value: r, label: r, locked, note: resNote(), cost: locked ? undefined : price({ ...s, resolution: r }) }; }), s.resolution, (r) => setV({ ...s, resolution: r })),
        h("label", { class: "toggle-row", onclick: () => setV({ ...s, audio: !s.audio }) }, h("span", {}, icon(s.audio ? "sound" : "mute", 17), " Sound"), h("span", { class: "switch" + (s.audio ? " on" : "") })));
    } else {
      const s = is(), m = imodel(s.model);
      fill(settingsBox,
        h("div", { class: "field-h" }, "Format"), seg(["1:1", "4:5", "9:16", "16:9"].filter((a) => m.aspects.includes(a)).map((a) => ({ value: a, label: a })), s.aspect, (a) => setI({ ...s, aspect: a })),
        h("button", { class: "mini", style: { alignSelf: "flex-start" }, onclick: () => openAspect(m.aspects, s.aspect, (a) => setI({ ...s, aspect: a })) }, icon("frame", 14), "More formats"),
        m.qualities.length > 1 ? [h("div", { class: "field-h" }, "Quality"), seg(m.qualities.map((q) => ({ value: q, label: q, cost: iprice({ ...s, quality: q }) })), s.quality, (q) => setI({ ...s, quality: q }))] : null,
        h("div", { class: "field-h" }, "How many"), seg(m.counts.map((c) => ({ value: c, label: `×${c}`, cost: iprice({ ...s, count: c }) })), s.count, (c) => setI({ ...s, count: c })));
    }
  }
  function drawPresets() {
    if (!isVid) { fill(presetBox); return; }
    const list = S.config.presets || [];
    fill(presetBox, h("div", { class: "field-h" }, "Camera & effects", h("button", { class: "act", onclick: () => openPresets(page.preset, (k) => { page.preset = k; draw(); }) }, "See all")),
      h("div", { class: "presets" }, [{ key: null, name: "None", hint: "Just your prompt", tint: "#8e8e93" }, ...list.slice(0, 12)].map((p) => presetTile(p, page.preset === p.key, () => { page.preset = page.preset === p.key ? null : p.key; draw(); }))));
  }
  function cost() {
    if (isVid) return page.refs.some((r) => r.kind === "video") ? exact : price(vs());
    return iprice(is());
  }
  function refreshCta() {
    const s = isVid ? vs() : is();
    const lockd = isVid ? !allowed(s.model) : !iallowed(s.model);
    const busy = page.refs.some((r) => !r.id);
    const ok = (page.prompt.trim() || (isVid && page.refs.length)) && !busy;
    const c = cost();
    fill(ctaBox, h("button", { class: "btn btn-cta btn-xl", disabled: !ok || page.sending, onclick: generate },
      page.sending ? spinner(18) : [lockd ? icon("lock", 17) : icon("sparkle", 18, 2.2), "Generate", h("span", { class: "cost" }, bolt(15), c ?? "…")]),
      h("div", { class: "cta-note" }, !S.me ? "Free account · 5 credits to start" : lockd ? "Unlocks with any credit pack" : `You have ${S.me.credits} credits`));
  }
  async function generate() {
    if (!signedIn()) return requireAccount();
    const s = isVid ? vs() : is();
    if (isVid ? !allowed(s.model) : !iallowed(s.model)) return openLocked(isVid ? model(s.model) : imodel(s.model), !isVid);
    page.sending = true; refreshCta();
    try {
      const r = await api("/api/generate", { method: "POST", body: { noChat: true, kind, prompt: page.prompt, settings: s, imageIds: page.refs.map((x) => x.id), preset: isVid ? page.preset : null } });
      setCredits(r.credits);
      S.gens.set(r.generation.id, r.generation); watch(r.generation.id);
      (S.feeds[kind] ||= []).unshift(r.generation);
      drawFeed();
      if (innerWidth <= 980) feed.scrollIntoView({ behavior: "smooth" });
    } catch (e) { handleError(e); }
    finally { page.sending = false; refreshCta(); }
  }
  function drawFeed() {
    const list = S.feeds[kind];
    if (!list) { fill(feed, h("div", { class: "hero" }, h("span", { class: "spin dark", style: { margin: "0 auto" } }))); return; }
    fill(feed, h("div", { class: "feed-h" }, h("h2", {}, isVid ? "Your videos" : "Your pictures"), list.length ? h("span", {}, `${list.length}`) : null),
      list.length ? h("div", { class: "feed" }, list.map((g) => resultCard(g)))
        : h("div", { class: "empty-feed" }, h("b", {}, isVid ? "Your first video starts here" : "Your first picture starts here"),
          isVid ? "Write a prompt on the left, or try one of these:" : "Write a prompt and hit Generate.",
          isVid ? showcaseGrid((x) => { page.prompt = x.prompt; ta.value = x.prompt; refreshCta(); ta.focus(); }, 8, null, "film") : null));
  }
  function draw() { drawModel(); drawRefs(); drawSettings(); drawPresets(); refreshCta(); askPrice(); }
  const enhance = h("button", { class: "mini wand", onclick: async (e) => {
    if (!page.prompt.trim()) return toast("Write an idea first — Kleo will make it a great prompt.");
    if (!signedIn()) return requireAccount();
    const b = e.currentTarget; b.disabled = true; fill(b, spinner(13), "Improving…");
    const cur = isVid ? fix(S.settings) : ifix(S.imageSettings);
    try { const r = await api("/api/enhance", { method: "POST", body: { kind, prompt: page.prompt, seconds: isVid ? cur.duration : undefined, aspect: cur.aspect, model: (isVid ? model(cur.model) : null)?.name } }); page.prompt = r.prompt; ta.value = r.prompt; refreshCta(); }
    catch (er) { handleError(er); } finally { b.disabled = false; fill(b, icon("wand", 14), "Enhance"); }
  } }, icon("wand", 14), "Enhance");
  const panel = h("div", { class: "panel" },
    modelBox,
    h("div", { class: "field" }, h("div", { class: "field-h" }, isVid ? "References" : "Reference photos", h("span", { style: { textTransform: "none", letterSpacing: 0, fontWeight: 500 } }, isVid ? "photos, clips, sounds · optional" : "optional")), refsBox),
    h("div", { class: "field" }, h("div", { class: "field-h" }, "Prompt"),
      h("div", { class: "prompt-box" }, ta, h("div", { class: "pb-tools" }, enhance, h("button", { class: "mini", onclick: () => { page.prompt = ""; ta.value = ""; refreshCta(); ta.focus(); } }, icon("x", 13), "Clear")))),
    presetBox, settingsBox, ctaBox);
  setView("", h("div", { class: "page wide" },
    h("div", { class: "page-h" }, h("div", {}, h("h1", {}, isVid ? "Create video" : "Create image"), h("p", {}, isVid ? "Seedance 2.5, Seedance 2.0 and Google Veo 3.1, with references and camera presets." : "Nano Banana Pro, Nano Banana 2.1, Nano Banana 2, Seedream 5.0 and FLUX.2 Pro."))),
    h("div", { class: "gen-layout" }, panel, feed)));
  draw(); drawFeed();
  loadFeed(kind).then(drawFeed);
}
async function loadFeed(kind, filter) {
  if (!S.me) { S.feeds[filter ? `tool:${filter}` : kind] = []; return; }
  try {
    const q = kind === "audio" ? "kind=tool" : kind === "library" ? "" : `kind=${kind}`;
    const { generations } = await api(`/api/generations?limit=60${q ? "&" + q : ""}${filter ? "&model=" + filter : ""}`);
    for (const g of generations) { S.gens.set(g.id, g); if (g.status === "running") watch(g.id); }
    S.feeds[filter ? `tool:${filter}` : kind] = generations;
  } catch (e) { handleError(e); S.feeds[filter ? `tool:${filter}` : kind] = []; }
}
// A preset tile shows its example picture with the preset's own camera move playing over it (app.css .pm-*).
function presetTile(p, on, pick) {
  const art = p.art
    ? h("div", { class: "art has-pic", style: { background: p.tint } }, h("img", { src: p.art, alt: "", loading: "lazy", decoding: "async", class: `pm pm-${p.group === "camera" ? p.key : "drift"}` }))
    : h("div", { class: "art", style: { background: `linear-gradient(135deg, ${p.tint}, ${p.tint}99)` } }, p.key ? icon(p.group === "effect" ? "flame" : p.group === "style" ? "sparkle" : "film", 20, 2) : icon("x", 18, 2));
  return h("button", { class: "preset" + (on ? " on" : ""), onclick: pick }, art, h("b", {}, p.name), h("span", {}, p.hint));
}
function openPresets(current, pick) {
  const list = S.config.presets || [];
  let group = "camera";
  const grid = h("div", { class: "preset-grid" });
  const tabs = h("div", { class: "seg", style: { margin: "0 16px 12px" } });
  const draw = () => {
    fill(tabs, [["camera", "Camera"], ["effect", "Effects"], ["style", "Styles"]].map(([k, l]) => h("button", { class: group === k ? "on" : "", onclick: () => { group = k; draw(); } }, l)));
    fill(grid, list.filter((p) => p.group === group).map((p) => presetTile(p, current === p.key, () => { closeLayer(); pick(current === p.key ? null : p.key); })));
  };
  draw();
  sheet("Camera & effects", "One tap adds a pro camera move or effect to your video.", tabs, grid);
}

// ── result cards (pages, Library) ───────────────────────────────────────────────────────────────────────────────
function resultCard(g) {
  if (!g) return h("div");
  const out = g.output || (g.kind === "image" ? "image" : "video");
  const el = h("div", { class: "result" + (g.status === "failed" ? " failed" : ""), "data-result": g.id });
  const s = g.settings || {};
  const ratio = out === "audio" ? "16 / 10" : g.kind === "image" ? cssRatio(s.aspect) : g.kind === "tool" ? "4 / 3" : s.imageRole === "first_frame" ? "16 / 10" : cssRatio(s.aspect);
  const media = h("div", { class: "media", style: { aspectRatio: ratio } });
  if (g.status === "running") {
    const t = h("span", {}); elapsed(g, t);
    const label = g.kind === "film" ? `${g.progress?.label || "Starting your film"} · ${Math.round(g.progress?.percent || 0)}%` : "Generating…";
    media.append(h("div", { class: "shimmer" }), h("div", { class: "state" }, h("span", {}, label), h("span", { class: "row-gap" }, t, h("span", { class: "spin" }))));
  } else if (g.status === "failed") {
    media.append(h("div", {}, h("div", {}, g.error || "This one couldn't be made."), g.refunded ? h("div", { class: "refund", style: { justifyContent: "center" } }, icon("check", 14, 2.6), `${g.credits} credits refunded`) : null));
  } else if (out === "audio") {
    const tint = g.model === "music" ? "linear-gradient(135deg,#af52de,#5e5ce6)" : g.model === "sfx" ? "linear-gradient(135deg,#32ade6,#30d158)" : "linear-gradient(135deg,#ff2d55,#ff9f0a)";
    media.style.background = tint;
    media.append(h("div", { class: "audio-art" }, icon(g.model === "music" ? "music" : g.model === "sfx" ? "wave" : "mic", 44, 1.6)));
  } else if (out === "image" || g.kind === "image") {
    const o = g.outputs?.[0];
    if (o) media.append(h("img", { src: o.url, alt: "", loading: "lazy" }));
    if ((g.outputs?.length || 0) > 1) media.append(h("span", { class: "badge-r" }, icon("layers", 12, 2.4), g.outputs.length));
    media.addEventListener("click", () => o && viewOutput(g, o));
  } else {
    const src = g.kind === "tool" ? g.outputs?.[0]?.url : g.video;
    if (g.kind === "film") media.style.aspectRatio = (s.format || "16:9").replace(":", " / ");
    if (src) {
      const v = h("video", { src: src + "#t=0.05", muted: true, playsinline: true, loop: true, preload: "metadata" });
      v.muted = true;
      media.append(v, h("span", { class: "badge-r" }, icon("play", 11, 2.4), g.kind === "tool" || g.kind === "film" ? g.modelName : `${s.duration || ""}s`));
      media.addEventListener("mouseenter", () => v.play().catch(() => {}));
      media.addEventListener("mouseleave", () => v.pause());
      media.addEventListener("click", () => (g.kind === "tool" ? viewOutput(g, g.outputs[0]) : viewVideo(g)));
    }
  }
  const acts = h("div", { class: "acts" }, h("span", { class: "meta" }, g.modelName || ""));
  if (g.status === "done") {
    const first = g.outputs?.[0];
    const dlUrl = g.kind === "video" || g.kind === "film" ? g.video : first?.url;
    if (dlUrl) acts.append(h("a", { class: "icon-btn", href: DEMO ? dlUrl : `${dlUrl}?dl=1`, download: "", title: "Download", "aria-label": "Download" }, icon("dl", 18)));
    acts.append(h("button", { class: "icon-btn", title: "Share", "aria-label": "Share", onclick: () => share(g, g.kind === "video" || g.kind === "film" ? undefined : first) }, icon("share", 18)));
    if (out === "image" && first) acts.append(h("button", { class: "icon-btn", title: "Animate", "aria-label": "Animate", onclick: () => animate(first) }, icon("play", 18)));
    acts.append(h("button", { class: "icon-btn", title: "Remix", "aria-label": "Remix", onclick: () => remix(g) }, icon("wand", 18)));
  }
  if (g.status === "done" || g.status === "failed") acts.append(h("button", { class: "icon-btn danger", title: "Delete", "aria-label": "Delete", onclick: () => deleteGen(g) }, icon("trash", 18)));
  el.append(media, h("div", { class: "info" },
    out === "audio" && g.status === "done" ? (g.outputs || []).map((o) => h("audio", { src: o.url, controls: true, preload: "none" })) : null,
    g.prompt ? h("p", {}, g.prompt) : null, acts));
  return el;
}

// ── Audio page ───────────────────────────────────────────────────────────────────────────────────────────────────
// ── Explore: every finished video the Kleo team made, Higgsfield-style (14 October 2026) ───────────────────────────
// studio-web/showcase.json (scripts/showcase.py) lists them; the files live on media.kleooai.com. Cards play their
// muted preview loop while they are on screen; a tap opens the whole clip with "Recreate" (the Video page, prompt and
// shape filled in) and "Ask Kleo" (the chat, prompt filled in). None of them went through the app, so the credit is
// "the Kleo team", never "made with Kleo".
let SHOWCASE = null;
async function showcase() {
  if (!SHOWCASE) SHOWCASE = await fetch("/showcase.json").then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return SHOWCASE;
}
const playing = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting) { if (!v.src) v.src = v.dataset.src; v.play().catch(() => {}); } else v.pause();
  }
}, { threshold: 0.55 }) : null;
function loopVideo(src, poster) {
  const v = h("video", { "data-src": src, poster, muted: true, loop: true, playsinline: true, preload: "none", "aria-hidden": "true" });
  v.muted = true;
  if (playing) playing.observe(v); else v.src = src;
  return v;
}
function showcaseCard(x, pick) {
  return h("button", { class: `sc-card sc-${x.format}`, onclick: () => (pick ? pick(x) : openShowcase(x)), "aria-label": x.title },
    h("div", { class: "sc-media" }, loopVideo(x.preview, x.poster)),
    h("div", { class: "sc-text" }, h("b", {}, x.title), x.line ? h("span", {}, x.line) : null));
}
function openShowcase(x) {
  const v = h("video", { src: x.full, poster: x.poster, autoplay: true, muted: true, loop: true, playsinline: true, controls: true });
  v.muted = true;
  // A film shows its prompt and can be recreated on the Video page; an ad has no prompt, so Kleo starts from it in the chat.
  viewerFrame(v, x.kind === "ad" ? x.line : x.prompt, x.kind === "ad"
    ? [h("button", { class: "btn btn-cta btn-sm", onclick: () => askKleo(x) }, icon("chat", 16), "Make one like this")]
    : [h("button", { class: "btn btn-cta btn-sm", onclick: () => recreate(x) }, icon("wand", 16), "Recreate"),
      h("button", { class: "btn btn-quiet btn-sm", onclick: () => askKleo(x) }, icon("chat", 16), "Ask Kleo")]);
}
function recreate(x) {
  closeLayer();
  S.page.video.prompt = x.prompt;
  S.settings = fix({ ...S.settings, aspect: x.format === "tall" ? "9:16" : x.format === "square" ? "1:1" : "16:9" });
  go("/video");
}
function askKleo(x) { closeLayer(); S.prefill = x.prompt; go("/"); }
/** A grid of cards (all one shape per row), filled when the list arrives. */
function showcaseGrid(pick, limit = 0, only = null, kind = null) {
  const box = h("div", { class: "sc-grids" });
  showcase().then((all) => {
    const list = all.filter((x) => (!only || x.format === only) && (!kind || (x.kind || "film") === kind)).slice(0, limit || undefined);
    const groups = ["wide", "tall", "square"].map((f) => list.filter((x) => x.format === f)).filter((g) => g.length);
    fill(box, groups.map((g) => h("div", { class: `sc-grid sc-grid-${g[0].format}` }, g.map((x) => showcaseCard(x, pick)))));
  });
  return box;
}
/** One scrolling row (the Create page): a few clips and "See all". */
function showcaseStrip(title) {
  const row = h("div", { class: "sc-row" });
  showcase().then((all) => fill(row, all.slice(0, 10).map((x) => showcaseCard(x))));
  return h("section", { class: "sc-strip" },
    h("div", { class: "sc-head" }, h("h2", {}, title), h("button", { class: "mini", onclick: () => go("/explore") }, "See all", icon("right", 14))), row);
}
function exploreView() {
  let only = null;
  const grids = h("div", {});
  const chips = h("div", { class: "seg2 sc-filter" });
  const draw = () => {
    fill(chips, [[null, "All"], ["wide", "Wide"], ["tall", "Vertical"]].map(([k, label]) =>
      h("button", { class: only === k ? "on" : "", onclick: () => { only = k; draw(); } }, label)));
    // Films first (each one can be recreated), then the Kleo ads.
    fill(grids, h("h2", { class: "sc-title" }, "Films"), showcaseGrid(null, 0, only, "film"),
      h("h2", { class: "sc-title" }, "Kleo ads"), showcaseGrid(null, 0, only, "ad"));
  };
  draw();
  setView("explore-view",
    h("div", { class: "page-head" }, h("h1", {}, "Explore"), h("p", {}, "Films made by the Kleo team. Tap one, then Recreate it.")),
    chips, grids);
}

function audioView() {
  const sub = store.get("audioTab", "voice");
  const tabs = h("div", { class: "seg2", style: { maxWidth: "460px", marginBottom: "16px" } },
    [["voice", "Voiceover"], ["music", "Music"], ["sfx", "Sound FX"]].map(([k, l]) => h("button", { class: sub === k ? "on" : "", onclick: () => { store.set("audioTab", k); audioView(); } }, l)));
  setView("", h("div", { class: "page wide" },
    h("div", { class: "page-h" }, h("div", {}, h("h1", {}, "Create audio"), h("p", {}, "Natural voices, songs and sound effects. Use them in your videos, talking photos and lipsync."))),
    tabs, toolBody(sub, true)));
}

// ── Apps ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const GROUPS = [["face", "Faces", "Swap, animate and make them talk"], ["video", "Video", "Move, edit and sharpen clips"], ["image", "Image", "Change looks in one tap"], ["audio", "Audio", "Voices, music and sounds"]];
function startFilm() {
  go("/");
  setTimeout(() => {
    setMode("video");
    const t = $("#prompt"); if (!t) return;
    if (!S.agent) toggleAgent();
    t.value = "Make a 60-second narrated film about "; autosize(t); updateSend(); t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, 80);
}
// ── App art (14 October 2026): every app shows what it does, the way Higgsfield's cards do ───────────────────────
// Pictures made for this with FLUX.2 Pro (media.kleooai.com/app/) and the Kleo team's own film loops. Before/after
// halves slide; sounds get a moving waveform. Nothing here is a fake result: each picture shows the kind of change.
const MEDIA = "https://media.kleooai.com";
const pic = (name) => `${MEDIA}/app/app-${name}.jpg`;
const loop = (slug) => `${MEDIA}/gallery/${slug}-p.mp4`;
const still = (slug) => `${MEDIA}/gallery/${slug}.jpg`;
function artImg(src, cls = "") { return h("img", { class: `art-fill ${cls}`, src, alt: "", decoding: "async" }); }
function artVideo(src, cls = "") { const v = loopVideo(src, src.replace(/-p\.mp4$/, ".jpg")); v.classList.add("art-fill"); if (cls) v.classList.add(...cls.split(" ")); return v; }
function waveBars(n = 22) { return h("div", { class: "art-wave", "aria-hidden": "true" }, Array.from({ length: n }, (_, i) => h("i", { style: { animationDelay: `${(i * 97) % 900}ms`, height: `${30 + ((i * 37) % 60)}%` } }))); }
const chip = (text, cls = "") => h("span", { class: `art-chip ${cls}` }, text);
/** Two layers with a sliding divider: the right one shows through from the divider on. */
function split(left, right, labels) {
  return h("div", { class: "art-split" }, left, h("div", { class: "art-split-r" }, right), h("span", { class: "art-split-bar" }, h("i")),
    labels ? [chip(labels[0], "l"), chip(labels[1], "r")] : null);
}
const APP_ART = {
  "face-swap": () => split(artImg(pic("face-a")), artImg(pic("face-b"))),
  "video-face-swap": () => h("div", { class: "art-stack" }, artVideo(loop("made-in-kleo-ai-queen")), h("span", { class: "art-face" }, artImg(pic("face-a"))), h("span", { class: "art-arrow" }, icon("redo", 16, 2.2))),
  "talking-photo": () => h("div", { class: "art-stack" }, artImg(pic("speaker")), h("span", { class: "art-bubble" }, "Hi, I'm talking!"), waveBars()),
  "lipsync": () => h("div", { class: "art-stack" }, artImg(pic("face-b")), h("span", { class: "art-bubble" }, "New words, same face"), waveBars()),
  "character-swap": () => split(artImg(pic("swap2-a")), artImg(pic("swap2-b"))),
  "photo-character-swap": () => split(artImg(pic("photoswap3-a")), artImg(pic("photoswap3-b"))),
  "motion-control": () => h("div", { class: "art-pair" }, artVideo(loop("lobby-run")), artVideo(loop("kitten-knight-jump")), h("span", { class: "art-arrow mid" }, icon("right", 16, 2.4))),
  "video-edit": () => split(artImg(still("koi-supra-night")), artImg(still("koi-supra-night"), "graded"), ["Before", "After"]),
  "video-upscale": () => split(artImg(still("dragon-rider-cat"), "soft"), artImg(still("dragon-rider-cat")), ["480p", "4K"]),
  "outfit-swap": () => split(artImg(pic("outfit-a"), "top"), artImg(pic("outfit-b"), "top")),
  "voice": () => h("div", { class: "art-stack" }, artImg(pic("face-a"), "dim"), waveBars(28)),
  "music": () => h("div", { class: "art-stack art-music" }, artImg(pic("music"), "blur"), h("img", { class: "art-cover", src: pic("music"), alt: "", loading: "lazy" }), waveBars(18)),
  "sfx": () => h("div", { class: "art-stack" }, artVideo(loop("mechs-in-snow"), "dim"), waveBars(28)),
};
function appArt(t) {
  const make = APP_ART[t.key];
  return h("div", { class: "art art-media", style: { background: `linear-gradient(135deg, ${t.tint}, ${t.tint}aa)` } },
    make ? make() : icon(t.icon, 44, 1.7), t.badge ? h("span", { class: "tag" }, t.badge) : null);
}

function appsView() {
  const tools = S.config.tools || [];
  setView("", h("div", { class: "page wide" },
    h("div", { class: "page-h" }, h("div", {}, h("h1", {}, "Apps"), h("p", {}, "One-tap tools. Pick one, add your photo or clip, done."))),
    h("button", { class: "film-banner", onclick: startFilm },
      h("div", { class: "fb-art fb-media" }, artVideo(loop("kleo-x-claude-ad"))),
      h("div", { class: "fb-tx" }, h("b", {}, "Kleo Film"), h("span", {}, "A whole narrated film from one message: script, voice, music, subtitles, 4K. Up to 5 minutes.")),
      h("span", { class: "fb-go" }, "Start", icon("right", 16, 2.2))),
    GROUPS.map(([g, title, sub]) => {
      const list = tools.filter((t) => t.group === g);
      if (!list.length) return null;
      return [h("div", { class: "apps-group" }, h("h2", {}, title), h("span", {}, sub)),
        h("div", { class: "app-grid" }, list.map((t) => h("button", { class: "app-card", onclick: () => go(`/apps/${t.key}`) },
          appArt(t),
          h("div", { class: "tx" }, h("b", {}, t.name), h("span", {}, t.blurb),
            h("span", { class: "from" }, tallowed(t.key) ? [h("span", {}, "from"), bolt(12), t.from] : [icon("lock", 13), "Unlocks with any pack"])))))];
    })));
}
function appView(key) {
  const t = tool(key);
  if (!t) return go("/apps");
  setView("", h("div", { class: "page wide" },
    h("button", { class: "back", onclick: () => go("/apps") }, icon("right", 16, 2.2), "Apps"),
    h("div", { class: "app-hero app-hero-big" }, h("div", { class: "app-hero-art" }, appArt(t)),
      h("div", { class: "app-hero-tx" },
        t.badge ? h("span", { class: "app-hero-badge" }, t.badge) : null,
        h("h1", {}, t.name), h("p", {}, t.blurb),
        // How it works, read from the app's own fields: what to add, then Generate (the way Higgsfield's pages say it).
        h("ol", { class: "app-steps" }, [...t.fields.filter((f) => !f.hidden && (f.required || ["image", "video", "audio"].includes(f.kind))).map((f) => f.label), t.output === "audio" ? "Create" : "Generate"].map((l, i) => h("li", {}, h("i", {}, i + 1), l))),
        h("span", { class: "app-hero-price" }, tallowed(t.key) ? [bolt(15), `from ${t.from} credits`] : [icon("lock", 15), "Unlocks with any credit pack"]))),
    toolBody(key, false)));
}
/** The form of one app with its results beside it. */
function toolBody(key, compact) {
  const t = tool(key);
  const st = (S.toolState ||= {})[key] ||= { inputs: Object.fromEntries(t.fields.filter((f) => f.default).map((f) => [f.key, f.default])), files: {}, consent: false };
  const form = h("div", { class: "panel" });
  const feed = h("div");
  const ctaBox = h("div", { class: "cta-wrap" });
  let quote = null;
  const visible = (f) => !f.when || f.when.is.includes(st.inputs[f.when.field] ?? t.fields.find((x) => x.key === f.when.field)?.default);
  const priceNow = debounce(async () => {
    if (!S.me) { quote = { credits: t.from, estimate: true }; drawCta(); return; }
    try { quote = await api("/api/tools/price", { method: "POST", body: { tool: key, inputs: st.inputs } }); } catch { quote = null; }
    drawCta();
  }, 250);
  function dropZone(f) {
    const file = st.files[f.key];
    const kindLabel = f.kind === "image" ? "photo" : f.kind === "video" ? "video" : "sound";
    const accept = f.kind === "image" ? "image/*" : f.kind === "video" ? "video/mp4,video/quicktime" : "audio/mpeg,audio/wav,audio/x-wav";
    const z = h("div", { class: "drop" + (file ? " filled" + (f.kind === "audio" ? " audio" : "") : ""), role: "button", tabindex: "0",
      onclick: (e) => { if (e.target.closest(".x") || e.target.closest("audio") || e.target.closest("video")) return; pickFile(accept, false, (fs) => fs[0] && put(f, fs[0])); },
      ondragover: (e) => { e.preventDefault(); z.classList.add("drag"); }, ondragleave: () => z.classList.remove("drag"),
      ondrop: (e) => { e.preventDefault(); z.classList.remove("drag"); const fl = e.dataTransfer?.files?.[0]; if (fl) put(f, fl); } });
    if (!file) z.append(h("div", { class: "dl" }, h("span", { class: "ic" }, icon(f.kind === "image" ? "photo" : f.kind === "video" ? "film" : "mic", 20)), h("b", {}, f.label), h("small", {}, f.hint || `Tap to add a ${kindLabel}`)));
    else {
      if (f.kind === "image") z.append(h("img", { src: file.local, alt: "" }));
      else if (f.kind === "video") z.append(h("video", { src: file.local, muted: true, playsinline: true, controls: true }));
      else z.append(h("div", { class: "dl", style: { color: "#fff", width: "100%" } }, icon("music", 30), h("audio", { src: file.local, controls: true })));
      if (file.duration) z.append(h("span", { class: "dur" }, fmtSec(file.duration)));
      if (!file.id) z.append(h("div", { class: "busy" }, h("span", { class: "spin" })));
      z.append(h("button", { class: "x", "aria-label": "Remove", onclick: (e) => { e.stopPropagation(); delete st.files[f.key]; delete st.inputs[f.key]; draw(); } }, icon("x", 14, 2.6)));
    }
    return z;
  }
  async function put(f, file) {
    const okType = f.kind === "image" ? file.type.startsWith("image/") : f.kind === "video" ? file.type.startsWith("video/") : file.type.startsWith("audio/");
    if (!okType) return toast(`That isn't a ${f.kind === "audio" ? "sound file" : f.kind}.`, true);
    st.files[f.key] = { local: URL.createObjectURL(file), id: null };
    draw();
    try { const u = await uploadFile(file); Object.assign(st.files[f.key], { id: u.id, duration: u.duration }); st.inputs[f.key] = u.id; }
    catch (e) { delete st.files[f.key]; handleError(e); }
    // An app with a hidden "frame" field (Character Swap) gets the video's first frame, taken here from the file.
    if (f.kind === "video" && st.inputs[f.key] && t.fields.some((x) => x.key === "frame")) {
      delete st.inputs.frame;
      try { st.inputs.frame = (await uploadFile(await firstFrame(file))).id; } catch (e) { handleError(e); }
    }
    draw();
  }
  function fieldEl(f) {
    if (!visible(f) || f.hidden) return null;
    if (f.kind === "text") {
      // Kleo's Enhance on every app prompt that describes something to make (not on words to be spoken as they are).
      const ek = f.key === "prompt" ? ({ music: "music", sfx: "sfx", "video-edit": "edit" })[key] || "video" : null;
      const ta2 = h("textarea", { class: "text-in", placeholder: f.placeholder || "", maxlength: f.maxLength || null, oninput: (e) => { st.inputs[f.key] = e.target.value; const c = e.target.parentNode?.querySelector(".field-h .count"); if (c && f.maxLength) c.textContent = `${e.target.value.length}/${f.maxLength}`; priceNow(); drawCta(); } }, st.inputs[f.key] || "");
      const enh = ek ? h("button", { class: "mini wand", type: "button", onclick: async (e) => {
        if (!(st.inputs[f.key] || "").trim()) return toast("Write an idea first — Kleo will make it a great prompt.");
        if (!signedIn()) return requireAccount();
        const b = e.currentTarget; b.disabled = true; fill(b, spinner(13), "Improving…");
        try { const r = await api("/api/enhance", { method: "POST", body: { kind: ek, prompt: st.inputs[f.key] } }); st.inputs[f.key] = r.prompt.slice(0, f.maxLength || 4000); ta2.value = st.inputs[f.key]; priceNow(); drawCta(); }
        catch (er) { handleError(er); } finally { b.disabled = false; fill(b, icon("wand", 14), "Enhance"); }
      } }, icon("wand", 14), "Enhance") : null;
      return h("div", { class: "field" }, h("div", { class: "field-h" }, f.label, h("span", { class: "row-gap" }, enh, f.maxLength ? h("span", { class: "count", style: { fontWeight: 500 } }, `${(st.inputs[f.key] || "").length}/${f.maxLength}`) : null)), ta2);
    }
    if (f.kind === "select") return h("div", { class: "field" }, h("div", { class: "field-h" }, f.label),
      h("div", { class: "seg2" }, f.options.map((o) => h("button", { class: (st.inputs[f.key] ?? f.default) === o.value ? "on" : "", onclick: () => { st.inputs[f.key] = o.value; draw(); } }, o.label))));
    if (f.kind === "voice") {
      const voices = [["nova", "Nova"], ["shimmer", "Shimmer"], ["coral", "Coral"], ["sage", "Sage"], ["alloy", "Alloy"], ["ash", "Ash"], ["onyx", "Onyx"], ["echo", "Echo"], ["ballad", "Ballad"], ["verse", "Verse"], ["fable", "Fable"]];
      return h("div", { class: "field" }, h("div", { class: "field-h" }, f.label),
        h("div", { class: "voice-pick" }, voices.map(([v, l]) => h("button", { class: (st.inputs[f.key] ?? f.default) === v ? "on" : "", onclick: () => { st.inputs[f.key] = v; draw(); } }, l))));
    }
    return null;
  }
  function drawCta() {
    const missing = quote?.missing;
    const busy = Object.values(st.files).some((x) => !x.id);
    const lockd = !tallowed(key);
    const ready = !S.me || (quote && quote.credits && !busy && (!t.consent || st.consent));
    fill(ctaBox, h("button", { class: "btn btn-cta btn-xl", disabled: !ready || st.sending, onclick: run },
      st.sending ? spinner(18) : [lockd ? icon("lock", 17) : icon("sparkle", 18, 2.2), t.output === "audio" ? "Create" : "Generate", h("span", { class: "cost" }, bolt(15), quote?.credits ? `${quote.estimate ? "~" : ""}${quote.credits}` : "…")]),
      h("div", { class: "cta-note" }, !S.me ? "Free account · 5 credits to start" : lockd ? "Unlocks with any credit pack" : missing || (t.consent && !st.consent ? "Tick the box above to continue" : `You have ${S.me.credits} credits`)));
  }
  async function run() {
    if (!signedIn()) return requireAccount();
    if (!tallowed(key)) return openBuy(`${t.name} unlocks with your first credit pack.`);
    st.sending = true; drawCta();
    try {
      const r = await api("/api/tools/run", { method: "POST", body: { tool: key, inputs: st.inputs, consent: st.consent } });
      setCredits(r.credits);
      S.gens.set(r.generation.id, r.generation);
      if (r.generation.status === "running") watch(r.generation.id);
      (S.feeds[`tool:${key}`] ||= []).unshift(r.generation);
      drawFeed();
      if (innerWidth <= 980) feed.scrollIntoView({ behavior: "smooth" });
    } catch (e) { handleError(e); }
    finally { st.sending = false; drawCta(); }
  }
  function drawFeed() {
    const list = S.feeds[`tool:${key}`];
    fill(feed, h("div", { class: "feed-h" }, h("h2", {}, "Your results")),
      !list ? h("div", { class: "hero" }, h("span", { class: "spin dark", style: { margin: "0 auto" } }))
        : list.length ? h("div", { class: "feed" }, list.map((g) => resultCard(g)))
        : h("div", { class: "empty-feed" }, h("b", {}, "Nothing yet"), t.output === "audio" ? "Your sounds will appear here." : "Your results will appear here."));
  }
  function draw() {
    const files = t.fields.filter((f) => ["image", "video", "audio"].includes(f.kind) && visible(f));
    fill(form,
      files.length ? h("div", { class: "drops" }, files.map((f, i) => { const z = dropZone(f); if (files.length === 1 || (files.length % 2 === 1 && i === files.length - 1)) z.classList.add("one"); return z; })) : null,
      t.fields.filter((f) => !["image", "video", "audio"].includes(f.kind)).map(fieldEl),
      t.consent ? h("label", { class: "consent" }, h("input", { type: "checkbox", checked: st.consent || null, onchange: (e) => { st.consent = e.target.checked; drawCta(); } }),
        h("span", {}, "I have the right to use this person's face. No public figures, no minors, nothing sexual or deceptive.")) : null,
      ctaBox);
    priceNow(); drawCta();
  }
  draw(); drawFeed();
  loadFeed("tool", key).then(drawFeed);
  return h("div", { class: "gen-layout" }, form, feed);
}

// ── Library ──────────────────────────────────────────────────────────────────────────────────────────────────────
function libraryView() {
  const f = store.get("libFilter", "all");
  const body = h("div", {}, h("div", { class: "hero" }, h("span", { class: "spin dark", style: { margin: "0 auto" } })));
  const filters = h("div", { class: "filters" }, [["all", "All"], ["video", "Videos"], ["image", "Pictures"], ["audio", "Audio"], ["apps", "Apps"]].map(([k, l]) =>
    h("button", { class: f === k ? "on" : "", onclick: () => { store.set("libFilter", k); libraryView(); } }, l)));
  setView("", h("div", { class: "page wide" }, h("div", { class: "page-h" }, h("div", {}, h("h1", {}, "Library"), h("p", {}, "Everything you made, in one place."))), filters, body));
  const drawIt = () => {
    const all = (S.feeds.library || []).filter((g) => g.status !== "failed");
    const list = all.filter((g) => f === "all" || (f === "video" && (g.kind === "video" || g.kind === "film")) || (f === "image" && g.kind === "image") || (f === "audio" && g.output === "audio") || (f === "apps" && g.kind === "tool" && g.output !== "audio"));
    fill(body, list.length ? h("div", { class: "feed" }, list.map((g) => resultCard(g)))
      : h("div", { class: "empty-feed" }, h("b", {}, "Nothing here yet"), "Everything you generate lands here.", h("div", { style: { marginTop: "16px" } }, h("button", { class: "btn btn-cta", onclick: () => go("/video") }, icon("sparkle", 18), "Make something"))));
  };
  if (!S.me) { fill(body, h("div", { class: "empty-feed" }, h("b", {}, "Your creations live here"), "Create a free account to start — 5 credits on us.", h("div", { style: { marginTop: "16px" } }, h("button", { class: "btn btn-cta", onclick: () => requireAccount() }, icon("sparkle", 18), "Start free")))); return; }
  if (S.feeds.library) drawIt();
  loadFeed("library").then(drawIt);
}

// ── sheets & menus ───────────────────────────────────────────────────────────────────────────────────────────────
let openLayer = null;
function closeLayer() { openLayer?.forEach((n) => n.remove()); openLayer = null; document.removeEventListener("keydown", escClose); }
const escClose = (e) => e.key === "Escape" && closeLayer();
function sheet(title, sub, ...content) {
  closeLayer();
  const scrim = h("div", { class: "scrim", onclick: closeLayer });
  const box = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "grabber" }),
    h("div", { class: "sheet-h" }, h("h2", {}, title), h("button", { class: "icon-btn", "aria-label": "Close", onclick: closeLayer }, icon("x", 19, 2.2))),
    sub ? h("p", { class: "sheet-sub" }, sub) : null, ...content.flat(Infinity).filter(Boolean));
  document.body.append(scrim, box); openLayer = [scrim, box];
  document.addEventListener("keydown", escClose);
  return box;
}
/**
 * Kleo's own "are you sure?" (15 October 2026, the owner: no browser pop-ups, ever). A card over the page with the
 * question, Cancel and the action; Enter confirms, Escape and a tap outside cancel. Answers true or false. With `word`
 * the action stays off until that word is typed (deleting the account). It never closes the sheet or viewer beneath it.
 */
function ask({ title, text = "", ok = "OK", cancel = "Cancel", danger = false, ic = danger ? "trash" : "check", word = null }) {
  return new Promise((done) => {
    const input = word ? h("input", { class: "input", placeholder: `Type ${word}`, autocomplete: "off", autocapitalize: "characters", spellcheck: "false" }) : null;
    const yes = h("button", { class: "btn " + (danger ? "btn-destroy" : "btn-primary"), type: "button" }, ok);
    const no = h("button", { class: "btn btn-quiet", type: "button" }, cancel);
    const card = h("div", { class: "ask", role: "alertdialog", "aria-modal": "true", "aria-label": title, onclick: (e) => e.stopPropagation() },
      h("div", { class: "ask-ic" + (danger ? " danger" : "") }, icon(ic, 24, 2)), h("h3", {}, title), text ? h("p", {}, text) : null, input, h("div", { class: "ask-btns" }, no, yes));
    const scrim = h("div", { class: "ask-scrim" }, card);
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === "Enter" && !yes.disabled) { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    const finish = (v) => { document.removeEventListener("keydown", key, true); scrim.classList.add("out"); setTimeout(() => scrim.remove(), 160); done(v); };
    scrim.addEventListener("click", () => finish(false));
    no.addEventListener("click", () => finish(false));
    yes.addEventListener("click", () => finish(true));
    if (input) { yes.disabled = true; input.addEventListener("input", () => { yes.disabled = input.value.trim().toUpperCase() !== word; }); }
    document.addEventListener("keydown", key, true);
    document.body.append(scrim);
    setTimeout(() => (input || yes).focus(), 30);
  });
}
function openMenu(anchor, options, pick) {
  // A locked option shows a lock instead of its price and opens Get credits instead of being chosen.
  const rows = (menu) => options.map((o) => h("button", { class: "row" + (o.locked ? " locked" : ""), role: menu ? "menuitem" : null, onclick: () => { closeLayer(); if (o.locked) return openBuy(o.note); pick(o.value); } },
    h("div", { class: "lbl" }, h("b", {}, o.label)), o.locked ? h("span", { class: "val" }, icon("lock", 16)) : o.cost !== undefined ? h("span", { class: "val" }, bolt(13), o.cost) : null,
    h("span", { class: "check", style: { visibility: o.on ? "visible" : "hidden" } }, icon("check", 17, 2.4))));
  if (innerWidth <= 640) { sheet("Choose", null, h("div", { class: "list" }, rows(false))); return; }
  closeLayer();
  const r = anchor.getBoundingClientRect();
  const scrim = h("div", { class: "scrim clear", onclick: closeLayer });
  const menu = h("div", { class: "menu", role: "menu" }, rows(true));
  document.body.append(scrim, menu); openLayer = [scrim, menu];
  const mh = menu.offsetHeight, mw = menu.offsetWidth;
  menu.style.top = (r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8) + "px";
  menu.style.left = Math.min(Math.max(8, r.left), innerWidth - mw - 8) + "px";
  document.addEventListener("keydown", escClose);
}
function modelRows(models, current, isAllowed, fromPrice, onPick, img) {
  return h("div", { class: "list" }, models.map((m) => {
    // A paused model (its provider is down) is shown, marked, and never chosen.
    const paused = !!m.paused;
    const lockd = paused || !isAllowed(m.key);
    return h("button", { class: "row" + (lockd ? " locked" : ""), onclick: () => (paused ? toast(`${m.name} is paused for a little while: its provider is having trouble.`, true) : lockd ? openLocked(m, img) : (closeLayer(), onPick(m))) },
      h("div", { class: "lbl" }, h("b", {}, m.name, m.badge ? h("span", { class: "badge" }, m.badge) : null), h("span", {}, paused ? "Paused for a little while" : lockd ? "Unlocks with any credit pack" : m.blurb)),
      h("span", { class: "val" }, paused ? icon("clock", 16) : lockd ? icon("lock", 16) : [h("small", { style: { fontSize: "12px" } }, "from"), bolt(13), fromPrice(m)]),
      current === m.key ? h("span", { class: "check" }, icon("check", 18, 2.4)) : null);
  }));
}
function openModelPicker(s, onPick) {
  sheet("Video model", "Pick the engine. Price shows the shortest clip.",
    modelRows(S.config.models, s.model, allowed, (m) => Math.min(...m.resolutions.map((r) => m.prices[r][m.durations[0]])),
      (m) => onPick({ ...s, model: m.key, duration: m.durations.includes(s.duration) ? s.duration : m.defaultDuration, resolution: m.resolutions.includes(s.resolution) ? s.resolution : m.defaultResolution }), false));
}
function openImageModelPicker(s, onPick) {
  sheet("Picture model", "Pick the engine. Price shows one picture.",
    modelRows(S.config.imageModels, s.model, iallowed, (m) => m.prices[m.defaultQuality][1], (m) => onPick({ ...s, model: m.key }), true));
}
function openLocked(m, img) {
  const free = (img ? S.config.imageModels : S.config.models).filter((x) => x.free).map((x) => x.name).join(", ");
  openBuy(`${m.name} unlocks with your first credit pack. Free credits work with ${free}.`);
}
function openAspect(aspects, current, onPick) {
  sheet("Format", null, h("div", { class: "ratio-grid" }, aspects.map((a) => {
    const d = RATIOS[a] || [26, 26, ""];
    return h("button", { class: "ratio" + (a === current ? " on" : ""), onclick: () => { closeLayer(); onPick(a); } },
      h("i", { style: { width: d[0] + "px", height: d[1] + "px" } }), a, h("small", {}, d[2]));
  })));
}
function packRows(note) {
  const packs = S.me.packs || [];
  if (!packs.some((p) => p.url)) return [h("p", { class: "sheet-sub" }, "Credit packs are not on sale right now. Please check back soon.")];
  const tags = ["", "Popular", "Best value"];
  return [note ? h("p", { class: "sheet-sub" }, note) : null, h("div", { class: "list" }, packs.map((p, i) => h("button", { class: "row", disabled: !p.url, onclick: () => {
    window.open(p.url, "_blank", "noopener"); toast("Finish the payment, then come back — credits appear by themselves.");
  } }, h("div", { class: "pack lbl" }, h("span", { class: "amt" }, bolt(18), p.credits), h("div", {}, h("b", {}, p.label.replace(" EUR", " €"), tags[i] ? h("span", { class: "badge" }, tags[i]) : null),
      h("span", {}, `${(Number(p.label.split(" ")[0]) / p.credits).toFixed(2)} € per credit`))), icon("right", 18)))),
    h("p", { class: "sheet-sub", style: { paddingTop: "10px" } }, "Secure checkout by Stripe: card, Apple Pay, Google Pay, PayPal. Your first pack unlocks every model and app.")];
}
function bigCredits(sub) { return h("div", { class: "big-credits" }, h("b", {}, bolt(34), h("span", { "data-credits": "" }, S.me.admin ? "∞" : S.me.credits)), h("span", {}, S.me.admin ? "Admin account: no limits" : sub)); }
function openBuy(note) { if (!S.me) return requireAccount(); sheet("Get credits", null, bigCredits("credits left"), packRows(note)); }
// ── Account: a whole page, like Higgsfield's settings (14 October 2026) ──────────────────────────────────────────
// Profile, credits and packs, what the credits went on and what was bought, sign-in and security, Kleo in your AI
// assistant, appearance, help, and the account's end. Plain words, iPhone-size type, every button does what it says.
function openAccount(e) {
  if (!S.me) return requireAccount("signin");
  const anchor = e?.currentTarget;
  if (!anchor || innerWidth <= 760) { closeLayer(); go("/account"); return; }
  closeLayer();
  const r = anchor.getBoundingClientRect();
  const item = (ic, label, fn, cls = "") => h("button", { class: "am-item " + cls, onclick: () => { closeLayer(); fn(); } }, icon(ic, 18), h("span", {}, label));
  const theme = store.get("theme", "system");
  const menu = h("div", { class: "account-menu", role: "menu", style: { top: `${r.bottom + 10}px`, right: `${Math.max(12, innerWidth - r.right)}px` } },
    h("div", { class: "am-head" }, h("span", { class: "avatar" }, (S.me.name || S.me.email || "K")[0].toUpperCase()),
      h("div", {}, h("b", {}, S.me.name || "Your account"), h("span", {}, S.me.email || "Signed in with a Kleo key"))),
    h("div", { class: "am-credits" }, h("div", {}, bolt(18), h("b", { "data-credits": "" }, S.me.admin ? "∞" : S.me.credits), h("span", {}, S.me.admin ? "admin" : "credits")),
      S.me.admin ? null : h("button", { class: "btn btn-cta btn-sm", onclick: () => { closeLayer(); openBuy(); } }, "Get credits")),
    item("user", "Account settings", () => go("/account")),
    item("library", "My creations", () => go("/library")),
    item("plug", "Kleo in Claude & ChatGPT", () => window.open("https://kleooai.com/mcp/", "_blank", "noopener")),
    h("div", { class: "am-theme" }, h("span", {}, "Appearance"), h("div", { class: "seg2" }, [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) =>
      h("button", { class: theme === k ? "on" : "", onclick: () => { store.set("theme", k); applyTheme(); closeLayer(); } }, l)))),
    item("chat", "Help", () => window.open("mailto:hello@kleooai.com", "_blank")),
    item("out", "Sign out", () => signOut(), "danger"));
  const scrim = h("div", { class: "scrim clear", onclick: closeLayer });
  document.body.append(scrim, menu); openLayer = [scrim, menu];
  document.addEventListener("keydown", escClose);
}
const ACCOUNT_SECTIONS = [["profile", "Profile", "user"], ["credits", "Credits", "star"], ["activity", "Activity", "clock"], ["security", "Sign-in & security", "lock"], ["assistant", "Kleo in your AI assistant", "plug"], ["appearance", "Appearance", "sparkle"], ["help", "Help", "chat"]];
const KIND_ICON = { video: "film", image: "photo", tool: "apps", film: "film" };
function nameOf(model) {
  return S.config?.models?.find((m) => m.key === model)?.name || S.config?.imageModels?.find((m) => m.key === model)?.name
    || S.config?.tools?.find((t) => t.key === model)?.name || (model === "kleo-film" ? "Kleo Film" : model === "kleo-animatic" ? "Kleo Animatic" : model);
}
const when = (iso) => { try { return new Date(iso.endsWith("Z") ? iso : iso + "Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } };
function accountView() {
  if (!S.me) { requireAccount("signin"); return; }
  const me = S.me;
  const hasPass = me.methods?.includes("password");
  const card = (id, title, sub, ...kids) => h("section", { class: "acct-card", id: `acct-${id}` }, h("h2", {}, title), sub ? h("p", { class: "acct-sub" }, sub) : null, ...kids);
  const nav = h("nav", { class: "acct-nav", "aria-label": "Account sections" }, ACCOUNT_SECTIONS.map(([id, label, ic]) =>
    h("button", { class: "acct-link", onclick: () => document.getElementById(`acct-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, icon(ic, 18), label)));

  // Profile
  const nameIn = h("input", { class: "input", value: me.name || "", placeholder: "Your name", maxlength: "60", autocomplete: "name" });
  const saveName = async () => {
    if ((nameIn.value.trim() || null) === (me.name || null)) return;
    try { me.name = (await api("/api/me/profile", { method: "POST", body: { name: nameIn.value } })).name; toast("Name saved"); renderShell(); route(); }
    catch (e) { handleError(e); }
  };
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameIn.blur(); } });
  nameIn.addEventListener("blur", saveName);
  const profile = card("profile", "Profile", null,
    h("div", { class: "acct-hero" }, h("div", { class: "acct-avatar" }, (me.name || me.email || "K")[0].toUpperCase()),
      h("div", {}, h("b", {}, me.name || me.email || "Kleo account"), h("span", {}, me.email ? `${me.email} · member since ${when(me.since || "")}` : `Signed in with a Kleo key · member since ${when(me.since || "")}`))),
    h("label", { class: "acct-field" }, h("span", {}, "Name"), nameIn));

  // Credits
  const credits = card("credits", "Credits", me.paid ? "Every model and app is unlocked." : "Your first pack unlocks every model and app.",
    bigCredits("credits left"), packRows());

  // Activity: what the credits went on, and what was bought
  let tab = "usage", data = null;
  const actList = h("div", { class: "list acct-list" }, h("div", { class: "row" }, h("span", { class: "spin dark" })));
  const actSeg = h("div", { class: "seg2 acct-seg" });
  const drawAct = () => {
    fill(actSeg, [["usage", "Usage"], ["purchases", "Purchases"]].map(([k, label]) => h("button", { class: tab === k ? "on" : "", onclick: () => { tab = k; drawAct(); } }, label)));
    if (!data) return;
    const rows = tab === "usage" ? data.usage.map((u) => h("div", { class: "row" }, icon(KIND_ICON[u.kind] || "film", 19),
        h("div", { class: "lbl" }, h("b", {}, nameOf(u.model)), h("span", {}, `${when(u.created_at)}${u.prompt ? " · " + u.prompt : ""}`)),
        h("span", { class: `val ${u.refunded ? "ok" : ""}` }, u.refunded ? "Refunded" : u.status === "failed" ? "Failed" : `−${u.credits}`)))
      : data.purchases.map((p) => h("div", { class: "row" }, icon("bag", 19),
        h("div", { class: "lbl" }, h("b", {}, `${p.credits} credits`), h("span", {}, `${when(p.at)}${p.status !== "paid" ? " · " + p.status : ""}`)),
        h("span", { class: "val" }, `${(p.amount_cent / 100).toFixed(2)} ${String(p.currency).toUpperCase() === "EUR" ? "€" : String(p.currency).toUpperCase()}`)));
    fill(actList, rows.length ? rows : h("div", { class: "row" }, h("div", { class: "lbl" }, h("span", {}, tab === "usage" ? "Nothing made yet." : "No packs bought yet."))));
  };
  drawAct();
  api("/api/me/activity").then((d) => { data = d; drawAct(); }).catch((e) => { data = { usage: [], purchases: [] }; drawAct(); handleError(e); });
  const activity = card("activity", "Activity", "What your credits went on, and the packs you bought.", actSeg, actList);

  // Sign-in & security
  let revealed = false;
  const keyBox = h("div", { class: "keybox" }, "••••••••••••••••••••••••");
  const cur = h("input", { class: "input", type: "password", placeholder: "Current password", autocomplete: "current-password" });
  const nxt = h("input", { class: "input", type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
  const changeForm = h("form", { class: "acct-form", onsubmit: async (ev) => {
    ev.preventDefault();
    try { await api("/api/auth/password/change", { method: "POST", body: { current: cur.value, password: nxt.value } }); cur.value = nxt.value = ""; toast("Password changed — other devices are signed out"); }
    catch (er) { handleError(er); }
  } }, cur, nxt, h("button", { class: "btn btn-primary" }, "Change password"));
  const security = card("security", "Sign-in & security", null,
    hasPass ? [h("h3", {}, "Password"), changeForm] : [h("h3", {}, "E-mail and password"), addPasswordForm()],
    socialList().length ? [h("h3", {}, "Google and Microsoft"), h("div", { class: "list" }, socialList().map((k) => {
      const on = me.methods?.includes(k);
      return h(on ? "div" : "a", { class: "row", href: on ? null : `/auth/${k}?link=1` }, SOCIAL[k].logo(), h("div", { class: "lbl" }, h("b", {}, SOCIAL[k].label), h("span", {}, on ? "Connected" : `Sign in with ${SOCIAL[k].label} next time`)),
        on ? h("span", { class: "check" }, icon("check", 18, 2.4)) : h("span", { class: "val" }, "Connect", icon("right", 16)));
    }))] : null,
    h("h3", {}, "Kleo key"),
    h("p", { class: "acct-sub" }, "It signs in to your account from anywhere: keep it private."),
    keyBox,
    h("div", { class: "acct-actions" },
      h("button", { class: "btn btn-quiet", onclick: async () => {
        try {
          if (!revealed) { revealed = (await api("/api/me/key", { method: "POST", body: {} })).key; keyBox.textContent = revealed; return; }
          navigator.clipboard.writeText(revealed); toast("Kleo key copied");
        } catch (e) { handleError(e); }
      } }, icon("key", 17), "Show / copy"),
      h("button", { class: "btn btn-quiet", onclick: async () => {
        if (!(await ask({ title: "Make a new Kleo key?", text: "The old one stops working everywhere: AI assistants connected with it are disconnected until you add Kleo again, and every other browser and phone is signed out.", ok: "Make a new key", ic: "key" }))) return;
        try { revealed = (await api("/api/me/key", { method: "POST", body: { reset: true } })).key; keyBox.textContent = revealed; toast("New Kleo key made"); }
        catch (e) { handleError(e); }
      } }, icon("redo", 17), "New key")),
    h("h3", {}, "Sessions"),
    h("div", { class: "acct-actions" },
      h("button", { class: "btn btn-quiet", onclick: async () => {
        if (!(await ask({ title: "Sign out everywhere?", text: "Every browser and phone signed in to this account is signed out, this one included.", ok: "Sign out", ic: "out" }))) return;
        try { await api("/api/auth/signout-all", { method: "POST" }); } catch (e) { return handleError(e); }
        signOut(true);
      } }, icon("out", 17), "Sign out everywhere"),
      h("button", { class: "btn btn-quiet", onclick: () => signOut() }, icon("out", 17), "Sign out")));

  // Kleo in your AI assistant
  const assistant = card("assistant", "Kleo in your AI assistant", "The same account and credits work in Claude, ChatGPT, Grok and Cursor. Add Kleo as a connector with this address:",
    h("button", { class: "acct-copy", onclick: () => { navigator.clipboard.writeText(me.mcpUrl); toast("Address copied"); } }, h("span", {}, me.mcpUrl), icon("copy", 18)),
    h("ol", { class: "acct-steps" },
      h("li", {}, "In Claude: Settings → Connectors → Add custom connector."),
      h("li", {}, "Name it Kleo and paste the address."),
      h("li", {}, "On Kleo's page, paste your Kleo key to use this account.")));

  // Appearance
  const theme = store.get("theme", "system");
  const appearance = card("appearance", "Appearance", null, h("div", { class: "seg2 acct-seg" }, ["system", "light", "dark"].map((t) =>
    h("button", { class: t === theme ? "on" : "", onclick: () => { store.set("theme", t); applyTheme(); accountView(); } }, t === "system" ? "Automatic" : t[0].toUpperCase() + t.slice(1)))));

  // Help, then the end of the account
  const help = card("help", "Help", null, h("div", { class: "list" },
    h("a", { class: "row", href: "mailto:hello@kleooai.com" }, icon("chat", 19), h("div", { class: "lbl" }, h("b", {}, "Write to us"), h("span", {}, "hello@kleooai.com")), icon("right", 16)),
    h("a", { class: "row", href: "https://kleooai.com/faq/", target: "_blank", rel: "noopener" }, icon("text", 19), h("div", { class: "lbl" }, h("b", {}, "Questions and answers")), icon("right", 16)),
    h("a", { class: "row", href: "https://kleooai.com/terms.html", target: "_blank", rel: "noopener" }, icon("text", 19), h("div", { class: "lbl" }, h("b", {}, "Terms")), icon("right", 16)),
    h("a", { class: "row", href: "https://kleooai.com/privacy.html", target: "_blank", rel: "noopener" }, icon("lock", 19), h("div", { class: "lbl" }, h("b", {}, "Privacy")), icon("right", 16))));
  const danger = h("section", { class: "acct-card acct-danger" }, h("h2", {}, "Delete account"),
    h("p", { class: "acct-sub" }, "Deletes your videos, pictures, sounds, chats and sign-in methods for good. Credits you have left are lost. This can't be undone."),
    h("button", { class: "btn btn-danger", onclick: async () => {
      if (!(await ask({ title: "Delete your account?", text: "Your videos, pictures, sounds, chats and credits are deleted for good. To confirm, type DELETE.", ok: "Delete my account", danger: true, word: "DELETE" }))) return;
      try { await api("/api/me/delete", { method: "POST", body: { confirm: "DELETE" } }); } catch (e) { return handleError(e); }
      signOut(true); toast("Your account was deleted");
    } }, icon("trash", 17), "Delete my account"));

  setView("account-view", h("div", { class: "acct" }, nav,
    h("div", { class: "acct-main" }, h("h1", { class: "acct-title" }, "Account"), profile, credits, activity, security, assistant, appearance, help, danger)));
}
function addPasswordForm() {
  const e = h("input", { class: "input", type: "email", placeholder: "E-mail", autocomplete: "email" });
  const p = h("input", { class: "input", type: "password", placeholder: "Password (8+ characters)", autocomplete: "new-password" });
  return h("form", { style: { padding: "0 16px" }, onsubmit: async (ev) => {
    ev.preventDefault();
    try { await api("/api/auth/password", { method: "POST", body: { email: e.value, password: p.value } }); S.me = await api("/api/me"); toast("Done — you can now sign in with your e-mail"); accountView(); }
    catch (er) { handleError(er); }
  } }, h("p", { class: "sheet-sub", style: { padding: "0 4px 10px" } }, "Add an e-mail and password so you can sign in anywhere."), e, p, h("button", { class: "btn btn-primary", style: { width: "100%" } }, "Save"));
}
async function signOut(already = false) {
  closeLayer();
  if (!already) try { await api("/api/auth/signout", { method: "POST" }); } catch { /* the cookie goes anyway */ }
  S.me = null; S.chat = null; S.messages = []; S.feeds = {}; watching.clear();
  history.replaceState(null, "", "/"); enter(); toast("Signed out");
}
function applyTheme() {
  const t = store.get("theme", "system");
  if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
}

// ── viewers ──────────────────────────────────────────────────────────────────────────────────────────────────────
function viewerFrame(media, prompt, actions) {
  closeLayer();
  const box = h("div", { class: "viewer", role: "dialog", "aria-modal": "true" },
    h("button", { class: "icon-btn vclose", "aria-label": "Close", onclick: closeLayer }, icon("x", 20, 2.2)), media,
    h("p", { class: "vprompt" }, prompt), h("div", { class: "vactions" }, actions));
  box.addEventListener("click", (e) => { if (e.target === box) closeLayer(); });
  document.body.append(box); openLayer = [box];
  document.addEventListener("keydown", escClose);
}
/** Deletes a creation for good (the file, its pictures or sounds) and takes it off every list on screen. */
async function deleteGen(g) {
  const what = g.kind === "image" ? (g.outputs?.length > 1 ? "these pictures" : "this picture") : g.output === "audio" ? "this sound" : g.kind === "film" ? "this film" : "this video";
  if (!(await ask({ title: `Delete ${what}?`, text: "This can't be undone.", ok: "Delete", danger: true }))) return;
  try { await api(`/api/generations/${g.id}`, { method: "DELETE" }); } catch (e) { return handleError(e); }
  closeLayer();
  S.gens.delete(g.id);
  for (const k of Object.keys(S.feeds)) if (Array.isArray(S.feeds[k])) S.feeds[k] = S.feeds[k].filter((x) => x.id !== g.id);
  document.querySelectorAll(`[data-result="${g.id}"], [data-gen="${g.id}"]`).forEach((n) => n.remove());
  toast("Deleted");
}
function viewVideo(g) {
  viewerFrame(h("video", { src: g.video, controls: true, autoplay: true, playsinline: true, loop: true }), g.prompt, [
    h("a", { class: "btn btn-quiet btn-sm", href: DEMO ? g.video : `${g.video}?dl=1`, download: `kleo-${g.id}.mp4` }, icon("dl", 17), "Download"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => share(g) }, icon("share", 17), "Share"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => remix(g) }, icon("wand", 17), "Remix"),
    h("button", { class: "btn btn-quiet btn-sm danger", onclick: () => deleteGen(g) }, icon("trash", 17), "Delete")]);
}
function viewOutput(g, o) {
  const isVid = o.type === "video";
  viewerFrame(isVid ? h("video", { src: o.url, controls: true, autoplay: true, playsinline: true, loop: true }) : h("img", { src: o.url, alt: g.prompt.slice(0, 80) }), g.prompt, [
    !isVid ? h("button", { class: "btn btn-cta btn-sm", onclick: () => animate(o) }, icon("play", 16), "Animate") : null,
    h("a", { class: "btn btn-quiet btn-sm", href: DEMO ? o.url : `${o.url}?dl=1`, download: "" }, icon("dl", 17), "Download"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => share(g, o) }, icon("share", 17), "Share"),
    !isVid ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => useAsReference(o, "image") }, icon("layers", 17), "Use as reference") : null,
    isVid ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => useAsReference(o, "video") }, icon("film", 17), "Use in a video") : null,
    h("button", { class: "btn btn-quiet btn-sm danger", onclick: () => deleteGen(g) }, icon("trash", 17), "Delete")]);
}

// ── demo mode (?demo=1): the whole app on fake data, no account, nothing charged ─────────────────────────────────
const demoUploads = new Map();
const demoDb = { chats: [], messages: new Map(), gens: new Map(), credits: 42, n: 0 };
const SAMPLES = INSPO.map((x) => x.url);
const STILLS = ["https://kleooai.com/samples/realistic-tether.jpg", "https://kleooai.com/samples/shot-moon.jpg", "https://kleooai.com/samples/animation-octopus.jpg", "https://kleooai.com/samples/shot-dunes.jpg"];
function demoUpload(url, kind = "image") { const id = "up_demo" + (++demoDb.n); demoUploads.set(id, { url, kind }); return { id, kind, duration: kind === "image" ? null : 6 }; }
const demoCatalog = () => {
  const cfg = [
    ["seedance-2.5", "Seedance 2.5", "Best all-round motion, with sound", "Best", "seedance", [5, 10, 15], ["480p", "720p", "1080p"], 0.0861],
    ["seedance-2.0", "Seedance 2.0", "Great quality for less", null, "seedance", [5, 10, 15], ["480p", "720p", "1080p"], 0.0591],
    ["seedance-2.0-fast", "Seedance 2.0 Fast", "Cheapest and quick, great for drafts", "Cheapest", "seedance", [5, 10, 15], ["480p", "720p"], 0.0476],
    ["veo-3.1", "Google Veo 3.1", "Maximum quality, cinematic, native audio", "Max quality", "veo", [4, 6, 8], ["720p", "1080p"], 0.212],
    ["veo-3.1-fast", "Veo 3.1 Fast", "The Veo look, faster and cheaper", null, "veo", [4, 6, 8], ["720p", "1080p"], 0.0795],
  ];
  const mult = { "480p": 1, "720p": 2.25, "1080p": 5.6 };
  return cfg.map(([key, name, blurb, badge, family, durations, resolutions, base]) => ({
    key, name, blurb, badge, family, durations, defaultDuration: durations[0] === 4 ? 8 : 5, resolutions, defaultResolution: family === "veo" ? "1080p" : "720p",
    aspects: family === "veo" ? ["16:9", "9:16"] : ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxReferences: family === "veo" ? 3 : 9, free: key === "seedance-2.0-fast",
    prices: Object.fromEntries(resolutions.map((r) => [r, Object.fromEntries(durations.map((d) => [d, Math.max(1, Math.ceil(base * (family === "veo" ? 1 : mult[r]) * d * 1.6 / 0.44))]))])),
  }));
};
const demoImageCatalog = () => [
  ["nano-banana-pro", "Nano Banana Pro", "Google's best: text, faces, edits", "Best", ["1K", "2K", "4K"], "2K", { "1K": [1, 1, 2], "2K": [1, 1, 2], "4K": [1, 1, 2] }],
  ["nano-banana-2.1", "Nano Banana 2.1", "Google's newest: sharper, better text and faces", "New", ["1K", "2K", "4K"], "2K", { "1K": [1, 1, 1], "2K": [1, 1, 1], "4K": [1, 1, 1] }],
  ["nano-banana-2", "Nano Banana 2", "Fast Google model, great value", null, ["1K", "2K", "4K"], "2K", { "1K": [1, 1, 1], "2K": [1, 1, 1], "4K": [1, 1, 2] }],
  ["seedream-5", "Seedream 5.0", "ByteDance, sharp and detailed", "Cheapest", ["2K"], "2K", { "2K": [1, 1, 1] }],
  ["flux-2-pro", "FLUX.2 Pro", "Photoreal, natural light", null, ["1K"], "1K", { "1K": [1, 1, 1] }],
].map(([key, name, blurb, badge, qualities, dq, pr]) => ({
  key, name, blurb, badge, qualities, defaultQuality: dq, aspects: ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"], maxReferences: 14, free: key !== "nano-banana-pro", counts: [1, 2, 4],
  prices: Object.fromEntries(qualities.map((q) => [q, { 1: pr[q][0], 2: pr[q][1], 4: pr[q][2] }])),
}));
const DEMO_PRESETS = [["crash-zoom", "Crash Zoom", "camera", "Fast punch-in", "#ff375f"], ["dolly-zoom", "Dolly Zoom", "camera", "Vertigo effect", "#bf5af2"], ["orbit-360", "360 Orbit", "camera", "Circle the subject", "#0a84ff"], ["fpv-drone", "FPV Drone", "camera", "Fast fly-through", "#30d158"], ["crane-up", "Crane Up", "camera", "Rise and reveal", "#64d2ff"], ["dolly-in", "Slow Push-In", "camera", "Cinematic tension", "#ffd60a"], ["bullet-time", "Bullet Time", "camera", "Frozen moment", "#5e5ce6"], ["earth-zoom-out", "Earth Zoom Out", "camera", "From face to space", "#32ade6"], ["disintegrate", "Disintegration", "effect", "Turns to dust", "#a2845e"], ["levitate", "Levitation", "effect", "Floats up", "#ac8e68"], ["explosion", "Explosion", "effect", "Boom behind", "#ff6b00"], ["lightning", "Thunder God", "effect", "Electric power", "#7d7aff"], ["portal", "Portal", "effect", "Step through", "#5856d6"], ["anime", "Anime", "style", "Japanese animation", "#ff7eb6"], ["clay", "Claymation", "style", "Stop-motion clay", "#d4a373"], ["vhs", "VHS 90s", "style", "Retro tape", "#6a994e"]].map(([key, name, group, hint, tint]) => ({ key, name, group, hint, tint, art: `https://media.kleooai.com/app/presets/${key}.jpg?v=1` }));
const DEMO_TOOLS = [
  ["face-swap", "Face Swap", "Put a face on any photo", "face", "user", "#ff375f", "image", true, "Popular", [["target", "image", "Photo", "The picture to change"], ["face", "image", "Face", "A clear, front-facing face"]], 1],
  ["video-face-swap", "Video Face Swap", "Swap a face in a video", "face", "film", "#bf5af2", "video", true, null, [["video", "video", "Video", "MP4 or MOV, 3–15 seconds"], ["face", "image", "Face", "A clear, front-facing face"]], 7],
  ["talking-photo", "Talking Photo", "Make any portrait speak", "face", "mic", "#0a84ff", "video", true, "New", [["image", "image", "Portrait", "One face, looking at the camera"], ["script", "text", "What should they say?"], ["voice", "voice", "Voice"]], 2],
  ["lipsync", "Lipsync", "Make a video say new words", "face", "lips", "#ff9f0a", "video", true, null, [["video", "video", "Video", "MP4 or MOV with one face"], ["script", "text", "What should they say?"], ["voice", "voice", "Voice"]], 1],
  ["character-swap", "Character Swap", "Put your character in any video", "video", "user", "#ff9f0a", "video", true, "Pro", [["video", "video", "Video", "MP4 or MOV, 3–10 seconds, 720p or more"], ["image", "image", "Character", "Clear face, the clothes you want"]], 4],
  ["photo-character-swap", "Photo Character Swap", "Put your character in any photo", "image", "user", "#ff6b00", "image", true, "New", [["photo", "image", "Photo", "The picture to change"], ["image", "image", "Character", "Clear face, the clothes you want"]], 1],
  ["motion-control", "Motion Control", "Copy any dance or move", "video", "run", "#30d158", "video", false, null, [["image", "image", "Character", "Full body works best"], ["video", "video", "Moves", "A clip of the motion"]], 3],
  ["outfit-swap", "Outfit Swap", "Try any clothes on anyone", "image", "shirt", "#64d2ff", "image", false, null, [["person", "image", "Person"], ["garment", "image", "Clothes"]], 1],
  ["video-edit", "Edit Video", "Change anything in a clip", "video", "wand", "#5e5ce6", "video", false, null, [["video", "video", "Video", "MP4, up to 15 seconds"], ["prompt", "text", "What should change?"]], 1],
  ["video-upscale", "Upscale Video", "Sharper, up to 4K", "video", "hd", "#ffd60a", "video", false, null, [["video", "video", "Video", "MP4 up to 20 seconds"]], 3],
  ["voice", "Voiceover", "Text to a natural voice", "audio", "mic", "#ff2d55", "audio", false, null, [["script", "text", "Text to read"], ["voice", "voice", "Voice"]], 1],
  ["music", "Music", "Songs and soundtracks", "audio", "music", "#af52de", "audio", false, null, [["prompt", "text", "Describe the music"]], 1],
  ["sfx", "Sound Effects", "Any sound from words", "audio", "wave", "#32ade6", "audio", false, null, [["prompt", "text", "Describe the sound"]], 1],
].map(([key, name, blurb, group, ic, tint, output, consent, badge, fields, from]) => ({ key, name, blurb, group, icon: ic, tint, output, consent, badge, from, fields: fields.map(([k, kind, label, hint]) => ({ key: k, kind, label, hint, default: kind === "voice" ? "nova" : undefined, maxLength: kind === "text" ? 1000 : undefined })) }));
async function demoApi(path, opts) {
  if (/^\/api\/generations\/g_[a-z0-9]+$/.test(path) && opts?.method === "DELETE") { demoDb.gens.delete(path.split("/").pop()); return { ok: true }; }
  if (path === "/api/me/activity") return { usage: [...demoDb.gens.values()].map((g) => ({ id: g.id, kind: g.kind, model: g.model, credits: g.credits, status: g.status, refunded: 0, created_at: g.createdAt, prompt: (g.prompt || "").slice(0, 90) })), purchases: [{ credits: 35, amount_cent: 1500, currency: "eur", status: "paid", at: new Date(Date.now() - 86400e3).toISOString() }] };
  if (path === "/api/me/profile") return { name: String(opts.body?.name || "").trim() || null };
  if (path === "/api/auth/password/change" || path === "/api/me/delete") return { ok: true };
  await new Promise((r) => setTimeout(r, path === "/api/chat" ? 1100 : 150));
  const method = opts.method || "GET", b = opts.body || {};
  const now = () => new Date().toISOString();
  if (path === "/api/config") return { google: true, microsoft: true, social: ["google"], emailReset: true, defaultModel: "seedance-2.5", models: demoCatalog(), defaultImageModel: "nano-banana-2", imageModels: demoImageCatalog(), freeCredits: 5, presets: DEMO_PRESETS, tools: DEMO_TOOLS };
  if (path === "/api/me" && DEMO_GUEST) throw new ApiError("Sign in first.", 401, "signin");
  if (path === "/api/me" && DEMO_FREE) return { id: "u_demo", email: "you@example.com", name: "Demo", since: "2026-10-01T09:00:00Z", credits: 5, paid: false, allowed: ["seedance-2.0-fast"], freeResolutions: ["480p"], allowedImages: ["nano-banana-2"], allowedTools: [], methods: ["password"], mcpUrl: "https://mcp.kleooai.com/mcp", packs: [{ label: "5 EUR", credits: 10, url: "https://kleooai.com/pricing/" }, { label: "15 EUR", credits: 35, url: "https://kleooai.com/pricing/" }, { label: "40 EUR", credits: 100, url: "https://kleooai.com/pricing/" }] };
  if (path === "/api/me") return { id: "u_demo", email: "you@example.com", name: "Demo", since: "2026-10-01T09:00:00Z", credits: demoDb.credits, paid: true, allowed: demoCatalog().map((m) => m.key), allowedImages: demoImageCatalog().map((m) => m.key), allowedTools: DEMO_TOOLS.map((t) => t.key), methods: ["password", "google"], mcpUrl: "https://mcp.kleooai.com/mcp", packs: [{ label: "5 EUR", credits: 10, url: "https://kleooai.com/pricing/" }, { label: "15 EUR", credits: 35, url: "https://kleooai.com/pricing/" }, { label: "40 EUR", credits: 100, url: "https://kleooai.com/pricing/" }] };
  if (path === "/api/auth/signout" || path === "/api/auth/signout-all") return { ok: true };
  if (path === "/api/me/key") return { key: "u_demo.0123456789abcdef0123456789abcdef" };
  if (path === "/api/chats" && method === "GET") return { chats: demoDb.chats };
  if (path === "/api/enhance") return { prompt: `${b.prompt}. Cinematic composition, rich detail, soft directional light, shallow depth of field, smooth camera movement, vivid but natural colors, immersive ambient sound.` };
  if (path === "/api/price") return { credits: 3 };
  if (path === "/api/tools/price") { const t = DEMO_TOOLS.find((x) => x.key === b.tool); const missing = t.fields.find((f) => ["image", "video", "audio"].includes(f.kind) && !b.inputs[f.key]); return missing ? { credits: null, missing: `Add the ${missing.label.toLowerCase()}.` } : { credits: t.from, estimate: t.key === "talking-photo" }; }
  const cm = path.match(/^\/api\/chats\/(c_\w+)$/);
  if (cm) { if (method === "DELETE") { demoDb.chats = demoDb.chats.filter((c) => c.id !== cm[1]); return { ok: true }; } const chat = demoDb.chats.find((c) => c.id === cm[1]); if (!chat) throw new ApiError("Chat not found.", 404); return { chat, messages: demoDb.messages.get(chat.id) }; }
  const ensureChat = (title) => {
    let chat = demoDb.chats.find((c) => c.id === b.chatId);
    if (!chat) { chat = { id: "c_demo" + (++demoDb.n), title: title.slice(0, 40) || "New chat", updated_at: now() }; demoDb.chats.unshift(chat); demoDb.messages.set(chat.id, []); }
    return chat;
  };
  const newGen = (kind, prompt, settings, chatId, extra = {}) => {
    const img = kind === "image";
    let credits = 1, name = "Kleo";
    if (kind === "tool") { const t = DEMO_TOOLS.find((x) => x.key === extra.tool); credits = t.from; name = t.name; }
    else { const m = img ? demoImageCatalog().find((x) => x.key === settings.model) : demoCatalog().find((x) => x.key === settings.model); credits = img ? m.prices[settings.quality][settings.count] : m.prices[settings.resolution][settings.duration]; name = m.name; }
    const g = { id: "g_demo" + (++demoDb.n), kind, model: extra.tool || settings.model, modelName: name, settings, prompt, credits, status: "running", chatId, createdAt: now(), video: null, outputs: [], count: img ? settings.count : 1, output: extra.output || kind, doneAt: Date.now() + (img ? 4000 : 6000) };
    demoDb.credits -= credits; demoDb.gens.set(g.id, g); return g;
  };
  if (path === "/api/tools/run") {
    const t = DEMO_TOOLS.find((x) => x.key === b.tool);
    if (t.consent && !b.consent) throw new ApiError("Please confirm you have the right to use this person's face.", 400, "consent");
    const g = newGen("tool", b.inputs.script || b.inputs.prompt || t.name, { tool: t.key, output: t.output }, null, { tool: t.key, output: t.output });
    return { generation: { ...g }, credits: demoDb.credits };
  }
  if (path === "/api/chat") {
    const chat = ensureChat(b.text);
    const u = { id: "m_u" + (++demoDb.n), role: "user", text: b.text, attachments: (b.imageIds || []).map((id) => ({ id, url: demoUploads.get(id)?.url, kind: demoUploads.get(id)?.kind })) };
    let p, reply;
    if (/film|story|storia|documentar|narrat/i.test(b.text)) {
      p = { kind: "film", title: b.text.split(/\s+/).slice(0, 4).join(" ") || "Your film", prompt: b.text, settings: { duration: 60, format: "16:9", style: "realistic", product: "film", music: true, subtitles: false, language: "en" }, credits: 40, quote: { film: { credits: 40, allowed: true }, animatic: { credits: 10, allowed: true } }, imageIds: [] };
      reply = "Here's your Kleo film: I picked 60 seconds, YouTube format, realistic look, English narration with music. Change anything on the card.";
    } else if (b.mode === "image") {
      const s = ifix(b.imageSettings || {});
      p = { kind: "image", title: b.text.split(/\s+/).slice(0, 4).join(" ") || "Your picture", prompt: `${b.text}. Striking composition, soft natural light, rich detail, shallow depth of field, editorial photography, cohesive color palette.`, settings: s, credits: iprice(s), imageIds: b.imageIds || [] };
      reply = "Nice! Here's the shot I'd paint. Tap Generate, or tell me what to change.";
    } else {
      const s = fix(b.settings, (b.imageIds || []).length);
      if (/tiktok|reel|short|vertical|verticale/i.test(b.text)) s.aspect = "9:16";
      p = { kind: "video", title: b.text.split(/\s+/).slice(0, 4).join(" ") || "Your video", prompt: `${b.text || "The attached picture comes to life"}. Cinematic composition, natural motion, a slow dolly-in that reveals the scene, soft golden light with gentle contrast, shallow depth of field, rich detailed textures, photoreal style, immersive ambient sound that matches the action.`, settings: s, credits: price(s), imageIds: b.imageIds || [] };
      reply = s.aspect === "9:16" ? "Love it — I set it up vertical for TikTok. Tap Generate or tell me what to tweak." : "Great idea! Here's how I'd shoot it. Tap Generate when you're ready, or ask me to change anything.";
    }
    const bot = { id: "m_b" + (++demoDb.n), role: "assistant", text: reply, proposal: p };
    demoDb.messages.get(chat.id).push(u, bot);
    return { chat, messages: [u, bot] };
  }
  if (path === "/api/generate") {
    if (b.proposalId) {
      for (const [cid, list] of demoDb.messages) {
        const m = list.find((x) => x.id === b.proposalId);
        if (!m) continue;
        const kind = m.proposal.kind || "video";
        if (kind === "film") {
          const g = { id: "g_demo" + (++demoDb.n), kind: "film", model: "kleo-film", modelName: "Kleo Film", settings: { ...m.proposal.settings, ...(b.settings || {}) }, prompt: m.proposal.prompt, credits: 40, status: "running", chatId: cid, createdAt: now(), video: null, outputs: [], output: "video", progress: { percent: 5, label: "Writing the script", eta_min: 30 }, doneAt: Date.now() + 15000 };
          demoDb.credits -= 40; demoDb.gens.set(g.id, g); m.generations = [...(m.generations || []), g];
          return { chat: demoDb.chats.find((c) => c.id === cid), generation: g, credits: demoDb.credits, messages: [m] };
        }
        const g = newGen(kind, b.prompt || m.proposal.prompt, kind === "image" ? ifix(b.settings || m.proposal.settings) : fix(b.settings || m.proposal.settings), cid);
        m.generations = [...(m.generations || []), g];
        return { chat: demoDb.chats.find((c) => c.id === cid), generation: g, credits: demoDb.credits, messages: [m] };
      }
    }
    const kind = b.kind === "image" ? "image" : "video";
    const settings = kind === "image" ? ifix(b.settings) : fix(b.settings, (b.imageIds || []).length);
    if (b.noChat) { const g = newGen(kind, b.prompt, settings, null); return { generation: { ...g }, credits: demoDb.credits }; }
    const chat = ensureChat(b.prompt);
    const u = { id: "m_u" + (++demoDb.n), role: "user", text: b.prompt };
    const g = newGen(kind, b.prompt, settings, chat.id);
    const bot = { id: "m_b" + (++demoDb.n), role: "assistant", text: "", generation: g };
    demoDb.messages.get(chat.id).push(u, bot);
    return { chat, generation: g, credits: demoDb.credits, messages: [u, bot] };
  }
  const gm = path.match(/^\/api\/generations\/(g_\w+)$/);
  if (gm) {
    const g = demoDb.gens.get(gm[1]);
    if (g.kind === "film" && g.status === "running") { const left = Math.max(0, g.doneAt - Date.now()); g.progress = { percent: Math.round(100 - left / 150), label: left > 10000 ? "Writing the script" : left > 5000 ? "Filming the scenes" : "Finishing the film", eta_min: Math.ceil(left / 1000) }; }
    if (g.status === "running" && Date.now() > g.doneAt) {
      g.status = "done";
      if (g.kind === "film") g.video = SAMPLES[1];
      else if (g.kind === "image" || (g.kind === "tool" && g.output === "image")) g.outputs = Array.from({ length: g.count }, (_, i) => { const url = STILLS[(demoDb.n + i) % STILLS.length]; const up = demoUpload(url); return { upload: up.id, url, type: "image" }; });
      else if (g.kind === "tool" && g.output === "audio") g.outputs = [{ upload: "up_demo_a", url: "https://kleooai.com/samples/cinema.mp4", type: "audio" }];
      else if (g.kind === "tool") g.outputs = [{ upload: "up_demo_v", url: SAMPLES[demoDb.n % SAMPLES.length], type: "video" }];
      else g.video = SAMPLES[demoDb.n % SAMPLES.length];
    }
    return { generation: { ...g }, credits: demoDb.credits };
  }
  if (path.startsWith("/api/generations")) {
    const q = new URLSearchParams(path.split("?")[1] || "");
    return { generations: [...demoDb.gens.values()].reverse().filter((g) => (!q.get("kind") || g.kind === q.get("kind")) && (!q.get("model") || g.model === q.get("model"))) };
  }
  throw new ApiError("Not in the demo.", 404);
}
if (DEMO) {
  const s = { model: "seedance-2.5", duration: 5, resolution: "720p", aspect: "16:9", audio: true, imageRole: "none" };
  const g = { id: "g_demo0", kind: "video", model: "seedance-2.5", modelName: "Seedance 2.5", settings: s, prompt: INSPO[0].p, credits: 4, status: "done", chatId: "c_demo0", createdAt: new Date(Date.now() - 3600e3).toISOString(), video: SAMPLES[0], outputs: [], output: "video" };
  const gi = { id: "g_demo00", kind: "image", model: "nano-banana-pro", modelName: "Nano Banana Pro", settings: { model: "nano-banana-pro", aspect: "1:1", quality: "2K", count: 2 }, prompt: "An astronaut portrait in soft studio light", credits: 1, status: "done", createdAt: new Date(Date.now() - 7200e3).toISOString(), outputs: [{ upload: "up_x1", url: STILLS[0], type: "image" }, { upload: "up_x2", url: STILLS[1], type: "image" }], output: "image", count: 2 };
  demoDb.gens.set(gi.id, gi); demoDb.gens.set(g.id, g);
  demoDb.chats.push({ id: "c_demo0", title: "Desert rider at sunset", updated_at: new Date(Date.now() - 3600e3).toISOString() });
  demoDb.messages.set("c_demo0", [
    { id: "m_d1", role: "user", text: "un cavaliere nel deserto al tramonto, molto cinematografico" },
    { id: "m_d2", role: "assistant", text: "Bellissima idea! Ecco come lo girerei: drone largo, luce dorata, sabbia nel vento. Premi Genera quando vuoi.", proposal: { kind: "video", title: "Cavaliere nel deserto", prompt: g.prompt, settings: s, credits: 4, imageIds: [] }, generations: [g] },
  ]);
}

boot();
