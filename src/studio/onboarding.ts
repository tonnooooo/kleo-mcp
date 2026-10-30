/**
 * KLEO STUDIO — THE WELCOME E-MAILS (27 October 2026, the owner, after a "Day 2 of 7" e-mail from Superhuman: "vorrei che
 * anche kleo mandasse una mail del genere, clean pulita dettagliata e professionale"). Between 13 and 26 October half of
 * the new accounts never made anything and nobody who failed a first try ever came back; nobody had written to them.
 *
 * TWO SERIES, written by Leonardo, sent from hello@kleooai.com through Cloudflare Email Sending (the EMAIL binding):
 *  · "welcome", for every account opened after the e-mails were switched on: one e-mail a day for seven days (Day 1 of 7
 *    … Day 7 of 7), what Kleo does and how to get a good first video. When a first try failed and nothing came out yet,
 *    the next e-mail is the "rescue" one instead (once): the credits are back, here is what usually fixes it.
 *  · "comeback", once, for the accounts of the 30 days before the switch that never paid: one e-mail that fits what they
 *    did (never made anything / failed / made something), and three days later the founder's question.
 *
 * WHAT STOPS THEM: the unsubscribe link (one click, RFC 8058, also the mail client's own button), a bounce or a refused
 * address, a closed, merged or deleted account, a purchase (the comeback series), and the owner's switch. The owner's own
 * accounts (STUDIO_ADMINS) are never written to. Every send is a studio_mail_log row; stopped addresses are mail_suppress
 * rows, a table the outreach engine reads too, so an address that said no to one never hears from the other.
 *
 * WHEN: after the first one (20 minutes after sign-up), only between 9:00 and 20:00 where the person signed in from
 * (studio_ips), at most STUDIO_MAIL_PER_TICK per 5-minute tick and STUDIO_MAIL_DAILY_CAP a UTC day.
 *
 * THE SWITCH is studio_meta 'onboarding_mode' ('on' | 'off', missing = off), set in the admin console's Emails page; the
 * moment it went on ('onboarding_on_since') divides the two series. Off, nothing is computed and nothing is sent.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { escapeHtml, hmacHex, safeEqual } from "../util.ts";
import { clipCredits, freeModels, type ClipSettings, type ModelKey } from "./models.ts";
import { PLANS } from "../plans.ts";
import { PACKS } from "../stripe.ts";
import { isCopyrightRefusal, marginOf, videoFactorOf } from "./generate.ts";
import { TOOLS } from "./tools.ts";
import { mailOwner } from "./providers.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export { ONBOARDING_SCHEMA } from "./mail-schema.ts";

export const MAIL_FROM = "hello@kleooai.com";
export const MAIL_FROM_NAME = "Leonardo from Kleo";
const APP = "https://app.kleooai.com";
/** The first e-mail goes this long after sign-up; the others follow at these offsets, in days, from the sign-up. */
const FIRST_AFTER_MIN = 20;
const COMEBACK_DAYS = 30;
const DAY_START_H = 9, DAY_END_H = 20;

type Track = "welcome" | "comeback";
export type MailKey =
  | "w0-welcome" | "w1-templates" | "w2-prompts" | "w3-apps" | "w4-share" | "w5-credits" | "w6-founder" | "rescue"
  | "c0-failed" | "c0-unused" | "c0-next" | "c1-founder";

/** The two series, step by step: the e-mail and its offset in days from the start of the series. */
export const SERIES: Record<Track, { day: number; mail: MailKey | "c0" }[]> = {
  welcome: [
    { day: 0, mail: "w0-welcome" }, { day: 1, mail: "w1-templates" }, { day: 2, mail: "w2-prompts" }, { day: 3, mail: "w3-apps" },
    { day: 4, mail: "w4-share" }, { day: 5, mail: "w5-credits" }, { day: 6, mail: "w6-founder" },
  ],
  comeback: [{ day: 0, mail: "c0" }, { day: 3, mail: "c1-founder" }],
};

// ── what Kleo knows about the person ─────────────────────────────────────────────────────────────────────────────

export interface Facts {
  id: string;
  email: string | null;
  name: string | null;
  credits: number;
  made: number;
  failed: number;
  copyright: boolean;
  paid: boolean;
  plan: string | null;
  createdAt: string;
  closed: string | null;
  country: string | null;
}

const FACTS_SQL = `SELECT u.id, u.display_name AS name, u.credits, u.created_at, u.blocked_at, u.merged_into, u.plan, u.plan_status,
  COALESCE((SELECT l.email FROM studio_logins l WHERE l.user_id = u.id AND l.email IS NOT NULL ORDER BY l.created_at LIMIT 1),
    CASE WHEN u.email LIKE '%.invalid' THEN NULL ELSE u.email END, u.contact_email) AS email,
  CASE WHEN u.email LIKE '%@deleted.kleo.invalid' THEN 1 ELSE 0 END AS deleted,
  (SELECT COUNT(*) FROM studio_generations g WHERE g.user_id = u.id AND g.status = 'done') AS made,
  (SELECT COUNT(*) FROM studio_generations g WHERE g.user_id = u.id AND g.status = 'failed') AS failed,
  (SELECT g.error FROM studio_generations g WHERE g.user_id = u.id AND g.status = 'failed' ORDER BY g.created_at DESC LIMIT 1) AS last_error,
  (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_cent > 0) AS paid,
  (SELECT i.country FROM studio_ips i WHERE i.user_id = u.id AND i.country IS NOT NULL ORDER BY i.at DESC LIMIT 1) AS country
  FROM users u WHERE u.id = ?`;

interface FactsRow {
  id: string; name: string | null; credits: number; created_at: string; blocked_at: string | null; merged_into: string | null;
  plan: string | null; plan_status: string | null; email: string | null; deleted: number; made: number; failed: number;
  last_error: string | null; paid: number; country: string | null;
}

export async function factsOf(env: StudioEnv, userId: string): Promise<Facts | null> {
  const r = await env.DB.prepare(FACTS_SQL).bind(userId).first<FactsRow>().catch(async (e) => {
    // A database without studio_ips (the MCP server's own tests) answers without the country.
    if (!/studio_ips/.test(String(e))) throw e;
    return env.DB.prepare(FACTS_SQL.replace(/\(SELECT i\.country[^)]*\) AS country/, "NULL AS country")).bind(userId).first<FactsRow>();
  });
  if (!r) return null;
  const active = r.plan && r.plan !== "trial" && (r.plan_status ?? "active") === "active";
  return {
    id: r.id, email: r.email, name: firstName(r.name), credits: Number(r.credits) || 0, made: Number(r.made) || 0,
    failed: Number(r.failed) || 0, copyright: isCopyrightRefusal(r.last_error ?? ""), paid: Number(r.paid) > 0 || !!active,
    plan: active ? r.plan : null, createdAt: r.created_at,
    closed: r.deleted ? "deleted" : r.blocked_at ? "blocked" : r.merged_into ? "merged" : null, country: r.country,
  };
}

/** "Maria Rossi" → "Maria"; nothing that does not look like a name ("u_6avh…", an address, digits). */
export function firstName(full: string | null): string | null {
  const w = (full ?? "").trim().split(/\s+/)[0] ?? "";
  if (!w || w.length > 24 || /[@\d_]/.test(w) || !/^\p{L}[\p{L}'’-]*$/u.test(w)) return null;
  return w[0].toUpperCase() + w.slice(1);
}

// ── the words ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One block of an e-mail: a paragraph, a heading, a list, a button. Inline: **bold** and [label](url). */
type Block = { p: string } | { h: string } | { list: string[] } | { button: { label: string; url: string } };
export interface Mail { key: string; subject: string; preheader: string; blocks: Block[]; /** The last line when there is no stop link (else a receipt's). */ footer?: string }

/** What the words need besides the person: prices read from the live catalogue, never typed twice. */
export interface Prices { freeModel: string; freeVideo: number; bestVideo: number; packFrom: string; lite: string; starter: string; pro: string; agency: string; templates: number }

const eur = (cents: number): string => `€${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export function pricesOf(env: StudioEnv, margin: number, factor: number, templates: number): Prices {
  const free = (freeModels(env.STUDIO_FREE_MODELS)[0] ?? "seedance-2.0-fast") as ModelKey;
  const clip = (model: ModelKey) => clipCredits({ model, duration: 5, resolution: "480p", aspect: "16:9", audio: true, imageRole: "none" } as ClipSettings, margin, 0, factor);
  const plan = (key: string) => PLANS.find((p) => p.key === key)?.tiers[0];
  const credits = (key: string) => `${eur(plan(key)?.cents ?? 0)} a month for ${plan(key)?.credits ?? 0} credits`;
  return {
    freeModel: free === "seedance-2.0-fast" ? "Seedance 2.0 Fast" : free, freeVideo: clip(free), bestVideo: clip("seedance-2.5" as ModelKey),
    packFrom: eur(Math.min(...PACKS.map((p) => p.cents))), lite: credits("lite"), starter: credits("starter"), pro: credits("pro"),
    agency: `from ${eur(plan("agency")?.cents ?? 0)} a month`, templates,
  };
}

/** The prices as the app shows them right now: the margin, the video factor and the template count of this Worker. */
export const livePrices = (env: StudioEnv): Prices => pricesOf(env, marginOf(env), videoFactorOf(env), TOOLS.filter((t) => t.group === "trend").length);

const u = (path: string, key: MailKey): string => `${APP}${path}${path.includes("?") ? "&" : "?"}utm_source=email&utm_medium=onboarding&utm_campaign=${key}`;
const hi = (f: Facts): string => `Hi ${f.name ?? "there"},`;
const SIGN: Block[] = [{ p: "Leonardo\nFounder, Kleo" }];
const day = (n: number, title: string): string => `Day ${n} of 7: ${title}`;
const PROMPT = "An old fisherman with a red beanie on a foggy pier at dawn, slow push-in, he lifts the net and laughs";

/** Every e-mail, written for one person. */
export function compose(key: MailKey, f: Facts, x: Prices): Mail {
  const free = f.paid ? "" : f.credits >= x.freeVideo ? ` A 5-second video on ${x.freeModel} costs ${x.freeVideo} credits, and you have ${f.credits}.`
    : ` A 5-second video on ${x.freeModel} costs ${x.freeVideo} credits; credit packs start at ${x.packFrom}.`;
  switch (key) {
    case "w0-welcome": return { key, subject: `Welcome to Kleo${f.name ? `, ${f.name}` : ""}`, preheader: "Your first video is one sentence away.", blocks: [
      { p: hi(f) },
      { p: "Thanks for joining Kleo. I'm Leonardo, and I build it. For the next week I'll send you one short e-mail a day with the things that make Kleo worth it. Today: your first video." },
      { h: "Make a video from one sentence" },
      { p: `Open Kleo and type what you want to see, like "a golden retriever surfing a wave at sunset, slow motion". Kleo turns it into a shot and makes the clip in a few minutes.${free}` },
      { h: "Or start from a photo" },
      { p: "Attach any picture and Kleo brings it to life: a product turning on a table, a portrait that looks up and smiles, a street at night with the rain falling." },
      { h: "Let Enhance write it for you" },
      { p: "Tap Enhance under the prompt box and Kleo rewrites your idea the way a director would: the camera, the light, the motion." },
      { button: { label: "Make my first video", url: u("/", key) } },
      { p: "If anything gets in the way, reply to this e-mail. It comes straight to me." },
      ...SIGN] };
    case "w1-templates": return { key, subject: day(2, "Put yourself in a viral video"), preheader: "One photo, one trending clip.", blocks: [
      { p: hi(f) },
      { p: "A lot of what you watch on TikTok and Reels is a trend: the same dance, the same move, a new face. Kleo's templates let you step into one with a single photo." },
      { h: "How it works" },
      { p: "Pick a template, add a sharp photo of the person (facing the camera, good light, the whole body if the move needs it) and Kleo makes the clip in a few minutes." },
      { h: "Good ones to start with" },
      { list: [`[APT](${u("/apps/trend-apt", key)})`, `[Call Me Maybe!](${u("/apps/trend-call-me-maybe", key)})`, `[Paris Fire Dance](${u("/apps/trend-paris-fire-dance", key)})`, `[Wings & Vibes](${u("/apps/trend-wings-and-vibes", key)})`] },
      { p: `There are ${x.templates} templates today, and new ones arrive as the trends move. ${f.paid ? "Your account can use every one of them." : `Templates open with any credit pack, from ${x.packFrom}.`}` },
      { p: "Only use photos of people who said yes. Yourself is always a good start." },
      { button: { label: "Browse the templates", url: u("/templates", key) } },
      ...SIGN] };
    case "w2-prompts": return { key, subject: day(3, "Prompts that look like film"), preheader: "Four things to say in every prompt.", blocks: [
      { p: hi(f) },
      { p: "The difference between an okay clip and one people watch twice is usually the prompt. Say four things every time:" },
      { list: [
        "**Who or what**, with one detail: \"an old fisherman with a red beanie\".",
        "**Where and when**: \"on a foggy pier at dawn\".",
        "**The camera**: \"slow push-in\", \"handheld\", \"drone shot\", \"close-up\".",
        "**The motion**: \"he lifts the net and laughs\".",
      ] },
      { p: `Put together: "${PROMPT}."` },
      { p: "Keep it to one scene per clip. For TikTok, Reels and Shorts pick 9:16; for YouTube, 16:9. Not sure which model? Keep the one Kleo suggests and press Enhance first." },
      { button: { label: "Try this prompt", url: u(`/video?prompt=${encodeURIComponent(PROMPT)}&aspect=9:16`, key) } },
      ...SIGN] };
    case "w3-apps": return { key, subject: day(4, "The apps inside Kleo"), preheader: "Face swap, voiceover, music and more.", blocks: [
      { p: hi(f) },
      { p: "Besides videos from a prompt, Kleo has apps for the jobs creators do every week:" },
      { list: [
        "**Face Swap** and **Video Face Swap**: put a face on a photo or a clip.",
        "**Outfit Swap**: try a new look on a photo.",
        "**Talking Photo** and **Lipsync**: make a portrait say your words.",
        "**Character Swap** and **Motion Control**: put your character into a video, or give your photo the moves of another clip.",
        "**Voiceover**, **Music** and **Sound Effects**: the audio, made to measure.",
        "**Edit Video** and **Upscale Video**: change a clip with words, or make it sharper.",
      ] },
      ...(f.paid ? [] : [{ p: "Face Swap, Outfit Swap, Voiceover, Music and Sound Effects work with the free credits too." }]),
      { button: { label: "Open the apps", url: u("/apps", key) } },
      ...SIGN] };
    case "w4-share": return { key, subject: day(5, "From Kleo to TikTok, Reels and Shorts"), preheader: "Sizes, sharing, and Kleo inside your AI assistant.", blocks: [
      { p: hi(f) },
      { p: "A few things that save time once you make videos every week:" },
      { list: [
        "**The right size first time**: 9:16 for TikTok, Reels and Shorts; 16:9 for YouTube and the web.",
        "**Download or share**: every video has a download button and a link you can send to a client.",
        "**Your library**: everything you make stays in Library, in one place.",
        `**Kleo in Claude and ChatGPT**: [connect Kleo](${u("/connect", key)}) to your assistant and ask for a video right from the chat.`,
        "**Sharper templates**: 720p and 1080p templates come with a plan.",
      ] },
      { button: { label: "Open my library", url: u("/library", key) } },
      ...SIGN] };
    case "w5-credits": return { key, subject: day(6, "How credits work"), preheader: "What things cost, and how to pay less per video.", blocks: [
      { p: hi(f) },
      { p: "Everything in Kleo is priced in credits, and you always see the price before you press make." },
      { list: [
        `A 5-second video on ${x.freeModel}: ${x.freeVideo} credits. On Seedance 2.5, the sharpest motion: ${x.bestVideo} credits.`,
        "If a video fails, its credits come back to your account by themselves.",
        `**Packs** top up once, from ${x.packFrom}.`,
        `**Plans** give you credits every month for less per credit: Lite ${x.lite}, Starter ${x.starter}, Pro ${x.pro}, Agency for teams ${x.agency}. Plans also open 720p and 1080p templates.`,
      ] },
      { p: f.plan ? `You're on the ${f.plan[0].toUpperCase()}${f.plan.slice(1)} plan, with ${f.credits} credits right now.` : `You have ${f.credits} credits right now.` },
      { button: { label: "See the plans", url: u("/plans", key) } },
      ...SIGN] };
    case "w6-founder": return { key, subject: day(7, "What do you want to make?"), preheader: "One question from me.", blocks: [
      { p: hi(f) },
      { p: "This is the last e-mail of the week, so one question, and I read every answer: what do you want to make with Kleo?" },
      { p: "Videos for your shop, ads for clients, a channel, something just for fun? Hit reply and tell me in one line. If something didn't work, tell me that too. I fix things fast." },
      { p: "No more daily e-mails after this one. Thanks for trying Kleo." },
      ...SIGN] };
    case "rescue": return { key, subject: "Your first video didn't come out", preheader: "The credits are back. Here's what usually fixes it.", blocks: [
      { p: hi(f) },
      { p: "Your first video on Kleo failed, and I'm sorry: that's not the start I want anyone to have. The credits went back to your account by themselves." },
      { p: f.copyright
        ? "The model said no because it thought the prompt or the photo showed a famous person, a brand or a protected character. Describe your own character instead of naming one (\"a hero in a red suit\" rather than a film's name), or use a photo of yourself."
        : "Most failures come from a busy model or a picture it can't read. Try again in a few minutes, use a sharp photo that faces the camera, and keep the prompt to one clear scene." },
      { button: { label: "Try again", url: u("/", key) } },
      { p: "If it fails again, reply with what you tried and I'll look at it myself." },
      ...SIGN] };
    case "c0-failed": return { key, subject: "Sorry about your first Kleo video", preheader: "Your credits came back. Here's what works.", blocks: [
      { p: hi(f) },
      { p: "You tried Kleo a little while ago and your video didn't come out. I'm sorry, that's on us. The credits went back to your account by themselves, so you still have " + f.credits + "." },
      { p: f.copyright
        ? "The model refused it because it thought the prompt or the photo showed a famous person, a brand or a protected character. Describe your own character instead of naming one, or use a photo of yourself, and it goes through."
        : "What usually works: one clear scene per prompt, a sharp photo that faces the camera, and a second try a few minutes later if the model is busy." },
      { p: `A prompt to start from: "${PROMPT}."` },
      { button: { label: "Try it now", url: u(`/video?prompt=${encodeURIComponent(PROMPT)}&aspect=9:16`, key) } },
      { p: "If it fails again, reply and tell me what you typed. I'll look at it myself." },
      ...SIGN] };
    case "c0-unused": return { key, subject: f.credits > 0 ? `Your ${f.credits} Kleo credits are still here` : "Your first Kleo video is one sentence away", preheader: "Your first video is one sentence away.", blocks: [
      { p: hi(f) },
      { p: f.credits > 0 ? `You opened a Kleo account but haven't made anything yet, so your ${f.credits} credits are waiting.` : "You opened a Kleo account but haven't made anything yet. Here's the quickest way to start." },
      { p: `Open Kleo and type one sentence about a scene, like "a golden retriever surfing a wave at sunset, slow motion". Kleo turns it into a shot and makes the clip in a few minutes. A 5-second video on ${x.freeModel} costs ${x.freeVideo} credits${f.credits >= x.freeVideo ? "" : `, and credit packs start at ${x.packFrom}`}.` },
      ...(f.credits > 0 ? [{ p: "Prefer a photo? Face Swap and Outfit Swap work with the free credits too." }] : []),
      { button: { label: "Make my first video", url: u("/", key) } },
      { p: "If something stopped you, reply and tell me. It comes straight to me." },
      ...SIGN] };
    case "c0-next": return { key, subject: "Three things to try next on Kleo", preheader: "Templates, apps, and a prompt trick.", blocks: [
      { p: hi(f) },
      { p: "Thanks for making something on Kleo. Three things worth trying next:" },
      { list: [
        `**Templates**: step into a trending clip with one photo. Try [APT](${u("/apps/trend-apt", key)}) or [Paris Fire Dance](${u("/apps/trend-paris-fire-dance", key)}).`,
        `**Apps**: [Face Swap, Talking Photo, Voiceover, Music](${u("/apps", key)}) and more, in the same place.`,
        "**Better prompts**: say who, where, the camera and the motion, like \"" + PROMPT + "\".",
      ] },
      { button: { label: "Open Kleo", url: u("/", key) } },
      ...SIGN] };
    case "c1-founder": return { key, subject: "What would make Kleo worth it for you?", preheader: "One question from me.", blocks: [
      { p: hi(f) },
      { p: "One question, and I read every answer: what would make Kleo worth it for you?" },
      { p: "Videos for your shop, ads for clients, a channel, something just for fun? Hit reply and tell me in one line. If something didn't work, tell me that too. I fix things fast." },
      { p: "This is the last e-mail I send about it. Thanks for trying Kleo." },
      ...SIGN] };
  }
}

/** The comeback e-mail that fits what the person did. */
export const comebackMail = (f: Facts): MailKey => f.made > 0 ? "c0-next" : f.failed > 0 ? "c0-failed" : "c0-unused";

// ── HTML and text ────────────────────────────────────────────────────────────────────────────────────────────────

const inlineHtml = (s: string): string => escapeHtml(s)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/&amp;/g, "&").replace(/"/g, "%22").replace(/&/g, "&amp;")}" style="color:#0a66d8;text-decoration:underline">${label}</a>`)
  .replace(/\n/g, "<br>");
const inlineText = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, "$1 ($2)");

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The footer of an e-mail with a stop link (the welcome series), or of a receipt (stopUrl null: nothing to stop). */
const RECEIPT_FOOTER = "This e-mail confirms a payment on your Kleo account.";

export function renderHtml(m: Mail, stopUrl: string | null): string {
  const body = m.blocks.map((b) => {
    if ("p" in b) return `<p style="margin:0 0 16px">${inlineHtml(b.p)}</p>`;
    if ("h" in b) return `<p style="margin:24px 0 6px;font-weight:600;font-size:17px">${inlineHtml(b.h)}</p>`;
    if ("list" in b) return `<ul style="margin:0 0 16px;padding-left:22px">${b.list.map((li) => `<li style="margin:0 0 8px">${inlineHtml(li)}</li>`).join("")}</ul>`;
    return `<p style="margin:24px 0 24px"><a href="${escapeHtml(b.button.url)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 22px;border-radius:999px">${escapeHtml(b.button.label)}</a></p>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(m.subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(m.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:${FONT};font-size:16px;line-height:1.6;color:#111111">
${body}
<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;font-size:15px;color:#6b6b6b">${stopUrl ? `You're getting this because you opened a Kleo account with this address. <a href="${escapeHtml(stopUrl)}" style="color:#6b6b6b">Stop these e-mails</a>.` : escapeHtml(m.footer ?? RECEIPT_FOOTER)} Kleo · <a href="https://kleooai.com" style="color:#6b6b6b">kleooai.com</a></p>
</div></body></html>`;
}

export function renderText(m: Mail, stopUrl: string | null): string {
  const lines = m.blocks.map((b) => {
    if ("p" in b) return inlineText(b.p);
    if ("h" in b) return inlineText(b.h);
    if ("list" in b) return b.list.map((li) => `- ${inlineText(li)}`).join("\n");
    return `${b.button.label}: ${b.button.url}`;
  });
  const foot = stopUrl ? `You're getting this because you opened a Kleo account with this address.\nStop these e-mails: ${stopUrl}` : (m.footer ?? RECEIPT_FOOTER);
  return `${lines.join("\n\n")}\n\n--\n${foot}\nKleo, https://kleooai.com\n`;
}

// ── the unsubscribe link ─────────────────────────────────────────────────────────────────────────────────────────

const stopSig = async (env: StudioEnv, userId: string): Promise<string> => (await hmacHex(env.INTERNAL_SECRET, `kleo-mail-stop:${userId}`)).slice(0, 32);
export async function stopLink(env: StudioEnv, userId: string): Promise<string> {
  return `${APP}/email/stop?u=${encodeURIComponent(userId)}&s=${await stopSig(env, userId)}`;
}

/** An address that must not be written to again; the account's series stops too. */
export async function suppress(env: StudioEnv, email: string, reason: string, source: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO mail_suppress (email, reason, source) VALUES (?, ?, ?)").bind(email.trim().toLowerCase(), reason, source).run();
  await env.DB.prepare(`UPDATE studio_mail SET status = 'stopped', stop_reason = ?, updated_at = ${NOW} WHERE email = ? AND status = 'active'`).bind(reason, email.trim().toLowerCase()).run();
}

/**
 * GET /email/stop shows one button (mail scanners open every link, and a GET that unsubscribed would stop e-mails
 * nobody asked to stop); POST stops — the button, or the mail client's own one-click button (RFC 8058).
 */
export async function handleStop(env: StudioEnv, request: Request, url: URL): Promise<Response> {
  const page = (title: string, text: string, form = "", status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Kleo</title>
<style>body{margin:0;background:#fff;color:#111;font:17px/1.55 ${FONT};display:grid;place-items:center;min-height:100vh;padding:24px 16px;box-sizing:border-box}main{width:min(440px,100%)}h1{font-size:24px;margin:0 0 10px}p{margin:0 0 20px;color:#444}button{font:600 17px ${FONT};background:#111;color:#fff;border:0;border-radius:999px;padding:14px 24px;cursor:pointer}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${form}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  const userId = url.searchParams.get("u") ?? "";
  const sig = url.searchParams.get("s") ?? "";
  if (!/^u_[a-z0-9]{4,40}$/.test(userId) || !safeEqual(sig, await stopSig(env, userId))) {
    return page("This link is not valid", "Write to hello@kleooai.com and we'll stop the e-mails by hand.", "", 400);
  }
  if (request.method === "POST") {
    const row = await env.DB.prepare("SELECT email FROM studio_mail WHERE user_id = ?").bind(userId).first<{ email: string }>();
    const email = row?.email ?? (await factsOf(env, userId))?.email ?? null;
    if (email) await suppress(env, email, "unsubscribe", "onboarding");
    await env.DB.prepare(`UPDATE studio_mail SET status = 'stopped', stop_reason = 'unsubscribe', updated_at = ${NOW} WHERE user_id = ?`).bind(userId).run();
    await audit(asEnv(env), userId, null, "mail.unsubscribe", { via: (await request.clone().text().catch(() => "")).includes("One-Click") ? "one-click" : "page" });
    return page("You're unsubscribed", "Kleo won't send you these e-mails again. Your account and your credits are unchanged.");
  }
  return page("Stop Kleo's e-mails?", "You won't get the tips and news e-mails any more. Your account stays as it is.",
    `<form method="post" action="/email/stop?u=${encodeURIComponent(userId)}&amp;s=${escapeHtml(sig)}"><button type="submit">Stop the e-mails</button></form>`);
}

// ── the switch ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function mailMode(env: StudioEnv): Promise<{ on: boolean; since: string | null }> {
  const rows = (await env.DB.prepare("SELECT key, value FROM studio_meta WHERE key IN ('onboarding_mode', 'onboarding_on_since')").all<{ key: string; value: string }>()).results ?? [];
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  return { on: get("onboarding_mode") === "on", since: get("onboarding_on_since") };
}

export async function setMailMode(env: StudioEnv, on: boolean, by: string): Promise<void> {
  const stmts = [env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES ('onboarding_mode', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(on ? "on" : "off")];
  // The first time it goes on is the line between the two series; switching off and on again keeps it.
  if (on) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO studio_meta (key, value) VALUES ('onboarding_on_since', ${NOW})`));
  await env.DB.batch(stmts);
  await audit(asEnv(env), by, null, "admin.mail_mode", { on });
}

// ── time of day ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a country mostly lives; a country not listed is treated as UTC. */
const ZONES: Record<string, string> = {
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires",
  CO: "America/Bogota", CL: "America/Santiago", PE: "America/Lima", GB: "Europe/London", IE: "Europe/Dublin", PT: "Europe/Lisbon",
  ES: "Europe/Madrid", FR: "Europe/Paris", IT: "Europe/Rome", DE: "Europe/Berlin", NL: "Europe/Amsterdam", BE: "Europe/Brussels",
  CH: "Europe/Zurich", AT: "Europe/Vienna", PL: "Europe/Warsaw", SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen",
  FI: "Europe/Helsinki", GR: "Europe/Athens", RO: "Europe/Bucharest", UA: "Europe/Kyiv", TR: "Europe/Istanbul", RU: "Europe/Moscow",
  IL: "Asia/Jerusalem", AE: "Asia/Dubai", SA: "Asia/Riyadh", EG: "Africa/Cairo", NG: "Africa/Lagos", ZA: "Africa/Johannesburg",
  KE: "Africa/Nairobi", MA: "Africa/Casablanca", IN: "Asia/Kolkata", PK: "Asia/Karachi", BD: "Asia/Dhaka", TH: "Asia/Bangkok",
  VN: "Asia/Ho_Chi_Minh", ID: "Asia/Jakarta", MY: "Asia/Kuala_Lumpur", SG: "Asia/Singapore", PH: "Asia/Manila", CN: "Asia/Shanghai",
  HK: "Asia/Hong_Kong", TW: "Asia/Taipei", KR: "Asia/Seoul", JP: "Asia/Tokyo", AU: "Australia/Sydney", NZ: "Pacific/Auckland",
};
export const zoneOf = (country: string | null): string => ZONES[(country ?? "").toUpperCase()] ?? "UTC";

function localHour(ms: number, zone: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", hour12: false }).format(new Date(ms));
    return Number(h) % 24;
  } catch { return new Date(ms).getUTCHours(); }
}

/** The moment itself when it falls between 9:00 and 20:00 where the person is, else the next 9:00 there (± a few minutes). */
export function inDaytime(ms: number, zone: string, jitterMin = 0): number {
  let t = ms;
  for (let i = 0; i < 26 && (localHour(t, zone) < DAY_START_H || localHour(t, zone) >= DAY_END_H); i++) t = Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000;
  return t === ms ? ms : t + jitterMin * 60_000;
}

// ── sending ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Email Sending binding as Kleo calls it (structured message; workers-types may only know the raw one). */
interface Sender { send(m: Record<string, unknown>): Promise<{ messageId?: string } | void> }
export type SendResult = { ok: true; id: string | null } | { ok: false; code: string; error: string };

/** One e-mail through Email Sending; a receipt (stopUrl null) carries no unsubscribe headers: it is not a mailing. */
export async function deliver(env: StudioEnv, to: string, m: Mail, stopUrl: string | null, tag: string): Promise<SendResult> {
  const sender = env.EMAIL as unknown as Sender | undefined;
  if (!sender) return { ok: false, code: "E_NO_BINDING", error: "The EMAIL binding is missing." };
  try {
    const r = await sender.send({
      to, from: { email: MAIL_FROM, name: MAIL_FROM_NAME }, replyTo: MAIL_FROM, subject: m.subject,
      html: renderHtml(m, stopUrl), text: renderText(m, stopUrl),
      headers: stopUrl ? { "List-Unsubscribe": `<${stopUrl}>, <mailto:${MAIL_FROM}?subject=unsubscribe>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Kleo-Mail": tag } : { "X-Kleo-Mail": tag },
    });
    return { ok: true, id: (r && typeof r === "object" && "messageId" in r ? String(r.messageId ?? "") : "") || null };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    return { ok: false, code: String(err?.code ?? "E_UNKNOWN"), error: String(err?.message ?? e).slice(0, 300) };
  }
}

/** A refusal about the address itself (bounced, suppressed, not valid): that address is done. */
const ADDRESS_PROBLEM = /suppress|bounce|invalid (recipient|address|email)|recipient.*(not|in)valid|mailbox|E_RECIPIENT|E_INVALID_TO/i;
/** A refusal about Kleo's side (domain not ready, sender not allowed): every send waits and the owner hears. */
const SENDER_PROBLEM = /E_SENDER|E_DOMAIN|not verified|not onboarded|E_NO_BINDING|E_UNAUTHORIZED|E_FORBIDDEN/i;
const RATE_PROBLEM = /RATE|QUOTA|LIMIT|429/i;

async function logSend(env: StudioEnv, userId: string | null, email: string, mail: string, kind: string, r: SendResult): Promise<void> {
  await env.DB.prepare("INSERT INTO studio_mail_log (user_id, email, mail, kind, ok, error, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(userId, email, mail, kind, r.ok ? 1 : 0, r.ok ? null : `${r.code}: ${r.error}`, r.ok ? r.id : null).run();
}

const int = (v: string | undefined, d: number): number => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const adminIds = (env: StudioEnv): string[] => (env.STUDIO_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface MailRow { user_id: string; email: string; track: Track; step: number; next_at: string; status: string; rescued: number; attempts: number; tz: string | null; started_at: string }

/** Accounts opened since the switch went on, and (once) the comeback accounts of the 30 days before. */
export async function enroll(env: StudioEnv, since: string, nowMs = Date.now()): Promise<{ welcome: number; comeback: number }> {
  const admins = adminIds(env);
  const notAdmin = admins.length ? ` AND u.id NOT IN (${admins.map(() => "?").join(",")})` : "";
  const fresh = (await env.DB.prepare(`SELECT u.id, u.created_at FROM users u WHERE u.created_at >= ?
      AND EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM studio_mail m WHERE m.user_id = u.id)${notAdmin}
      ORDER BY u.created_at LIMIT 200`).bind(since, ...admins).all<{ id: string; created_at: string }>()).results ?? [];
  let welcome = 0, comeback = 0;
  for (const a of fresh) if (await start(env, a.id, "welcome", a.created_at, Math.max(nowMs, Date.parse(a.created_at) + FIRST_AFTER_MIN * 60_000))) welcome++;
  const done = await env.DB.prepare("SELECT value FROM studio_meta WHERE key = 'onboarding_comeback'").first<{ value: string }>();
  if (!done) {
    const from = new Date(Date.parse(since) - COMEBACK_DAYS * 86_400_000).toISOString();
    const old = (await env.DB.prepare(`SELECT u.id FROM users u WHERE u.created_at >= ? AND u.created_at < ?
        AND EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM studio_mail m WHERE m.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_cent > 0)${notAdmin}
        ORDER BY u.created_at`).bind(from, since, ...admins).all<{ id: string }>()).results ?? [];
    // Spread over the day: one every few minutes, each moved into the person's own daytime.
    for (const [i, a] of old.entries()) if (await start(env, a.id, "comeback", new Date(nowMs).toISOString(), nowMs + i * 4 * 60_000, true)) comeback++;
    await env.DB.prepare("INSERT OR IGNORE INTO studio_meta (key, value) VALUES ('onboarding_comeback', ?)").bind(new Date(nowMs).toISOString()).run();
  }
  return { welcome, comeback };
}

async function start(env: StudioEnv, userId: string, track: Track, startedAt: string, firstMs: number, daytime = false): Promise<boolean> {
  const f = await factsOf(env, userId);
  if (!f?.email || f.closed) return false;
  if (await env.DB.prepare("SELECT 1 AS one FROM mail_suppress WHERE email = ?").bind(f.email.toLowerCase()).first()) return false;
  const tz = zoneOf(f.country);
  const at = daytime ? inDaytime(firstMs, tz, Math.floor(Math.random() * 25)) : firstMs;
  const r = await env.DB.prepare("INSERT OR IGNORE INTO studio_mail (user_id, email, track, step, next_at, tz, started_at) VALUES (?, ?, ?, 0, ?, ?, ?)")
    .bind(userId, f.email.toLowerCase(), track, new Date(at).toISOString(), tz, startedAt).run();
  return (r.meta.changes ?? 0) === 1;
}

export interface TickResult { sent: number; skipped: number; failed: number; paused?: string }

/**
 * One tick of the cron (every 5 minutes): enroll, then send what is due, within the per-tick and daily caps. Stops at
 * the first refusal about Kleo's own side (and tells the owner, twice a day at most) or about the quota.
 */
export async function mailTick(env: StudioEnv, prices: Prices, nowMs = Date.now()): Promise<TickResult> {
  const mode = await mailMode(env);
  const out: TickResult = { sent: 0, skipped: 0, failed: 0 };
  if (!mode.on || !mode.since) return out;
  await enroll(env, mode.since, nowMs);
  const cap = int(env.STUDIO_MAIL_DAILY_CAP, 300);
  const today = (await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_mail_log WHERE ok = 1 AND kind = 'live' AND at >= strftime('%Y-%m-%dT00:00:00.000Z','now')").first<{ n: number }>())?.n ?? 0;
  const room = Math.max(0, Math.min(int(env.STUDIO_MAIL_PER_TICK, 12), cap - today));
  if (!room) return { ...out, paused: "daily cap" };
  const due = (await env.DB.prepare("SELECT * FROM studio_mail WHERE status = 'active' AND next_at <= ? ORDER BY next_at LIMIT ?")
    .bind(new Date(nowMs).toISOString(), room).all<MailRow>()).results ?? [];
  for (const row of due) {
    const r = await sendStep(env, row, prices, nowMs);
    if (r === "sent") out.sent++; else if (r === "skipped") out.skipped++; else if (r === "failed") out.failed++;
    else { out.paused = r; break; }
  }
  return out;
}

const stopRow = (env: StudioEnv, userId: string, why: string) =>
  env.DB.prepare(`UPDATE studio_mail SET status = 'stopped', stop_reason = ?, updated_at = ${NOW} WHERE user_id = ?`).bind(why, userId).run();

async function sendStep(env: StudioEnv, row: MailRow, prices: Prices, nowMs: number): Promise<"sent" | "skipped" | "failed" | string> {
  const f = await factsOf(env, row.user_id);
  if (!f || f.closed) { await stopRow(env, row.user_id, f?.closed ?? "gone"); return "skipped"; }
  if (await env.DB.prepare("SELECT 1 AS one FROM mail_suppress WHERE email = ?").bind(row.email).first()) { await stopRow(env, row.user_id, "suppressed"); return "skipped"; }
  if (row.track === "comeback" && f.paid) { await stopRow(env, row.user_id, "paid"); return "skipped"; }
  const series = SERIES[row.track];
  const step = series[row.step];
  if (!step) { await env.DB.prepare(`UPDATE studio_mail SET status = 'done', updated_at = ${NOW} WHERE user_id = ?`).bind(row.user_id).run(); return "skipped"; }
  // A first try that failed with nothing made since: the rescue e-mail, once, in place of the step that was due.
  const rescue = row.track === "welcome" && row.step >= 1 && !row.rescued && f.failed > 0 && f.made === 0;
  const key: MailKey = rescue ? "rescue" : step.mail === "c0" ? comebackMail(f) : step.mail;
  const stopUrl = await stopLink(env, row.user_id);
  const r = await deliver(env, row.email, compose(key, f, prices), stopUrl, key);
  await logSend(env, row.user_id, row.email, key, "live", r);
  if (!r.ok) {
    const what = `${r.code} ${r.error}`;
    if (SENDER_PROBLEM.test(what)) { await alertOwner(env, what, nowMs); return "sender"; }
    if (RATE_PROBLEM.test(what)) return "rate";
    if (ADDRESS_PROBLEM.test(what)) { await suppress(env, row.email, "bounce", "onboarding"); return "failed"; }
    const attempts = row.attempts + 1;
    await env.DB.prepare(`UPDATE studio_mail SET attempts = ?, next_at = ?, status = CASE WHEN ? >= 3 THEN 'stopped' ELSE status END,
        stop_reason = CASE WHEN ? >= 3 THEN 'errors' ELSE stop_reason END, updated_at = ${NOW} WHERE user_id = ?`)
      .bind(attempts, new Date(nowMs + 3_600_000).toISOString(), attempts, attempts, row.user_id).run();
    return "failed";
  }
  const nextStep = rescue ? row.step : row.step + 1;
  const next = series[nextStep];
  if (!next) {
    await env.DB.prepare(`UPDATE studio_mail SET step = ?, status = 'done', next_at = NULL, attempts = 0, updated_at = ${NOW} WHERE user_id = ?`).bind(nextStep, row.user_id).run();
  } else {
    // The next one on its day, never less than 20 hours after this one, in the person's daytime.
    const planned = Math.max(Date.parse(row.started_at) + next.day * 86_400_000, nowMs + 20 * 3_600_000);
    const at = inDaytime(planned, row.tz ?? "UTC", Math.floor(Math.random() * 30));
    await env.DB.prepare(`UPDATE studio_mail SET step = ?, rescued = ?, next_at = ?, attempts = 0, updated_at = ${NOW} WHERE user_id = ?`)
      .bind(nextStep, rescue ? 1 : row.rescued, new Date(at).toISOString(), row.user_id).run();
  }
  return "sent";
}

async function alertOwner(env: StudioEnv, what: string, nowMs: number): Promise<void> {
  const last = await env.DB.prepare("SELECT value FROM studio_meta WHERE key = 'onboarding_alerted_at'").first<{ value: string }>();
  if (last && nowMs - Date.parse(last.value) < 12 * 3_600_000) return;
  await env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES ('onboarding_alerted_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(new Date(nowMs).toISOString()).run();
  await mailOwner(env, "Kleo's welcome e-mails are waiting", `Cloudflare refused to send Kleo's welcome e-mails:\n\n${what}\n\nNothing is lost: they wait and go out by themselves once sending works. Check Email Sending for kleooai.com in the Cloudflare dashboard (Compute > Email Service > Email Sending).`, nowMs);
}

// ── the owner's preview ──────────────────────────────────────────────────────────────────────────────────────────

/** Every e-mail in the order a person meets them, for the console's preview and the owner's test send. */
export const ALL_MAILS: MailKey[] = ["w0-welcome", "w1-templates", "w2-prompts", "w3-apps", "w4-share", "w5-credits", "w6-founder", "rescue", "c0-failed", "c0-unused", "c0-next", "c1-founder"];

/** A believable account for the previews: a new one with the free credits and nothing made. */
export const sampleFacts = (over: Partial<Facts> = {}): Facts => ({
  id: "u_preview", email: "you@example.com", name: "Alex", credits: 5, made: 0, failed: 0, copyright: false, paid: false, plan: null,
  createdAt: new Date().toISOString(), closed: null, country: null, ...over,
});

/** Sends the whole series to the owner (the Email Routing address, which is free and needs no sending domain). */
export async function sendSeriesToOwner(env: StudioEnv, prices: Prices, to = (env.OWNER_MAIL_TO ?? "kleooai@gmail.com").trim()): Promise<{ sent: number; failed: string[] }> {
  const failed: string[] = [];
  let sent = 0;
  const stopUrl = `${APP}/email/stop?u=u_preview&s=preview`;
  for (const [i, key] of ALL_MAILS.entries()) {
    const f = sampleFacts(key === "c0-next" ? { made: 2, credits: 1 } : key === "c0-failed" || key === "rescue" ? { failed: 1 } : {});
    const m = compose(key, f, prices);
    const r = await deliver(env, to, { ...m, subject: `[Preview ${i + 1}/${ALL_MAILS.length}] ${m.subject}` }, stopUrl, `preview:${key}`);
    await logSend(env, null, to, key, "preview", r);
    if (r.ok) sent++; else failed.push(`${key}: ${r.code} ${r.error}`);
  }
  // The payment e-mails too (src/studio/receipts.ts), after the series.
  const { RECEIPT_KINDS, composeReceipt, sampleReceipt } = await import("./receipts.ts");
  for (const [i, r0] of RECEIPT_KINDS.entries()) {
    const m = composeReceipt(r0.kind, sampleReceipt(r0.kind));
    const r = await deliver(env, to, { ...m, subject: `[Preview receipt ${i + 1}/${RECEIPT_KINDS.length}] ${m.subject}` }, null, `preview:${r0.key}`);
    await logSend(env, null, to, r0.key, "preview", r);
    if (r.ok) sent++; else failed.push(`${r0.key}: ${r.code} ${r.error}`);
  }
  return { sent, failed };
}
