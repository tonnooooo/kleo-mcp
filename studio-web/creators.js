// Kleo Studio — Kleo Creators (app.kleooai.com/creators, 28 October 2026). app.js loads this module when somebody opens
// /creators and hands it the app's own helpers (the kit). API: src/studio/creators.ts. Rules: the same numbers the server
// applies, read from /api/creators/me (rules). With ?demo=1 it runs on fake data; &creator=guest|none|plan|applied|
// refused|active|paused|ended picks the state.
//
// One page for everybody: what the program gives and asks, who can join, the real creators; then, for a signed-in
// person, the next step: a plan, the application, the bio code, or the creator's own dashboard (posts, link, money).

let K = null;
const h = (...a) => K.h(...a);
const icon = (...a) => K.icon(...a);
const AGREEMENT = "https://kleooai.com/creators/agreement.html";
const MARK_PNG = "https://kleooai.com/brand/made-with-kleo.png";
const MARK_SVG = "https://kleooai.com/brand/made-with-kleo.svg";

const num = (n) => new Intl.NumberFormat("en-GB").format(Number(n) || 0);
const eur = (cents) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format((Number(cents) || 0) / 100);
const date = (iso) => { try { return new Date(String(iso).endsWith("Z") ? iso : `${iso}Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }); } catch { return ""; } };
const card = (title, sub, ...kids) => h("section", { class: "cr-card" }, title ? h("h2", {}, title) : null, sub ? h("p", { class: "cr-sub" }, sub) : null, ...kids);
const pill = (text, tone = "") => h("span", { class: `cr-pill ${tone}` }, text);

async function call(path, opts = {}) {
  if (K.DEMO) return demo(path, opts);
  return K.api(path, opts);
}

export async function render(kit) {
  K = kit;
  const body = h("div", { class: "cr-stack" }, h("div", { class: "cr-loading" }, K.spinner(24)));
  K.setView("cr-view", h("div", { class: "page cr-page" }, hero(), body));
  let st = null, list = [];
  try {
    [st, list] = await Promise.all([
      K.me || K.DEMO ? call("/api/creators/me").catch((e) => (e?.status === 401 ? null : Promise.reject(e))) : Promise.resolve(null),
      call("/api/creators/public").then((r) => r.creators || []).catch(() => []),
    ]);
  } catch (e) { K.handleError(e); }
  if (location.pathname !== "/creators") return; // the person went somewhere else meanwhile
  const rules = st?.rules || DEFAULT_RULES;
  K.fill(body, nextStep(st, rules), howItWorks(rules), levelsCard(rules), rewardsCard(rules), postRules(), whoCanJoin(rules), creatorsList(list), faq(rules));
}

function hero() {
  return h("header", { class: "cr-hero" },
    h("div", { class: "cr-hero-ic" }, icon("star", 30, 2)),
    h("h1", {}, "Kleo Creators"),
    h("p", {}, "Make videos with Kleo, post them, and earn credits and cash for the views you get and the people you bring."));
}

// ── the next step, by state ──────────────────────────────────────────────────────────────────────────────────────
function nextStep(st, rules) {
  if (!st) {
    return card("Start with a Kleo account", "Kleo Creators is for people who already create with Kleo. Make your account, pick a plan, then apply.",
      h("div", { class: "cr-actions" }, h("button", { class: "btn btn-cta", onclick: () => K.requireAccount("signup") }, icon("sparkle", 18), "Create your account"),
        h("button", { class: "btn btn-quiet", onclick: () => K.requireAccount("signin") }, "Sign in")));
  }
  const s = st.state;
  if (s === "none" && !st.plan) {
    return card("Kleo Creators starts with a plan", "Every creator is a Kleo subscriber first. Pick Lite (€9 a month) or higher, then come back to apply. It keeps the program for real creators.",
      h("div", { class: "cr-actions" }, h("button", { class: "btn btn-cta", onclick: () => K.go("/plans") }, icon("sparkle", 18), "See plans")));
  }
  if (s === "none") return applyForm(rules);
  if (s === "applied") {
    const net = rules.platforms.find((p) => p.key === st.platform)?.name || "social";
    return card("We have your application", `Thanks. We review every application by hand and answer by e-mail within 3 days.`,
      h("div", { class: "cr-step" }, h("span", { class: "cr-n" }, "1"), h("div", {},
        h("h3", {}, `Put this code in your ${net} bio`), h("p", {}, "It proves the account is yours. Keep it there until we accept you, then remove it."),
        h("div", { class: "cr-code" }, h("b", { class: "mono" }, st.bioCode), h("button", { class: "btn btn-quiet btn-sm", onclick: () => { navigator.clipboard?.writeText(st.bioCode); K.toast("Code copied"); } }, icon("copy", 16), "Copy")),
        st.bioSeen ? h("p", { class: "cr-ok" }, icon("check", 17, 2.4), "We've seen it. Thanks.") : null)),
      h("div", { class: "cr-step" }, h("span", { class: "cr-n" }, "2"), h("div", {},
        h("h3", {}, "Keep your plan running"), h("p", {}, "Creators keep a Kleo plan while they're in the program."))),
      h("div", { class: "cr-actions" }, h("a", { class: "btn btn-quiet", href: st.profileUrl, target: "_blank", rel: "noopener" }, icon("share", 16), `@${st.handle}`),
        h("button", { class: "btn btn-quiet", onclick: () => leave(true) }, "Withdraw my application")));
  }
  if (s === "refused") {
    return card("Your application wasn't accepted", st.why || "Thanks for applying. This time it didn't meet the program's rules.",
      h("p", { class: "cr-sub" }, `You can apply again from ${date(st.againAt)}.`));
  }
  if (s === "ended" || s === "banned") {
    return card("Your place in Kleo Creators has ended", st.endReason || "Thanks for creating with Kleo. Your account and your plan carry on as normal.");
  }
  return dashboard(st, rules);
}

// ── applying ─────────────────────────────────────────────────────────────────────────────────────────────────────
const COUNTRIES = (() => {
  const codes = "AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW".split(" ");
  let names = null;
  try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* codes only */ }
  return codes.map((c) => [c, names?.of(c) || c]).sort((a, b) => a[1].localeCompare(b[1]));
})();

function applyForm(rules) {
  const F = (applyForm.F ||= { platform: "instagram", handle: "", followers: "", bestViews: "", accountSince: "", aiPosts: "", usernameChanges: "0", country: "", bestUrl: "", about: "", name: K.me?.name || "", accept: false });
  const err = h("p", { class: "cr-err", role: "alert" });
  const field = (label, el, hint) => h("label", { class: "cr-field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
  const input = (key, attrs = {}) => {
    const el = h("input", { class: "input", value: F[key], autocomplete: "off", ...attrs });
    el.addEventListener("input", () => { F[key] = el.value; });
    return el;
  };
  const nets = h("div", { class: "cr-chips" });
  const drawNets = () => K.fill(nets, rules.platforms.map((p) => h("button", { type: "button", class: "cr-chip" + (F.platform === p.key ? " on" : ""), "aria-pressed": String(F.platform === p.key), onclick: () => { F.platform = p.key; drawNets(); } }, p.name)));
  drawNets();
  const country = h("select", { class: "input" }, h("option", { value: "" }, "Pick your country"), COUNTRIES.map(([c, n]) => h("option", { value: c, selected: F.country === c || null }, n)));
  country.addEventListener("change", () => { F.country = country.value; });
  const about = h("textarea", { class: "input cr-area", rows: "3", maxlength: "600", placeholder: "What you make, and what you'd make with Kleo" }, F.about);
  about.addEventListener("input", () => { F.about = about.value; });
  const accept = h("input", { type: "checkbox", checked: F.accept || null });
  accept.addEventListener("change", () => { F.accept = accept.checked; });
  const send = h("button", { class: "btn btn-cta", type: "submit" }, icon("send", 18), "Send my application");
  const thisMonth = new Date().toISOString().slice(0, 7);
  const form = h("form", { class: "cr-form", onsubmit: async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    if (!F.accept) { err.textContent = "Read and accept the Kleo Creator Agreement first."; return; }
    send.disabled = true;
    try {
      await call("/api/creators/apply", { method: "POST", body: { ...F, accept: F.accept === true } });
      applyForm.F = null;
      K.toast("Application sent");
      render(K);
    } catch (e) { err.textContent = e.message || "Something went wrong."; send.disabled = false; }
  } },
    field("Your name", input("name", { autocomplete: "name", maxlength: "80", required: "" })),
    field("Your network", nets, "One account only: the one where you'll post your Kleo videos."),
    field("Username", input("handle", { placeholder: "@yourname", autocapitalize: "off", spellcheck: "false", required: "" })),
    h("div", { class: "cr-form2" },
      field("Followers", input("followers", { type: "number", inputmode: "numeric", min: "0", placeholder: "12000", required: "" })),
      field("Views on your best AI post", input("bestViews", { type: "number", inputmode: "numeric", min: "0", placeholder: "50000" }))),
    h("div", { class: "cr-form2" },
      field("Account opened", input("accountSince", { type: "month", max: thisMonth, required: "" }), "Instagram shows it in “About this account”."),
      field("Posts of your own AI work", input("aiPosts", { type: "number", inputmode: "numeric", min: "0", placeholder: "30", required: "" }))),
    h("div", { class: "cr-form2" },
      field("Times the username changed", input("usernameChanges", { type: "number", inputmode: "numeric", min: "0", placeholder: "0" })),
      field("Country", country)),
    field("Link to your best AI post", input("bestUrl", { type: "url", inputmode: "url", placeholder: "https://www.instagram.com/reel/…", autocapitalize: "off", spellcheck: "false", required: "" })),
    field("About you", about),
    h("label", { class: "cr-check" }, accept, h("span", {}, "I'm 18 or older and I accept the ", h("a", { href: AGREEMENT, target: "_blank", rel: "noopener" }, "Kleo Creator Agreement"), ".")),
    err, h("div", { class: "cr-actions" }, send));
  return card("Apply to Kleo Creators", "Tell us about the account where you'll post. We check every answer against the account itself.", form);
}

// ── the creator's own page ───────────────────────────────────────────────────────────────────────────────────────
function dashboard(st, rules) {
  const f = st.figures;
  const paused = st.state === "paused";
  const lvl = rules.levels.find((l) => l.key === st.level) || rules.levels[0];
  const pct = Math.min(100, Math.round((f.posts.counted / Math.max(1, f.posts.needed)) * 100));
  const head = h("div", { class: "cr-dash-head" },
    h("div", {}, h("h2", {}, `You're a ${st.levelName}`, pill(paused ? "Paused" : "Active", paused ? "warn" : "ok")),
      h("p", { class: "cr-sub" }, `@${st.handle} · since ${date(st.levelSince || st.approvedAt)} · ${lvl.rate}% commission`)),
    h("a", { class: "btn btn-quiet btn-sm", href: st.profileUrl, target: "_blank", rel: "noopener" }, icon("share", 16), "Your profile"));
  const pausedNote = paused ? h("div", { class: "cr-banner" }, icon("lock", 18),
    h("div", {}, h("b", {}, "Your plan has ended"), h("span", {}, "Bonuses and the monthly +50% wait until a plan runs again.")),
    h("button", { class: "btn btn-cta btn-sm", onclick: () => K.go("/plans") }, "See plans")) : null;

  const month = card("This month", st.level === "pro" ? "Your Pro plan comes from the program while you keep posting." : `Make ${f.posts.needed} posts this month and Kleo adds ${Math.round(lvl.boost * 100)}% of your plan's credits.`,
    h("div", { class: "cr-meter" }, h("i", { style: { width: `${pct}%` } })),
    h("div", { class: "cr-figs" },
      fig("Posts counted", `${f.posts.counted} of ${f.posts.needed}`, f.posts.pending ? `${f.posts.pending} waiting for day 7` : null),
      fig("View bonuses", `${num(f.posts.bonus)} of ${num(f.posts.bonusCap)} credits`),
      fig("Program credits", num(f.programCredits.left), f.programCredits.nextExpiry ? `Next ones expire ${date(f.programCredits.nextExpiry)}` : "Spent first, kept 90 days")),
    st.misses ? h("p", { class: "cr-warn" }, "Last month didn't have enough posts. One more month like that and your place ends.") : null);

  const link = card("Your Kleo link", "Put it in your bio and in your captions. Everybody who opens a Kleo account through it counts for you for 12 months.",
    h("div", { class: "cr-code" }, h("b", { class: "mono" }, (st.link || "").replace(/^https:\/\//, "")),
      h("button", { class: "btn btn-quiet btn-sm", onclick: () => { navigator.clipboard?.writeText(st.link); K.toast("Link copied"); } }, icon("copy", 16), "Copy")),
    h("div", { class: "cr-figs" }, fig("People who signed up", num(f.people.signups)), fig("People who paid", num(f.people.paying))));

  // Sending a post
  const url = h("input", { class: "input", type: "url", inputmode: "url", placeholder: "Paste the link of your post", autocapitalize: "off", spellcheck: "false" });
  const send = h("button", { class: "btn btn-primary", type: "submit" }, "Send");
  const err = h("p", { class: "cr-err", role: "alert" });
  const postForm = h("form", { class: "cr-post-form", onsubmit: async (ev) => {
    ev.preventDefault(); err.textContent = "";
    if (!url.value.trim()) return;
    send.disabled = true;
    try { await call("/api/creators/posts", { method: "POST", body: { url: url.value.trim() } }); K.toast("Post sent. We read its views at day 7."); render(K); }
    catch (e) { err.textContent = e.message; send.disabled = false; }
  } }, url, send);
  const rows = (st.posts || []).map((p) => h("div", { class: "row" }, icon(p.status === "eligible" ? "check" : p.status === "rejected" ? "x" : "clock", 19),
    h("div", { class: "lbl" }, h("b", {}, h("a", { href: p.url, target: "_blank", rel: "noopener", class: "cr-post-url" }, p.url.replace(/^https:\/\/(www\.)?/, ""))),
      h("span", {}, p.status === "eligible" ? `Counted · ${num(p.views)} views${p.bonus ? ` · +${p.bonus} credits` : ""}`
        : p.status === "rejected" ? `Not counted: ${p.reason || "it didn't follow the rules"}` : `Sent ${date(p.created_at)} · views read at day 7`)),
    p.status === "pending" ? h("button", { class: "btn btn-quiet btn-sm", "aria-label": "Remove this post", onclick: () => removePost(p) }, "Remove") : null));
  const posts = card("Your posts", "Send every post you make with Kleo. Each one needs the “Made with Kleo” mark, @kleooai, #kleo, your link and #ad.",
    postForm, err, rows.length ? h("div", { class: "list cr-list" }, rows) : h("p", { class: "cr-empty" }, "No post sent yet."));

  // Money
  const cash = st.payout.pref === "cash";
  const money = card("Your commission", `${lvl.rate}% of what the people you bring pay Kleo, for 12 months. Take it as credits at once (worth ${rules.creditMultiplier}x), or as cash after ${rules.holdDays} days.`,
    h("div", { class: "cr-figs" },
      fig("Taken as credits", `${num(f.commission.credits)} credits`, f.commission.creditedCents ? `${eur(f.commission.creditedCents)} of commission` : null),
      fig("Cash on hold", eur(f.commission.heldCents), `Ready ${rules.holdDays} days after each payment`),
      fig("Cash ready", eur(f.commission.readyCents), `Paid from ${eur(f.commission.minCashCents)}`),
      fig("Cash paid", eur(f.commission.paidCents))),
    h("div", { class: "cr-payout" }, h("div", { class: "seg2" },
      h("button", { class: cash ? "" : "on", onclick: () => payout("credits") }, "Credits at once"),
      h("button", { class: cash ? "on" : "", onclick: () => payout("cash") }, "Cash after 60 days")),
      cash && st.payout.email ? h("span", { class: "cr-sub" }, `Paid to ${st.payout.email}`) : null));

  const kit = card("The “Made with Kleo” mark", "Put it in a corner of every video you post for the program. Posts without it don't count.",
    h("div", { class: "cr-mark" }, h("img", { src: MARK_SVG, alt: "Made with Kleo", width: "220", height: "64" })),
    h("div", { class: "cr-actions" }, h("a", { class: "btn btn-quiet", href: MARK_PNG, download: "made-with-kleo.png" }, icon("down", 16), "Download PNG"),
      h("a", { class: "btn btn-quiet", href: MARK_SVG, download: "made-with-kleo.svg" }, icon("down", 16), "Download SVG")));

  const out = h("div", { class: "cr-leave" }, h("button", { class: "btn btn-quiet btn-sm", onclick: () => leave(false) }, "Leave Kleo Creators"));
  return h("div", { class: "cr-stack" }, card(null, null, head, pausedNote), month, posts, link, money, kit, out);
}
const fig = (label, value, sub) => h("div", { class: "cr-fig" }, h("span", {}, label), h("b", {}, value), sub ? h("small", {}, sub) : null);

async function removePost(p) {
  try { await call(`/api/creators/posts/${p.id}`, { method: "DELETE" }); K.toast("Post removed"); render(K); } catch (e) { K.handleError(e); }
}
async function payout(pref) {
  let email;
  if (pref === "cash") {
    const v = await K.ask({ title: "Cash commission", ic: "bag", ok: "Save", text: "We pay by PayPal or Wise each month once your cash reaches €50, 60 days after each payment.",
      fields: [{ key: "email", label: "PayPal or Wise e-mail", type: "email", placeholder: "you@example.com", autocomplete: "email", required: true }] });
    if (!v) return;
    email = v.email;
  }
  try { await call("/api/creators/payout", { method: "POST", body: { pref, email } }); K.toast(pref === "cash" ? "Cash it is" : "Credits it is"); render(K); } catch (e) { K.handleError(e); }
}
async function leave(application) {
  const ok = await K.ask(application
    ? { title: "Withdraw your application?", text: "You can apply again later.", ok: "Withdraw", danger: true, ic: "x" }
    : { title: "Leave Kleo Creators?", text: "Your account and your plan carry on. Commission already earned is still paid; program credits stay until they expire.", ok: "Leave", danger: true, ic: "x" });
  if (!ok) return;
  try { await call("/api/creators/leave", { method: "POST", body: { confirm: true } }); K.toast(application ? "Application withdrawn" : "You've left Kleo Creators"); render(K); } catch (e) { K.handleError(e); }
}

// ── the rules, for everybody ─────────────────────────────────────────────────────────────────────────────────────
function howItWorks() {
  const step = (n, title, text) => h("div", { class: "cr-step" }, h("span", { class: "cr-n" }, String(n)), h("div", {}, h("h3", {}, title), h("p", {}, text)));
  return card("How it works", null,
    step(1, "Subscribe and apply", "Pick a Kleo plan, then tell us about your account. We review every application by hand."),
    step(2, "Make and post", "Create with Kleo, post on your account with the “Made with Kleo” mark, and send us the link."),
    step(3, "Earn", "Bonus credits for views, extra credits every month you post, and a share of what the people you bring pay."),
    step(4, "Move up", "Bring real views and real customers, and your plan becomes free."));
}
function levelsCard(rules) {
  const L = Object.fromEntries(rules.levels.map((l) => [l.key, l]));
  const lv = (l, pay, gives, owes, how, top) => h("div", { class: "cr-level" + (top ? " top" : "") },
    h("h3", {}, l.name), h("p", { class: "cr-how" }, how), h("p", { class: "cr-pay" }, pay),
    h("ul", {}, gives.map((g) => h("li", {}, icon("check", 15, 2.6), g))), h("p", { class: "cr-owe" }, owes));
  return card("Three levels", "Everybody starts as a Creator. Every level keeps its commission for 12 months on each person you bring.",
    h("div", { class: "cr-levels" },
      lv(L.creator, "You pay Lite, €9 a month", [`+${Math.round(L.creator.boost * 100)}% of your plan's credits in every month you post`, "Bonus credits for views", `${L.creator.rate}% commission`], `${L.creator.posts} posts a month`, "When we accept you"),
      lv(L.partner, "You pay Lite, €9 a month", [`${L.partner.monthly} credits a month (Starter's), plus ${Math.round(L.partner.boost * 100)}% in months you post`, "Featured on Kleo's Instagram and in the app", "New templates a week early", `${L.partner.rate}% commission`], `${L.partner.posts} posts a month`, "After 2 months, with 30,000 views or 3 paying people"),
      lv(L.pro, "Free", [`A Pro plan at no charge (${L.pro.monthly} credits a month)`, "Everything Partners get", `${L.pro.rate}% commission`], `${L.pro.posts} posts a month`, "150,000 views or 10 paying people in a month", true)),
    h("p", { class: "cr-sub cr-gap" }, "A month without enough posts moves you down one level. Two months in a row end your place in the program."));
}
function rewardsCard(rules) {
  return card("Bonus credits for views", `We read each post's views 7 days after it went up. Up to ${num(rules.bonusCap)} bonus credits a month.`,
    h("div", { class: "list cr-list" }, rules.bonuses.slice().reverse().map((b) => h("div", { class: "row" }, icon("star", 19),
      h("div", { class: "lbl" }, h("b", {}, `${num(b.views)} views`)), h("span", { class: "val" }, `+${b.credits} credits`)))),
    h("p", { class: "cr-sub cr-gap" }, `Program credits are spent before your own and last ${rules.programDays} days. Commission taken as cash is paid after ${rules.holdDays} days, once it reaches €${rules.minCash}.`));
}
function postRules() {
  const items = [
    "Made with your own Kleo account.",
    "The “Made with Kleo” mark in a corner, or Kleo's end card.",
    "@kleooai tagged and #kleo in the caption.",
    "Your Kleo link in the caption or your bio.",
    "Marked as an ad: the paid-partnership label, or #ad at the start.",
    "Public for at least 30 days.",
  ];
  const never = [
    "Bought views, bots or engagement groups.",
    "Selling or giving away Kleo credits or accounts, or asking anyone for money in Kleo's name.",
    "Somebody's face or voice without their consent, or anything sexual, hateful or illegal.",
  ];
  return card("Every post that counts", null,
    h("ul", { class: "cr-ticks" }, items.map((t) => h("li", {}, icon("check", 16, 2.6), t))),
    h("h3", {}, "What ends your place at once"),
    h("ul", { class: "cr-ticks no" }, never.map((t) => h("li", {}, icon("x", 16, 2.6), t))));
}
function whoCanJoin(rules) {
  const e = rules.entry;
  return card("Who can join", "We check every answer against the account itself.",
    h("ul", { class: "cr-ticks" }, [
      "18 or older, with a Kleo plan (Lite or higher).",
      `A public Instagram, TikTok, YouTube or X account at least ${e.minAccountMonths} months old.`,
      `${num(e.minFollowers)} followers, or a post with ${num(e.orViews)} views.`,
      `At least ${e.minAiPosts} posts of your own AI work.`,
      `A username changed no more than ${e.maxUsernameChanges} times.`,
      "One account per person.",
    ].map((t) => h("li", {}, icon("check", 16, 2.6), t))));
}
function creatorsList(list) {
  return card("The real Kleo creators", "Only these accounts work with Kleo. Kleo never sells credits or accounts through a creator.",
    list.length ? h("div", { class: "list cr-list" }, list.map((c) => h("a", { class: "row", href: c.url, target: "_blank", rel: "noopener" }, icon("user", 19),
      h("div", { class: "lbl" }, h("b", {}, `@${c.handle}`), h("span", {}, `${c.network} · ${c.level}`)), icon("right", 16))))
      : h("p", { class: "cr-empty" }, "The first creators join soon."));
}
function faq(rules) {
  const qa = [
    ["Why do I need a plan?", "It keeps the program for real creators. Kleo gives back much more than the plan costs once your posts get views and the people you bring subscribe."],
    ["Can I get a free account instead?", "No. The only free plan is the Pro partner level, and it's paid for by the customers a creator brings."],
    ["Who owns my videos?", "You do. Kleo may share your posts on its own channels, with credit to you, and asks you first before using one in an ad."],
    ["Can I work with other AI tools?", "Yes. There's no exclusivity."],
    ["How is commission paid?", `As Kleo credits at once, worth ${rules.creditMultiplier}x, or as cash by PayPal or Wise after ${rules.holdDays} days, from €${rules.minCash}. A refunded payment earns nothing.`],
  ];
  return card("Questions", null,
    h("div", { class: "cr-faq" }, qa.map(([q, a]) => h("details", {}, h("summary", {}, q), h("p", {}, a)))),
    h("p", { class: "cr-sub cr-gap" }, "The full rules are in the ", h("a", { href: AGREEMENT, target: "_blank", rel: "noopener" }, "Kleo Creator Agreement"), ". Questions: hello@kleooai.com"));
}

// The same numbers as src/studio/creators.ts publicRules(), for visitors who aren't signed in.
const DEFAULT_RULES = {
  levels: [
    { key: "creator", name: "Creator", posts: 2, rate: 25, boost: 0.5, monthly: 0, comp: false },
    { key: "partner", name: "Partner", posts: 4, rate: 30, boost: 0.5, monthly: 50, comp: false },
    { key: "pro", name: "Pro partner", posts: 4, rate: 35, boost: 0, monthly: 110, comp: true },
  ],
  bonuses: [{ views: 100000, credits: 80 }, { views: 50000, credits: 40 }, { views: 10000, credits: 15 }], bonusCap: 150, programDays: 90,
  holdDays: 60, minCash: 50, creditMultiplier: 1.5, months: 12, entry: { minFollowers: 1000, orViews: 10000, minAccountMonths: 6, minAiPosts: 9, maxUsernameChanges: 2 },
  platforms: [{ key: "instagram", name: "Instagram" }, { key: "tiktok", name: "TikTok" }, { key: "youtube", name: "YouTube" }, { key: "x", name: "X" }],
};

// ── demo ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const DEMO_STATE = { s: new URLSearchParams(location.search).get("creator") || "active" };
async function demo(path, opts = {}) {
  await new Promise((r) => setTimeout(r, 120));
  if (path === "/api/creators/public") return { creators: [{ platform: "instagram", network: "Instagram", handle: "demo.partner", url: "https://www.instagram.com/", level: "Partner" }, { platform: "tiktok", network: "TikTok", handle: "demo.creator", url: "https://www.tiktok.com/", level: "Creator" }] };
  const s = DEMO_STATE.s;
  if (s === "guest") { const e = new Error("Sign in."); e.status = 401; throw e; }
  if (path === "/api/creators/apply") { DEMO_STATE.s = "applied"; return {}; }
  if (path === "/api/creators/leave") { DEMO_STATE.s = s === "applied" ? "plan" : "ended"; return {}; }
  if (path === "/api/creators/posts" || path === "/api/creators/payout" || path.startsWith("/api/creators/posts/")) return {};
  const base = { rules: DEFAULT_RULES, terms: { url: AGREEMENT }, plan: s === "none" ? null : "lite", platform: "instagram", handle: "demo.creator", profileUrl: "https://www.instagram.com/" };
  if (s === "none" || s === "plan") return { ...base, state: "none" };
  if (s === "applied") return { ...base, state: "applied", bioCode: "KLEO-7QX2MP", bioSeen: false };
  if (s === "refused") return { ...base, state: "refused", why: "The account needs to be at least 6 months old.", againAt: new Date(Date.now() + 20 * 864e5).toISOString() };
  if (s === "ended") return { ...base, state: "ended", endReason: "You left the program." };
  return {
    ...base, state: s === "paused" ? "paused" : "active", level: "creator", levelName: "Creator", levelSince: "2026-10-02T10:00:00Z", approvedAt: "2026-10-02T10:00:00Z", misses: 0,
    payout: { pref: "credits", email: null }, link: "https://app.kleooai.com/r/c-demo-creator", rate: 25,
    figures: { month: "2026-10", posts: { needed: 2, counted: 1, eligible: 1, pending: 1, rejected: 0, bonus: 15, bonusCap: 150 }, people: { signups: 7, paying: 2 },
      commission: { heldCents: 0, readyCents: 0, paidCents: 0, creditedCents: 410, credits: 12, minCashCents: 5000 }, programCredits: { left: 38, nextExpiry: "2027-01-01T10:00:00Z" } },
    posts: [
      { id: "cp_demo1", url: "https://www.instagram.com/reel/DEMO1/", status: "pending", created_at: new Date(Date.now() - 2 * 864e5).toISOString() },
      { id: "cp_demo2", url: "https://www.instagram.com/reel/DEMO2/", status: "eligible", views: 18400, bonus: 15, created_at: "2026-10-12T09:00:00Z" },
    ],
  };
}
