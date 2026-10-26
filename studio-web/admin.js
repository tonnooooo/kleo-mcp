// Kleo Studio — the admin console (app.kleooai.com/admin, 23 October 2026). app.js loads this module only when an
// admin opens /admin, and hands it the app's own helpers (the kit): the element builder, the icons, toasts, sheets and
// the ask() questions, never a browser pop-up. API: src/studio/admin.ts. With ?demo=1 everything runs on fake data.
//
// Pages: Overview · Users (and one account) · Sources · Emails · Outreach · Payments · Creations · Providers & keys ·
// Security. Desktop: a
// side list of pages; phones: the same pages as a row of pills.
//
// The console opens with a second factor (src/studio/admin-auth.ts): the first visit sets up a code on the owner's phone
// (a QR code drawn by qr.js, on this origin), every later visit asks for the 6-digit code, and the dangerous actions
// ask for a new one.

import { qrSvg } from "./qr.js?v=83";

let K = null;
const DEMO_MODE = new URLSearchParams(location.search).get("demo");
/** Whether this page load has an open admin session (the server says so; a 401 closes it again). */
const GATE = { open: false };
const SECTIONS = [
  { key: "overview", label: "Overview", ic: "grid" },
  { key: "users", label: "Users", ic: "user" },
  { key: "sources", label: "Sources", ic: "share" },
  { key: "emails", label: "Emails", ic: "mail" },
  { key: "outreach", label: "Outreach", ic: "send" },
  { key: "payments", label: "Payments", ic: "bag" },
  { key: "creations", label: "Creations", ic: "film" },
  { key: "providers", label: "Providers", ic: "plug" },
  { key: "keys", label: "API keys", ic: "key" },
  { key: "security", label: "Security", ic: "lock" },
];
const h = (...a) => K.h(...a);
const icon = (...a) => K.icon(...a);
// The console's own fetch: the app's header and cookie, plus two answers of its own. An admin session that ended (401
// admin_signin or admin_enroll) brings back the code screen; a redirect means Cloudflare Access, when the owner put it in
// front of /admin (docs/ADMIN-SECURITY.md), wants its own sign-in again.
class AdminError extends Error { constructor(msg, status, code, data = {}) { super(msg); this.status = status; this.code = code; this.data = data; } }
async function call(path, opts = {}) {
  if (K.DEMO) return demo(path, opts);
  const init = { method: opts.method || "GET", headers: { "x-kleo": "1" }, credentials: "same-origin", redirect: "manual" };
  // A read made by the page refreshing itself, not by the owner: it never keeps the console's session open (admin.ts).
  if (LIVE.auto && init.method === "GET") init.headers["x-kleo-auto"] = "1";
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["content-type"] = "application/json"; }
  let res;
  try { res = await fetch(path, init); } catch { throw new AdminError("You seem to be offline.", 0, "offline"); }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new AdminError("Your Cloudflare Access sign-in has ended. Reload the page to sign in again.", 401, "access");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AdminError(data.error || "Something went wrong.", res.status, data.code, data);
  return data;
}
/** What every page does with an error: back to the code screen when the admin session ended, else the app's toast. */
function oops(e) {
  if (e?.code === "admin_signin" || e?.code === "admin_enroll") { GATE.open = false; render(K); return; }
  K.handleError(e);
}
/** A code from the phone, asked in the app's own sheet; null when cancelled. */
async function askCode(title, text) {
  const v = await K.ask({ title, text, ok: "Confirm", ic: "lock",
    fields: [{ key: "code", label: "6-digit code", placeholder: "123456", inputmode: "numeric", autocomplete: "one-time-code", required: true }] });
  return v ? v.code : null;
}
/** A write that may want a fresh code: asked for, then the write is sent again with it. */
async function postFresh(path, body) {
  try { return await call(path, { method: "POST", body }); }
  catch (e) {
    if (e?.code !== "fresh_code") throw e;
    const code = await askCode("Type a new code", "This action needs a code from your phone, typed now.");
    if (!code) throw new AdminError("Cancelled.", 0, "dismissed");
    return call(path, { method: "POST", body: { ...body, code } });
  }
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────────────────────────
const toDate = (iso) => new Date(String(iso).endsWith("Z") ? iso : `${iso}Z`);
function money(cents, cur = "eur") {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: String(cur || "eur").toUpperCase() }).format((Number(cents) || 0) / 100); }
  catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${String(cur).toUpperCase()}`; }
}
const usd = (n) => `$${(Number(n) || 0).toFixed(Math.abs(Number(n) || 0) >= 1000 ? 0 : 2)}`;
const num = (n) => new Intl.NumberFormat("en-GB").format(Number(n) || 0);
/** "1 credit", "3 credits". */
const count = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;
function day(iso, withYear = false) {
  if (!iso) return "—";
  const d = toDate(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear || d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
function stamp(iso) {
  if (!iso) return "—";
  const d = toDate(iso);
  return `${day(iso)}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - toDate(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return Math.floor(s / 86400) === 1 ? "yesterday" : `${Math.floor(s / 86400)} days ago`;
  return day(iso);
}
const FLAGS = !/Windows/.test(navigator.userAgent);
const flag = (cc) => (FLAGS && /^[A-Z]{2}$/i.test(cc || "") && !/^(XX|T1)$/i.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");
function countryName(cc) {
  if (!cc) return null;
  if (/^T1$/i.test(cc)) return "Tor network";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(cc.toUpperCase()) || cc; } catch { return cc; }
}
const place = (o) => [o.city, o.region && o.region !== o.city ? o.region : null, countryName(o.country)].filter(Boolean).join(", ");
const shortUa = (ua) => {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  return [os, br].filter(Boolean).join(" · ") || ua.slice(0, 40);
};
const who = (u) => u.name || u.email || u.id;
const PROVIDER = { ephone: "ePhone", wavespeed: "WaveSpeed", apimart: "APIMart", "kleo-mcp": "Kleo films" };
const KIND = { video: "Video", image: "Picture", tool: "App", film: "Film" };
const modelName = (m) => (K.nameOf ? K.nameOf(m) : m) || m;

// ── building blocks ──────────────────────────────────────────────────────────────────────────────────────────────
const pill = (text, tone = "") => h("span", { class: `adm-pill ${tone}` }, text);
const statusPill = (s) => pill(s === "done" ? "Done" : s === "failed" ? "Failed" : "Running", s === "done" ? "ok" : s === "failed" ? "bad" : "info");
const payPill = (s) => pill(s === "paid" ? "Paid" : s === "refunded" ? "Refunded" : s === "disputed" ? "Disputed" : s, s === "paid" ? "ok" : "bad");
function head(title, sub, ...actions) {
  return h("header", { class: "adm-head" }, h("div", { class: "adm-head-t" }, h("h1", {}, title), sub ? h("p", {}, sub) : null), actions.length ? h("div", { class: "adm-head-a" }, actions) : null);
}
const card = (title, sub, ...kids) => h("section", { class: "adm-card" }, title ? h("h2", {}, title) : null, sub ? h("p", { class: "adm-sub" }, sub) : null, ...kids);
const tile = (label, value, sub, tone = "") => h("div", { class: `adm-tile ${tone}` }, h("span", { class: "adm-tile-l" }, label), h("b", {}, value), sub ? h("span", { class: "adm-tile-s" }, sub) : null);
const tiles = (...t) => h("div", { class: "adm-tiles" }, t);
const cap = (t) => (t ? String(t)[0].toUpperCase() + String(t).slice(1) : t);
const empty = (text) => h("div", { class: "adm-empty" }, text);
const loading = () => h("div", { class: "adm-loading" }, K.spinner(24));
const kv = (rows) => h("dl", { class: "adm-kv" }, rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== "").map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
const avatar = (u) => h("span", { class: "adm-av" }, String(who(u) || "K")[0].toUpperCase());
function copyBtn(text, label = "Copy") {
  return h("button", { class: "icon-btn adm-copy", "aria-label": label, title: label, onclick: (e) => { e.stopPropagation(); navigator.clipboard?.writeText(text); K.toast("Copied"); } }, icon("copy", 16));
}
const refreshBtn = (fn) => h("button", { class: "btn btn-quiet btn-sm", onclick: fn }, icon("redo", 16), "Refresh");
function failed(box, e, retry) {
  if (LIVE.auto) LIVE.failed = true; // a refresh that failed keeps what is on screen (live() below)
  K.fill(box, card("This didn't load", e?.message || "Something went wrong.", h("button", { class: "btn btn-primary btn-sm", onclick: retry }, icon("redo", 16), "Try again")));
  if (e?.code === "signin" || e?.code === "admin_signin" || e?.code === "admin_enroll") oops(e);
}

// ── live: every page keeps itself up to date (23 October 2026, the owner: "la pagina admin deve aggiornarsi in
// automatico, deve dire dati reali") ─────────────────────────────────────────────────────────────────────────────
// Every LIVE_MS the page on screen is built again off screen and swapped in only when its data arrived, so nothing
// flickers and a failed refresh leaves the last good figures up. It waits while the tab is hidden, while a sheet or a
// question is open, while the owner types or selects text, and after "Show more" (that list would shrink back). Its
// reads carry X-Kleo-Auto, so a console left open still closes after 30 idle minutes (src/studio/admin.ts).
const LIVE_MS = 20_000;
const LIVE = { timer: 0, clock: 0, run: null, at: 0, busy: false, failed: false, auto: false, hold: false };
function liveStart(run) {
  LIVE.run = run; LIVE.at = Date.now(); LIVE.failed = false; LIVE.hold = false;
  clearInterval(LIVE.timer); clearInterval(LIVE.clock);
  LIVE.timer = setInterval(() => live(false), LIVE_MS);
  LIVE.clock = setInterval(liveLabel, 5_000);
  liveLabel();
}
function liveStop() { clearInterval(LIVE.timer); clearInterval(LIVE.clock); LIVE.run = null; }
function liveWaits() {
  if (document.hidden || LIVE.hold) return true;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest(".adm-main")) return true;
  if (document.querySelector(".layer, .sheet, [role=dialog]")) return true;
  return !!window.getSelection?.()?.toString();
}
async function live(now) {
  const main = document.querySelector(".adm-main");
  if (!main || !GATE.open || !LIVE.run) { if (!main) liveStop(); return; }
  if (LIVE.busy || (!now && liveWaits())) return;
  const run = LIVE.run, stage = h("div");
  LIVE.busy = true; LIVE.failed = false; LIVE.auto = !now;
  try { await run(stage); } catch { LIVE.failed = true; }
  LIVE.busy = false; LIVE.auto = false;
  if (run !== LIVE.run || !GATE.open || !main.isConnected) return; // the page changed meanwhile
  if (!LIVE.failed && !(!now && liveWaits())) {
    const y = window.scrollY;
    main.replaceChildren(...stage.childNodes);
    window.scrollTo(0, y);
    LIVE.at = Date.now();
  }
  liveLabel();
}
function liveLabel() {
  const el = document.querySelector(".adm-live-t");
  if (!el) return;
  const s = Math.round((Date.now() - LIVE.at) / 1000);
  el.textContent = LIVE.failed ? "Couldn't update" : s < 10 ? "Live · just updated" : s < 60 ? `Live · ${s} s ago` : `Live · ${Math.floor(s / 60)} min ago`;
  el.parentElement?.classList.toggle("bad", LIVE.failed);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && LIVE.run && Date.now() - LIVE.at > 5_000) live(false); });
function chips(options, current, pick) {
  return h("div", { class: "adm-chips", role: "tablist" }, options.map(([k, label]) =>
    h("button", { class: "chip" + (k === current ? " on" : ""), role: "tab", "aria-selected": String(k === current), onclick: () => pick(k) }, label)));
}
function seg(options, current, pick) {
  return h("div", { class: "seg2 adm-seg" }, options.map(([k, label]) => h("button", { class: k === current ? "on" : "", onclick: () => pick(k) }, label)));
}
function mediaEl(o, controls = false) {
  if (!o) return null;
  if (o.type === "video") {
    const v = h("video", { src: controls ? o.url : `${o.url}#t=0.1`, playsinline: "", preload: "metadata", loop: "", ...(controls ? { controls: "" } : {}) });
    v.muted = !controls;
    if (!controls) { v.addEventListener("mouseenter", () => v.play().catch(() => {})); v.addEventListener("mouseleave", () => v.pause()); }
    return v;
  }
  if (o.type === "audio") return controls ? h("audio", { src: o.url, controls: "" }) : h("div", { class: "adm-gen-ph" }, icon("music", 28));
  return h("img", { src: o.url, alt: "", loading: "lazy", decoding: "async" });
}

// ── the frame ────────────────────────────────────────────────────────────────────────────────────────────────────
export function render(kit) {
  K = kit;
  if (!GATE.open) { gate(); return; }
  const [, , section = "overview", id] = location.pathname.split("/");
  const key = SECTIONS.some((s) => s.key === section) ? section : "overview";
  const nav = h("nav", { class: "adm-nav", "aria-label": "Admin pages" },
    h("div", { class: "adm-brand" }, icon("grid", 18), "Admin"),
    SECTIONS.map((s) => h("button", { class: "adm-link" + (s.key === key ? " on" : ""), "aria-current": s.key === key ? "page" : null, onclick: () => K.go(s.key === "overview" ? "/admin" : `/admin/${s.key}`) }, icon(s.ic, 18), s.label)),
    h("button", { class: "adm-live", title: "Update now", onclick: () => live(true) }, h("i", { class: "adm-live-dot" }), h("span", { class: "adm-live-t" }, "Live")));
  const main = h("div", { class: "adm-main" });
  K.setView("admin-view", h("div", { class: "adm" }, nav, main));
  const pages = { overview: overviewPage, users: id ? (m, o) => userPage(m, id, o) : usersPage, sources: sourcesPage, emails: emailsPage, outreach: outreachPage, payments: paymentsPage, creations: creationsPage, providers: providersPage, keys: keysPage, security: securityPage };
  pages[key](main);
  // The same page, built again off screen every LIVE_MS (live() above).
  liveStart((into) => pages[key](main, { into }));
}
const openUser = (id) => K.go(`/admin/users/${id}`);

// ── the door: setting up the code, then the code at every visit ─────────────────────────────────────────────────
const LOST_PHONE = [
  "Open the console with one of your recovery codes instead of the 6-digit code. Each works once.",
  "In Security, make new recovery codes, and keep them in iPhone Passwords (a note on the Kleo entry).",
  "To move the code to a new phone, ask for a reset: the second factor is reset from a terminal, never from this page (docs/ADMIN-SECURITY.md in kleo-mcp). Then open /admin and set it up again.",
  "No recovery code left and no phone: the same reset from a terminal is the way back in.",
];
function gateFrame(title, sub, ...kids) {
  K.setView("admin-view", h("div", { class: "adm-gate" }, h("div", { class: "adm-gate-card" },
    h("div", { class: "adm-gate-ic" }, icon("lock", 28, 2)), h("h1", {}, title), sub ? h("p", { class: "adm-gate-sub" }, sub) : null, ...kids)));
}
async function gate() {
  K.setView("admin-view", h("div", { class: "adm-gate" }, loading()));
  let st;
  try { st = await call("/api/admin/auth"); }
  catch (e) {
    gateFrame("The console didn't open", e?.message || "Something went wrong.", h("button", { class: "btn btn-primary adm-gate-btn", onclick: () => gate() }, "Try again"));
    if (e?.code === "signin") K.handleError(e);
    return;
  }
  if (st.signedIn) { GATE.open = true; render(K); return; }
  if (!st.enrolled) enrollStart(st); else signinScreen(st);
}
function signinScreen(st) {
  let recovery = false;
  const input = h("input", { class: "input adm-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456", "aria-label": "Code", spellcheck: "false" });
  const err = h("p", { class: "adm-gate-err", role: "alert" });
  const go = h("button", { class: "btn btn-primary adm-gate-btn" }, "Open the console");
  const swap = h("button", { class: "adm-a adm-gate-link" }, "Use a recovery code");
  const submit = async () => {
    const code = input.value.trim();
    if (!code || go.disabled) return;
    go.disabled = true; err.textContent = "";
    try { await call("/api/admin/auth/signin", { method: "POST", body: { code } }); GATE.open = true; K.toast("Console open"); render(K); return; }
    catch (e) {
      if (e?.code === "admin_locked") { gateFrame("The console is locked", e.message, lostLink()); return; }
      err.textContent = e?.data?.left ? `${e.message} ${e.data.left} ${e.data.left === 1 ? "try" : "tries"} left before it locks for 15 minutes.` : e?.message || "That didn't work.";
      input.select();
    }
    go.disabled = false;
  };
  input.addEventListener("input", () => { if (!recovery && /^\d{6}$/.test(input.value.trim())) submit(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  go.addEventListener("click", submit);
  swap.addEventListener("click", () => {
    recovery = !recovery;
    Object.assign(input, { value: "", placeholder: recovery ? "abcd-efgh-jkmn" : "123456", maxLength: recovery ? 16 : 6, inputMode: recovery ? "text" : "numeric", autocomplete: recovery ? "off" : "one-time-code" });
    swap.textContent = recovery ? "Use the code from my phone" : "Use a recovery code";
    input.focus();
  });
  if (st.lockedMinutes) { gateFrame("The console is locked", `Too many wrong codes. Try again in ${st.lockedMinutes} ${st.lockedMinutes === 1 ? "minute" : "minutes"}.`, lostLink()); return; }
  gateFrame("Admin console", "Type the 6-digit code for “Kleo admin” from the Passwords app on your iPhone.", input, err, go, h("div", { class: "adm-gate-links" }, swap, lostLink()));
  setTimeout(() => input.focus(), 50);
}
const lostLink = () => h("button", { class: "adm-a adm-gate-link", onclick: () => K.sheet("Lost your phone?", null, h("ol", { class: "adm-steps" }, LOST_PHONE.map((t) => h("li", {}, t)))) }, "Lost your phone?");

function enrollStart(st) {
  const pw = st.hasPassword ? h("input", { class: "input", type: "password", placeholder: "Your Kleo password", autocomplete: "current-password", "aria-label": "Password" }) : null;
  const err = h("p", { class: "adm-gate-err", role: "alert" });
  const go = h("button", { class: "btn btn-primary adm-gate-btn" }, "Continue");
  const submit = async () => {
    if (go.disabled) return;
    go.disabled = true; err.textContent = "";
    try { enrollCode(await call("/api/admin/auth/enroll", { method: "POST", body: { password: pw?.value ?? "" } })); return; }
    catch (e) { if (e?.code === "admin_locked") { gateFrame("The console is locked", e.message); return; } err.textContent = e?.message || "That didn't work."; }
    go.disabled = false;
  };
  pw?.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  go.addEventListener("click", submit);
  gateFrame("Set up the admin console", "Once only: a 6-digit code from your iPhone will open the console from now on. First, prove it's you.",
    pw ? [h("p", { class: "adm-gate-note" }, "Type your Kleo password again. An admin password needs at least 14 characters, and can't contain your e-mail or name."), pw]
      : h("p", { class: "adm-gate-note" }, "Sign out, sign in with Google again, and come back here within 5 minutes."),
    err, go);
  setTimeout(() => pw?.focus(), 50);
}
function enrollCode(r) {
  const input = h("input", { class: "input adm-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456", "aria-label": "Code" });
  const err = h("p", { class: "adm-gate-err", role: "alert" });
  const go = h("button", { class: "btn btn-primary adm-gate-btn" }, "Finish set-up");
  const submit = async () => {
    if (go.disabled) return;
    go.disabled = true; err.textContent = "";
    try { const done = await call("/api/admin/auth/enroll/confirm", { method: "POST", body: { code: input.value.trim() } }); showRecovery(done.recovery, true); return; }
    catch (e) { err.textContent = e?.message || "That didn't work."; }
    go.disabled = false;
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  go.addEventListener("click", submit);
  const grouped = r.secret.match(/.{1,4}/g).join(" ");
  gateFrame("Add the code to your iPhone", null,
    h("ol", { class: "adm-steps" },
      h("li", {}, "On your iPhone, open Passwords, then Codes, then the + button, and scan this QR code. Save it on the entry of your Kleo password."),
      h("li", {}, "Type the 6-digit code it shows.")),
    h("div", { class: "adm-qr", html: qrSvg(r.uri) }),
    h("div", { class: "adm-secret" }, h("span", {}, "Or type this set-up key by hand"), h("b", { class: "mono" }, grouped), copyBtn(r.secret, "Copy the set-up key")),
    input, err, go);
}
function showRecovery(codes, firstTime) {
  const text = `Kleo admin console — recovery codes\nEach one opens the console once, instead of the code from your phone.\n\n${codes.join("\n")}\n`;
  const file = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const body = [
    h("div", { class: "adm-recovery" }, codes.map((c) => h("b", { class: "mono" }, c))),
    h("div", { class: "adm-actions" },
      h("button", { class: "btn btn-quiet", onclick: () => { navigator.clipboard?.writeText(text); K.toast("Recovery codes copied"); } }, icon("copy", 17), "Copy all"),
      h("a", { class: "btn btn-quiet", href: file, download: "kleo-admin-recovery-codes.txt" }, icon("dl", 17), "Download")),
  ];
  if (!firstTime) { K.sheet("New recovery codes", "Save them now: they are shown only this once. The old ones no longer work.", h("div", { class: "adm-sheet-body" }, body)); return; }
  gateFrame("Save your recovery codes", "They open the console if you lose your phone, each one once. They are shown only now: keep them in iPhone Passwords, in the notes of your Kleo entry.",
    ...body, h("button", { class: "btn btn-primary adm-gate-btn", onclick: () => { GATE.open = true; K.toast("The console is set up"); render(K); } }, "I've saved them"));
}

// ── Security ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SECURITY_EVENTS = { "admin.signin": "Console opened", "admin.code_wrong": "Wrong code", "admin.locked": "Console locked", "admin.2fa_enrolled": "Phone set up",
  "admin.recovery_used": "Recovery code used", "admin.recovery_renewed": "New recovery codes", "admin.signout_sessions": "Console signed out everywhere" };
const HOW_TO = [
  "On your own computer, open admin.kleooai.com in Chrome (bookmark it). It opens only where your Kleo admin certificate is installed: anywhere else it says Forbidden.",
  "If Chrome asks which certificate to use, pick “Kleo admin”.",
  "Sign in with your e-mail and your Kleo password. Keep the password in iPhone Passwords (and let Chrome fill it in).",
  "Type the 6-digit code for “Kleo admin” from the Passwords app on your iPhone (Codes). It changes every 30 seconds.",
  "The console stays open 30 minutes without use, 12 hours at most. Deleting or closing an account, a big credit change, a new key and signing someone out ask for a new code.",
  "Every sign-in to the console sends an e-mail to kleooai@gmail.com with the address, place and device. If one wasn't you, change your password and ask for a reset of the code.",
];
async function securityPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("Security", "How the console is locked, and who opened it.", refreshBtn(() => securityPage(main))), body);
  let r;
  try { r = await call("/api/admin/security"); } catch (e) { return failed(body, e, () => securityPage(main)); }
  const signout = async (everywhere) => {
    if (everywhere && !(await K.ask({ title: "Sign the console out everywhere?", text: "Every browser with the console open has to type a code again, this one included.", ok: "Sign out", ic: "out" }))) return;
    try { await call("/api/admin/auth/signout", { method: "POST", body: { everywhere } }); } catch (e) { return oops(e); }
    GATE.open = false; K.toast("Console signed out"); render(K);
  };
  const newCodes = async () => {
    const code = await askCode("Make new recovery codes?", "The old ones stop working. Type a code from your phone to go on.");
    if (!code) return;
    try { const x = await call("/api/admin/auth/recovery", { method: "POST", body: { code } }); showRecovery(x.recovery, false); securityPage(main); }
    catch (e) { oops(e); }
  };
  const methods = { password: "E-mail and password", google: "Google", microsoft: "Microsoft", apple: "Apple" };
  K.fill(body,
    card("This console session", `It ends after ${r.idleMinutes} minutes without use and after ${r.maxHours} hours at most. The dangerous actions want a code typed in the last ${r.freshMinutes} minutes.`,
      kv([["Opened", stamp(r.session.issued)], ["Last used", ago(r.session.seen)], ["Last code", ago(r.session.fresh)], ["Phone set up", stamp(r.enrolledAt)]]),
      h("div", { class: "adm-actions" },
        h("button", { class: "btn btn-quiet", onclick: () => signout(false) }, icon("out", 17), "Sign out of the console"),
        h("button", { class: "btn btn-quiet", onclick: () => signout(true) }, icon("out", 17), "Sign out everywhere"))),
    card("Recovery codes", `${count(r.recoveryLeft, "code")} of 10 left. Each one opens the console once if your phone is lost.`,
      r.recoveryLeft <= 3 ? h("div", { class: "adm-note bad" }, icon("key", 17), "Few left: make new ones and save them in iPhone Passwords.") : null,
      h("div", { class: "adm-actions" }, h("button", { class: "btn btn-quiet", onclick: newCodes }, icon("redo", 17), "Make new codes"))),
    card("How you sign in to Kleo", null, h("div", { class: "list" }, (r.methods || []).map((m) => h("div", { class: "row" }, icon(m.provider === "password" ? "key" : "user", 19),
      h("div", { class: "lbl" }, h("b", {}, methods[m.provider] || m.provider), h("span", {}, [m.email, m.last_login_at ? `last used ${ago(m.last_login_at)}` : null].filter(Boolean).join(" · ")))))),
      h("div", { class: "adm-actions" }, h("a", { class: "btn btn-quiet", href: K.DEMO ? "/account?demo=1" : "https://app.kleooai.com/account", target: K.DEMO ? null : "_blank", rel: "noopener" }, icon("key", 17), "Change password in the app"))),
    card("Recent console activity", r.events?.length ? null : "Nothing yet.", r.events?.length ? h("div", { class: "adm-timeline" }, r.events.map((a) => {
      let d = {};
      try { d = JSON.parse(a.detail || "{}"); } catch { /* none */ }
      return h("div", { class: `adm-ev ${a.event === "admin.signin" ? "money" : "admin"}` }, h("i", { class: "dot" }),
        h("div", { class: "adm-ev-t" }, h("b", {}, SECURITY_EVENTS[a.event] || a.event), h("span", {}, stamp(a.at)),
          h("p", {}, [d.ip, [d.city, countryName(d.country)].filter(Boolean).join(", "), d.network, shortUa(d.ua)].filter(Boolean).join(" · "))));
    })) : null),
    card("How to sign in", null, h("ol", { class: "adm-steps" }, HOW_TO.map((t) => h("li", {}, t)))),
    card("If your phone is lost", null, h("ol", { class: "adm-steps" }, LOST_PHONE.map((t) => h("li", {}, t)))),
    card("Only your computer", "The console lives on admin.kleooai.com, and opens only with the Kleo admin certificate installed on your PC: Cloudflare refuses every other device before Kleo even sees it, and Kleo checks the certificate again on every request. A new computer needs the certificate installed (docs/ADMIN-SECURITY.md).",
      h("a", { class: "btn btn-quiet btn-sm", href: "https://github.com/tonnooooo/kleo-mcp/blob/main/docs/ADMIN-SECURITY.md", target: "_blank", rel: "noopener" }, "How it works", icon("right", 15))),
    card("An extra lock, if you want it", "Cloudflare Access (free) can also ask for a one-time PIN sent to kleooai@gmail.com. The steps are in docs/ADMIN-SECURITY.md in kleo-mcp.",
      h("a", { class: "btn btn-quiet btn-sm", href: "https://github.com/tonnooooo/kleo-mcp/blob/main/docs/ADMIN-SECURITY.md", target: "_blank", rel: "noopener" }, "Open the steps", icon("right", 15))));
}

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function overviewPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  const bal = h("div", { class: "adm-bal" }, loading());
  K.fill(opts.into || main, head("Overview", K.DEMO ? "Demo data: nothing here is real." : "Everything at a glance.", refreshBtn(() => overviewPage(main))), body);
  const balances = balancesInto(bal);
  let o;
  try { o = await call("/api/admin/overview"); } catch (e) { return failed(body, e, () => overviewPage(main)); }
  const c = o.counts || {};
  const main$ = (o.revenue || []).slice().sort((a, b) => b.total - a.total)[0];
  const budgetPct = o.budget.day ? Math.min(100, (o.budget.spent / o.budget.day) * 100) : 0;
  const trouble = (o.trouble || []).map((t) => `${t.n} ${t.status}`).join(" · ");
  K.fill(body,
    tiles(
      tile("Accounts", num(c.users), `+${num(c.users_7d)} this week · +${num(c.users_1d)} today`),
      tile("Paying", num(c.payers), c.blocked ? `${num(c.blocked)} closed · ${count(c.blocked_addresses, "address", "addresses")} blocked` : `${count(c.blocked_addresses, "address", "addresses")} blocked`),
      tile("Money in, 30 days", main$ ? money(main$.d30, main$.currency) : money(0), main$ ? `${money(main$.total, main$.currency)} in all${trouble ? ` · ${trouble}` : ""}` : "No payments yet"),
      tile("Provider cost, 7 days", usd(c.spend_7d), `${usd(c.spend_30d)} in 30 days`),
      h("div", { class: "adm-tile" }, h("span", { class: "adm-tile-l" }, "Spent today"), h("b", {}, usd(o.budget.spent)),
        h("div", { class: "adm-bar" }, h("i", { style: { width: `${budgetPct}%` }, class: budgetPct > 80 ? "hot" : "" })),
        h("span", { class: "adm-tile-s" }, `Budget ${usd(o.budget.day)} a day · free accounts ${usd(o.budget.freeSpent)} of ${usd(o.budget.freeDay)} · since midnight UTC`)),
      tile("Creations today", num(c.gens_today), `${num(c.running)} running now`),
      tile("Failed, 24 h", num(c.failed_1d), c.gens_1d ? `${Math.round((c.failed_1d / c.gens_1d) * 100)}% of ${num(c.gens_1d)}` : "Nothing made", c.failed_1d && c.failed_1d / Math.max(1, c.gens_1d) > 0.3 ? "warn" : "")),
    card("Provider balances", null, bal),
    h("div", { class: "adm-two" },
      card("Newest accounts", null, h("div", { class: "list" }, (o.newest || []).map((u) => h("button", { class: "row", onclick: () => openUser(u.id) }, avatar(u),
        h("div", { class: "lbl" }, h("b", {}, who(u)), h("span", {}, [flag(u.country), place(u) || "Place not recorded", ago(u.created_at)].filter(Boolean).join(" · "))), icon("right", 16))),
        !(o.newest || []).length ? empty("No accounts yet.") : null), h("button", { class: "btn btn-quiet btn-sm adm-more", onclick: () => K.go("/admin/users") }, "All users", icon("right", 15))),
      card("Latest payments", null, h("div", { class: "list" }, (o.payments || []).map((p) => h("button", { class: "row", onclick: () => p.user_id && openUser(p.user_id) }, icon("bag", 19),
        h("div", { class: "lbl" }, h("b", {}, money(p.amount_cent, p.currency)), h("span", {}, [p.email || p.user_id || "No account", stamp(p.at)].join(" · "))), payPill(p.status))),
        !(o.payments || []).length ? empty("No payments yet.") : null), h("button", { class: "btn btn-quiet btn-sm adm-more", onclick: () => K.go("/admin/payments") }, "All payments", icon("right", 15)))),
    card("Latest failures", null, (o.failed || []).length ? h("div", { class: "adm-gens" }, o.failed.map((g) => genCard(g, true))) : empty("Nothing failed."),
      h("button", { class: "btn btn-quiet btn-sm adm-more", onclick: () => { CQ.tab = "failures"; K.go("/admin/creations"); } }, "Failures by reason", icon("right", 15))));
  await balances;
}

// ── Users ────────────────────────────────────────────────────────────────────────────────────────────────────────
const UQ = { q: "", filter: "all", sort: "created", dir: "desc" };
const USER_FILTERS = [["all", "All"], ["paid", "Paid"], ["free", "Never paid"], ["new", "New this week"], ["blocked", "Closed"], ["deleted", "Deleted"]];
const USER_SORTS = [["created", "Joined"], ["seen", "Last seen"], ["paid", "Paid"], ["credits", "Credits"], ["spend", "Provider cost"], ["gens", "Creations"], ["name", "Name"]];
async function usersPage(main, opts = {}) {
  let offset = 0, total = 0, busy = false;
  const list = h("div", { class: "adm-users" });
  const more = h("button", { class: "btn btn-quiet adm-more", style: { display: "none" } }, "Show more");
  const countEl = h("p", {}, " ");
  const search = h("input", { class: "input adm-search", type: "search", placeholder: "Search e-mail, name, id, IP or city", value: UQ.q, autocomplete: "off", spellcheck: "false", "aria-label": "Search users" });
  const sortLabel = () => USER_SORTS.find(([k]) => k === UQ.sort)?.[1] || "Joined";
  const sortBtn = h("button", { class: "btn btn-quiet btn-sm", onclick: openSort }, icon("down", 15), `Sort: ${sortLabel()}`);
  const dirBtn = h("button", { class: "btn btn-quiet btn-sm", "aria-label": "Order", onclick: () => { UQ.dir = UQ.dir === "desc" ? "asc" : "desc"; redraw(); } }, UQ.dir === "desc" ? "High to low" : "Low to high");
  const filters = h("div");
  const header = h("div", { class: "adm-urow adm-uhead", role: "row" },
    h("span", { class: "c-av" }), sortCell("Account", "name", "c-who"), h("span", { class: "c-place" }, "Place"), h("span", { class: "c-ip" }, "Last IP"),
    sortCell("Credits", "credits", "c-credits"), sortCell("Paid", "paid", "c-paid"), sortCell("Joined", "created", "c-joined"), sortCell("Last seen", "seen", "c-seen"));
  function sortCell(label, key, cls) {
    return h("button", { class: `${cls} sortable${UQ.sort === key ? " on" : ""}`, onclick: () => { if (UQ.sort === key) UQ.dir = UQ.dir === "desc" ? "asc" : "desc"; else { UQ.sort = key; UQ.dir = key === "name" ? "asc" : "desc"; } redraw(); } },
      label, UQ.sort === key ? (UQ.dir === "desc" ? " ↓" : " ↑") : "");
  }
  function openSort() {
    K.sheet("Sort users", null, h("div", { class: "list" }, USER_SORTS.map(([k, label]) => h("button", { class: "row" + (UQ.sort === k ? " on" : ""), onclick: () => { K.closeLayer(); UQ.sort = k; redraw(); } },
      h("div", { class: "lbl" }, h("b", {}, label)), h("span", { class: "check", style: { visibility: UQ.sort === k ? "visible" : "hidden" } }, icon("check", 17, 2.4))))));
  }
  const redraw = () => usersPage(main);
  K.fill(filters, chips(USER_FILTERS, UQ.filter, (k) => { UQ.filter = k; redraw(); }));
  const top = head("Users", null);
  top.querySelector(".adm-head-t").append(countEl);
  K.fill(opts.into || main, top, h("div", { class: "adm-toolbar" }, search, h("div", { class: "adm-toolbar-r" }, sortBtn, dirBtn)), filters, h("div", { class: "adm-table" }, header, list), more);
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { UQ.q = search.value.trim(); offset = 0; load(true); }, 280); });
  more.addEventListener("click", () => { LIVE.hold = true; load(false); });
  async function load(reset) {
    if (busy) return;
    busy = true;
    if (reset) K.fill(list, loading());
    more.disabled = true;
    try {
      const p = new URLSearchParams({ q: UQ.q, filter: UQ.filter, sort: UQ.sort, dir: UQ.dir, offset: String(offset), limit: "50" });
      const r = await call(`/api/admin/users?${p}`);
      total = r.total;
      if (reset) K.fill(list);
      list.append(...r.users.map(userRow));
      offset += r.users.length;
      if (!total) K.fill(list, empty(UQ.q ? "No account matches that search." : "No accounts here."));
      countEl.textContent = `${num(total)} ${total === 1 ? "account" : "accounts"}${UQ.q ? ` for “${UQ.q}”` : ""}`;
      more.style.display = offset < total ? "" : "none";
    } catch (e) { failed(list, e, () => load(true)); }
    busy = false; more.disabled = false;
  }
  await load(true);
}
function userRow(u) {
  const tags = [u.admin ? pill("Admin", "info") : null, u.blocked_at ? pill("Closed", "bad") : null, u.deleted ? pill("Deleted", "bad") : null,
    u.merged_into ? pill("Merged", "") : null, u.anonymous ? pill("Assistant only", "") : null, u.plan_until && toDate(u.plan_until) > new Date() && u.plan !== "trial" ? pill(cap(u.plan), "ok") : null].filter(Boolean);
  const where = [flag(u.country), u.city || countryName(u.country)].filter(Boolean).join(" ");
  return h("button", { class: "adm-urow", role: "row", onclick: () => openUser(u.id) },
    h("span", { class: "c-av" }, avatar(u)),
    h("span", { class: "c-who" }, h("b", {}, h("span", { class: "nm" }, who(u)), tags), h("span", {}, u.name && u.email ? u.email : u.id)),
    h("span", { class: "c-place" }, where || "—", h("span", { class: "c-seen-m" }, ` · ${ago(u.last_seen)}`)),
    h("span", { class: "c-ip mono" }, u.ip || "—"),
    h("span", { class: "c-credits num" }, u.admin ? "∞" : num(u.credits), h("span", { class: "u-m" }, " credits")),
    h("span", { class: "c-paid num" + (u.paid_cent ? " paid" : "") }, u.paid_cent ? money(u.paid_cent, u.currency) : "—"),
    h("span", { class: "c-joined" }, day(u.created_at)),
    h("span", { class: "c-seen" }, ago(u.last_seen)));
}

// ── One account ──────────────────────────────────────────────────────────────────────────────────────────────────
const EVENTS = {
  "user.created": "Account opened", "studio.key_signin": "Signed in with the Kleo key", "pay.session": "Opened a payment", "credits.purchased": "Bought credits",
  "credits.debit": "Credits spent on a film", "credits.refund": "Credits given back", "studio.create": "Started a creation", "studio.submitted": "Sent to the provider",
  "studio.done": "Creation finished", "studio.failed": "Creation failed", "studio.deleted": "Deleted a creation", "studio.enhance": "Used Enhance",
  "studio.signout_all": "Signed out everywhere", "studio.key_rotated": "Made a new Kleo key", "studio.password_changed": "Changed the password",
  "studio.account_deleted": "Account deleted", "studio.login_linked": "Connected a sign-in", "oauth.granted": "Connected an AI assistant",
  "studio.backup": "Moved to a backup provider", "studio.reset_done": "Reset the password", "studio.reset_sent": "Asked for a password reset", "studio.auto_wan": "Changed the Wan 3.0 switch",
  "job.created": "Ordered a film", "job.done": "Film finished", "job.failed": "Film failed", "studio.budget": "Stopped by the daily budget", "studio.free_budget": "Stopped by the free pool",
  "studio.address_blocked": "Stopped: address blocked", "studio.free_address": "Stopped: free allowance of the address", "studio.wan_retry": "Made again on Wan 3.0",
  "admin.credits": "Admin changed credits", "admin.block": "Admin closed the account", "admin.unblock": "Admin reopened the account", "admin.address_block": "Admin blocked the address",
  "admin.address_unblock": "Admin freed the address", "admin.key_reset": "Admin made a new Kleo key", "admin.signout": "Admin signed it out everywhere", "admin.delete": "Admin deleted the account",
  "admin.ip_lookup": "Admin looked up an address",
};
const LOOKUP_EVENTS = new Set(["user.created", "pay.session", "studio.key_signin", "oauth.granted", "studio.reset_done", "studio.login_linked", "credits.purchased"]);
const TIMELINE_FILTERS = [["all", "All"], ["money", "Money"], ["make", "Creations"], ["account", "Account"], ["admin", "Admin"]];
const eventGroup = (e) => (e.startsWith("admin.") ? "admin" : /^(credits\.|pay\.)/.test(e) ? "money" : /^(studio\.(create|submitted|done|failed|deleted|enhance|backup|fallback|wan|rewrite|next)|job\.)/.test(e) ? "make" : "account");
function detailText(raw) {
  let d;
  try { d = JSON.parse(raw || "null"); } catch { return String(raw || "").slice(0, 160); }
  if (!d || typeof d !== "object") return d === null ? "" : String(d);
  return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== "").slice(0, 5)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 90)}`).join(" · ");
}

async function userPage(main, id, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  const back = h("button", { class: "btn btn-quiet btn-sm adm-back", onclick: () => K.go("/admin/users") }, h("span", { class: "flip" }, icon("right", 15)), "Users");
  K.fill(opts.into || main, h("div", { class: "adm-backrow" }, back), body);
  let d;
  try { d = await call(`/api/admin/users/${id}`); } catch (e) { return failed(body, e, () => userPage(main, id)); }
  const u = d.user;
  const reload = () => userPage(main, id);
  const lastIp = d.ips?.[0] || null;
  const paidText = (d.totals.paid || []).map((p) => money(p.cents, p.currency)).join(" + ") || money(0);
  const methods = (d.logins || []).map((l) => ({ password: "E-mail and password", google: "Google", microsoft: "Microsoft", apple: "Apple" })[l.provider] || l.provider);

  // What the owner can do to the account; every action asks why, and the reason goes into the audit log.
  const post = (what, b) => postFresh(`/api/admin/users/${id}/${what}`, b);
  async function act(o) {
    const v = await K.ask({ title: o.title, text: o.text, ok: o.ok, danger: !!o.danger, ic: o.ic, word: o.word || null,
      fields: [...(o.fields || []), { key: "reason", label: "Reason, kept in the audit log", placeholder: "Why you are doing this", required: true }] });
    if (!v) return;
    try { await o.run(v); K.toast(o.done); reload(); } catch (e) { oops(e); }
  }
  const credit = (sign) => act({
    title: sign > 0 ? "Add credits" : "Take credits away", ic: "star", ok: sign > 0 ? "Add" : "Take away", danger: sign < 0,
    text: `${who(u)} has ${u.admin ? "unlimited" : num(u.credits)} credits.${sign < 0 ? " The balance never goes under zero." : ""}`,
    fields: [{ key: "amount", label: "Credits", type: "number", placeholder: "10", required: true }],
    run: (v) => { const n = Math.abs(Math.trunc(Number(v.amount))); if (!n) throw new Error("Type a number of credits."); return post("credits", { delta: sign * n, reason: v.reason }); },
    done: sign > 0 ? "Credits added" : "Credits taken away",
  });
  const blocked = !!u.blocked_at;
  const addrBlocked = (d.address.blocks || []).some((b) => b.ip_hash === d.address.hash);
  const actions = h("div", { class: "adm-actions" },
    h("button", { class: "btn btn-quiet", onclick: () => credit(1) }, icon("plus", 17), "Add credits"),
    h("button", { class: "btn btn-quiet", onclick: () => credit(-1) }, icon("star", 17), "Take credits away"),
    u.admin ? null : h("button", { class: "btn btn-quiet", onclick: () => act(blocked
      ? { title: "Reopen this account?", text: "It can sign in again. Its Kleo key is the new one made when it was closed.", ok: "Reopen", ic: "check", run: (v) => post("block", { on: false, reason: v.reason }), done: "Account reopened" }
      : { title: "Close this account?", text: "It is signed out everywhere at once and can't sign in again. Its Kleo key is renewed, so assistants connected with it stop too.", ok: "Close account", danger: true, ic: "lock", run: (v) => post("block", { on: true, reason: v.reason }), done: "Account closed" }) },
      icon("lock", 17), blocked ? "Reopen account" : "Close account"),
    u.admin || !d.address.hash ? null : h("button", { class: "btn btn-quiet", onclick: () => act(addrBlocked
      ? { title: "Free this address?", text: "New accounts can be opened from it again.", ok: "Free address", ic: "globe", run: (v) => post("address", { on: false, reason: v.reason }), done: "Address freed" }
      : { title: "Block the sign-up address?", text: `No new account can be opened from it, and its never-paid accounts stop making things for free. ${d.address.twins.length ? `${d.address.twins.length} other accounts came from it.` : ""}`, ok: "Block address", danger: true, ic: "globe",
        fields: [{ key: "days", label: "Days", type: "number", value: "30", required: true }], run: (v) => post("address", { on: true, days: Number(v.days) || 30, reason: v.reason }), done: "Address blocked" }) },
      icon("globe", 17), addrBlocked ? "Free address" : "Block address"),
    h("button", { class: "btn btn-quiet", onclick: () => act({ title: "Make a new Kleo key?", text: "The old key stops working everywhere: assistants connected with it are disconnected, and every browser and phone is signed out.", ok: "New key", ic: "key", run: (v) => post("key", { reason: v.reason }), done: "New Kleo key made" }) },
      icon("key", 17), "New Kleo key"),
    h("button", { class: "btn btn-quiet", onclick: () => act({ title: "Sign out everywhere?", text: "Every browser and phone signed in to this account is signed out.", ok: "Sign out", ic: "out", run: (v) => post("signout", { reason: v.reason }), done: "Signed out everywhere" }) },
      icon("out", 17), "Sign out everywhere"),
    u.admin || u.deleted ? null : h("button", { class: "btn btn-danger", onclick: () => act({ title: "Delete this account?", text: "Its videos, pictures, sounds, chats, sign-in methods and credits are deleted for good. Payments stay on record. To confirm, type DELETE.", ok: "Delete account", danger: true, word: "DELETE",
      run: (v) => post("delete", { reason: v.reason, confirm: "DELETE" }), done: "Account deleted" }) }, icon("trash", 17), "Delete account"));

  const hero = h("div", { class: "adm-hero" }, h("span", { class: "adm-av big" }, String(who(u))[0].toUpperCase()),
    h("div", { class: "adm-hero-t" }, h("h1", {}, who(u)), h("p", {}, u.name && u.email ? u.email : u.email ? "" : "No e-mail on record"),
      h("div", { class: "adm-tags" }, u.admin ? pill("Admin", "info") : null, u.paid_cent ? pill("Paid", "ok") : pill("Never paid"), blocked ? pill("Closed", "bad") : null, u.deleted ? pill("Deleted", "bad") : null,
        addrBlocked ? pill("Address blocked", "bad") : null, u.merged_into ? pill("Merged", "") : null, u.anonymous ? pill("Assistant only", "") : null)),
    h("div", { class: "adm-id" }, h("span", { class: "mono" }, u.id), copyBtn(u.id, "Copy id")));

  const stats = h("div", { class: "adm-tiles four" },
    tile("Credits", u.admin ? "∞" : num(u.credits), u.plan_until && u.plan !== "trial" ? `Plan ${cap(u.plan)}, until ${day(u.plan_until)}` : "No plan"),
    tile("Paid", paidText, count((d.payments || []).length, "payment")),
    tile("Provider cost", usd(d.totals.spend_usd + d.totals.films_usd), `${num(d.totals.credits_spent)} credits used`),
    tile("Creations", num((d.generations || []).length), `${d.totals.failed} failed`));

  const profile = card("Profile", null, kv([
    ["E-mail", u.email || "—"],
    ["Name", u.name || "—"],
    ["Sign-in", methods.join(", ") || "Kleo key only"],
    ["Joined", stamp(u.created_at)],
    ["Last seen", u.last_seen ? `${ago(u.last_seen)} (${stamp(u.last_seen)})` : "—"],
    ["Place", lastIp ? `${flag(lastIp.country)} ${place(lastIp) || "—"}` : u.country ? `${flag(u.country)} ${countryName(u.country)}` : "Not recorded yet"],
    ["Last IP", lastIp?.ip ? h("span", { class: "adm-inline" }, h("span", { class: "mono" }, lastIp.ip), copyBtn(lastIp.ip, "Copy IP")) : "—"],
    ["Network", lastIp?.as_org ? `${lastIp.as_org}${lastIp.asn ? ` (AS${lastIp.asn})` : ""}` : null],
    ["Device", shortUa(lastIp?.ua)],
    ...cameFrom(d.attribution, u),
    ["Free credits at sign-up", u.gift ? `${u.gift}` : "None"],
    ["Plan", u.plan && u.plan !== "trial" ? `${cap(u.plan)}, ${u.plan_period === "year" ? "yearly" : "monthly"}, ${u.plan_status || "active"}, until ${day(u.plan_until, true)}` : null],
    ["Stripe customer", u.plan_customer ? h("a", { href: `https://dashboard.stripe.com/customers/${encodeURIComponent(u.plan_customer)}`, target: "_blank", rel: "noopener" }, u.plan_customer) : null],
    ["Kleo key version", String(u.key_version ?? 0)],
    ["Closed because", blocked ? `${u.blocked_reason || "—"} (${stamp(u.blocked_at)})` : null],
    ["Account address", u.account_email && u.account_email !== u.email ? u.account_email : null],
    ["Launch code", d.redemption ? `${d.redemption.code} (${d.redemption.credits} credits, ${day(d.redemption.at)})` : null],
    ["Merged into it", d.merged?.length ? h("span", { class: "adm-links" }, d.merged.map((m) => h("button", { class: "adm-a", onclick: () => openUser(m) }, m))) : null],
    ["Merged into", u.merged_into ? h("button", { class: "adm-a", onclick: () => openUser(u.merged_into) }, u.merged_into) : null],
  ]));

  const payments = card("Payments", d.payments?.length ? null : "No payments.", d.payments?.length ? h("div", { class: "list" }, d.payments.map(payRow)) : null);

  const gens = d.generations || [];
  let shown = 12;
  const genGrid = h("div", { class: "adm-gens" });
  const genMore = h("button", { class: "btn btn-quiet btn-sm adm-more" }, "Show more");
  const drawGens = () => { K.fill(genGrid, gens.slice(0, shown).map((g) => genCard(g))); genMore.style.display = gens.length > shown ? "" : "none"; };
  genMore.addEventListener("click", () => { shown += 24; drawGens(); });
  drawGens();
  const creations = card("Creations", gens.length ? `${gens.length} in all, newest first.` : "Nothing made yet.", gens.length ? [genGrid, genMore] : null);
  const films = d.jobs?.length ? card("Films ordered through assistants", null, h("div", { class: "list" }, d.jobs.map((j) => h("div", { class: "row" }, icon("film", 19),
    h("div", { class: "lbl" }, h("b", {}, `${j.template} · ${j.state}`), h("span", {}, [stamp(j.created_at), count(j.credits, "credit"), j.cost_usd ? usd(j.cost_usd) : null, j.error ? j.error.slice(0, 120) : null].filter(Boolean).join(" · "))),
    h("span", { class: "val mono" }, j.id))))) : null;

  const signins = card("Sign-in methods", d.logins?.length ? null : "Only the Kleo key opens this account.", d.logins?.length ? h("div", { class: "list" }, d.logins.map((l) => h("div", { class: "row" }, icon(l.provider === "password" ? "key" : "user", 19),
    h("div", { class: "lbl" }, h("b", {}, methods[d.logins.indexOf(l)]), h("span", {}, [l.email || l.subject, `added ${day(l.created_at, true)}`, l.last_login_at ? `last used ${ago(l.last_login_at)}` : null].filter(Boolean).join(" · ")))))) : null);

  const addresses = card("Addresses and places", `Recorded at every sign-up, sign-in, assistant connection and payment since 23 October 2026, kept ${d.retentionDays} days.${d.lookup ? " For older events, use Find address in the timeline." : " To find the address of older events, add the CF_ANALYTICS_TOKEN secret: a Find address button then appears in the timeline."}`,
    d.ips?.length ? h("div", { class: "list" }, d.ips.map((i) => h("div", { class: "row" }, icon("globe", 19),
      h("div", { class: "lbl" }, h("b", { class: "mono" }, i.ip || "—", i.ip ? copyBtn(i.ip, "Copy IP") : null), h("span", {}, [`${flag(i.country)} ${place(i) || "—"}`, i.as_org, shortUa(i.ua)].filter(Boolean).join(" · "))),
      h("span", { class: "val" }, h("span", {}, { signup: "Sign-up", signin: "Sign-in", connect: "Assistant", pay: "Payment", lookup: "Found" }[i.event] || i.event), h("span", {}, ago(i.at))))))
      : empty("No address recorded yet."),
    (d.address.blocks || []).length ? h("div", { class: "adm-note bad" }, icon("lock", 17), `Blocked address until ${day(d.address.blocks[0].until, true)}: ${d.address.blocks[0].reason}`) : null,
    d.address.twins?.length ? [h("h3", {}, `${d.address.twins.length} other ${d.address.twins.length === 1 ? "account" : "accounts"} from the sign-up address`),
      h("div", { class: "list" }, d.address.twins.map((t) => h("button", { class: "row", onclick: () => openUser(t.id) }, avatar(t), h("div", { class: "lbl" }, h("b", {}, t.email || t.id), h("span", {}, `joined ${day(t.created_at, true)}`)), icon("right", 16))))] : null);

  // The timeline: every audit row of the account, newest first.
  let tf = "all", tShown = 40;
  const tList = h("div", { class: "adm-timeline" });
  const tMore = h("button", { class: "btn btn-quiet btn-sm adm-more" }, "Show more");
  const tChips = h("div");
  const drawTimeline = () => {
    K.fill(tChips, chips(TIMELINE_FILTERS, tf, (k) => { tf = k; tShown = 40; drawTimeline(); }));
    const rows = (d.audit || []).filter((a) => tf === "all" || eventGroup(a.event) === tf);
    K.fill(tList, rows.slice(0, tShown).map((a) => h("div", { class: `adm-ev ${eventGroup(a.event)}` }, h("i", { class: "dot" }),
      h("div", { class: "adm-ev-t" }, h("b", {}, EVENTS[a.event] || a.event), h("span", {}, stamp(a.at)), detailText(a.detail) ? h("p", {}, detailText(a.detail)) : null,
        d.lookup && LOOKUP_EVENTS.has(a.event) ? h("button", { class: "btn btn-quiet btn-sm", onclick: (e) => findAddress(a, e.currentTarget) }, icon("globe", 15), "Find address") : null))),
      rows.length ? null : empty("Nothing here."));
    tMore.style.display = rows.length > tShown ? "" : "none";
  };
  tMore.addEventListener("click", () => { tShown += 60; drawTimeline(); });
  drawTimeline();
  const timeline = card("Timeline", "Everything the account did, and everything done to it.", tChips, tList, tMore);

  async function findAddress(a, btn) {
    btn.disabled = true;
    const old = [...btn.childNodes];
    K.fill(btn, K.spinner(15), "Asking Cloudflare");
    try {
      const r = await call(`/api/admin/users/${id}/ip-lookup`, { method: "POST", body: { audit: a.id } });
      const b = r.best;
      K.sheet("Address found", `${EVENTS[a.event] || a.event}, ${stamp(a.at)}. Cloudflare's requests five seconds either side of it.`,
        b ? h("div", { class: "adm-found" }, h("b", { class: "mono" }, b.ip), copyBtn(b.ip, "Copy IP"), h("span", {}, `${flag(b.country)} ${countryName(b.country) || ""} · ${b.method} ${b.path} · ${shortUa(b.ua) || ""}`)) : empty("No request from a person in that window."),
        r.rows?.length ? h("div", { class: "list" }, r.rows.map((x) => h("div", { class: "row" + (x.match ? " on" : "") }, h("div", { class: "lbl" }, h("b", { class: "mono" }, x.ip), h("span", {}, `${x.at.slice(11, 19)} UTC · ${flag(x.country)} ${x.method} ${x.host}${x.path}`)), x.match ? pill("This event", "ok") : null))) : null);
      if (b) userPage(main, id).catch(() => {});
    } catch (e) { oops(e); }
    btn.disabled = false; K.fill(btn, old);
  }

  K.fill(body, hero, stats, card("Actions", "Every action asks for a reason and is written to the audit log with your id.", actions),
    h("div", { class: "adm-two" }, profile, h("div", { class: "adm-stack" }, payments, signins)), creations, films, addresses, timeline);
}
function payRow(p) {
  return h("div", { class: "row adm-pay" }, icon("bag", 19),
    h("div", { class: "lbl" }, h("b", {}, money(p.amount_cent, p.currency), h("span", { class: "adm-dim" }, ` · ${count(p.credits, "credit")}`)),
      h("span", {}, [p.account_email || p.email || (p.user_id ? p.user_id : "No account"), p.country ? `${flag(p.country)} ${p.country}` : null, stamp(p.at)].filter(Boolean).join(" · "))),
    h("span", { class: "val adm-pay-r" }, payPill(p.status), (p.links || []).map((l) => h("a", { class: "btn btn-quiet btn-sm", href: l.url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() }, l.label))));
}

// ── creations, as cards ──────────────────────────────────────────────────────────────────────────────────────────
function genCard(g, showUser = false) {
  const out = g.outputs?.[0];
  const media = out ? mediaEl(out) : h("div", { class: "adm-gen-ph" }, icon(g.status === "failed" ? "x" : g.kind === "image" ? "photo" : "film", 26));
  return h("button", { class: `adm-gen ${g.status}`, onclick: () => genSheet(g) },
    h("div", { class: "adm-gen-media" }, media, h("span", { class: "adm-gen-st" }, statusPill(g.status))),
    h("div", { class: "adm-gen-meta" }, h("b", {}, modelName(g.model)),
      h("span", {}, `${KIND[g.kind] || g.kind} · ${count(g.credits, "credit")} · ${usd(g.est_usd)}`),
      h("span", {}, `${PROVIDER[g.provider] || g.provider} · ${ago(g.created_at)}`),
      showUser ? h("span", { class: "adm-gen-u" }, g.email || g.user_id) : null,
      g.status === "failed" && g.error ? h("p", { class: "adm-gen-err" }, g.error) : null));
}
function genSheet(g) {
  const s = g.settings || {};
  const set = [s.resolution, s.duration ? `${s.duration} s` : null, s.aspect, s.quality, s.count ? `${s.count} pictures` : null, s.tool].filter(Boolean).join(" · ");
  K.sheet(modelName(g.model), `${KIND[g.kind] || g.kind} · ${stamp(g.created_at)}`,
    g.outputs?.length ? h("div", { class: "adm-sheet-media" }, g.outputs.map((o) => mediaEl(o, true))) : null,
    h("div", { class: "adm-sheet-body" }, kv([
      ["Status", statusPill(g.status)], ["Account", h("button", { class: "adm-a", onclick: () => { K.closeLayer(); openUser(g.user_id); } }, g.email || g.user_id)],
      ["Credits", `${num(g.credits)}${g.refunded ? " (given back)" : ""}`], ["Provider cost", usd(g.est_usd)], ["Provider", PROVIDER[g.provider] || g.provider],
      ["Settings", set || null], ["Finished", g.finished_at ? stamp(g.finished_at) : null], ["Error", g.error || null], ["Prompt", g.prompt || null],
      ["Id", h("span", { class: "adm-inline" }, h("span", { class: "mono" }, g.id), copyBtn(g.id, "Copy id"))],
    ]), g.outputs?.length ? h("div", { class: "adm-actions" }, g.outputs.map((o, i) => h("a", { class: "btn btn-quiet btn-sm", href: o.url, target: "_blank", rel: "noopener" }, icon("dl", 16), g.outputs.length > 1 ? `Open file ${i + 1}` : "Open file"))) : null));
}

// ── Payments ─────────────────────────────────────────────────────────────────────────────────────────────────────
let PQ = "all";
async function paymentsPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("Payments", "Every payment Stripe told Kleo about.", refreshBtn(() => paymentsPage(main))), body);
  let r;
  try { r = await call(`/api/admin/payments${PQ === "all" ? "" : `?status=${PQ}`}`); } catch (e) { return failed(body, e, () => paymentsPage(main)); }
  const totals = (r.totals || []).slice().sort((a, b) => b.total - a.total);
  const cur = totals[0]?.currency || "eur";
  const t = totals[0] || { total: 0, d30: 0, month: 0, today: 0, n: 0, payers: 0 };
  const st = Object.fromEntries((r.states || []).map((s) => [s.status, s]));
  const others = totals.slice(1).map((x) => money(x.total, x.currency)).join(" + ");
  // The last 30 days as bars, in the main currency.
  const byDay = new Map((r.days || []).filter((x) => x.currency === cur).map((x) => [x.day, x]));
  const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.now() - (29 - i) * 86400e3); const k = d.toISOString().slice(0, 10); return { k, d, v: byDay.get(k)?.cents || 0, n: byDay.get(k)?.n || 0 }; });
  const max = Math.max(1, ...days.map((x) => x.v));
  const chart = h("div", { class: "adm-chart", role: "img", "aria-label": "Money in per day, last 30 days" },
    days.map((x, i) => h("div", { class: "adm-col", title: `${day(x.k)}: ${money(x.v, cur)} (${x.n})` },
      h("i", { style: { height: `${Math.max(x.v ? 4 : 0, (x.v / max) * 100)}%` } }), i % 6 === 0 || i === 29 ? h("span", {}, x.d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })) : null)));
  const months = (r.months || []).filter((m) => m.currency === cur);
  K.fill(body,
    tiles(tile("Today", money(t.today, cur)), tile("This month", money(t.month, cur)), tile("Last 30 days", money(t.d30, cur)),
      tile("All time", money(t.total, cur), `${count(t.n, "payment")} · ${count(t.payers, "person", "people")}${others ? ` · plus ${others}` : ""}`),
      tile("Refunded", num(st.refunded?.n || 0), st.refunded?.n ? money(st.refunded.cents, cur) : null, st.refunded?.n ? "warn" : ""),
      tile("Disputed", num(st.disputed?.n || 0), st.disputed?.n ? money(st.disputed.cents, cur) : null, st.disputed?.n ? "bad" : "")),
    card("Last 30 days", `Paid money in ${cur.toUpperCase()}, per day.`, chart),
    months.length ? card("By month", null, h("div", { class: "list" }, months.map((m) => h("div", { class: "row" }, icon("clock", 19),
      h("div", { class: "lbl" }, h("b", {}, toDate(`${m.month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }))), h("span", { class: "val" }, `${money(m.cents, cur)} · ${m.n}`))))) : null,
    card("All payments", `${num(r.total)} ${PQ === "all" ? "in all" : PQ}.`, chips([["all", "All"], ["paid", "Paid"], ["refunded", "Refunded"], ["disputed", "Disputed"]], PQ, (k) => { PQ = k; paymentsPage(main); }),
      r.payments.length ? h("div", { class: "list" }, r.payments.map((p) => {
        const row = payRow(p);
        if (p.user_id) { row.classList.add("tap"); row.addEventListener("click", () => openUser(p.user_id)); }
        return row;
      })) : empty("No payments here.")));
}

// ── Sources (25 October 2026, the owner: which network, which post or video and which link brought each account;
// src/studio/attribution.ts) ─────────────────────────────────────────────────────────────────────────────────────
const CHANNEL = { instagram: "Instagram", tiktok: "TikTok", x: "X", youtube: "YouTube", facebook: "Facebook", threads: "Threads", reddit: "Reddit",
  linkedin: "LinkedIn", pinterest: "Pinterest", snapchat: "Snapchat", whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord", line: "LINE",
  linktree: "Linktree", chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", gemini: "Gemini", copilot: "Copilot", producthunt: "Product Hunt",
  hn: "Hacker News", github: "GitHub", google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo", yahoo: "Yahoo", ecosia: "Ecosia", brave: "Brave Search",
  email: "E-mail", dm: "Direct messages", site: "Kleo website", other: "Other sites", direct: "Direct: typed or saved",
  untracked: "No record kept", assistant: "Opened in an assistant", before: "Unknown (before tracking)", deleted: "Deleted accounts" };
/** What a bucket means, under its name. */
const CHANNEL_NOTE = {
  direct: "No link, no tag and no site before Kleo.",
  untracked: "A private browser, or the first visit was more than 7 days before.",
  assistant: "Opened by the MCP server, not in the app.",
  before: "Opened before Kleo began recording where accounts come from.",
  deleted: "Where they came from was deleted with their data.",
};
const channelName = (c) => CHANNEL[c] || cap(c || "—");
/**
 * Where a short link can be pasted so that a tap opens it (25 October 2026, the owner: "metti i link a disposizione per
 * copiarli"). Instagram and TikTok captions and Shorts descriptions are plain text: a link there is never tapped.
 */
function linkPlace(l) {
  if (l.channel === "dm") return "Paste it in DM replies, for example to people who comment KLEO. A link in a DM opens with a tap.";
  if (/\bbio\b|\bchannel\b/i.test(l.label)) return {
    instagram: "Instagram: Edit profile, then Links.",
    tiktok: "TikTok: Edit profile, then Website. TikTok shows that field only on a Business account or from 1,000 followers.",
    x: "X: Edit profile, then Website.",
    youtube: "YouTube: Customise channel, then Links. YouTube allows links only on a verified channel.",
  }[l.channel] || "Paste it where your profile takes a link.";
  return {
    instagram: "Captions can't be tapped. Use it in a story link sticker, in DMs, or in the bio while this post takes off.",
    tiktok: "Captions can't be tapped. Use it in the bio while this post takes off, or in DMs.",
    youtube: "Shorts descriptions can't be tapped. Use it in the description of a long video.",
    x: "A link opens with a tap in the post and in replies.",
  }[l.channel] || "Paste it wherever a link opens with a tap.";
}
/** What the page counts and how, in plain words (the owner: "salva questo nella pagina admin"). */
const HOW_SOURCES = [
  "The first time a browser opens Kleo, or one of your short links, Kleo keeps where it came from in one cookie for 7 days: the network, the short link, the tags in the address, the site before Kleo, the first page, and the app whose built-in browser was used (Instagram, TikTok…).",
  "When that browser opens an account, with Google or with an e-mail, its source is saved with the account and the cookie is deleted. Deleting an account deletes its source too.",
  "Instagram and TikTok often hide the site a visit came from. With no short link and no site before Kleo, the network is read from the name of the app's built-in browser, and the account is marked as guessed.",
  "Without a short link Kleo still knows the network, but not the post. Only a tap on a /r/ link says which post or bio brought the person.",
  "Robots, link previews and people already signed in are never counted. Browsers that ask not to be tracked (Global Privacy Control, Do Not Track) get no cookie: their new accounts show as No record kept, like accounts whose first visit was more than 7 days before.",
  "Accounts opened before tracking began show as Unknown (before tracking). Accounts opened from an assistant, outside the app, show as Opened in an assistant.",
  "Each short link opens its page with utm tags, so the source stays in the address even when someone moves from Instagram's browser to Safari or Chrome.",
];
const LINK_NETS = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["x", "X"], ["youtube", "YouTube"], ["dm", "Direct messages"], ["other", "Other"]];
/** Money in each currency, EUR first: "€40.00 + $12.00". */
function moneyOf(paid) {
  const e = Object.entries(paid || {}).filter(([, c]) => c > 0).sort(([a], [b]) => (a === "eur" ? -1 : b === "eur" ? 1 : a.localeCompare(b)));
  return e.length ? e.map(([cur, c]) => money(c, cur)).join(" + ") : "—";
}
const share = (n, of) => (of ? ` (${Math.round((n / of) * 100)}%)` : "");
/** Where an account came from, as Profile rows. */
function cameFrom(a, u) {
  if (!a) return [["Came from", u.src && u.src !== "studio" ? u.src : "Not recorded: the account is older than tracking, or was opened in an assistant"]];
  const tags = [a.utm_source && `utm_source=${a.utm_source}`, a.utm_medium && `utm_medium=${a.utm_medium}`, a.utm_campaign && `utm_campaign=${a.utm_campaign}`,
    a.utm_content && `utm_content=${a.utm_content}`, a.src && `src=${a.src}`].filter(Boolean).join(" · ");
  return [
    ["Came from", `${channelName(a.channel)}${a.guessed ? ", guessed from the in-app browser" : ""}`],
    ["Short link", a.link_code ? `${a.link_label || a.link_code} (/r/${a.link_code})` : null],
    ["Site before Kleo", a.ref_host],
    ["First page", a.landing],
    ["Tags", tags || null],
    ["In-app browser", a.in_app ? channelName(a.in_app) : null],
    ["First visit", a.first_seen_at ? stamp(a.first_seen_at) : null],
  ];
}
const SQ = { days: 30, hidden: false, made: null, form: { channel: "instagram", label: "", code: "", target: "/" } };
async function sourcesPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("Sources", "Which network, post and link brought each account.", refreshBtn(() => sourcesPage(main))),
    seg([[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]], SQ.days, (k) => { SQ.days = k; sourcesPage(main); }), body);
  let r;
  try { r = await call(`/api/admin/sources?days=${SQ.days}`); } catch (e) { return failed(body, e, () => sourcesPage(main)); }
  const reload = () => sourcesPage(main);
  const t = r.total;
  const period = SQ.days ? `in the last ${SQ.days} days` : "in all";

  // One row of a funnel table: the name, then the six figures (each with its label on a phone).
  const cell = (label, value, cls = "") => h("span", { class: `f-c ${cls}` }, h("span", { class: "f-l" }, label), h("b", {}, value));
  const figures = (x) => [cell("First visits", num(x.visits)), cell("Link clicks", x.clicks ? num(x.clicks) : "—"), cell("Sign-ups", num(x.signups)),
    cell("Made something", x.signups ? `${num(x.made)}${share(x.made, x.signups)}` : "—"), cell("Paying", x.signups ? `${num(x.paying)}${share(x.paying, x.signups)}` : "—"),
    cell("Money", moneyOf(x.paid), x.paying ? "paid" : "")];
  const tableHead = (first) => h("div", { class: "adm-frow adm-fhead", role: "row" }, h("span", { class: "f-name" }, first),
    ["First visits", "Link clicks", "Sign-ups", "Made something", "Paying", "Money"].map((x) => h("span", { class: "f-c" }, x)));

  const channelRows = (r.channels || []).map((c) => h("div", { class: "adm-frow", role: "row" },
    h("span", { class: "f-name" }, h("b", {}, channelName(c.channel)),
      c.guessed ? h("span", {}, `${num(c.guessed)} guessed from the in-app browser`) : CHANNEL_NOTE[c.channel] ? h("span", {}, CHANNEL_NOTE[c.channel]) : null),
    figures(c)));

  // Making a link: the form keeps what was typed in SQ.form, so the page refreshing itself loses nothing.
  const F = SQ.form;
  const nets = h("div");
  const drawNets = () => K.fill(nets, chips(LINK_NETS, F.channel, (k) => { F.channel = k; drawNets(); }));
  drawNets();
  const input = (key, placeholder, extra = {}) => {
    const el = h("input", { class: "input", value: F[key], placeholder, autocomplete: "off", spellcheck: "false", ...extra });
    el.addEventListener("input", () => { F[key] = el.value; });
    return el;
  };
  const labelIn = input("label", "Bio, or the post or video it goes under", { "aria-label": "Post or video" });
  const codeIn = input("code", "Made from the name when empty", { autocapitalize: "off", "aria-label": "Code" });
  const targetIn = input("target", "/", { autocapitalize: "off", "aria-label": "Page it opens" });
  const makeBtn = h("button", { class: "btn btn-primary", onclick: make }, icon("plus", 17), "Make link");
  async function make() {
    if (F.label.trim().length < 2) { K.toast("Say which bio, post or video the link is for.", true); labelIn.focus(); return; }
    makeBtn.disabled = true;
    try {
      const res = await call("/api/admin/sources/links", { method: "POST", body: { channel: F.channel, label: F.label.trim(), code: F.code.trim(), target: F.target.trim() || "/" } });
      SQ.made = res.link;
      Object.assign(F, { label: "", code: "", target: "/" });
      navigator.clipboard?.writeText(res.link.url).catch(() => {});
      K.toast("Link made and copied");
      reload();
    } catch (e) { oops(e); makeBtn.disabled = false; }
  }
  const field = (label, el) => h("label", { class: "adm-field" }, h("span", {}, label), el);
  const made = SQ.made ? h("div", { class: "adm-made" }, icon("check", 18, 2.2),
    h("div", { class: "lbl" }, h("b", {}, SQ.made.label), h("span", { class: "mono" }, SQ.made.url)), copyBtn(SQ.made.url, "Copy link")) : null;
  const form = card("Make a short link", "Put it in a bio, a story or a DM, where a tap opens it. Every click is counted, and the accounts it brings show up below.",
    made, field("Network", nets), h("div", { class: "adm-form2" }, field("Post or video", labelIn), field("Code", codeIn)), field("Page it opens", targetIn),
    h("div", { class: "adm-actions" }, makeBtn));

  // The links, newest first; hidden ones only on request.
  async function edit(l) {
    const v = await K.ask({ title: "Change this link", ic: "share", ok: "Save", text: `${l.url} keeps working; only its name and page change.`,
      fields: [{ key: "label", label: "Post or video", value: l.label, required: true }, { key: "target", label: "Page it opens", value: l.target, required: true }] });
    if (!v) return;
    try { await call(`/api/admin/sources/links/${l.code}`, { method: "POST", body: { label: v.label, target: v.target } }); K.toast("Link changed"); reload(); } catch (e) { oops(e); }
  }
  async function hide(l) {
    try { await call(`/api/admin/sources/links/${l.code}`, { method: "POST", body: { archived: !l.archived } }); K.toast(l.archived ? "Link shown again" : "Link hidden. It still works."); reload(); } catch (e) { oops(e); }
  }
  const shownLinks = (r.links || []).filter((l) => SQ.hidden || !l.archived);
  const hiddenCount = (r.links || []).filter((l) => l.archived).length;
  const linkRows = shownLinks.map((l) => h("div", { class: "adm-frow adm-flink", role: "row" },
    h("span", { class: "f-name" }, h("b", {}, l.label, pill(channelName(l.channel), ""), l.archived ? pill("Hidden", "") : null),
      h("span", { class: "adm-inline" }, h("span", { class: "mono" }, l.url.replace(/^https:\/\//, "")), copyBtn(l.url, "Copy link")),
      h("span", {}, `Opens ${l.target} · ${count(l.clicks_all, "click")} in all · made ${day(l.created_at)}`),
      h("span", { class: "adm-link-a" }, h("button", { class: "btn btn-quiet btn-sm", onclick: () => edit(l) }, icon("wand", 15), "Change"),
        h("button", { class: "btn btn-quiet btn-sm", onclick: () => hide(l) }, icon(l.archived ? "redo" : "x", 15), l.archived ? "Show" : "Hide"))),
    figures(l)));

  const newest = (r.newest || []).map((u) => h("button", { class: "row", onclick: () => openUser(u.id) }, avatar(u),
    h("div", { class: "lbl" }, h("b", {}, who(u), u.paid ? pill("Paid", "ok") : null),
      h("span", {}, [channelName(u.channel) + (u.guessed ? " (guessed)" : ""), u.link_label || (u.link_code ? `/r/${u.link_code}` : null), u.ref_host, u.landing && u.landing !== "/" ? `first page ${u.landing}` : null].filter(Boolean).join(" · "))),
    h("span", { class: "val" }, ago(u.created_at))));

  // Every link ready to paste, with where a tap opens it. Hidden links are left out.
  const ready = (r.links || []).filter((l) => !l.archived).map((l) => h("div", { class: "row adm-ready" },
    h("div", { class: "lbl" }, h("b", {}, l.label, pill(channelName(l.channel), "")), h("span", { class: "mono" }, l.url.replace(/^https:\/\//, "")), h("span", {}, linkPlace(l))),
    h("button", { class: "btn btn-quiet btn-sm", "aria-label": `Copy ${l.url}`, onclick: () => { navigator.clipboard?.writeText(l.url); K.toast("Link copied"); } }, icon("copy", 16), "Copy")));

  K.fill(body,
    tiles(tile("First visits", num(t.visits), "Browsers opening Kleo for the first time"), tile("Link clicks", num(t.clicks), "On your short links"),
      tile("Sign-ups", num(t.signups), `Accounts opened ${period}`), tile("Made something", num(t.made), t.signups ? `${Math.round((t.made / t.signups) * 100)}% of the sign-ups` : null),
      tile("Paying", num(t.paying), t.signups ? `${Math.round((t.paying / t.signups) * 100)}% of the sign-ups` : null), tile("Money", moneyOf(t.paid), "What these accounts paid so far")),
    ready.length ? card("Your links, ready to paste", "Copy one when you want to use it. Until a link is in a bio, a DM or a story, it counts nothing.", h("div", { class: "list" }, ready)) : null,
    form,
    card("By network", "Sign-ups are the accounts opened in this period. Made something, Paying and Money are what those accounts did since. Guessed: the in-app browser sent no address, so the network was read from the browser's name.",
      channelRows.length ? h("div", { class: "adm-ftable" }, tableHead("Network"), channelRows) : empty("No visit or account in this period.")),
    card("By link", r.links?.length ? `${count(r.links.length, "link")}. Clicks and first visits ${period}.` : "No short link yet. Make one above.",
      linkRows.length ? h("div", { class: "adm-ftable links" }, tableHead("Link"), linkRows) : null,
      hiddenCount ? h("button", { class: "btn btn-quiet btn-sm adm-more", onclick: () => { SQ.hidden = !SQ.hidden; reload(); } }, SQ.hidden ? "Leave out hidden links" : `Show ${count(hiddenCount, "hidden link")}`) : null),
    r.others?.length ? card("Other sites", "The sites behind “Other sites”, by sign-ups.", h("div", { class: "list" }, r.others.map((o) => h("div", { class: "row" }, icon("globe", 19),
      h("div", { class: "lbl" }, h("b", { class: "mono" }, o.label)), h("span", { class: "val" }, count(o.signups, "sign-up")))))) : null,
    card("Newest accounts", "Where each one came from.", newest.length ? h("div", { class: "list" }, newest) : empty("No account in this period.")),
    card("How Sources works", null, h("ol", { class: "adm-steps adm-how" }, HOW_SOURCES.map((x) => h("li", {}, x)))),
    r.tracking ? h("p", { class: "adm-foot" }, `Recording since ${stamp(r.tracking)}. A first visit is kept in one cookie for ${7} days, then forgotten.`) : null);
}

// ── Creations ────────────────────────────────────────────────────────────────────────────────────────────────────
const CQ = { tab: "recent", status: "all", kind: "all", days: 7, spendDays: 30 };
async function creationsPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" });
  const tabs = seg([["recent", "Recent"], ["failures", "Failures"], ["spend", "Cost"]], CQ.tab, (k) => { CQ.tab = k; creationsPage(main); });
  K.fill(opts.into || main, head("Creations", "Every account's videos, pictures and apps.", refreshBtn(() => creationsPage(main))), tabs, body);
  if (CQ.tab === "failures") return failuresTab(body, main);
  if (CQ.tab === "spend") return spendTab(body, main);
  const grid = h("div", { class: "adm-gens" }, loading());
  const more = h("button", { class: "btn btn-quiet adm-more", style: { display: "none" } }, "Show more");
  K.fill(body, chips([["all", "All"], ["done", "Done"], ["failed", "Failed"], ["running", "Running"]], CQ.status, (k) => { CQ.status = k; creationsPage(main); }),
    chips([["all", "Every kind"], ["video", "Videos"], ["image", "Pictures"], ["tool", "Apps"], ["film", "Films"]], CQ.kind, (k) => { CQ.kind = k; creationsPage(main); }), grid, more);
  let before = "";
  const load = async (reset) => {
    more.disabled = true;
    try {
      const p = new URLSearchParams({ ...(CQ.status !== "all" ? { status: CQ.status } : {}), ...(CQ.kind !== "all" ? { kind: CQ.kind } : {}), ...(before ? { before } : {}) });
      const r = await call(`/api/admin/generations?${p}`);
      if (reset) K.fill(grid);
      grid.append(...r.generations.map((g) => genCard(g, true)));
      if (reset && !r.generations.length) K.fill(grid, empty("Nothing here."));
      before = r.generations.at(-1)?.created_at || before;
      more.style.display = r.more ? "" : "none";
    } catch (e) { failed(grid, e, () => load(true)); }
    more.disabled = false;
  };
  more.addEventListener("click", () => { LIVE.hold = true; load(false); });
  await load(true);
}
async function failuresTab(body, main) {
  K.fill(body, seg([[1, "24 hours"], [7, "7 days"], [30, "30 days"]], CQ.days, (k) => { CQ.days = k; creationsPage(main); }), loading());
  let r;
  try { r = await call(`/api/admin/failures?days=${CQ.days}`); } catch (e) { return failed(body, e, () => creationsPage(main)); }
  body.lastChild.remove();
  body.append(r.groups.length ? card(`${num(r.total)} failed`, "Grouped by what went wrong and where.", h("div", { class: "list" }, r.groups.map((g) => h("div", { class: "row adm-fail" },
    h("div", { class: "adm-fail-n" }, num(g.count)),
    h("div", { class: "lbl" }, h("b", {}, g.kind, pill(PROVIDER[g.provider] || g.provider, "")), h("span", {}, `${g.users} ${g.users === 1 ? "account" : "accounts"} · last ${ago(g.last)} · ${g.models.map(modelName).join(", ")}`),
      g.sample ? h("p", { class: "adm-fail-s" }, g.sample) : null))))) : card("Nothing failed", `No failed creation in the last ${CQ.days === 1 ? "24 hours" : `${CQ.days} days`}.`),
    h("button", { class: "btn btn-quiet adm-more", onclick: () => { CQ.tab = "recent"; CQ.status = "failed"; creationsPage(main); } }, "See every failed creation", icon("right", 15)));
}
async function spendTab(body, main) {
  K.fill(body, seg([[1, "24 hours"], [7, "7 days"], [30, "30 days"], [0, "All time"]], CQ.spendDays, (k) => { CQ.spendDays = k; creationsPage(main); }), loading());
  let r;
  try { r = await call(`/api/admin/spend?days=${CQ.spendDays}`); } catch (e) { return failed(body, e, () => creationsPage(main)); }
  body.lastChild.remove();
  body.append(card(`${usd(r.usd)} provider cost`, "What each account cost Kleo at the providers, next to what it paid.", r.users.length ? h("div", { class: "list" }, r.users.map((u) =>
    h("button", { class: "row", onclick: () => openUser(u.id) }, avatar({ id: u.id, email: u.email }),
      h("div", { class: "lbl" }, h("b", {}, u.email || u.id, u.admin ? pill("Admin", "info") : null), h("span", {}, `${count(u.gens, "creation")} · ${num(u.failed)} failed · ${count(u.credits, "credit")} · last ${ago(u.last)}`)),
      h("span", { class: "val adm-cost" }, h("b", {}, usd(u.usd)), h("span", { class: u.paid_cent ? "paid" : "" }, u.paid_cent ? `paid ${money(u.paid_cent, u.currency)}` : "never paid"))))) : empty("Nothing made in that time.")));
}

// ── Providers & keys ─────────────────────────────────────────────────────────────────────────────────────────────
async function balancesInto(box, data) {
  let r = data;
  if (!r) { try { r = await call("/api/admin/providers"); } catch (e) { K.fill(box, empty(e.message || "Balances didn't load.")); return null; } }
  K.fill(box, r.balances.map((b) => {
    // A figure from an old refusal is history, not the balance: shown as unknown, with what it said and when.
    const known = b.usd !== null && !b.stale;
    const said = b.source === "live" ? "Live, read just now" : b.source === "last_read" ? `Read ${ago(b.at)}`
      : b.source === "last_refusal" ? (b.stale ? `Unknown now. Its last refusal said ${usd(b.usd)}, ${ago(b.at)}.` : `From its refusal ${ago(b.at)}`) : b.error;
    return h("div", { class: `adm-balance${known && b.usd < 5 ? " low" : ""}${b.paused ? " low" : ""}` },
      h("span", { class: "adm-tile-l" }, b.name), h("b", {}, known ? usd(b.usd) : "Unknown"),
      h("span", { class: "adm-tile-s" }, said, b.paused ? " · orders on it are paused" : ""));
  }));
  return r;
}
async function providersPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("Providers", "Balances, which keys are set, and the app's settings.", refreshBtn(() => providersPage(main))), body);
  let r;
  try { r = await call("/api/admin/providers"); } catch (e) { return failed(body, e, () => providersPage(main)); }
  const bal = h("div", { class: "adm-bal" });
  balancesInto(bal, r);
  K.fill(body,
    card("Balances", r.secrets.some((s) => s.name === "EPHONE_ADMIN_KEY" && s.set)
      ? "Read live from each provider; this page updates itself. Under $5 shows in red."
      : "WaveSpeed and APIMart are read live. ePhone needs its read-only admin key (EPHONE_ADMIN_KEY) to be read live; without it Kleo knows only what ePhone said when it last refused an order. Under $5 shows in red.", bal),
    card("Keys", "Only the names: a key's value never leaves the Worker.", h("div", { class: "list" }, r.secrets.map((s) => h("div", { class: "row" }, icon("key", 19),
      h("div", { class: "lbl" }, h("b", { class: "mono" }, s.name), h("span", {}, s.purpose)), s.set ? pill("Set", "ok") : pill("Not set", "")))),
      h("button", { class: "btn btn-quiet btn-sm adm-more", onclick: () => K.go("/admin/keys") }, "Change a key", icon("right", 15))),
    card("Settings", "The Worker's settings as deployed (wrangler.studio.jsonc).", kv(r.settings.map((s) => [s.name, h("span", { class: "mono" }, s.value === null || s.value === "" ? "—" : s.value)]))),
    card("Address lookup", r.lookup ? "On: past sign-ins can be looked up in Cloudflare's logs from each account's timeline." : "Off: add the CF_ANALYTICS_TOKEN secret (a Cloudflare API token with Analytics read on kleooai.com) to look up the address of sign-ins made before 23 October 2026."));
}

// ── API keys (23 October 2026, the owner: "una sezione per le key, in modo che posso cambiare le api key quando ho
// bisogno"): a new key is tried live by the Worker before it is kept, and no answer ever carries a key ─────────────
async function keysPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("API keys", "The keys Kleo uses to pay its providers. Change one here when you renew it.", refreshBtn(() => keysPage(main))), body);
  let r;
  try { r = await call("/api/admin/keys"); } catch (e) { return failed(body, e, () => keysPage(main)); }
  const reload = () => keysPage(main);
  const where = (k) => k.source === "console" ? `Changed here ${ago(k.setAt)}, ends in ${k.last4}`
    : k.source === "worker" ? `Worker secret, ends in ${k.last4}` : "Not set";
  async function test(k, btn) {
    btn.disabled = true;
    try {
      const t = await call(`/api/admin/keys/${k.name}/test`, { method: "POST", body: {} });
      t.ok ? K.toast(t.detail) : K.handleError(new AdminError(t.detail, 400, "key_test"));
    } catch (e) { oops(e); } finally { btn.disabled = false; }
  }
  async function change(k) {
    const v = await K.ask({ title: `Change ${k.name}`, ic: "key", ok: "Try and save",
      text: `${k.purpose}. Kleo tries the new key with the provider first and keeps it only if it works. Every Kleo server uses it within a minute.`,
      fields: [{ key: "value", label: "New key", type: "password", placeholder: "Paste the new key", required: true },
        { key: "reason", label: "Reason, kept in the audit log", placeholder: "Why you are changing it", required: true }] });
    if (!v) return;
    try { const res = await postFresh(`/api/admin/keys/${k.name}`, { value: v.value, reason: v.reason }); K.toast(`Saved. ${res.detail || ""}`.trim()); reload(); } catch (e) { oops(e); }
  }
  async function revert(k) {
    const v = await K.ask({ title: `Go back to the Worker secret?`, ic: "redo", ok: "Go back",
      text: `The key changed here is forgotten, and ${k.name} is again the one set with wrangler.`,
      fields: [{ key: "reason", label: "Reason, kept in the audit log", placeholder: "Why you are going back", required: true }] });
    if (!v) return;
    try { await postFresh(`/api/admin/keys/${k.name}/revert`, { reason: v.reason }); K.toast("Back to the Worker secret"); reload(); } catch (e) { oops(e); }
  }
  const row = (k) => {
    const tbtn = h("button", { class: "btn btn-quiet btn-sm", onclick: () => test(k, tbtn), disabled: k.source === "none" }, icon("check", 16), "Test");
    return h("div", { class: "adm-keyrow" },
      h("div", { class: "row" }, icon("key", 19),
        h("div", { class: "lbl" }, h("b", { class: "mono" }, k.name), h("span", {}, k.purpose), h("span", {}, where(k))),
        k.source === "console" ? pill("Changed here", "info") : k.source === "worker" ? pill("Set", "ok") : pill("Not set", "")),
      h("div", { class: "adm-actions" }, tbtn,
        h("button", { class: "btn btn-quiet btn-sm", onclick: () => change(k) }, icon("key", 16), "Change"),
        k.source === "console" ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => revert(k) }, icon("redo", 16), "Use Worker secret") : null));
  };
  K.fill(body,
    card("Provider keys", "A change needs a new code from your phone, is written in the audit log with the key's last 4 characters, and is mailed to you.",
      h("div", { class: "list" }, r.keys.map(row))),
    card("Changed only in a terminal", "These open payments and sign-ins, so the console can't change them. Run this in the kleo-mcp folder and paste the new value when asked:",
      h("div", { class: "list" }, r.terminalOnly.map((s) => h("div", { class: "row" }, icon("lock", 19), h("div", { class: "lbl" }, h("b", { class: "mono" }, s.name)), s.set ? pill("Set", "ok") : pill("Not set", "")))),
      h("div", { class: "adm-note" }, icon("lock", 17), h("span", {}, h("code", {}, "npx wrangler secret put NAME --config wrangler.studio.jsonc")))));
}

// ── emails: the welcome e-mails (src/studio/onboarding.ts, 27 October 2026) ──────────────────────────────────────
// The switch (on needs a new code from the phone: it writes to real people), what was sent and what comes next, and
// every e-mail readable as a new account gets it.
async function emailsPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("Emails", "The welcome e-mails every new account gets from Leonardo, at hello@kleooai.com.", refreshBtn(() => emailsPage(main))), body);
  let r;
  try { r = await call("/api/admin/emails"); } catch (e) { return failed(body, e, () => emailsPage(main)); }
  const reload = () => emailsPage(main);
  async function toggle() {
    if (r.on) {
      if (!(await K.ask({ title: "Turn the e-mails off?", text: "Nothing more is sent until you turn them on again. Every series waits where it is.", ok: "Turn off", ic: "pause" }))) return;
      try { await call("/api/admin/emails/mode", { method: "POST", body: { on: false } }); K.toast("Welcome e-mails are off"); reload(); } catch (e) { oops(e); }
      return;
    }
    const first = r.comeback ? `Kleo writes once to ${count(r.comeback.total, "account")} from the last 30 days that never paid, spread over the day, and` : "From now on";
    if (!(await K.ask({ title: "Turn the e-mails on?", text: `${first} every new account gets the 7-day series. They go out only between 9:00 and 20:00 where each person is.`, ok: "Turn on", ic: "play" }))) return;
    try { await postFresh("/api/admin/emails/mode", { on: true }); K.toast("Welcome e-mails are on"); reload(); } catch (e) { oops(e); }
  }
  async function preview(m) {
    let p;
    try { p = await call(`/api/admin/emails/preview?key=${encodeURIComponent(m.key)}`); } catch (e) { return oops(e); }
    // The e-mail's own HTML in a shadow root: its inline styles stay inside, the console's stay out.
    const host = h("div", { class: "adm-mail" });
    const doc = new DOMParser().parseFromString(p.html, "text/html");
    host.attachShadow({ mode: "open" }).innerHTML = `<div style="background:#ffffff;border-radius:12px;overflow:hidden">${doc.body.innerHTML}</div>`;
    K.sheet(p.subject, `${p.name}. Inbox preview: ${p.preheader}`, h("div", { class: "adm-sheet-body" }, host));
  }
  async function test(btn) {
    if (!(await K.ask({ title: "Send every e-mail to you?", text: `All ${r.mails.length} e-mails, as a sample account gets them, go to your own inbox. Nobody else gets anything.`, ok: "Send", ic: "check" }))) return;
    btn.disabled = true;
    try {
      const t = await call("/api/admin/emails/test", { method: "POST", body: {} });
      if (t.failed?.length) K.handleError(new AdminError(`${t.sent} sent, ${t.failed.length} refused. ${t.failed[0]}`, 400, "mail_test"));
      else K.toast(`${t.sent} e-mails sent to your inbox`);
      reload();
    } catch (e) { oops(e); } finally { btn.disabled = false; }
  }
  async function stopAddress() {
    const v = await K.ask({ title: "Stop one address", ic: "x", ok: "Stop it", text: "Kleo never writes to it again: no welcome e-mails and no outreach.",
      fields: [{ key: "email", label: "E-mail address", placeholder: "name@example.com", required: true }] });
    if (!v) return;
    try { await call("/api/admin/emails/suppress", { method: "POST", body: { email: v.email, on: true } }); K.toast("That address won't hear from Kleo again"); reload(); } catch (e) { oops(e); }
  }
  const sw = h("button", { class: "btn " + (r.on ? "btn-quiet" : "btn-primary"), onclick: toggle }, icon(r.on ? "pause" : "play", 17), r.on ? "Turn off" : "Turn on");
  const testBtn = h("button", { class: "btn btn-quiet btn-sm", onclick: () => test(testBtn) }, icon("mail", 16), "Send them all to me");
  const comeback = r.comeback && !r.on ? h("div", { class: "adm-note" }, icon("chat", 17), h("span", {},
    `Turning them on writes once to ${count(r.comeback.total, "account")} from the last 30 days that never paid` +
    (Object.keys(r.comeback.byMail).length ? `: ${Object.entries(r.comeback.byMail).map(([k, n]) => `${n} get "${k}"`).join(", ")}.` : ".") +
    " Every new account then gets the 7-day series.")) : null;
  const state = card("Welcome e-mails",
    r.on ? `On since ${stamp(r.since)}. From ${r.from}.` : r.since ? `Off. They were on from ${stamp(r.since)}; every series waits where it stopped.` : "Off. Nothing has been sent to anybody yet.",
    comeback, h("div", { class: "adm-actions" }, sw, pill(r.on ? "On" : "Off", r.on ? "ok" : "")));
  const upcoming = r.upcoming.map((x) => h("button", { class: "row", onclick: () => openUser(x.user_id) }, icon("clock", 19),
    h("div", { class: "lbl" }, h("b", {}, x.mail), h("span", {}, x.email)), h("span", { class: "val" }, stamp(x.next_at))));
  const recent = r.recent.map((x) => h("div", { class: "row" }, icon(x.ok ? "check" : "x", 19),
    h("div", { class: "lbl" }, h("b", {}, x.name, x.kind === "preview" ? pill("Preview", "info") : null, x.ok ? null : pill("Refused", "bad")),
      h("span", {}, x.ok ? x.email : `${x.email} · ${x.error}`)), h("span", { class: "val" }, ago(x.at))));
  const list = r.mails.map((m) => h("button", { class: "row", onclick: () => preview(m) }, icon("mail", 19),
    h("div", { class: "lbl" }, h("b", {}, m.name), h("span", {}, m.subject)), icon("right", 16)));
  K.fill(body,
    state,
    tiles(tile("Sent today", num(r.sent.today), `Up to ${num(r.dailyCap)} a day`), tile("Sent, 7 days", num(r.sent.week), `${num(r.sent.total)} in all`),
      tile("In a series", num(r.counts.active), `${num(r.counts.done)} finished · ${num(r.counts.stopped)} stopped`),
      tile("Unsubscribed", num(r.unsubscribed), `${num(r.bounced)} bounced`),
      tile("Paid after an e-mail", num(r.paidAfter), "Accounts that paid after their series began", r.paidAfter ? "ok" : ""),
      tile("Refused, 7 days", num(r.failures), "Sends Cloudflare said no to", r.failures ? "bad" : "")),
    card("The e-mails", "Tap one to read it as a new account gets it. Prices and the number of templates come from the live app.",
      h("div", { class: "list" }, list), h("div", { class: "adm-actions" }, testBtn, h("button", { class: "btn btn-quiet btn-sm", onclick: stopAddress }, icon("x", 16), "Stop one address"))),
    card("Coming up", upcoming.length ? "The next e-mails due, each in its person's daytime." : null,
      upcoming.length ? h("div", { class: "list" }, upcoming) : empty(r.on ? "Nothing is due right now." : "Nothing is scheduled while the e-mails are off.")),
    card("Sent", null, recent.length ? h("div", { class: "list" }, recent) : empty("Nothing sent yet.")));
}

// ── outreach: Kleo writes to agencies on its own (src/studio/outreach.ts, src/studio/scout.ts, 27 October 2026) ───
// The switch and what it waits for, the replies, the businesses (approve before anything is sent), the mailboxes Kleo
// sends from, the settings (postal address, trial credits, answering a "yes", the scout), the scout's numbers, which
// version of the first e-mail gets answered most, and a box to add businesses as CSV.
const OQ = { status: "new", q: "", offset: 0, form: null, csv: "", settings: null };
const OUT_STATUS = [["new", "To approve"], ["approved", "Approved"], ["active", "Writing to"], ["replied", "Replied"], ["done", "No answer"], ["stopped", "Stopped"], ["", "All"]];
const OUT_CLASS = { interested: ["Interested", "ok"], question: ["Question", "info"], not_interested: ["Not interested", ""], unsubscribe: ["Said no", ""],
  out_of_office: ["Out of office", ""], wrong_person: ["Wrong person", ""], bounce: ["Bounced", "bad"], other: ["Replied", "info"] };
const NEW_BOX = () => ({ id: "", fromName: "Leonardo", fromAddr: "", user: "", smtpHost: "smtp.gmail.com", smtpPort: "465", imapHost: "imap.gmail.com", imapPort: "993", dailyMax: "40", password: "" });
async function outreachPage(main, opts = {}) {
  const body = h("div", { class: "adm-stack" }, loading());
  K.fill(opts.into || main, head("Outreach", "Kleo finds agencies, writes to them from your mailboxes, follows up twice, answers a yes with a free trial, and reads every reply.", refreshBtn(() => outreachPage(main))), body);
  let r, list;
  try {
    [r, list] = await Promise.all([call("/api/admin/outreach"),
      call(`/api/admin/outreach/prospects?status=${encodeURIComponent(OQ.status)}&q=${encodeURIComponent(OQ.q)}&offset=${OQ.offset}`)]);
  } catch (e) { return failed(body, e, () => outreachPage(main)); }
  const reload = () => outreachPage(main);
  const c = r.counts || {};
  const n = (k) => Number(c[k] || 0);
  const field = (label, obj, key, extra = {}) => {
    const el = h("input", { class: "input", value: obj[key] ?? "", autocomplete: "off", spellcheck: "false", ...extra });
    el.addEventListener("input", () => { obj[key] = el.value; });
    return h("label", { class: "adm-field" }, h("span", {}, label), el);
  };
  const toggle = (label, sub, obj, key, onChange) => {
    const box = h("input", { type: "checkbox", checked: obj[key] ? "" : null });
    box.addEventListener("change", () => { obj[key] = box.checked; onChange?.(); });
    return h("label", { class: "consent adm-toggle" }, box, h("span", {}, h("b", {}, label), sub ? h("span", {}, ` ${sub}`) : null));
  };

  // The switch, and what it waits for.
  const check = (ok, text) => h("div", { class: "row" }, icon(ok ? "check" : "x", 19), h("div", { class: "lbl" }, h("b", {}, text)), pill(ok ? "Ready" : "Missing", ok ? "ok" : ""));
  async function onOff() {
    if (r.on) {
      try { await call("/api/admin/outreach/mode", { method: "POST", body: { on: false } }); K.toast("Outreach is off"); reload(); } catch (e) { oops(e); }
      return;
    }
    if (!(await K.ask({ title: "Start writing to agencies?", ok: "Start", ic: "send",
      text: `Kleo writes from ${count(r.ready.senders, "mailbox", "mailboxes")} to the ${count(r.ready.approved, "approved business", "approved businesses")}, 5 a day per mailbox to start, only Monday to Friday in their working hours, and follows up twice when nobody answers.` }))) return;
    try { await postFresh("/api/admin/outreach/mode", { on: true }); K.toast("Outreach is on"); reload(); } catch (e) { oops(e); }
  }
  async function test(id, btn) {
    btn.disabled = true;
    try { const t = await call("/api/admin/outreach/test", { method: "POST", body: { sender: id } }); K.toast(`Test sent to ${t.to}`); } catch (e) { oops(e); } finally { btn.disabled = false; }
  }
  const sw = h("button", { class: "btn " + (r.on ? "btn-quiet" : "btn-primary"), onclick: onOff, disabled: !r.on && !r.ready.ok }, icon(r.on ? "pause" : "send", 17), r.on ? "Turn off" : "Turn on");
  const paused = (r.mailboxes || []).filter((m) => m.status === "paused");
  const state = card("Outreach",
    r.on ? (paused.length ? `On, but ${paused.map((m) => m.fromAddr).join(", ")} refused to send: check its app password below.` : `On, from ${count(r.ready.senders, "mailbox", "mailboxes")}.`)
      : r.ready.ok ? "Off. Everything is ready." : "Off. It starts once these are ready:",
    r.on ? null : h("div", { class: "list" }, check(r.ready.senders > 0, r.ready.senders ? count(r.ready.senders, "mailbox", "mailboxes") : "A mailbox to send from"),
      check(r.ready.postal, "Postal address (the law wants it in every e-mail)"), check(r.ready.approved > 0, `${count(r.ready.approved, "approved business", "approved businesses")}`)),
    h("div", { class: "adm-actions" }, sw, pill(r.on ? "On" : "Off", r.on ? "ok" : "")));

  // The businesses: approve before anything is sent.
  async function act(p, action) {
    try { await call(`/api/admin/outreach/prospects/${p.id}`, { method: "POST", body: { action } }); K.toast(action === "approve" ? `${p.company} approved` : action === "reject" ? `${p.company} left out` : "Back to waiting"); reload(); } catch (e) { oops(e); }
  }
  async function approveAll() {
    if (!(await K.ask({ title: `Approve all ${n("new")} waiting?`, ok: "Approve all", ic: "check", text: "Each one publishes this address on its own site for business contact, in the US, Canada, the UK, Australia or New Zealand. Kleo writes to them only while outreach is on." }))) return;
    try { const a = await call("/api/admin/outreach/approve-new", { method: "POST", body: {} }); K.toast(`${a.approved} approved`); reload(); } catch (e) { oops(e); }
  }
  async function preview(p) {
    let v;
    try { v = await call(`/api/admin/outreach/preview?id=${encodeURIComponent(p.id)}`); } catch (e) { return oops(e); }
    const box = (title, sub, text) => h("section", { class: "adm-card" }, h("h2", {}, title), sub ? h("p", { class: "adm-sub" }, sub) : null, h("pre", { class: "adm-mailtext" }, text));
    K.sheet(p.company, `What ${p.email} gets. ${v.first.length > 1 ? "Kleo picks one version of the first e-mail, more often the one that gets more answers." : ""}`,
      h("div", { class: "adm-sheet-body" },
        v.first.map((w) => box(`First e-mail · ${w.name}`, w.subject, w.text)),
        box("Follow-up, 3 working days later", v.followUps[0].subject, v.followUps[0].text),
        box("Last one, 5 working days later", v.followUps[1].subject, v.followUps[1].text),
        box("Kleo's answer to a yes", null, v.yes)));
  }
  const search = h("input", { class: "input", value: OQ.q, placeholder: "Search a company, address or city", "aria-label": "Search", autocomplete: "off" });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") { OQ.q = search.value.trim(); OQ.offset = 0; reload(); } });
  const rows = list.prospects.map((p) => h("div", { class: "adm-keyrow" },
    h("div", { class: "row" }, h("span", { class: "adm-av" }, String(p.company || "?")[0].toUpperCase()),
      h("div", { class: "lbl" }, h("b", {}, p.company, " ", p.reply_class ? pill(...(OUT_CLASS[p.reply_class] || OUT_CLASS.other)) : null, p.converted_user ? pill("Signed up", "ok") : null,
          String(p.batch || "").startsWith("scout") ? pill("Scout", "") : null),
        h("span", {}, [p.email, [p.city, p.region, p.country].filter(Boolean).join(", "), p.contact_name].filter(Boolean).join(" · ")),
        p.reply_summary ? h("span", {}, `They said: ${p.reply_summary}`) : p.opener ? h("span", {}, `“${p.opener}”`) : null,
        h("span", {}, h("a", { class: "adm-a", href: p.source_url, target: "_blank", rel: "noopener noreferrer" }, `Address seen on ${String(p.source_url).replace(/^https:\/\/(www\.)?/, "").slice(0, 60)}`),
          p.step ? ` · ${count(Math.min(p.step, 3), "e-mail")} sent${p.next_at ? `, next ${stamp(p.next_at)}` : ""}` : "", p.stop_reason ? ` · ${p.stop_reason.replace(/_/g, " ")}` : ""))),
    h("div", { class: "adm-actions" },
      h("button", { class: "btn btn-quiet btn-sm", onclick: () => preview(p) }, icon("mail", 15), "Read the e-mails"),
      (p.status === "new" || p.status === "rejected") && !p.step ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => act(p, "approve") }, icon("check", 15), "Approve") : null,
      (p.status === "new" || p.status === "approved") && !p.step ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => act(p, "reject") }, icon("x", 15), "Leave out") : null)));
  const prospects = card("Businesses", `${num(n("new"))} waiting for you, ${num(n("approved"))} approved, ${num(n("active"))} being written to. Every address was seen on the business's own site; the link shows where.`,
    chips(OUT_STATUS.map(([k, label]) => [k, k ? `${label} ${num(n(k) + (k === "stopped" ? n("bounced") + n("invalid") : 0))}` : label]), OQ.status, (k) => { OQ.status = k; OQ.offset = 0; reload(); }),
    h("div", { class: "adm-actions" }, search, OQ.status === "new" && n("new") ? h("button", { class: "btn btn-primary btn-sm", onclick: approveAll }, icon("check", 16), `Approve all ${num(n("new"))}`) : null),
    rows.length ? h("div", { class: "list" }, rows) : empty("Nobody here."),
    list.more || OQ.offset ? h("div", { class: "adm-actions" },
      OQ.offset ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => { OQ.offset = Math.max(0, OQ.offset - 60); reload(); } }, "Previous") : null,
      list.more ? h("button", { class: "btn btn-quiet btn-sm", onclick: () => { LIVE.hold = true; OQ.offset += 60; reload(); } }, "Next 60") : null) : null);

  // The replies Kleo read.
  const replies = (r.replies || []).map((x) => h("div", { class: "row" }, icon(x.class === "interested" ? "star" : "chat", 19),
    h("div", { class: "lbl" }, h("b", {}, x.company || x.from_addr, " ", pill(...(OUT_CLASS[x.class] || OUT_CLASS.other))), h("span", {}, x.summary || x.subject || "")), h("span", { class: "val" }, ago(x.at))));

  // The mailboxes. The form keeps what was typed while the page refreshes itself.
  const F = (OQ.form ||= NEW_BOX());
  async function boxAction(m, action) {
    if (action === "remove" && !(await K.ask({ title: `Remove ${m.fromAddr}?`, ok: "Remove", danger: true, text: "Kleo forgets this mailbox and its password." }))) return;
    try { await call(`/api/admin/outreach/senders/${m.id}`, { method: "POST", body: { action } }); K.toast(action === "off" ? "Mailbox switched off" : action === "on" ? "Mailbox on again" : "Mailbox removed"); reload(); } catch (e) { oops(e); }
  }
  const edit = (m) => { OQ.form = { id: m.id, fromName: m.fromName, fromAddr: m.fromAddr, user: m.user, smtpHost: m.smtpHost, smtpPort: String(m.smtpPort), imapHost: m.imapHost, imapPort: String(m.imapPort), dailyMax: String(m.dailyMax), password: "" }; reload(); };
  const boxes = (r.mailboxes || []).map((m) => {
    const tbtn = h("button", { class: "btn btn-quiet btn-sm", onclick: () => test(m.id, tbtn) }, icon("mail", 15), "Send me a test");
    return h("div", { class: "adm-keyrow" },
      h("div", { class: "row" }, icon("mail", 19),
        h("div", { class: "lbl" }, h("b", {}, m.fromAddr, " ", pill(m.status === "active" ? "On" : m.status === "paused" ? "Paused" : "Off", m.status === "active" ? "ok" : m.status === "paused" ? "bad" : "")),
          h("span", {}, `Warm-up day ${m.warmupDay}: ${m.sentLastDay} of ${m.quota} sent in the last 24 hours, up to ${m.dailyMax} once warmed up. Password ends in ${m.passwordEnds}.`),
          m.pausedReason ? h("span", {}, `Refused: ${m.pausedReason}`) : null)),
      h("div", { class: "adm-actions" }, tbtn,
        h("button", { class: "btn btn-quiet btn-sm", onclick: () => edit(m) }, icon("wand", 15), "Change"),
        h("button", { class: "btn btn-quiet btn-sm", onclick: () => boxAction(m, m.status === "off" ? "on" : "off") }, icon(m.status === "off" ? "play" : "pause", 15), m.status === "off" ? "Switch on" : "Switch off"),
        h("button", { class: "btn btn-quiet btn-sm", onclick: () => boxAction(m, "remove") }, icon("trash", 15), "Remove")));
  });
  const saveBox = h("button", { class: "btn btn-primary", onclick: () => saveMailbox() }, icon("check", 17), F.id ? "Check and save" : "Check and add");
  async function saveMailbox() {
    saveBox.disabled = true;
    try {
      await postFresh("/api/admin/outreach/senders", { ...F, smtpPort: Number(F.smtpPort), imapPort: Number(F.imapPort), dailyMax: Number(F.dailyMax) });
      K.toast("Saved. Kleo signed in to send and to read.");
      OQ.form = null; reload();
    } catch (e) { oops(e); saveBox.disabled = false; }
  }
  const mailboxes = card("Mailboxes", "Each on a domain of its own (never kleooai.com or Gmail). Every mailbox warms up by itself, from 5 a day; add more to write to more businesses a day.",
    boxes.length ? h("div", { class: "list" }, boxes) : null,
    h("h2", { class: "adm-subhead" }, F.id ? `Change ${F.fromAddr}` : "Add a mailbox"),
    h("div", { class: "adm-form2" }, field("Your name in the From line", F, "fromName"), field("Address", F, "fromAddr", { placeholder: "leo@yourdomain.com", inputmode: "email" })),
    h("div", { class: "adm-form2" }, field("Sign-in name", F, "user", { placeholder: "Usually the address" }), field("App password", F, "password", { type: "password", placeholder: F.id ? "Leave empty to keep it" : "16 characters, from the mailbox's settings" })),
    h("div", { class: "adm-form2" }, field("Sending server", F, "smtpHost"), field("Port", F, "smtpPort", { inputmode: "numeric" })),
    h("div", { class: "adm-form2" }, field("Reading server", F, "imapHost"), field("Port", F, "imapPort", { inputmode: "numeric" })),
    field("Most e-mails in a day, once warmed up (5 to 60)", F, "dailyMax", { inputmode: "numeric" }),
    h("div", { class: "adm-note" }, icon("lock", 17), h("span", {}, "Google Workspace: smtp.gmail.com 465 and imap.gmail.com 993, an app password from myaccount.google.com/apppasswords (2-step verification on). Kleo signs in to both before it keeps anything, and seals the password.")),
    h("div", { class: "adm-actions" }, saveBox, F.id ? h("button", { class: "btn btn-quiet", onclick: () => { OQ.form = null; reload(); } }, "Cancel") : null));

  // The settings.
  const S2 = (OQ.settings ||= { ...r.settings, trialCredits: String(r.settings.trialCredits), scoutDaily: String(r.settings.scoutDaily) });
  const saveSet = h("button", { class: "btn btn-primary", onclick: () => saveSettings() }, icon("check", 17), "Save");
  async function saveSettings() {
    saveSet.disabled = true;
    try {
      await postFresh("/api/admin/outreach/settings", { ...S2, trialCredits: Number(S2.trialCredits), scoutDaily: Number(S2.scoutDaily) });
      K.toast("Settings saved"); OQ.settings = null; reload();
    } catch (e) { oops(e); saveSet.disabled = false; }
  }
  const settings = card("Settings", null,
    field("Postal address, in every e-mail's footer", S2, "postal", { placeholder: "A street address or PO box, with the country" }),
    field("Free credits for a business that signs up through its link (0 to 200)", S2, "trialCredits", { inputmode: "numeric" }),
    toggle("Answer a yes by itself", "with the business's personal link to sign up and get those credits.", S2, "autoReply"),
    toggle("Look for new businesses every day (the scout)", "with Cloudflare's web search, from your AI Gateway credits.", S2, "scoutOn"),
    field("Searches a day (5 to 200)", S2, "scoutDaily", { inputmode: "numeric" }),
    toggle("Approve the scout's finds by itself", "instead of waiting for you here. Each one is still checked: its address on its own site, its work, its country.", S2, "autoApprove"),
    h("div", { class: "adm-actions" }, saveSet));

  // The scout's numbers.
  const sc = r.scout || {};
  const scout = card("Scout", r.settings.scoutOn ? `On: up to ${r.settings.scoutDaily} searches a day, ${sc.today} today.` : "Off. Switch it on in Settings.",
    tiles(tile("Found", num(sc.added), `${num(sc.addedWeek)} this week`), tile("Websites checked", num(sc.checked), `${num(sc.queued)} waiting to be checked`)),
    sc.lastError ? h("div", { class: "adm-note bad" }, icon("x", 17), h("span", {}, `Last trouble: ${sc.lastError}. If it says the AI Gateway credit balance is zero, add credits in Cloudflare: AI, AI Gateway, Credits.`)) : null,
    h("div", { class: "adm-note" }, icon("globe", 17), h("span", {}, "One search costs $0.00025 (30 a day is about $0.25 a month); reading the websites with Workers AI is about $3 to $4 a month at that pace.")));

  // Which version of the first e-mail gets answered.
  const versions = (r.variants || []).map((v) => h("div", { class: "row" }, icon("chat", 19),
    h("div", { class: "lbl" }, h("b", {}, v.name), h("span", {}, `${num(v.sent)} sent, ${num(v.answered)} answered${v.sent ? ` (${Math.round((v.answered / v.sent) * 100)}%)` : ""}`))));
  const learning = card("Which first e-mail works", "Kleo sends each new business one of these, more often the one that gets more answers.", h("div", { class: "list" }, versions));

  // More businesses, as CSV.
  const csv = h("textarea", { class: "input adm-csv", rows: 5, placeholder: "company,website,email,source_url,country,state,city,contact_first_name,type,opener" }, OQ.csv);
  csv.addEventListener("input", () => { OQ.csv = csv.value; });
  async function importCsv() {
    try {
      const res = await call("/api/admin/outreach/import", { method: "POST", body: { csv: OQ.csv, batch: "console" } });
      K.toast(`${res.added} added${res.skipped.length ? `, ${res.skipped.length} skipped (${res.skipped[0].why})` : ""}`);
      if (res.added) { OQ.csv = ""; reload(); }
    } catch (e) { oops(e); }
  }
  const add = card("Add businesses", "One per line, with a header line. source_url is the page on their own site where the address is published: without it a line is skipped. Only US, CA, GB, AU and NZ.",
    csv, h("div", { class: "adm-actions" }, h("button", { class: "btn btn-quiet btn-sm", onclick: importCsv }, icon("plus", 16), "Add")));

  const sends = (r.sends || []).map((x) => h("div", { class: "row" }, icon(x.ok ? "check" : "x", 19),
    h("div", { class: "lbl" }, h("b", {}, x.company || x.email, " ", pill(x.step === 0 ? "First" : x.step === 1 ? "Follow-up" : x.step === 9 ? "Answer to a yes" : "Last", "")),
      h("span", {}, [x.ok ? x.email : `${x.email} · ${x.error}`, x.sender ? `from ${x.sender}` : null].filter(Boolean).join(" · "))), h("span", { class: "val" }, ago(x.at))));

  K.fill(body,
    state,
    tiles(tile("To approve", num(n("new")), "Waiting for you"), tile("Being written to", num(n("active")), `${num(n("approved"))} approved, not started`),
      tile("Contacted", num(r.contacted), "Got at least the first e-mail"), tile("Replied", num(r.replied), r.contacted ? `${Math.round((r.replied / r.contacted) * 100)}% of those contacted` : null, r.replied ? "ok" : ""),
      tile("Signed up", num(r.signedUp), "Through their personal link", r.signedUp ? "ok" : ""), tile("Paying", num(r.paying), "Of those that signed up", r.paying ? "ok" : "")),
    card("Replies", replies.length ? "Kleo reads every mailbox each 15 minutes, stops writing to anyone who answered, answers a yes by itself and e-mails you about every real answer." : null,
      replies.length ? h("div", { class: "list" }, replies) : empty("No reply yet.")),
    prospects, mailboxes, settings, scout, learning, add,
    card("Sent", null, sends.length ? h("div", { class: "list" }, sends) : empty("Nothing sent yet.")));
}

// ── demo data (?demo=1): nothing here is real ────────────────────────────────────────────────────────────────────
let D = null;
function demoDb() {
  if (D) return D;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pickOf = (a) => a[Math.floor(rnd() * a.length)];
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const names = ["Ana Lima", "Marco Bianchi", "Sofia Rossi", "Liam O'Brien", "Yuki Tanaka", "Lena Weber", "Noah Smith", "Chloé Martin", "Diego Ruiz", "Aisha Khan", "Tom Becker", "Elena Popescu",
    "Jonas Berg", "Mia Novak", "Omar Haddad", "Grace Kim", "Lucas Silva", "Hana Sato", "Ivan Petrov", "Emma Jones", "Pablo Gómez", "Zoe Clarke"];
  const places = [["DE", "Berlin", "Berlin"], ["IT", "Milan", "Lombardy"], ["US", "Austin", "Texas"], ["GB", "London", "England"], ["JP", "Osaka", "Osaka"], ["BR", "São Paulo", "São Paulo"],
    ["FR", "Lyon", "Auvergne-Rhône-Alpes"], ["IN", "Pune", "Maharashtra"], ["NZ", "Auckland", "Auckland"], ["ES", "Valencia", "Valencia"], ["CA", "Toronto", "Ontario"], ["AU", "Sydney", "New South Wales"]];
  const uas = ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15", "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"];
  const nets = [["Deutsche Telekom AG", 3320], ["Vodafone Italia", 30722], ["Comcast Cable", 7922], ["BT", 2856], ["NTT", 4713], ["Claro", 28573], ["Orange", 3215], ["Jio", 55836], ["Spark New Zealand", 4771]];
  const VIDS = ["https://kleooai.com/samples/shot-dunes.mp4", "https://kleooai.com/samples/realistic-tether.mp4", "https://kleooai.com/samples/animation-octopus.mp4", "https://kleooai.com/samples/shot-moon.mp4"];
  const PICS = ["https://kleooai.com/samples/realistic-tether.jpg", "https://kleooai.com/samples/shot-moon.jpg", "https://kleooai.com/samples/animation-octopus.jpg", "https://kleooai.com/samples/shot-dunes.jpg"];
  const MODELS = [["seedance-2.5", "video", 0.86], ["seedance-2.0-fast", "video", 0.24], ["veo-3.1-fast", "video", 0.64], ["nano-banana-2", "image", 0.04], ["flux-2-pro", "image", 0.06], ["face-swap", "tool", 0.05], ["kleo-film", "film", 1.9]];
  const ERRORS = [["Our generation engine is being recharged. Your credits are back — please try again in a little while.", "ephone"],
    ["Seedance 2.5 won't make this one: it recognised characters, people or music protected by copyright. Your credits are back.", "ephone"],
    ["The picture is too small for this model: use one at least 300 pixels on its short side.", "ephone"], ["The provider took too long and the clip was cancelled. Your credits are back.", "apimart"]];
  const users = [], payments = [], gens = [], ips = [], audit = [];
  let aid = 1;
  names.forEach((name, i) => {
    const id = `u_demo${String(i).padStart(2, "0")}${"abcdefgh"[i % 8]}`;
    const [country, city, region] = places[i % places.length];
    const created = iso((i * 2.6 + rnd()) * 86400e3);
    const ip = i % 3 === 0 ? `2001:db8:${(i * 37).toString(16)}:1::${i + 10}` : `${["192.0.2", "198.51.100", "203.0.113"][i % 3]}.${10 + i * 7}`;
    const net = nets[i % nets.length];
    const u = { id, name: i % 4 === 3 ? null : name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`, credits: Math.floor(rnd() * 120), plan: i === 2 ? "pro" : "trial", plan_period: i === 2 ? "month" : null,
      plan_until: i === 2 ? iso(-20 * 86400e3) : null, plan_status: i === 2 ? "active" : null, created_at: created, src: pickOf(["studio", "tiktok", "x", null]), merged_into: null,
      blocked_at: i === 9 ? iso(86400e3) : null, blocked_reason: i === 9 ? "Card testing from many cards" : null, ip_hash: `demo_hash_${i}`, deleted: 0, anonymous: 0,
      methods: i % 5 === 0 ? "password" : "google", gift: i % 6 === 5 ? 0 : 5, key_version: i % 7 === 0 ? 1 : 0, account_email: null };
    users.push(u);
    ips.push({ id: aid++, user_id: id, at: created, event: "signup", ip, ip_hash: u.ip_hash, country, region, city, asn: net[1], as_org: net[0], ua: uas[i % uas.length] });
    if (i % 2 === 0) ips.push({ id: aid++, user_id: id, at: iso(rnd() * 3 * 86400e3), event: "signin", ip, ip_hash: u.ip_hash, country, region, city, asn: net[1], as_org: net[0], ua: uas[i % uas.length] });
    audit.push({ id: aid++, at: created, user_id: id, event: "user.created", job_id: null, detail: JSON.stringify({ via: "studio", credits: u.gift, ip: u.ip_hash }) });
    if (i % 3 !== 1) {
      const n = 1 + (i % 3);
      for (let k = 0; k < n; k++) {
        const cents = pickOf([500, 1500, 4000, 900, 1900]);
        const at = iso(((i * 2.6 + rnd()) * 86400e3) * (k + 1) / (n + 1));
        payments.push({ session_id: `cs_live_demo${i}${k}`, user_id: id, credits: Math.round(cents / 40), amount_cent: cents, currency: "eur", email: u.email, payment_intent: `pi_demo${i}${k}`, status: i === 5 && k === 0 ? "refunded" : i === 8 && k === 1 ? "disputed" : "paid", country, event_type: "checkout.session.completed", at });
        audit.push({ id: aid++, at, user_id: id, event: "credits.purchased", job_id: null, detail: JSON.stringify({ credits: Math.round(cents / 40), amount_cent: cents, currency: "eur" }) });
      }
    }
    const m = 2 + (i % 5);
    for (let k = 0; k < m; k++) {
      const [model, kind, cost] = pickOf(MODELS);
      const fail = rnd() < 0.22;
      const [err, provider] = pickOf(ERRORS);
      const at = iso(rnd() * 9 * 86400e3);
      const gid = `g_demo${i}x${k}`;
      gens.push({ id: gid, user_id: id, email: u.email, kind, model, status: fail ? "failed" : k === 0 && i === 1 ? "running" : "done", credits: Math.max(1, Math.round(cost * 6)), est_usd: cost, refunded: fail, error: fail ? err : null,
        prompt: pickOf(["A lone rider crosses golden dunes at sunset", "An astronaut floats outside a space station", "A playful octopus explores a coral reef", "A giant moon rises over a calm sea"]),
        created_at: at, finished_at: fail ? at : iso(Date.now() - Date.parse(at) - 90e3), provider: fail ? provider : pickOf(["ephone", "ephone", "apimart", "wavespeed"]),
        outputs: fail ? [] : kind === "image" || model === "face-swap" ? [{ type: "image", url: pickOf(PICS) }] : [{ type: "video", url: pickOf(VIDS) }],
        settings: kind === "image" ? { quality: "2K", aspect: "1:1", count: 1 } : { resolution: "720p", duration: 5, aspect: "16:9" } });
      audit.push({ id: aid++, at, user_id: id, event: "studio.create", job_id: gid, detail: JSON.stringify({ model, credits: Math.round(cost * 6), usd: cost }) });
      if (fail) audit.push({ id: aid++, at, user_id: id, event: "studio.failed", job_id: gid, detail: JSON.stringify({ why: err }) });
    }
  });
  users[0].name = "You (owner)"; users[0].email = "owner@example.com"; users[0].admin = true;
  // The console's own door: ?demo=enroll shows the first set-up, ?demo=signin the code screen; 123456 is the demo code.
  const auth = { enrolled: DEMO_MODE !== "enroll", signedIn: DEMO_MODE !== "enroll" && DEMO_MODE !== "signin", recovery: 8, fresh: 0, wrong: 0, enrolledAt: iso(12 * 86400e3) };
  D = { auth, users, payments, gens, ips, audit, aid, blocks: [{ ip_hash: "demo_hash_9", reason: "admin: farm of accounts", until: iso(-25 * 86400e3), created_at: iso(5 * 86400e3) }] };
  return D;
}
function demoUser(u) {
  const db = demoDb();
  const pays = db.payments.filter((p) => p.user_id === u.id && p.status === "paid");
  const g = db.gens.filter((x) => x.user_id === u.id);
  const ip = db.ips.filter((x) => x.user_id === u.id).sort((a, b) => b.at.localeCompare(a.at))[0];
  const seen = [ip?.at, ...g.map((x) => x.created_at)].filter(Boolean).sort().at(-1) || u.created_at;
  return { ...u, paid_cent: pays.reduce((a, p) => a + p.amount_cent, 0), currency: pays.length ? "eur" : null, gens: g.length, spend_usd: g.filter((x) => x.status !== "failed").reduce((a, x) => a + x.est_usd, 0),
    ip: ip?.ip ?? null, city: ip?.city ?? null, region: ip?.region ?? null, country: ip?.country ?? null, last_seen: seen };
}
const DEMO_CHANNELS = ["tiktok", "instagram", "tiktok", "instagram", "chatgpt", "google", "direct", "youtube", "x", "site", "untracked"];
function demoLinks() {
  const db = demoDb();
  db.links ??= [["ig-bio", "instagram", "Instagram bio", "/", 9, 412], ["tt-bio", "tiktok", "TikTok bio", "/", 9, 655], ["tt-lupin-paris-fire-dance", "tiktok", "Lupin Paris Fire Dance", "/templates", 3, 233],
    ["ig-michael-scott-quinceanera", "instagram", "Michael Scott quinceañera", "/templates", 3, 141], ["dm", "dm", "Comment KLEO replies", "/", 2, 37]]
    .map(([code, channel, label, target, d, clicks]) => ({ code, channel, label, target, created_at: new Date(Date.now() - d * 86400e3).toISOString(), archived_at: null, clicks }));
  return db.links;
}
function demoAttribution(u) {
  const i = Number(u.id.slice(6, 8)) || 0;
  if (i > 16) return null;
  const channel = DEMO_CHANNELS[i % DEMO_CHANNELS.length];
  const link = demoLinks().find((l) => l.channel === channel && i % 2 === 0) || null;
  return { channel, guessed: !link && (channel === "instagram" || channel === "tiktok") ? 1 : 0, link_code: link?.code ?? null, link_label: link?.label ?? null,
    utm_source: link ? channel : null, utm_medium: link ? "social" : null, utm_campaign: link?.code ?? null, utm_content: null, src: null,
    ref_host: channel === "chatgpt" ? "chatgpt.com" : channel === "google" ? "google.com" : channel === "site" ? "kleooai.com" : null,
    landing: link?.target ?? "/", in_app: channel === "instagram" || channel === "tiktok" ? channel : null, first_seen_at: u.created_at };
}
function demoSources(p, q, b) {
  const db = demoDb();
  const links = demoLinks();
  const base = "https://app.kleooai.com";
  const out = (l) => ({ ...l, url: `${base}/r/${l.code}`, archived: !!l.archived_at });
  if (p === "/api/admin/sources/links") {
    if (!LINK_NETS.some(([k]) => k === b.channel)) throw new AdminError("Pick the network the link is for.", 400, "channel");
    const slug = String(b.label || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    const code = String(b.code || "").toLowerCase() || `${{ instagram: "ig", tiktok: "tt", x: "x", youtube: "yt", dm: "dm", other: "go" }[b.channel]}-${slug || "link"}`;
    if (links.some((l) => l.code === code)) throw new AdminError("That code is taken. Pick another one.", 409, "code_taken");
    const l = { code, channel: b.channel, label: b.label, target: b.target || "/", created_at: new Date().toISOString(), archived_at: null, clicks: 0 };
    links.unshift(l);
    return { link: out(l) };
  }
  const lm = p.match(/^\/api\/admin\/sources\/links\/([a-z0-9-]+)$/);
  if (lm) {
    const l = links.find((x) => x.code === lm[1]);
    if (!l) throw new AdminError("No short link with that code.", 404, "not_found");
    if (b.label !== undefined) l.label = b.label;
    if (b.target !== undefined) l.target = b.target;
    if (b.archived !== undefined) l.archived_at = b.archived ? new Date().toISOString() : null;
    return { link: out(l) };
  }
  const days = Number(q.get("days") ?? 30);
  const inPeriod = (iso) => !days || Date.now() - Date.parse(iso) < days * 86400e3;
  const blank = () => ({ visits: 0, clicks: 0, signups: 0, guessed: 0, made: 0, paying: 0, paid: {} });
  const ch = new Map(), bl = new Map();
  const get = (m, k) => { if (!m.has(k)) m.set(k, blank()); return m.get(k); };
  const users = db.users.filter((u) => !u.admin && inPeriod(u.created_at)).map((u) => ({ u: demoUser(u), a: demoAttribution(u) }));
  for (const { u, a } of users) {
    for (const r of [get(ch, a ? a.channel : "before"), ...(a?.link_code ? [get(bl, a.link_code)] : [])]) {
      r.signups++; if (a?.guessed) r.guessed++; if (u.gens) r.made++;
      if (u.paid_cent) { r.paying++; r.paid.eur = (r.paid.eur || 0) + u.paid_cent; }
    }
  }
  const f = days ? Math.min(1, days / 30) : 1.4;
  for (const [k, n] of [["tiktok", 820], ["instagram", 515], ["chatgpt", 78], ["google", 14], ["direct", 160], ["youtube", 3], ["x", 0], ["site", 40]]) get(ch, k).visits += Math.round(n * f);
  for (const l of links) { const r = get(bl, l.code); r.clicks = Math.round(l.clicks * f); r.visits = Math.round(l.clicks * f * 0.7); get(ch, l.channel).clicks += r.clicks; }
  const total = blank();
  for (const r of ch.values()) { for (const k of ["visits", "clicks", "signups", "guessed", "made", "paying"]) total[k] += r[k]; total.paid.eur = (total.paid.eur || 0) + (r.paid.eur || 0); }
  return {
    days, tracking: new Date(Date.now() - 9 * 86400e3).toISOString(), base, total,
    channels: [...ch.entries()].map(([channel, r]) => ({ channel, ...r })).sort((x, y) => y.signups - x.signups || y.visits - x.visits),
    links: links.map((l) => ({ ...out(l), clicks_all: l.clicks, ...(bl.get(l.code) || blank()) })),
    others: [{ label: "linktr.ee", signups: 1 }],
    newest: users.slice().sort((x, y) => y.u.created_at.localeCompare(x.u.created_at)).slice(0, 12)
      .map(({ u, a }) => ({ id: u.id, name: u.name, email: u.email, created_at: u.created_at, channel: a ? a.channel : "before", guessed: a?.guessed, link_code: a?.link_code, link_label: a?.link_label, ref_host: a?.ref_host, landing: a?.landing, paid: u.paid_cent ? { eur: u.paid_cent } : null })),
  };
}
/** The Emails page on fake data (?demo=1). */
const DEMO_MAILS = { on: false };
function demoEmails(p, q, b) {
  const names = [["w0-welcome", "Day 1 · Welcome", "Welcome to Kleo, Alex"], ["w1-templates", "Day 2 · Templates", "Day 2 of 7: Put yourself in a viral video"],
    ["w2-prompts", "Day 3 · Prompts", "Day 3 of 7: Prompts that look like film"], ["rescue", "Rescue · first try failed", "Your first video didn't come out"]];
  if (p === "/api/admin/emails/mode") { DEMO_MAILS.on = !!b.on; DEMO_MAILS.since ??= new Date().toISOString(); return { ok: true, on: DEMO_MAILS.on }; }
  if (p === "/api/admin/emails/test") return { sent: names.length, failed: [] };
  if (p === "/api/admin/emails/suppress") return { ok: true };
  if (p === "/api/admin/emails/preview") {
    const n = names.find((x) => x[0] === q.get("key")) || names[0];
    return { key: n[0], name: n[1], subject: n[2], preheader: "Your first video is one sentence away.",
      html: `<p style="font:16px/1.6 -apple-system,sans-serif;padding:24px;color:#111">Hi Alex,<br><br>This is a demo of <b>${n[1]}</b>.</p>`, text: "" };
  }
  const iso = (m) => new Date(Date.now() - m * 60_000).toISOString();
  return { on: DEMO_MAILS.on, since: DEMO_MAILS.since || null, from: "Leonardo from Kleo <hello@kleooai.com>", dailyCap: 300,
    counts: { active: 18, done: 4, stopped: 2, welcome: 9, comeback: 15 }, sent: { today: 6, week: 41, total: 41 }, failures: 0, unsubscribed: 1, bounced: 1, paidAfter: 2,
    comeback: DEMO_MAILS.since ? null : { total: 31, byMail: { "Comeback · nothing made yet": 22, "Comeback · first try failed": 6, "Comeback · made something": 3 } },
    upcoming: [{ user_id: "u_demo1", email: "ana@example.com", mail: "Day 3 · Prompts", next_at: iso(-90) }],
    recent: [{ user_id: "u_demo2", email: "liam@example.com", mail: "w1-templates", name: "Day 2 · Templates", kind: "live", ok: 1, error: null, at: iso(12) }],
    mails: names.map(([key, name, subject]) => ({ key, name, subject })) };
}
/** The Outreach page on fake data (?demo=1). */
function demoOutreach(p, q, b) {
  const list = [
    { id: "p_demo1", email: "hello@brightreels.example", company: "Bright Reels", website: "https://brightreels.example", country: "US", region: "NY", city: "Brooklyn", type: "social-media-agency", contact_name: "Maya", source_url: "https://brightreels.example/contact", opener: "Saw that you run TikTok for three Brooklyn coffee roasters.", status: "new", step: 0, batch: "scout-2026-10-27" },
    { id: "p_demo2", email: "studio@northugc.example", company: "North UGC", website: "https://northugc.example", country: "GB", region: null, city: "Manchester", type: "ugc-agency", contact_name: null, source_url: "https://northugc.example/", opener: "Noticed you produce creator-style ads for skincare brands.", status: "replied", step: 1, reply_class: "interested", reply_summary: "Wants a trial for the team.", converted_user: "u_demo9", batch: "research-uk" },
  ];
  if (p === "/api/admin/outreach/prospects") return { prospects: list.filter((x) => !q.get("status") || x.status === q.get("status")), more: false };
  if (p === "/api/admin/outreach/preview") {
    const w = (subject) => ({ subject, text: "Hi Maya,\n\n(demo)\n\nLeonardo\nFounder, Kleo" });
    return { first: [{ variant: "a", name: "Ten hooks in an afternoon", ...w("Short-form video for Bright Reels") }, { variant: "b", name: "The slow-to-shoot parts", ...w("Bright Reels + AI video") }],
      followUps: [w("Re: Short-form video for Bright Reels"), w("Re: Short-form video for Bright Reels")], yes: "Hi Maya,\n\nGreat, here's Bright Reels' link: https://app.kleooai.com/r/bright-reels-x2k4" };
  }
  if (p === "/api/admin/outreach/approve-new") return { ok: true, approved: 1 };
  if (p === "/api/admin/outreach/import") return { added: 0, skipped: [] };
  if (p.startsWith("/api/admin/outreach/")) return { ok: true, to: "leo@outreach.example", on: !!b?.on, id: "s_demo1" };
  return { on: false, settings: { postal: "", trialCredits: 20, autoReply: true, autoApprove: false, scoutOn: false, scoutDaily: 30 },
    ready: { senders: 0, postal: false, approved: 0, ok: false }, mailboxes: [], counts: { new: 1, replied: 1 }, contacted: 1, replied: 1, signedUp: 1, paying: 0,
    variants: [{ id: "a", name: "Ten hooks in an afternoon", sent: 12, answered: 2 }, { id: "b", name: "The slow-to-shoot parts", sent: 9, answered: 0 }, { id: "c", name: "Ten hooks to test", sent: 4, answered: 1 }],
    replies: [{ prospect_id: "p_demo2", from_addr: "studio@northugc.example", subject: "Re: Short-form video for North UGC", class: "interested", summary: "Wants a trial for the team.", at: new Date().toISOString(), company: "North UGC" }],
    sends: [], countries: ["US", "CA", "GB", "AU", "NZ"], scout: { today: 0, queued: 0, checked: 0, added: 1, addedWeek: 1, lastError: null } };
}
async function demo(path, opts) {
  await new Promise((r) => setTimeout(r, 160));
  const db = demoDb();
  const [p, qs] = path.split("?");
  const q = new URLSearchParams(qs || "");
  const b = opts.body || {};
  const daysAgo = (iso) => (Date.now() - Date.parse(iso)) / 86400e3;
  const A = db.auth;
  const fail = (msg, code, status = 400, data = {}) => new AdminError(msg, status, code, data);
  const wrongCode = () => { A.wrong++; return fail("That code isn't right. Check the time on your phone and try the newest code.", "admin_wrong", 401, { left: Math.max(1, 5 - A.wrong) }); };
  const codes = () => ["k7m2-q9xd-4tpa", "h3nw-8zrc-u5ke", "p2fy-6jtm-x9qa", "r4vd-7hne-c2wu", "m8ka-3qzp-t6yf", "w5ub-9xmr-e2jh", "n6tc-4pya-z8dk", "s3qe-7fwm-b5ru", "y9hd-2nkx-a4vt", "e7rp-5cuj-q3mw"];
  if (p === "/api/admin/auth" && !opts.method) return { enrolled: A.enrolled, signedIn: A.signedIn, lockedMinutes: 0, recoveryLeft: A.recovery, hasPassword: true, email: "owner@example.com", enrolledAt: A.enrolled ? A.enrolledAt : null, session: null };
  if (p === "/api/admin/auth/enroll") {
    if (String(b.password || "").length < 14) throw fail("An admin password needs at least 14 characters. A sentence of four or five words works well. Change it on the Account page first, then come back.", "weak_password");
    return { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", uri: "otpauth://totp/Kleo%20admin:owner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kleo" };
  }
  if (p === "/api/admin/auth/enroll/confirm") { if (b.code !== "123456") throw wrongCode(); Object.assign(A, { enrolled: true, signedIn: true, fresh: Date.now(), recovery: 10, enrolledAt: new Date().toISOString() }); return { ok: true, recovery: codes() }; }
  if (p === "/api/admin/auth/signin") {
    const rec = String(b.code || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "k7m2q9xd4tpa";
    if (b.code !== "123456" && !rec) throw wrongCode();
    if (rec) A.recovery--;
    Object.assign(A, { signedIn: true, fresh: Date.now(), wrong: 0 });
    return { ok: true, via: rec ? "recovery" : "code" };
  }
  if (p === "/api/admin/auth/signout") { A.signedIn = false; return { ok: true }; }
  if (p === "/api/admin/auth/recovery") { if (b.code !== "123456") throw wrongCode(); Object.assign(A, { recovery: 10, fresh: Date.now() }); return { ok: true, recovery: codes() }; }
  if (!A.signedIn) throw fail("Type the code from your phone to open the console.", A.enrolled ? "admin_signin" : "admin_enroll", 401);
  if (p === "/api/admin/security") {
    const ago_ = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const where = { ip: "203.0.113.9", country: "NZ", city: "Auckland", network: "Spark New Zealand", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1" };
    return {
      events: [
        { id: 3, at: ago_(0.1), event: "admin.signin", detail: JSON.stringify({ ...where, via: "code" }) },
        { id: 2, at: ago_(26), event: "admin.code_wrong", detail: JSON.stringify({ ...where, ip: "198.51.100.40", country: "US", city: "Dallas", network: "Comcast Cable", ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0" }) },
        { id: 1, at: A.enrolledAt, event: "admin.2fa_enrolled", detail: JSON.stringify(where) },
      ],
      methods: [{ provider: "password", email: "owner@example.com", created_at: ago_(500), last_login_at: ago_(0.2) }],
      recoveryLeft: A.recovery, enrolledAt: A.enrolledAt,
      session: { issued: ago_(0.4), seen: ago_(0.01), fresh: A.fresh ? new Date(A.fresh).toISOString() : ago_(0.4) },
      idleMinutes: 30, maxHours: 12, freshMinutes: 5, lockAfter: 5, lockMinutes: 15,
    };
  }
  if (p === "/api/admin/overview") {
    const all = db.users.map(demoUser);
    const paid = db.payments.filter((x) => x.status === "paid");
    return {
      counts: { users: all.length, users_1d: all.filter((u) => daysAgo(u.created_at) < 1).length, users_7d: all.filter((u) => daysAgo(u.created_at) < 7).length, payers: new Set(paid.map((x) => x.user_id)).size,
        blocked: all.filter((u) => u.blocked_at).length, blocked_addresses: db.blocks.length, gens_today: db.gens.filter((g) => daysAgo(g.created_at) < 1).length,
        failed_1d: db.gens.filter((g) => g.status === "failed" && daysAgo(g.created_at) < 1).length, gens_1d: db.gens.filter((g) => daysAgo(g.created_at) < 1).length,
        running: db.gens.filter((g) => g.status === "running").length, spend_7d: db.gens.filter((g) => g.status !== "failed" && daysAgo(g.created_at) < 7).reduce((a, g) => a + g.est_usd, 0),
        spend_30d: db.gens.filter((g) => g.status !== "failed").reduce((a, g) => a + g.est_usd, 0) },
      revenue: [{ currency: "eur", total: paid.reduce((a, x) => a + x.amount_cent, 0), d30: paid.filter((x) => daysAgo(x.at) < 30).reduce((a, x) => a + x.amount_cent, 0), today: paid.filter((x) => daysAgo(x.at) < 1).reduce((a, x) => a + x.amount_cent, 0), n: paid.length }],
      trouble: [{ status: "refunded", n: 1, cents: 500 }, { status: "disputed", n: 1, cents: 1500 }],
      newest: all.slice().sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 6),
      payments: db.payments.slice().sort((x, y) => y.at.localeCompare(x.at)).slice(0, 6),
      failed: db.gens.filter((g) => g.status === "failed").sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 6),
      budget: { day: 30, spent: 4.82, freeDay: 8, freeSpent: 1.12 },
    };
  }
  if (p === "/api/admin/users") {
    const s = (q.get("q") || "").toLowerCase();
    const f = q.get("filter") || "all";
    let list = db.users.map(demoUser).filter((u) => !s || [u.id, u.email, u.name, u.ip, u.city, u.country].some((x) => String(x || "").toLowerCase().includes(s)));
    list = list.filter((u) => f === "all" || (f === "paid" && u.paid_cent) || (f === "free" && !u.paid_cent && !u.deleted) || (f === "blocked" && u.blocked_at) || (f === "deleted" && u.deleted) || (f === "new" && daysAgo(u.created_at) < 7));
    const key = { created: "created_at", seen: "last_seen", credits: "credits", paid: "paid_cent", spend: "spend_usd", gens: "gens", name: "name" }[q.get("sort")] || "created_at";
    const dir = q.get("dir") === "asc" ? 1 : -1;
    list.sort((x, y) => { const a = key === "name" ? who(x).toLowerCase() : x[key] ?? "", c = key === "name" ? who(y).toLowerCase() : y[key] ?? ""; return (a > c ? 1 : a < c ? -1 : 0) * dir; });
    const off = Number(q.get("offset") || 0);
    return { users: list.slice(off, off + 50), total: list.length };
  }
  const um = p.match(/^\/api\/admin\/users\/(u_\w+)$/);
  if (um) {
    const raw = db.users.find((u) => u.id === um[1]);
    if (!raw) throw Object.assign(new Error("No account with that id."), { code: "not_found" });
    const u = demoUser(raw);
    const gens = db.gens.filter((g) => g.user_id === u.id).sort((x, y) => y.created_at.localeCompare(x.created_at));
    const pays = db.payments.filter((x) => x.user_id === u.id).sort((x, y) => y.at.localeCompare(x.at)).map((x) => ({ ...x, links: [{ label: "Payment", url: "https://dashboard.stripe.com/payments" }, { label: "Checkout", url: "https://dashboard.stripe.com/search" }] }));
    return {
      user: u, logins: [{ provider: raw.methods, subject: raw.methods === "google" ? "1048…" : u.email, email: u.email, created_at: u.created_at, last_login_at: u.last_seen }],
      payments: pays, generations: gens, jobs: [], audit: db.audit.filter((a) => a.user_id === u.id).sort((x, y) => y.at.localeCompare(x.at)),
      ips: db.ips.filter((x) => x.user_id === u.id).sort((x, y) => y.at.localeCompare(x.at)), merged: [], redemption: null,
      address: { hash: raw.ip_hash, blocks: db.blocks.filter((x) => x.ip_hash === raw.ip_hash), twins: u.id === "u_demo09b" ? [demoUser(db.users[3]), demoUser(db.users[14])] : [] },
      totals: { paid: u.paid_cent ? [{ currency: "eur", cents: u.paid_cent }] : [], spend_usd: u.spend_usd, credits_spent: gens.filter((g) => g.status !== "failed").reduce((a, g) => a + g.credits, 0), failed: gens.filter((g) => g.status === "failed").length, films_usd: 0 },
      lookup: true, retentionDays: 90,
      attribution: demoAttribution(u),
    };
  }
  const am = p.match(/^\/api\/admin\/users\/(u_\w+)\/([a-z-]+)$/);
  if (am) {
    const u = db.users.find((x) => x.id === am[1]);
    const risky = am[2] === "delete" || am[2] === "key" || (am[2] === "block" && b.on) || (am[2] === "signout" && u.id !== "u_demo00a") || (am[2] === "credits" && Math.abs(Number(b.delta)) > 100);
    if (risky && Date.now() - A.fresh > 5 * 60e3) {
      if (!b.code) throw fail("Type a new code from your phone to do this.", "fresh_code", 403);
      if (b.code !== "123456") throw wrongCode();
      A.fresh = Date.now();
    }
    const log = (event, extra = {}) => db.audit.push({ id: db.aid++, at: new Date().toISOString(), user_id: u.id, event, job_id: null, detail: JSON.stringify({ admin: "u_demo00a", reason: b.reason, ...extra }) });
    if (am[2] === "credits") { const before = u.credits; u.credits = Math.max(0, u.credits + Number(b.delta)); log("admin.credits", { delta: b.delta, before, after: u.credits }); return { ok: true, credits: u.credits }; }
    if (am[2] === "block") { u.blocked_at = b.on ? new Date().toISOString() : null; u.blocked_reason = b.on ? b.reason : null; log(b.on ? "admin.block" : "admin.unblock"); return { ok: true }; }
    if (am[2] === "address") {
      db.blocks = db.blocks.filter((x) => x.ip_hash !== u.ip_hash);
      if (b.on) db.blocks.push({ ip_hash: u.ip_hash, reason: `admin: ${b.reason}`, until: new Date(Date.now() + (b.days || 30) * 86400e3).toISOString() });
      log(b.on ? "admin.address_block" : "admin.address_unblock", { days: b.days }); return { ok: true };
    }
    if (am[2] === "key") { u.key_version = (u.key_version || 0) + 1; log("admin.key_reset"); return { ok: true }; }
    if (am[2] === "signout") { log("admin.signout"); return { ok: true }; }
    if (am[2] === "delete") { u.email = `${u.id}@deleted.kleo.invalid`; u.name = null; u.credits = 0; u.deleted = 1; log("admin.delete"); return { ok: true }; }
    if (am[2] === "ip-lookup") {
      const a = db.audit.find((x) => x.id === b.audit);
      const best = { at: a.at.slice(0, 19) + "Z", ip: "198.51.100.77", country: "DE", host: "app.kleooai.com", method: "GET", path: "/auth/google/callback", status: 302, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)", count: 1, match: true };
      db.ips.push({ id: db.aid++, user_id: u.id, at: a.at, event: "lookup", ip: best.ip, country: "DE", ua: best.ua });
      log("admin.ip_lookup", { audit: a.id, found: true });
      return { event: a, best, rows: [best, { ...best, ip: "203.0.113.200", country: "US", path: "/", match: false }] };
    }
  }
  if (p === "/api/admin/sources" || p.startsWith("/api/admin/sources/links")) return demoSources(p, q, b);
  if (p.startsWith("/api/admin/emails")) return demoEmails(p, q, b);
  if (p.startsWith("/api/admin/outreach")) return demoOutreach(p, q, b);
  if (p === "/api/admin/payments") {
    const st = q.get("status");
    const rows = db.payments.filter((x) => !st || x.status === st).sort((x, y) => y.at.localeCompare(x.at)).map((x) => ({ ...x, account_email: x.email, links: [{ label: "Payment", url: "https://dashboard.stripe.com/payments" }, { label: "Checkout", url: "https://dashboard.stripe.com/search" }] }));
    const paid = db.payments.filter((x) => x.status === "paid");
    const days = new Map(), months = new Map();
    for (const x of paid) {
      const d = x.at.slice(0, 10), m = x.at.slice(0, 7);
      if (daysAgo(x.at) < 30) days.set(d, { day: d, currency: "eur", cents: (days.get(d)?.cents || 0) + x.amount_cent, n: (days.get(d)?.n || 0) + 1 });
      months.set(m, { month: m, currency: "eur", cents: (months.get(m)?.cents || 0) + x.amount_cent, n: (months.get(m)?.n || 0) + 1 });
    }
    const sum = (f) => paid.filter(f).reduce((a, x) => a + x.amount_cent, 0);
    return { payments: rows, total: rows.length, days: [...days.values()], months: [...months.values()].sort((x, y) => y.month.localeCompare(x.month)),
      totals: [{ currency: "eur", total: sum(() => true), d30: sum((x) => daysAgo(x.at) < 30), month: sum((x) => x.at.slice(0, 7) === new Date().toISOString().slice(0, 7)), today: sum((x) => daysAgo(x.at) < 1), n: paid.length, payers: new Set(paid.map((x) => x.user_id)).size }],
      states: ["paid", "refunded", "disputed"].map((s) => ({ status: s, n: db.payments.filter((x) => x.status === s).length, cents: db.payments.filter((x) => x.status === s).reduce((a, x) => a + x.amount_cent, 0) })) };
  }
  if (p === "/api/admin/generations") {
    const st = q.get("status"), kind = q.get("kind"), before = q.get("before");
    const list = db.gens.filter((g) => (!st || g.status === st) && (!kind || g.kind === kind) && (!before || g.created_at < before)).sort((x, y) => y.created_at.localeCompare(x.created_at));
    return { generations: list.slice(0, 24), more: list.length > 24 };
  }
  if (p === "/api/admin/failures") {
    const days = Number(q.get("days") || 7);
    const list = db.gens.filter((g) => g.status === "failed" && daysAgo(g.created_at) < days);
    const groups = new Map();
    for (const g of list) {
      const kind = /recharged/.test(g.error) ? "Provider out of credit" : /copyright/.test(g.error) ? "Copyright refusal" : /too small/.test(g.error) ? "Picture too small" : "Took too long";
      const k = `${kind}|${g.provider}`;
      const e = groups.get(k) || { kind, provider: g.provider, count: 0, users: new Set(), models: new Set(), last: g.created_at, sample: g.error, ids: [] };
      e.count++; e.users.add(g.user_id); e.models.add(g.model); if (g.created_at > e.last) e.last = g.created_at;
      groups.set(k, e);
    }
    return { days, total: list.length, groups: [...groups.values()].sort((x, y) => y.count - x.count).map((e) => ({ ...e, users: e.users.size, models: [...e.models] })) };
  }
  if (p === "/api/admin/spend") {
    const days = Number(q.get("days") ?? 30);
    const by = new Map();
    for (const g of db.gens.filter((x) => !days || daysAgo(x.created_at) < days)) {
      const e = by.get(g.user_id) || { id: g.user_id, email: g.email, gens: 0, failed: 0, usd: 0, credits: 0, last: g.created_at };
      e.gens++; if (g.status === "failed") e.failed++; else { e.usd += g.est_usd; e.credits += g.credits; }
      if (g.created_at > e.last) e.last = g.created_at;
      by.set(g.user_id, e);
    }
    const users = [...by.values()].map((e) => { const u = demoUser(db.users.find((x) => x.id === e.id)); return { ...e, paid_cent: u.paid_cent, currency: u.currency, admin: !!u.admin }; }).sort((x, y) => y.usd - x.usd);
    return { days, users, usd: users.reduce((a, x) => a + x.usd, 0) };
  }
  if (p === "/api/admin/providers") {
    const names = [["INTERNAL_SECRET", "Signs sessions, links and Kleo keys", true], ["EPHONE_API_KEY", "ePhone: every video, picture and app, and the chat agent", true], ["WAVESPEED_API_KEY", "WaveSpeed: viral templates and backups", true],
      ["APIMART_API_KEY", "APIMart: backup of most models", true], ["STRIPE_SECRET_KEY", "Stripe: Apple Pay and Google Pay inside the app", true], ["RESEND_API_KEY", "Password reset e-mails", false], ["GOOGLE_CLIENT_ID", "Sign in with Google", true],
      ["GOOGLE_CLIENT_SECRET", "Sign in with Google", true], ["TURNSTILE_SECRET", "The bot check on sign-up", true], ["CF_ANALYTICS_TOKEN", "Finds the address of past sign-ins in Cloudflare's logs", false]];
    return {
      secrets: names.map(([name, purpose, set]) => ({ name, purpose, set })),
      balances: [{ provider: "ephone", name: "ePhone", usd: 1.09, at: new Date(Date.now() - 5 * 3600e3).toISOString(), source: "last_refusal", stale: true }, { provider: "wavespeed", name: "WaveSpeed", usd: 11.25, at: new Date().toISOString(), source: "live" },
        { provider: "apimart", name: "APIMart", usd: 3.5, at: new Date().toISOString(), source: "live" }],
      lookup: false,
      settings: [["STUDIO_DAILY_BUDGET_USD", "30"], ["STUDIO_FREE_DAILY_BUDGET_USD", "8"], ["STUDIO_MARGIN", "1.6"], ["FREE_CREDITS", "5"], ["STUDIO_FREE_MODELS", "seedance-2.0-fast"], ["STUDIO_MAX_RUNNING", "3"], ["STUDIO_ADMINS", "u_demo00a"]].map(([name, value]) => ({ name, value })),
    };
  }
  if (p === "/api/admin/keys") {
    db.keys ??= [["EPHONE_API_KEY", "ePhone: every video, picture and app, and the chat agent", "worker", "x7Qa"], ["EPHONE_ADMIN_KEY", "ePhone admin key, read only (account:read): reads the balance live", "console", "m2Kd"],
      ["WAVESPEED_API_KEY", "WaveSpeed: viral templates and backups", "worker", "9fTb"], ["APIMART_API_KEY", "APIMart: backup of most models", "worker", "Lw3e"], ["RESEND_API_KEY", "Password reset e-mails", "none", null],
      ["CF_ANALYTICS_TOKEN", "Finds the address of past sign-ins in Cloudflare's logs", "none", null]]
      .map(([name, purpose, source, last4]) => ({ name, purpose, source, last4, ...(source === "console" ? { setAt: new Date(Date.now() - 2 * 3600e3).toISOString(), setBy: "u_demo00a" } : {}) }));
    return { keys: db.keys, terminalOnly: ["INTERNAL_SECRET", "STRIPE_SECRET_KEY", "GOOGLE_CLIENT_SECRET", "TURNSTILE_SECRET"].map((name) => ({ name, set: true })) };
  }
  const km = p.match(/^\/api\/admin\/keys\/([A-Z0-9_]+)(?:\/(test|revert))?$/);
  if (km) {
    const k = (db.keys || []).find((x) => x.name === km[1]);
    if (!k) throw fail("That key can't be changed from the console.", "not_found", 404);
    if (km[2] === "test") return k.source === "none" ? { ok: false, detail: "No key is set." } : { ok: true, detail: "The provider accepts this key." };
    if (Date.now() - A.fresh > 5 * 60e3) {
      if (!b.code) throw fail("Type a new code from your phone to do this.", "fresh_code", 403);
      if (b.code !== "123456") throw wrongCode();
      A.fresh = Date.now();
    }
    if (km[2] === "revert") { Object.assign(k, { source: "worker", last4: "x7Qa", setAt: null, setBy: null }); return { ok: true }; }
    const v = String(b.value || "").trim();
    if (v.length < 16) throw fail("That doesn't look like a key. Paste the whole key.", "key_shape");
    Object.assign(k, { source: "console", last4: v.slice(-4), setAt: new Date().toISOString(), setBy: "u_demo00a" });
    return { ok: true, last4: k.last4, detail: "The provider accepts this key." };
  }
  throw Object.assign(new Error("Not in the demo."), { code: "demo" });
}
