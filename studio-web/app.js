// Kleo Studio — the web app. No framework: a small element builder, one state object, the JSON API of the
// kleo-studio Worker (src/studio/index.ts). Add ?demo=1 to the address to see the whole app on fake data.

const DEMO = new URLSearchParams(location.search).has("demo");
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
const SOCIAL = { google: { label: "Google", logo: googleLogo }, microsoft: { label: "Microsoft", logo: microsoftLogo } };
const socialList = () => (S.config?.social || (S.config?.google ? ["google"] : [])).filter((k) => SOCIAL[k]);

const store = {
  get(k, d) { try { const v = localStorage.getItem("kleo." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kleo." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("err", !!err); t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2800);
}
const spinner = (size = 16) => h("span", { class: "spin", style: { borderColor: "rgba(127,127,127,.35)", borderTopColor: "currentColor", width: size + "px", height: size + "px" } });

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────
const S = {
  config: null, me: null, chats: [], chat: null, messages: [], gens: new Map(), view: "chat",
  mode: store.get("mode", "video"), settings: store.get("settings", {}), imageSettings: store.get("imageSettings", {}),
  agent: store.get("agent", true), attachments: [], busy: false,
};
// video models
const model = (key) => S.config.models.find((m) => m.key === key) || S.config.models.find((m) => m.key === S.config.defaultModel);
function fix(s, images = 0) {
  const m = model(s.model);
  const out = { model: m.key };
  out.duration = m.durations.includes(Number(s.duration)) ? Number(s.duration) : m.defaultDuration;
  out.resolution = m.resolutions.includes(s.resolution) ? s.resolution : m.defaultResolution;
  out.aspect = m.aspects.includes(s.aspect) ? s.aspect : "16:9";
  out.audio = s.audio !== false;
  out.imageRole = images === 0 ? "none" : images === 1 ? (s.imageRole === "reference" ? "reference" : "first_frame") : "reference";
  return out;
}
const price = (s) => model(s.model).prices[s.resolution]?.[s.duration] ?? 1;
const allowed = (key) => !S.me || S.me.allowed.includes(key);
// image models
const imodel = (key) => S.config.imageModels.find((m) => m.key === key) || S.config.imageModels.find((m) => m.key === S.config.defaultImageModel);
function ifix(s) {
  const m = imodel(s.model);
  return {
    model: m.key, aspect: m.aspects.includes(s.aspect) ? s.aspect : "1:1",
    quality: m.qualities.includes(s.quality) ? s.quality : m.defaultQuality, count: m.counts.includes(Number(s.count)) ? Number(s.count) : 1,
  };
}
const iprice = (s) => imodel(s.model).prices[s.quality]?.[s.count] ?? 1;
const iallowed = (key) => !S.me || (S.me.allowedImages || []).includes(key);
const isImage = (p) => p?.kind === "image";
const RATIOS = { "16:9": [34, 19, "YouTube"], "9:16": [19, 34, "TikTok · Reels"], "1:1": [26, 26, "Square"], "4:3": [30, 23, "Classic"], "3:4": [23, 30, "Portrait"], "21:9": [38, 16, "Cinema"], "4:5": [24, 30, "Instagram"], "2:3": [21, 31, "Poster"], "3:2": [31, 21, "Photo"] };

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
  if (e?.code === "signin") { S.me = null; renderAuth(); return; }
  if (e?.code === "locked" || e?.code === "credits") { toast(e.message, true); setTimeout(() => openBuy(), 350); return; }
  toast(e?.message || "Something went wrong.", true);
}
function setCredits(n) {
  if (!S.me || typeof n !== "number" || n === S.me.credits) return;
  S.me.credits = n;
  for (const el of document.querySelectorAll("[data-credits]")) { el.textContent = n; el.parentElement?.classList.remove("bump"); void el.offsetWidth; el.parentElement?.classList.add("bump"); }
}

// ── boot & routing ───────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  applyTheme();
  try { S.config = await api("/api/config"); } catch { fill($("#app"), h("div", { class: "boot" }, h("p", {}, "Kleo Studio can't load right now. Please refresh."))); return; }
  const q = new URLSearchParams(location.search);
  if (location.pathname === "/reset" && q.get("t")) return renderReset(q.get("t"));
  const err = q.get("signin_error"), linked = q.get("linked");
  if (err || linked) {
    history.replaceState(null, "", "/");
    const who = (k) => SOCIAL[k]?.label || "That account";
    const msg = linked ? `${who(linked)} is now connected — use it to sign in next time.`
      : err === "day_full" ? "Kleo is full for new accounts today. Please come back tomorrow."
      : err === "address_full" ? "Too many new accounts from this connection today."
      : /^taken_/.test(err) ? `That ${who(err.slice(6))} account already belongs to another Kleo account.`
      : err === "cancelled" ? "Sign-in was cancelled."
      : `${who(err)} sign-in didn't finish. Please try again.`;
    setTimeout(() => toast(msg, !linked), 300);
  }
  try { S.me = await api("/api/me"); } catch (e) { if (e.code === "signin" || e.status === 401) return renderAuth(); return handleError(e); }
  await enter();
}
async function enter() {
  S.settings = fix(S.settings);
  if (!allowed(S.settings.model)) S.settings = fix({ ...S.settings, model: S.me.allowed[0] });
  S.imageSettings = ifix(S.imageSettings);
  if (!iallowed(S.imageSettings.model) && S.me.allowedImages?.length) S.imageSettings = ifix({ ...S.imageSettings, model: S.me.allowedImages[0] });
  renderShell();
  loadChats();
  await route();
}
async function route() {
  const p = location.pathname;
  const m = p.match(/^\/c\/(c_[a-z0-9]+)/);
  closeSide(); closeLayer();
  if (p === "/gallery") return showGallery();
  if (m) return openChat(m[1]);
  return newChat();
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
function authFrame(title, sub, ...content) {
  fill($("#app"), h("div", { class: "auth" }, h("div", { class: "auth-card" },
    h("img", { class: "logo", src: "/kleo-mark.svg", alt: "Kleo" }), h("h1", {}, title), h("p", { class: "sub" }, sub), ...content)));
}
function busyButton(btn) { const old = btn.textContent; btn.disabled = true; fill(btn, spinner(18)); return () => { btn.disabled = false; btn.textContent = old; }; }

function renderAuth(mode = "signup") {
  let showKey = false;
  const email = h("input", { class: "input", type: "email", placeholder: "E-mail", autocomplete: "email", inputmode: "email", autocapitalize: "off" });
  const pass = h("input", { class: "input", type: "password", placeholder: mode === "signup" ? "Password (8+ characters)" : "Password", autocomplete: mode === "signup" ? "new-password" : "current-password" });
  const key = h("input", { class: "input", placeholder: "Paste your Kleo key", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const err = h("div", { class: "auth-err" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, mode === "signup" ? "Create account" : "Sign in");
  const keyBox = h("div", { style: { display: "none" } }, key);
  const form = h("form", { onsubmit: async (ev) => {
    ev.preventDefault(); err.textContent = "";
    const restore = busyButton(submit);
    try {
      if (showKey) await api("/api/auth/key", { method: "POST", body: { key: key.value } });
      else await api(mode === "signup" ? "/api/auth/signup" : "/api/auth/signin", { method: "POST", body: { email: email.value, password: pass.value } });
      S.me = await api("/api/me");
      await enter();
      if (mode === "signup" && !showKey) toast(`Welcome! You have ${S.me.credits} free credits.`);
    } catch (e) { err.textContent = e.message; restore(); }
  } }, email, pass, keyBox, err, submit);
  const toggleKey = h("button", { type: "button", onclick: () => {
    showKey = !showKey;
    keyBox.style.display = showKey ? "" : "none"; email.style.display = pass.style.display = showKey ? "none" : "";
    submit.textContent = showKey ? "Sign in with key" : mode === "signup" ? "Create account" : "Sign in";
    toggleKey.textContent = showKey ? "Use e-mail instead" : "I have a Kleo key";
    (showKey ? key : email).focus();
  } }, "I have a Kleo key");
  authFrame(mode === "signup" ? "Create with Kleo" : "Welcome back", "Make AI videos and pictures just by chatting.",
    mode === "signup" ? h("div", { class: "gift" }, bolt(15), `${S.config?.freeCredits ?? 5} free credits to start`) : null,
    socialList().length ? [h("div", { class: "socials" }, socialList().map((k) => h("a", { class: "btn google", href: `/auth/${k}` }, SOCIAL[k].logo(), `Continue with ${SOCIAL[k].label}`))), h("div", { class: "or" }, "or use e-mail")] : null,
    form,
    h("div", { class: "auth-switch" },
      mode === "signup" ? ["Already have an account? ", h("button", { type: "button", onclick: () => renderAuth("signin") }, "Sign in")]
        : ["New here? ", h("button", { type: "button", onclick: () => renderAuth("signup") }, "Create an account")]),
    h("div", { class: "auth-switch small" }, toggleKey, mode === "signin" ? [" · ", h("button", { type: "button", onclick: () => renderForgot(email.value) }, "Forgot password?")] : null),
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
        S.me = await api("/api/me"); await enter(); toast("Password changed");
      } catch (e) { err.textContent = e.message; restore(); }
    } }, pass, err, btn));
  pass.focus();
}

// ── shell ────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderShell() {
  const side = h("aside", { class: "side", id: "side" },
    h("div", { class: "side-top" },
      h("div", { class: "brand" }, h("img", { src: "/kleo-mark.svg", alt: "" }), "Kleo", h("small", {}, "Studio")),
      h("span", { class: "spacer" }),
      h("button", { class: "icon-btn", title: "New chat", "aria-label": "New chat", onclick: () => go("/") }, icon("compose", 21))),
    h("button", { class: "nav-item", id: "nav-new", onclick: () => go("/") }, icon("sparkle", 19), "Create"),
    h("button", { class: "nav-item", id: "nav-gallery", onclick: () => go("/gallery") }, icon("grid", 19), "My creations"),
    h("div", { class: "side-label" }, "Chats"),
    h("div", { class: "chats", id: "chats" }),
    h("button", { class: "me-row", onclick: openAccount },
      h("div", { class: "avatar" }, (S.me.email || "K")[0].toUpperCase()),
      h("div", { class: "who" }, h("b", {}, S.me.email || "Kleo account"), h("span", {}, h("span", { "data-credits": "" }, S.me.credits), " credits")),
      icon("right", 16)));
  const main = h("main", { class: "main" },
    h("header", { class: "topbar", id: "topbar" },
      h("button", { class: "icon-btn menu-btn", "aria-label": "Menu", onclick: openSide }, icon("side", 22)),
      h("div", { class: "title", id: "title" }),
      h("button", { class: "credits-pill", onclick: openAccount, "aria-label": "Credits" }, bolt(15), h("span", { "data-credits": "" }, S.me.credits))),
    h("div", { class: "scroll", id: "scroll", onscroll: (e) => $("#topbar").classList.toggle("scrolled", e.target.scrollTop > 4) }, h("div", { class: "col", id: "col" })),
    h("div", { class: "dock", id: "dock" }, composer()));
  fill($("#app"), h("div", { class: "shell" }, side, main));
}
function openSide() { $("#side").classList.add("open"); const s = h("div", { class: "side-scrim", onclick: closeSide }); document.body.append(s); S.sideScrim = s; }
function closeSide() { $("#side")?.classList.remove("open"); S.sideScrim?.remove(); S.sideScrim = null; }

async function loadChats() {
  try { S.chats = (await api("/api/chats")).chats; } catch { S.chats = []; }
  renderChats();
}
function renderChats() {
  const box = $("#chats"); if (!box) return;
  fill(box, S.chats.length ? S.chats.map((c) => h("div", { class: "chat-item" + (S.chat?.id === c.id && S.view === "chat" ? " on" : ""), role: "button", tabindex: "0",
    onclick: () => go(`/c/${c.id}`), onkeydown: (e) => e.key === "Enter" && go(`/c/${c.id}`) },
    h("span", {}, c.title || "Untitled"),
    h("button", { class: "del", title: "Delete chat", "aria-label": "Delete chat", onclick: async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this chat? Your creations stay in My creations.")) return;
      try { await api(`/api/chats/${c.id}`, { method: "DELETE" }); S.chats = S.chats.filter((x) => x.id !== c.id); renderChats(); if (S.chat?.id === c.id) go("/"); } catch (er) { handleError(er); }
    } }, icon("trash", 16)))) : h("div", { class: "empty-chats" }, "Your chats will show up here."));
  $("#nav-gallery")?.classList.toggle("on", S.view === "gallery");
  $("#nav-new")?.classList.toggle("on", S.view === "chat" && !S.chat);
}

// ── chat view ────────────────────────────────────────────────────────────────────────────────────────────────────
function newChat() {
  S.view = "chat"; S.chat = null; S.messages = [];
  $("#dock").style.display = ""; $("#title").textContent = "";
  renderMessages(); renderChats();
  if (!IS_TOUCH) $("#prompt")?.focus();
}
async function openChat(id) {
  S.view = "chat"; $("#dock").style.display = "";
  if (S.chat?.id !== id) { S.chat = { id }; S.messages = []; fill($("#col"), h("div", { class: "hero" }, h("span", { class: "spin dark", style: { margin: "0 auto" } }))); }
  renderChats();
  try {
    const r = await api(`/api/chats/${id}`);
    S.chat = r.chat; S.messages = r.messages;
    for (const m of S.messages) collectGens(m);
    $("#title").textContent = S.chat.title || "";
    renderMessages(true); renderChats();
  } catch (e) { if (e.status === 404) { toast("That chat is gone.", true); go("/"); } else handleError(e); }
}
function collectGens(m) {
  for (const g of [m.generation, ...(m.generations || [])].filter(Boolean)) { S.gens.set(g.id, g); if (g.status === "running") watch(g.id); }
}

const IDEAS = {
  video: [
    { ic: "bag", c: "#ff9500", t: "Cinematic product shot", p: "A sleek black wireless earbud case opening slowly on a wet reflective surface, macro lens, soft rim light, slow orbit, premium commercial look, subtle whoosh sound." },
    { ic: "phone", c: "#ff2d55", t: "Scroll-stopping TikTok hook", p: "A vertical POV shot running through a neon night market in Tokyo, handheld energy, steam and lights, fast and exciting, upbeat ambience." },
    { ic: "photo", c: "#007aff", t: "Animate a photo", p: "", photo: true },
    { ic: "flame", c: "#af52de", t: "Anime fight scene", p: "Two anime warriors clash on a rooftop at sunset, dramatic speed lines, wind in their hair, dynamic camera swing, epic music swell." },
    { ic: "globe", c: "#30b0c7", t: "Dreamy travel clip", p: "Drone shot gliding over turquoise water toward a tiny island with one palm tree at golden hour, gentle waves, calm ambient sound." },
    { ic: "cup", c: "#a2845e", t: "Cozy café ad", p: "Close-up of latte art being poured in a warm sunlit café, steam rising, shallow depth of field, slow push-in, soft jazz in the background." },
  ],
  image: [
    { ic: "bag", c: "#ff9500", t: "Product photo", p: "A minimalist perfume bottle on a travertine pedestal, soft morning light through palm leaves, beige and sage palette, studio product photography, crisp reflections." },
    { ic: "star", c: "#ff2d55", t: "YouTube thumbnail", p: "A shocked young creator pointing at a giant glowing golden trophy, bold rim light, vibrant teal and orange background, high contrast YouTube thumbnail style, big empty space on the right." },
    { ic: "photo", c: "#007aff", t: "Edit my photo", p: "", photo: true },
    { ic: "text", c: "#af52de", t: "Poster with text", p: "A retro 70s travel poster of the Amalfi coast, sun-faded colors, bold title text \"AMALFI\" at the top, grainy print texture." },
    { ic: "user", c: "#30b0c7", t: "Character design", p: "Full-body character sheet of a friendly cyberpunk courier girl with a yellow jacket and a robot cat, front and side views, clean white background, 3D animated film style." },
    { ic: "layers", c: "#a2845e", t: "Album cover", p: "An album cover: a lone astronaut sitting on a crescent moon fishing for stars, dreamy pastel gradient sky, painterly texture, square composition." },
  ],
};
function renderMessages(jump = false) {
  const col = $("#col"); if (!col) return;
  if (!S.messages.length) {
    const img = S.mode === "image";
    fill(col, h("div", { class: "hero" },
      h("img", { src: "/kleo-mark.svg", alt: "" }),
      h("h1", {}, img ? "What should we picture?" : "What do you want to create?"),
      h("p", {}, S.agent ? (img ? "Describe a picture or drop a photo to edit. I'll set up the perfect shot." : "Tell me your idea, drop a photo, or tap an example. I'll set up the perfect video.")
        : img ? "Describe your picture and hit Generate." : "Describe your video and hit Generate."),
      h("div", { class: "ideas" }, IDEAS[S.mode].map((i) => h("button", { class: "idea", onclick: () => useIdea(i) },
        h("span", { class: "em", style: { background: i.c } }, icon(i.ic, 19, 2)), h("div", {}, h("b", {}, i.t), h("span", {}, i.photo ? (img ? "Upload a picture and say what to change." : "Upload a picture and bring it to life.") : i.p)))))));
    return;
  }
  fill(col, S.messages.map(messageEl));
  if (jump) requestAnimationFrame(() => { const s = $("#scroll"); s.style.scrollBehavior = "auto"; s.scrollTop = s.scrollHeight; s.style.scrollBehavior = ""; });
}
function useIdea(i) {
  if (i.photo) return pickFiles();
  const t = $("#prompt"); t.value = i.p; autosize(t); updateSend(); t.focus();
}
function scrollDown() { requestAnimationFrame(() => { const s = $("#scroll"); if (s) s.scrollTop = s.scrollHeight; }); }

function messageEl(m) {
  if (m.role === "user") {
    return h("div", { class: "msg user", "data-msg": m.id },
      m.attachments?.length ? h("div", { class: "attach-row" }, m.attachments.map((a) => h("img", { src: a.url, alt: "Attached picture", loading: "lazy" }))) : null,
      m.text ? h("div", { class: "bubble" }, m.text) : null);
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
const resOptions = (s) => model(s.model).resolutions.map((r) => ({ label: r === "1080p" ? "1080p · Full HD" : r === "720p" ? "720p · HD" : "480p · Draft", value: r, on: r === s.resolution, cost: price({ ...s, resolution: r }) }));
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

function proposalEl(m) {
  const p = m.proposal;
  const img = isImage(p);
  let s = img ? ifix(p.settings) : fix(p.settings, p.imageIds?.length || 0);
  let editing = false, expanded = false;
  const wrap = h("div", { class: "card", "data-proposal": m.id });
  const draw = () => {
    const gens = (m.generations || []).map((g) => S.gens.get(g.id) || g);
    const long = p.prompt.length > 220;
    const cost = img ? iprice(s) : price(s);
    const lockd = img ? !iallowed(s.model) : !allowed(s.model);
    fill(wrap,
      h("div", { class: "card-h" }, h("span", { class: "eyebrow" }, icon(img ? "photo" : "sparkle", 13, 2.2), gens.length ? (img ? "Your pictures" : "Your video") : "Ready to generate")),
      h("div", { class: "card-title" }, p.title),
      editing ? h("textarea", { "aria-label": "Prompt", oninput: (e) => { p.prompt = e.target.value; } }, p.prompt)
        : h("div", { class: "card-prompt" + (expanded ? "" : " clamp") }, p.prompt),
      !editing && long ? h("button", { class: "more", onclick: () => { expanded = !expanded; draw(); } }, expanded ? "Less" : "More") : null,
      p.imageIds?.length ? h("div", { class: "card-thumbs" }, p.imageIds.map((id) => h("img", { src: DEMO ? demoUploads.get(id) : `/media/u/${id}`, alt: "" }))) : null,
      settingPills(s, (ns) => { s = img ? ifix(ns) : fix(ns, p.imageIds?.length || 0); p.settings = s; draw(); }, img ? "image" : "video"),
      h("div", { class: "card-f" },
        h("button", { class: "btn btn-primary btn-grow", onclick: (e) => generateFromProposal(m, s, e.currentTarget) },
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
  const cost = img ? iprice(s) : price(s);
  if (S.me.credits < cost) return openBuy(`This costs ${cost} credits. You have ${S.me.credits}.`);
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

// ── one generation: a clip or a set of pictures ──────────────────────────────────────────────────────────────────
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
  return g.kind === "image" ? picturesEl(g) : clipEl(g);
}
function clipEl(g) {
  const s = g.settings || {};
  const shape = s.aspect === "9:16" || s.aspect === "3:4" ? "portrait" : s.aspect === "1:1" ? "square" : "";
  const ratio = s.imageRole === "first_frame" ? "16 / 10" : cssRatio(s.aspect);
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
  el.append(h("div", { class: "pics-grid" }, g.outputs.map((o) => h("button", { class: "pic", style: { aspectRatio: cssRatio(s.aspect) }, onclick: () => viewPicture(g, o) },
      h("img", { src: o.url, alt: g.prompt.slice(0, 80), loading: "lazy" })))),
    h("div", { class: "pics-bar" },
      h("span", { class: "meta" }, `${g.modelName} · ${s.aspect} · ${s.quality}`, g.refunded ? ` · ${g.count - g.outputs.length} failed, refunded` : ""),
      g.outputs.length === 1 ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => animate(g.outputs[0]) }, icon("play", 15), "Animate") : null,
      h("button", { class: "icon-btn", title: "Remix", "aria-label": "Remix", onclick: () => remix(g) }, icon("wand", 19))));
  return el;
}
function refreshGen(id) {
  for (const old of document.querySelectorAll(`[data-gen="${id}"]`)) old.replaceWith(genEl(id));
  const tile = document.querySelector(`[data-tile="${id}"]`);
  if (tile) tile.replaceWith(tileEl(S.gens.get(id)));
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
  if (S.view !== "chat") go(g.chatId ? `/c/${g.chatId}` : "/");
  setTimeout(() => {
    const t = $("#prompt"); if (!t) return;
    setMode(g.kind === "image" ? "image" : "video");
    t.value = g.prompt; autosize(t);
    if (g.kind === "image") { S.imageSettings = ifix({ ...S.imageSettings, ...g.settings }); store.set("imageSettings", S.imageSettings); }
    else { S.settings = fix({ ...S.settings, ...g.settings }); store.set("settings", S.settings); }
    drawChips(); updateSend(); t.focus();
    toast("Prompt is back in the box — change anything");
  }, 60);
}
/** A finished picture becomes the start frame of a new video. */
function animate(o) {
  closeLayer();
  if (S.view !== "chat") go(S.chat?.id ? `/c/${S.chat.id}` : "/");
  setTimeout(() => {
    setMode("video");
    S.attachments = [{ id: o.upload, local: o.url }];
    S.settings = fix({ ...S.settings, imageRole: "first_frame" }, 1); store.set("settings", S.settings);
    drawAttachments(); drawChips(); updateSend();
    const t = $("#prompt"); t.value = ""; t.placeholder = "Describe the motion… (or just send)"; t.focus();
    toast("Picture attached as the first frame");
  }, 60);
}
function useAsReference(o) {
  closeLayer();
  if (S.attachments.length >= 6) return toast("Up to 6 pictures.", true);
  S.attachments.push({ id: o.upload, local: o.url });
  drawAttachments(); drawChips(); updateSend(); $("#prompt")?.focus();
  toast("Picture attached");
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
      if (r.generation.status !== "running") {
        watching.delete(id);
        setCredits(r.credits);
        refreshGen(id);
        if (r.generation.status === "done") toast(r.generation.kind === "image" ? "Your pictures are ready ✨" : "Your video is ready ✨");
      } else if (!before) refreshGen(id);
    } catch (e) { if (e.code === "signin") { watching.clear(); return handleError(e); } }
  }
}

// ── composer ─────────────────────────────────────────────────────────────────────────────────────────────────────
function composer() {
  const ta = h("textarea", { id: "prompt", rows: "1", placeholder: S.mode === "image" ? "Describe your picture…" : "Describe your video…", "aria-label": "Describe what to create",
    oninput: (e) => { autosize(e.target); updateSend(); },
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !IS_TOUCH && !e.isComposing) { e.preventDefault(); submit(); } },
    onpaste: (e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (files.length) { e.preventDefault(); addFiles(files); } } });
  const file = h("input", { type: "file", accept: "image/*", multiple: true, id: "file", hidden: true, onchange: (e) => { addFiles([...e.target.files]); e.target.value = ""; } });
  const modes = h("div", { class: "modes", role: "tablist" },
    [["video", "film", "Video"], ["image", "photo", "Image"]].map(([k, ic, label]) => h("button", { role: "tab", "data-mode": k, class: S.mode === k ? "on" : "", onclick: () => setMode(k) }, icon(ic, 16), label)));
  const box = h("div", { class: "composer", id: "composer",
    ondragover: (e) => { e.preventDefault(); box.classList.add("drag"); }, ondragleave: () => box.classList.remove("drag"),
    ondrop: (e) => { e.preventDefault(); box.classList.remove("drag"); addFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"))); } },
    file, h("div", { class: "att", id: "att" }), ta,
    h("div", { class: "tools" },
      h("button", { class: "plus", title: "Add pictures", "aria-label": "Add pictures", onclick: pickFiles }, icon("plus", 20, 2.1)),
      h("div", { class: "chips", id: "chips" }),
      h("button", { class: "agent-toggle", id: "agent", title: "Kleo agent: chat first, then generate", onclick: toggleAgent }, h("span", { class: "lbl-text" }, "Agent"), h("span", { class: "switch" + (S.agent ? " on" : "") })),
      h("div", { id: "send-slot" })));
  setTimeout(() => { drawChips(); updateSend(); drawAttachments(); }, 0);
  return [h("div", { class: "modes-row" }, modes), box, h("div", { class: "hint" }, "Kleo can make mistakes. Everything is generated by AI models.")];
}
function autosize(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + "px"; }
function pickFiles() { $("#file")?.click(); }
function toggleAgent() {
  S.agent = !S.agent; store.set("agent", S.agent);
  $("#agent .switch").classList.toggle("on", S.agent);
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
  const s = S.settings = fix(S.settings, S.attachments.length);
  const m = model(s.model);
  const set = (ns) => { S.settings = fix(ns, S.attachments.length); store.set("settings", S.settings); drawChips(); updateSend(); };
  fill(box,
    h("button", { class: "chip model", onclick: () => openModelPicker(s, set) }, h("span", { class: "dot" }), m.name, icon("down", 14, 2.2)),
    s.imageRole === "first_frame" ? null : h("button", { class: "chip", onclick: () => openAspect(m.aspects, s.aspect, (a) => set({ ...s, aspect: a })) }, icon("frame", 16), s.aspect),
    h("button", { class: "chip", onclick: (e) => openMenu(e.currentTarget, durOptions(s), (v) => set({ ...s, duration: v })) }, icon("clock", 16), `${s.duration}s`),
    h("button", { class: "chip", onclick: (e) => openMenu(e.currentTarget, resOptions(s), (v) => set({ ...s, resolution: v })) }, icon("hd", 16), s.resolution),
    h("button", { class: "chip", title: s.audio ? "Sound on" : "Sound off", "aria-label": s.audio ? "Sound on" : "Sound off", onclick: () => set({ ...s, audio: !s.audio }) }, icon(s.audio ? "sound" : "mute", 16)));
}
function currentCost() { return S.mode === "image" ? iprice(ifix(S.imageSettings)) : price(fix(S.settings, S.attachments.length)); }
function currentLocked() { return S.mode === "image" ? !iallowed(ifix(S.imageSettings).model) : !allowed(fix(S.settings, S.attachments.length).model); }
function updateSend() {
  const slot = $("#send-slot"); if (!slot) return;
  const text = $("#prompt")?.value.trim() || "";
  const ready = (text || (S.attachments.length && S.mode === "video")) && !S.busy && !S.attachments.some((a) => !a.id);
  if (S.agent) {
    fill(slot, h("button", { class: "send", disabled: !ready, "aria-label": "Send", onclick: submit }, S.busy ? spinner(16) : icon("up", 20, 2.4)));
  } else {
    fill(slot, h("button", { class: "gen-btn", disabled: !ready, onclick: submit }, currentLocked() ? icon("lock", 15) : null, h("span", { class: "lbl-text" }, "Generate"), h("span", { class: "cost" }, bolt(14), currentCost())));
  }
}

// attachments
async function addFiles(files) {
  const room = 6 - S.attachments.length;
  if (room <= 0) return toast("Up to 6 pictures.", true);
  for (const f of files.slice(0, room)) {
    const a = { local: URL.createObjectURL(f), id: null };
    S.attachments.push(a); drawAttachments(); drawChips(); updateSend();
    try {
      const { blob, w, h: hh } = await shrink(f);
      const r = DEMO ? demoUpload(a.local) : await api("/api/uploads", { method: "POST", raw: blob, headers: { "content-type": blob.type, "x-width": String(w), "x-height": String(hh) } });
      a.id = r.id;
    } catch (e) {
      S.attachments = S.attachments.filter((x) => x !== a); handleError(e.message ? e : new Error("That picture couldn't be added."));
    }
    drawAttachments(); updateSend();
  }
  if (!IS_TOUCH) $("#prompt")?.focus();
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
function drawAttachments() {
  const box = $("#att"); if (!box) return;
  const one = S.attachments.length === 1;
  const s = fix(S.settings, S.attachments.length);
  const label = S.mode === "image" ? "Reference" : s.imageRole === "first_frame" ? "Start frame" : "Reference";
  fill(box, S.attachments.map((a) => h("div", { class: "thumb" },
    h("img", { src: a.local, alt: "" }),
    !a.id ? h("div", { class: "busy" }, h("span", { class: "spin" })) : null,
    a.id ? h("button", { class: "role", title: S.mode === "image" ? "The picture model edits or follows this picture" : one ? "Tap to switch: start frame or style reference" : "Used as reference", onclick: () => {
      if (S.mode === "image") return toast("The picture model edits or follows your pictures.");
      if (!one) return toast("With several pictures, Kleo uses them as references.");
      S.settings = fix({ ...S.settings, imageRole: s.imageRole === "first_frame" ? "reference" : "first_frame" }, 1); store.set("settings", S.settings);
      drawAttachments(); drawChips(); toast(S.settings.imageRole === "first_frame" ? "The video will start from this picture" : "The picture guides the look (character, product, style)");
    } }, label) : null,
    h("button", { class: "x", "aria-label": "Remove picture", onclick: () => { S.attachments = S.attachments.filter((x) => x !== a); drawAttachments(); drawChips(); updateSend(); } }, icon("x", 12, 3)))));
}

async function submit() {
  const t = $("#prompt");
  const text = t.value.trim();
  const img = S.mode === "image";
  if ((!text && (img || !S.attachments.length)) || S.busy || S.attachments.some((a) => !a.id)) return;
  const imageIds = S.attachments.map((a) => a.id);
  const settings = img ? ifix(S.imageSettings) : fix(S.settings, imageIds.length);
  if (!S.agent) {
    if (currentLocked()) return openLocked(img ? imodel(settings.model) : model(settings.model), img);
    if (S.me.credits < currentCost()) return openBuy(`This costs ${currentCost()} credits. You have ${S.me.credits}.`);
  }
  const atts = S.attachments.map((a) => ({ id: a.id, url: a.local }));
  S.busy = true; updateSend();
  const tempUser = { id: "tmp-u", role: "user", text, attachments: atts };
  const tempBot = { id: "tmp-b", role: "assistant", typing: true };
  S.messages.push(tempUser); if (S.agent) S.messages.push(tempBot);
  t.value = ""; autosize(t); t.placeholder = img ? "Describe your picture…" : "Describe your video…";
  S.attachments = []; drawAttachments(); drawChips();
  renderMessages(); scrollDown();
  try {
    const r = S.agent
      ? await api("/api/chat", { method: "POST", body: { chatId: S.chat?.id, text, imageIds, mode: S.mode, settings: fix(S.settings, imageIds.length), imageSettings: ifix(S.imageSettings) } })
      : await api("/api/generate", { method: "POST", body: { chatId: S.chat?.id, kind: S.mode, prompt: text, settings, imageIds } });
    S.messages = S.messages.filter((m) => m !== tempUser && m !== tempBot);
    for (const m of r.messages) { collectGens(m); if (m.role === "user" && atts.length && DEMO) m.attachments = atts; }
    S.messages.push(...r.messages);
    if (r.generation) { S.gens.set(r.generation.id, r.generation); watch(r.generation.id); setCredits(r.credits); }
    const isNew = !S.chat || S.chat.id !== r.chat.id;
    S.chat = r.chat; $("#title").textContent = r.chat.title || "";
    if (isNew) history.replaceState(null, "", `/c/${r.chat.id}${DEMO ? "?demo=1" : ""}`);
    S.chats = [r.chat, ...S.chats.filter((c) => c.id !== r.chat.id)];
    renderChats(); renderMessages(); scrollDown();
  } catch (e) {
    S.messages = S.messages.filter((m) => m !== tempUser && m !== tempBot);
    t.value = text; autosize(t);
    renderMessages(); handleError(e);
  } finally { S.busy = false; updateSend(); }
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
function openMenu(anchor, options, pick) {
  const rows = (menu) => options.map((o) => h("button", { class: "row", role: menu ? "menuitem" : null, onclick: () => { closeLayer(); pick(o.value); } },
    h("div", { class: "lbl" }, h("b", {}, o.label)), o.cost !== undefined ? h("span", { class: "val" }, bolt(13), o.cost) : null,
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
    const lockd = !isAllowed(m.key);
    return h("button", { class: "row" + (lockd ? " locked" : ""), onclick: () => (lockd ? openLocked(m, img) : (closeLayer(), onPick(m))) },
      h("div", { class: "lbl" }, h("b", {}, m.name, m.badge ? h("span", { class: "badge" }, m.badge) : null), h("span", {}, lockd ? "Unlocks with any credit pack" : m.blurb)),
      h("span", { class: "val" }, lockd ? icon("lock", 16) : [h("small", { style: { fontSize: "12px" } }, "from"), bolt(13), fromPrice(m)]),
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
    h("p", { class: "sheet-sub", style: { paddingTop: "10px" } }, "Secure checkout by Stripe: card, Apple Pay, Google Pay, PayPal. Your first pack unlocks every model.")];
}
function bigCredits(sub) { return h("div", { class: "big-credits" }, h("b", {}, bolt(34), h("span", { "data-credits": "" }, S.me.credits)), h("span", {}, sub)); }
function openBuy(note) { sheet("Get credits", null, bigCredits("credits left"), packRows(note)); }
function openAccount() {
  closeSide();
  const hasPass = S.me.methods?.includes("password");
  let revealed = false;
  const keyBox = h("div", { class: "keybox" }, "••••••••••••••••••••••••");
  const theme = store.get("theme", "system");
  const seg = h("div", { class: "seg" }, ["system", "light", "dark"].map((t) => h("button", { class: t === theme ? "on" : "", onclick: () => { store.set("theme", t); applyTheme(); openAccount(); } }, t[0].toUpperCase() + t.slice(1))));
  sheet("Account", S.me.email || "Signed in with a Kleo key",
    bigCredits(S.me.paid ? "credits · all models unlocked" : "credits · buy a pack to unlock every model"),
    packRows(),
    h("div", { class: "field-label" }, "Use Kleo in Claude & ChatGPT"),
    h("p", { class: "sheet-sub" }, "The same credits work in your AI assistant. Add Kleo as a connector with this address:"),
    h("div", { class: "list" },
      h("button", { class: "row", onclick: () => { navigator.clipboard.writeText(S.me.mcpUrl); toast("Address copied"); } }, icon("plug", 19), h("div", { class: "lbl" }, h("b", {}, S.me.mcpUrl)), icon("copy", 18)),
      h("button", { class: "row", onclick: () => {
        if (!revealed) { revealed = true; keyBox.textContent = S.me.kleoKey; return; }
        navigator.clipboard.writeText(S.me.kleoKey); toast("Kleo key copied — keep it private");
      } }, icon("key", 19), h("div", { class: "lbl" }, h("b", {}, "Kleo key"), h("span", {}, "Tap to show, tap again to copy. It signs in to your account.")))),
    keyBox,
    socialList().length ? [h("div", { class: "field-label" }, "Sign-in methods"), h("div", { class: "list" }, socialList().map((k) => {
      const on = S.me.methods?.includes(k);
      return h(on ? "div" : "a", { class: "row", href: on ? null : `/auth/${k}?link=1` }, SOCIAL[k].logo(), h("div", { class: "lbl" }, h("b", {}, SOCIAL[k].label), h("span", {}, on ? "Connected" : `Sign in with ${SOCIAL[k].label} next time`)),
        on ? h("span", { class: "check" }, icon("check", 18, 2.4)) : h("span", { class: "val" }, "Connect", icon("right", 16)));
    }))] : null,
    !hasPass ? [h("div", { class: "field-label" }, "E-mail and password"), addPasswordForm()] : null,
    h("div", { class: "field-label" }, "Appearance"), seg,
    h("div", { class: "list", style: { marginTop: "14px" } },
      h("button", { class: "row danger", onclick: signOut }, icon("out", 19), h("div", { class: "lbl" }, h("b", {}, "Sign out")))));
}
function addPasswordForm() {
  const e = h("input", { class: "input", type: "email", placeholder: "E-mail", autocomplete: "email" });
  const p = h("input", { class: "input", type: "password", placeholder: "Password (8+ characters)", autocomplete: "new-password" });
  return h("form", { style: { padding: "0 16px" }, onsubmit: async (ev) => {
    ev.preventDefault();
    try { await api("/api/auth/password", { method: "POST", body: { email: e.value, password: p.value } }); S.me = await api("/api/me"); toast("Done — you can now sign in with your e-mail"); openAccount(); }
    catch (er) { handleError(er); }
  } }, h("p", { class: "sheet-sub", style: { padding: "0 4px 10px" } }, "Add an e-mail and password so you can sign in anywhere."), e, p, h("button", { class: "btn btn-primary", style: { width: "100%" } }, "Save"));
}
async function signOut() {
  closeLayer();
  try { await api("/api/auth/signout", { method: "POST" }); } catch { /* the cookie goes anyway */ }
  S.me = null; S.chat = null; S.messages = []; watching.clear();
  history.replaceState(null, "", "/"); renderAuth("signin");
}
function applyTheme() {
  const t = store.get("theme", "system");
  if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
}

// ── gallery ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function showGallery() {
  S.view = "gallery"; S.chat = null; $("#title").textContent = "My creations"; $("#dock").style.display = "none";
  renderChats();
  const col = $("#col");
  fill(col, h("div", { class: "gallery-h" }, h("h1", {}, "My creations")), h("div", { class: "hero" }, h("span", { class: "spin dark", style: { margin: "0 auto" } })));
  try {
    const { generations } = await api("/api/generations?limit=100");
    for (const g of generations) { S.gens.set(g.id, g); if (g.status === "running") watch(g.id); }
    const shown = generations.filter((g) => g.status !== "failed");
    const nv = shown.filter((g) => g.status === "done" && g.kind !== "image").length;
    const np = shown.filter((g) => g.status === "done" && g.kind === "image").reduce((a, g) => a + g.outputs.length, 0);
    fill(col, h("div", { class: "gallery-h" }, h("h1", {}, "My creations"), h("span", {}, `${nv} videos · ${np} pictures`)),
      shown.length ? h("div", { class: "grid" }, shown.map(tileEl))
        : h("div", { class: "empty-gallery" }, h("b", {}, "Nothing here yet"), "Everything you generate lands here.", h("div", { style: { marginTop: "18px" } }, h("button", { class: "btn btn-primary", onclick: () => go("/") }, icon("sparkle", 18), "Make your first one"))));
  } catch (e) { handleError(e); }
}
function tileEl(g) {
  if (g.status === "running") return h("div", { class: "tile", "data-tile": g.id }, h("div", { class: "shimmer" }), h("div", { class: "cap" }, h("span", {}, "Generating…"), h("span", { class: "spin", style: { width: "14px", height: "14px" } })));
  if (g.status === "failed") return h("div", { class: "tile failed", "data-tile": g.id }, "Couldn't be made · refunded");
  if (g.kind === "image") {
    const o = g.outputs[0];
    return h("button", { class: "tile", "data-tile": g.id, onclick: () => viewPicture(g, o) },
      h("img", { src: o.url, alt: "", loading: "lazy" }), g.outputs.length > 1 ? h("span", { class: "count" }, icon("layers", 13, 2.2), g.outputs.length) : null,
      h("div", { class: "cap" }, h("span", {}, g.prompt), h("span", {}, g.settings?.aspect || "")));
  }
  const v = h("video", { src: g.video + "#t=0.05", muted: true, playsinline: true, loop: true, preload: "metadata" });
  v.muted = true;
  return h("button", { class: "tile", "data-tile": g.id, onclick: () => viewVideo(g), onmouseenter: () => v.play().catch(() => {}), onmouseleave: () => v.pause() },
    v, h("span", { class: "count" }, icon("play", 12, 2.4)), h("div", { class: "cap" }, h("span", {}, g.prompt), h("span", {}, `${g.settings?.duration || ""}s`)));
}
function viewerFrame(media, prompt, actions) {
  closeLayer();
  const box = h("div", { class: "viewer", role: "dialog", "aria-modal": "true" },
    h("button", { class: "icon-btn vclose", "aria-label": "Close", onclick: closeLayer }, icon("x", 20, 2.2)), media,
    h("p", { class: "vprompt" }, prompt), h("div", { class: "vactions" }, actions));
  box.addEventListener("click", (e) => { if (e.target === box) closeLayer(); });
  document.body.append(box); openLayer = [box];
  document.addEventListener("keydown", escClose);
}
function viewVideo(g) {
  viewerFrame(h("video", { src: g.video, controls: true, autoplay: true, playsinline: true, loop: true }), g.prompt, [
    h("a", { class: "btn btn-quiet btn-sm", href: DEMO ? g.video : `${g.video}?dl=1`, download: `kleo-${g.id}.mp4` }, icon("dl", 17), "Download"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => share(g) }, icon("share", 17), "Share"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => { closeLayer(); remix(g); } }, icon("wand", 17), "Remix")]);
}
function viewPicture(g, o) {
  viewerFrame(h("img", { src: o.url, alt: g.prompt.slice(0, 80) }), g.prompt, [
    h("button", { class: "btn btn-primary btn-sm", onclick: () => animate(o) }, icon("play", 16), "Animate"),
    h("a", { class: "btn btn-quiet btn-sm", href: DEMO ? o.url : `${o.url}?dl=1`, download: `kleo-${o.upload}.jpg` }, icon("dl", 17), "Download"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => share(g, o) }, icon("share", 17), "Share"),
    h("button", { class: "btn btn-quiet btn-sm", onclick: () => { setMode("image"); useAsReference(o); } }, icon("layers", 17), "Use as reference")]);
}

// ── demo mode (?demo=1): the whole app on fake data, no account, nothing charged ─────────────────────────────────
const demoUploads = new Map();
const demoDb = { chats: [], messages: new Map(), gens: new Map(), credits: 42, n: 0 };
const SAMPLES = ["https://kleooai.com/samples/shot-dunes.mp4", "https://kleooai.com/samples/realistic-tether.mp4", "https://kleooai.com/samples/animation-octopus.mp4", "https://kleooai.com/samples/shot-moon.mp4"];
const STILLS = ["https://kleooai.com/samples/realistic-tether.jpg", "https://kleooai.com/samples/shot-moon.jpg", "https://kleooai.com/samples/animation-octopus.jpg", "https://kleooai.com/samples/shot-dunes.jpg"];
function demoUpload(url) { const id = "up_demo" + (++demoDb.n); demoUploads.set(id, url); return { id }; }
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
  ["nano-banana-2", "Nano Banana 2", "Fast Google model, great value", null, ["1K", "2K", "4K"], "2K", { "1K": [1, 1, 1], "2K": [1, 1, 1], "4K": [1, 1, 2] }],
  ["seedream-5", "Seedream 5.0", "ByteDance, sharp and detailed", "Cheapest", ["2K"], "2K", { "2K": [1, 1, 1] }],
  ["flux-2-pro", "FLUX.2 Pro", "Photoreal, natural light", null, ["1K"], "1K", { "1K": [1, 1, 1] }],
].map(([key, name, blurb, badge, qualities, dq, pr]) => ({
  key, name, blurb, badge, qualities, defaultQuality: dq, aspects: ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"], maxReferences: 14, free: key !== "nano-banana-pro", counts: [1, 2, 4],
  prices: Object.fromEntries(qualities.map((q) => [q, { 1: pr[q][0], 2: pr[q][1], 4: pr[q][2] }])),
}));
async function demoApi(path, opts) {
  await new Promise((r) => setTimeout(r, path === "/api/chat" ? 1100 : 150));
  const method = opts.method || "GET", b = opts.body || {};
  const now = () => new Date().toISOString();
  if (path === "/api/config") return { google: true, microsoft: true, social: ["google", "microsoft"], emailReset: true, defaultModel: "seedance-2.5", models: demoCatalog(), defaultImageModel: "nano-banana-2", imageModels: demoImageCatalog(), freeCredits: 5 };
  if (path === "/api/me") return { id: "u_demo", email: "you@example.com", credits: demoDb.credits, paid: true, allowed: demoCatalog().map((m) => m.key), allowedImages: demoImageCatalog().map((m) => m.key), methods: ["password", "google"], kleoKey: "u_demo.0123456789abcdef0123456789abcdef", mcpUrl: "https://mcp.kleooai.com/mcp", packs: [{ label: "5 EUR", credits: 10, url: "https://kleooai.com/pricing/" }, { label: "15 EUR", credits: 35, url: "https://kleooai.com/pricing/" }, { label: "40 EUR", credits: 100, url: "https://kleooai.com/pricing/" }] };
  if (path === "/api/auth/signout") return { ok: true };
  if (path === "/api/chats" && method === "GET") return { chats: demoDb.chats };
  const cm = path.match(/^\/api\/chats\/(c_\w+)$/);
  if (cm) { if (method === "DELETE") { demoDb.chats = demoDb.chats.filter((c) => c.id !== cm[1]); return { ok: true }; } const chat = demoDb.chats.find((c) => c.id === cm[1]); if (!chat) throw new ApiError("Chat not found.", 404); return { chat, messages: demoDb.messages.get(chat.id) }; }
  const ensureChat = (title) => {
    let chat = demoDb.chats.find((c) => c.id === b.chatId);
    if (!chat) { chat = { id: "c_demo" + (++demoDb.n), title: title.slice(0, 40) || "New chat", updated_at: now() }; demoDb.chats.unshift(chat); demoDb.messages.set(chat.id, []); }
    return chat;
  };
  const newGen = (kind, prompt, settings, chatId) => {
    const img = kind === "image";
    const m = img ? demoImageCatalog().find((x) => x.key === settings.model) : demoCatalog().find((x) => x.key === settings.model);
    const credits = img ? m.prices[settings.quality][settings.count] : m.prices[settings.resolution][settings.duration];
    const g = { id: "g_demo" + (++demoDb.n), kind, model: m.key, modelName: m.name, settings, prompt, credits, status: "running", chatId, createdAt: now(), video: null, outputs: [], count: img ? settings.count : 1, doneAt: Date.now() + (img ? 4000 : 7000) };
    demoDb.credits -= credits; demoDb.gens.set(g.id, g); return g;
  };
  if (path === "/api/chat") {
    const chat = ensureChat(b.text);
    const u = { id: "m_u" + (++demoDb.n), role: "user", text: b.text, attachments: (b.imageIds || []).map((id) => ({ id, url: demoUploads.get(id) })) };
    let p, reply;
    if (b.mode === "image") {
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
        const g = newGen(kind, b.prompt || m.proposal.prompt, kind === "image" ? ifix(b.settings || m.proposal.settings) : fix(b.settings || m.proposal.settings), cid);
        m.generations = [...(m.generations || []), g];
        return { chat: demoDb.chats.find((c) => c.id === cid), generation: g, credits: demoDb.credits, messages: [m] };
      }
    }
    const chat = ensureChat(b.prompt);
    const u = { id: "m_u" + (++demoDb.n), role: "user", text: b.prompt };
    const g = newGen(b.kind === "image" ? "image" : "video", b.prompt, b.kind === "image" ? ifix(b.settings) : fix(b.settings, (b.imageIds || []).length), chat.id);
    const bot = { id: "m_b" + (++demoDb.n), role: "assistant", text: "", generation: g };
    demoDb.messages.get(chat.id).push(u, bot);
    return { chat, generation: g, credits: demoDb.credits, messages: [u, bot] };
  }
  const gm = path.match(/^\/api\/generations\/(g_\w+)$/);
  if (gm) {
    const g = demoDb.gens.get(gm[1]);
    if (g.status === "running" && Date.now() > g.doneAt) {
      g.status = "done";
      if (g.kind === "image") g.outputs = Array.from({ length: g.count }, (_, i) => { const url = STILLS[(demoDb.n + i) % STILLS.length]; const up = demoUpload(url); return { upload: up.id, url }; });
      else g.video = SAMPLES[demoDb.n % SAMPLES.length];
    }
    return { generation: { ...g }, credits: demoDb.credits };
  }
  if (path.startsWith("/api/generations")) return { generations: [...demoDb.gens.values()].reverse() };
  throw new ApiError("Not in the demo.", 404);
}
if (DEMO) {
  // Seed one finished conversation so the demo opens on something real.
  const s = { model: "seedance-2.5", duration: 5, resolution: "720p", aspect: "16:9", audio: true, imageRole: "none" };
  const g = { id: "g_demo0", kind: "video", model: "seedance-2.5", modelName: "Seedance 2.5", settings: s, prompt: "A lone rider crosses golden dunes at sunset, wind lifting sand into the light, wide drone shot slowly pushing in, warm cinematic grade, soft desert wind sound.", credits: 4, status: "done", chatId: "c_demo0", createdAt: new Date(Date.now() - 3600e3).toISOString(), video: SAMPLES[0], outputs: [] };
  demoDb.gens.set(g.id, g);
  demoDb.chats.push({ id: "c_demo0", title: "Desert rider at sunset", updated_at: new Date(Date.now() - 3600e3).toISOString() });
  demoDb.messages.set("c_demo0", [
    { id: "m_d1", role: "user", text: "un cavaliere nel deserto al tramonto, molto cinematografico" },
    { id: "m_d2", role: "assistant", text: "Bellissima idea! Ecco come lo girerei: drone largo, luce dorata, sabbia nel vento. Premi Genera quando vuoi.", proposal: { kind: "video", title: "Cavaliere nel deserto", prompt: g.prompt, settings: s, credits: 4, imageIds: [] }, generations: [g] },
  ]);
}

boot();
