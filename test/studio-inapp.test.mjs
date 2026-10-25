/**
 * Signing up from Instagram's and TikTok's in-app browsers (studio-web/inapp.js, the sign-in screen in studio-web/app.js).
 * Google refuses its sign-in inside an app's embedded browser ("Error 403: disallowed_useragent") and new Studio
 * accounts are opened with Google only, so in those apps the sign-in screen first opens the page in Safari or Chrome.
 * Covers: the in-app browsers are named the same way as the Worker names them (src/studio/attribution.ts), which apps
 * get the step and on which phone, the address that goes to the other browser (it keeps the first visit's utm tags, and
 * the Worker reads the same source from it with no cookie), the Android intent link, that both hosts serve the new
 * file, and the owner's rules for the screen (no browser pop-ups, no text under 16 px).
 * Run: node --test test/studio-inapp.test.mjs
 */
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage {}") };
  return next(s, c);
}`));
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { inAppOf, signInHop, hopFor, osOf, hopAddress, chromeIntent, GOOGLE_BLOCKED, SOURCE_TAGS } from "../studio-web/inapp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let worker;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { inAppOf, touchOf } from "./src/studio/attribution.ts";
      export { APP_PATH } from "./src/studio/site.ts"; export { ADMIN_SITE_PATH, CONSOLE_PATH } from "./src/studio/admin-host.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  worker = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const CHROME_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22H31 Instagram 402.0.0.31.104 (iPhone16,2; iOS 18_7; en_US; en; scale=3.00; 1290x2796; 812345678)";
const IG_ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Instagram 402.0.0.31.104 Android (35/15; 420dpi; 1080x2424; Google/google; Pixel 9; tokay; tokay; en_US; 812345678)";
const TIKTOK_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_41.8.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/NZ";
const TIKTOK_ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36 trill_410800 BytedanceWebview/d8a21c6";
const FB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.40.100;FBBV/700000000;FBDV/iPhone16,2]";
const THREADS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Barcelona 402.0.0.12.109 (iPhone16,2; iOS 18_7; en_US; en)";
const X_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.20";
const LINKEDIN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.31.1";
const IPAD_IG = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 402.0.0.31.104 (iPad13,1; iPadOS 18_7)";
const ALL = [SAFARI, CHROME_ANDROID, CHROME_DESKTOP, IG_UA, IG_ANDROID, TIKTOK_UA, TIKTOK_ANDROID, FB_UA, THREADS_UA, X_UA, LINKEDIN_UA, IPAD_IG,
  "Mozilla/5.0 (Linux; Android 14) Snapchat/13.10.0.42 (SM-S918B)", "Mozilla/5.0 (iPhone) Pinterest for iOS/12.40", "Mozilla/5.0 (iPhone) Line/14.1.0",
  "Mozilla/5.0 (iPhone) Discord/240.0", "Mozilla/5.0 (iPhone) com.google.ios.youtube/19.40.4", "", null];

test("the page names an in-app browser exactly as the Worker does", () => {
  for (const ua of ALL) assert.equal(inAppOf(ua), worker.inAppOf(ua), String(ua));
  const src = readFileSync(join(ROOT, "src", "studio", "attribution.ts"), "utf8");
  const page = readFileSync(join(ROOT, "studio-web", "inapp.js"), "utf8");
  const list = (text) => text.slice(text.indexOf("const IN_APP")).split("];")[0].match(/\[\/.+?\/[a-z]*, "[a-z]+"\]/g);
  assert.deepEqual(list(page), list(src), "the same regular expressions in the same order");
});

test("Instagram, TikTok, Facebook and Threads get the step, with the phone's own browser; the rest sign in with Google here", () => {
  assert.deepEqual(Object.keys(GOOGLE_BLOCKED).sort(), ["facebook", "instagram", "threads", "tiktok"]);
  const hop = (ua, touch) => { const x = signInHop(ua, touch); return x && [x.app, x.os, x.browser, x.name]; };
  assert.deepEqual(hop(IG_UA), ["instagram", "ios", "Safari", "Instagram"]);
  assert.deepEqual(hop(IG_ANDROID), ["instagram", "android", "Chrome", "Instagram"]);
  assert.deepEqual(hop(TIKTOK_UA), ["tiktok", "ios", "Safari", "TikTok"]);
  assert.deepEqual(hop(TIKTOK_ANDROID), ["tiktok", "android", "Chrome", "TikTok"]);
  assert.deepEqual(hop(FB_UA), ["facebook", "ios", "Safari", "Facebook"]);
  assert.deepEqual(hop(THREADS_UA), ["threads", "ios", "Safari", "Threads"]);
  assert.deepEqual(hop(IPAD_IG, 5), ["instagram", "ios", "Safari", "Instagram"], "an iPad that says Macintosh");
  for (const ua of [SAFARI, CHROME_ANDROID, CHROME_DESKTOP, X_UA, LINKEDIN_UA, "", null]) assert.equal(signInHop(ua), null, String(ua));
  // The app's menu entry on iPhone.
  assert.equal(signInHop(IG_UA).menu, "Open in external browser");
  assert.equal(signInHop(TIKTOK_UA).menu, "Open in browser");
  // An unknown phone still gets the step, with a copied link for "your browser".
  assert.deepEqual([hopFor("tiktok", null).os, hopFor("tiktok", null).browser], [null, "your browser"]);
  assert.equal(osOf(CHROME_DESKTOP), null);
  // The demo's ?inapp= only takes the four apps; anything else (or a property of every object) shows the normal screen.
  for (const app of [null, "", "x", "toString", "__proto__", "constructor"]) assert.equal(hopFor(app, "ios"), null, String(app));
});

test("the address for Safari or Chrome keeps the first visit's tags, and the Worker reads the same source from it with no cookie", () => {
  const read = (address, ua = SAFARI) => {
    const t = worker.touchOf(new Request(address, { headers: { "user-agent": ua } }), new URL(address));
    return [t.channel, t.guessed, t.link, t.utmSource, t.utmMedium, t.utmCampaign, t.landing];
  };
  // The Instagram bio's short link opened /templates with its tags; the visitor then went to /video and tapped Generate.
  const landing = "?utm_source=instagram&utm_medium=social&utm_campaign=ig-bio";
  const inApp = read(`https://app.kleooai.com/templates${landing}`, IG_UA);
  const out = hopAddress("https://app.kleooai.com/video", landing, "instagram");
  assert.equal(out, "https://app.kleooai.com/video?utm_source=instagram&utm_medium=social&utm_campaign=ig-bio");
  assert.deepEqual(read(out), ["instagram", false, "ig-bio", "instagram", "social", "ig-bio", "/video"]);
  assert.deepEqual(read(out).slice(0, 6), inApp.slice(0, 6), "Safari's first visit says what Instagram's said");

  // The first visit's tags win over the ones the page has now; a moment's parameters and the hash are left behind.
  assert.equal(hopAddress("https://app.kleooai.com/?utm_source=x&gift=none&signin_error=cancelled&paid=1&linked=google#top", "?utm_source=tiktok&utm_campaign=tt-lupin&utm_medium=social", "tiktok"),
    "https://app.kleooai.com/?utm_source=tiktok&utm_medium=social&utm_campaign=tt-lupin");
  // Other parameters stay (the demo's, a template's).
  assert.equal(hopAddress("https://app.kleooai.com/apps/trend-apt?demo=guest", "?src=producthunt", "instagram"), "https://app.kleooai.com/apps/trend-apt?demo=guest&src=producthunt");
  // No tags at the start: the ones the page has now, else the app itself, so the account is never "direct".
  assert.equal(hopAddress("https://app.kleooai.com/?utm_source=ig&utm_medium=social&utm_campaign=batman", "", "instagram"), "https://app.kleooai.com/?utm_source=ig&utm_medium=social&utm_campaign=batman");
  const bare = hopAddress("https://app.kleooai.com/", "", "tiktok");
  assert.equal(bare, "https://app.kleooai.com/?utm_source=tiktok&utm_medium=in-app");
  assert.deepEqual(read(bare).slice(0, 5), ["tiktok", false, null, "tiktok", "in-app"]);
  assert.deepEqual(read("https://app.kleooai.com/").slice(0, 2), ["direct", false], "without the tags Safari would have said direct");
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "src", "ref"]) assert.ok(SOURCE_TAGS.includes(k), k);
});

test("Android opens Chrome with an intent link to the same address", () => {
  const out = "https://app.kleooai.com/video?utm_source=tiktok&utm_medium=social&utm_campaign=tt-bio";
  assert.equal(chromeIntent(out), "intent://app.kleooai.com/video?utm_source=tiktok&utm_medium=social&utm_campaign=tt-bio#Intent;scheme=https;package=com.android.chrome;end");
  assert.equal(chromeIntent("https://app.kleooai.com/"), "intent://app.kleooai.com/#Intent;scheme=https;package=com.android.chrome;end");
});

test("both hosts serve every file app.js imports (the admin console loads app.js too)", () => {
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const html = readFileSync(join(ROOT, "studio-web", "index.html"), "utf8");
  const imports = [...app.matchAll(/^import [^;]+ from "(\/[^"?]+)(\?v=(\d+))?";/gm)];
  assert.ok(imports.some((m) => m[1] === "/inapp.js"), "app.js imports inapp.js");
  const version = html.match(/\/app\.js\?v=(\d+)/)[1];
  for (const [, path, , v] of imports) {
    assert.equal(v, version, `${path} carries the release's ?v=`);
    assert.ok(worker.APP_PATH.test(path), `app host: ${path}`);
    assert.ok(worker.ADMIN_SITE_PATH.test(path), `admin host: ${path}`);
    assert.ok(!worker.CONSOLE_PATH.test(path), `${path} is not the console's own`);
  }
});

test("the sign-in screen: the step above Google, Google's button asks first, no browser pop-ups, no small text", () => {
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const page = readFileSync(join(ROOT, "studio-web", "inapp.js"), "utf8");
  const auth = app.slice(app.indexOf("function renderAuth("), app.indexOf("function renderForgot("));
  assert.match(auth, /hop \? hopBox\(mode\) : null,\s*socialList\(\)/, "the step comes before the Google button");
  assert.match(auth, /onclick: hop && k === "google" \? \(e\) => \{ e\.preventDefault\(\); hopAsk\(\); \}/, "Google's button opens the step in an app's browser");
  const hop = app.slice(app.indexOf("async function copyText("), app.indexOf("function renderAuth("));
  assert.match(hop, /await ask\(\{/, "the question goes through the app's own ask()");
  assert.match(hop, /chromeIntent\(hopHere\(\)\)/);
  assert.match(hop, /history\.replaceState\(null, "", to\.slice\(location\.origin\.length\)\)/, "the page's own address carries the tags for the app's menu");
  for (const js of [hop, page]) assert.doesNotMatch(js, /\b(?:window\.)?(?:alert|confirm|prompt)\(/);
  assert.match(app, /const LANDING_QUERY = location\.search;/);
  assert.ok(app.indexOf("const LANDING_QUERY") < app.indexOf("history.replaceState"), "the landing query is read before the address is tidied");
  const css = readFileSync(join(ROOT, "studio-web", "app.css"), "utf8");
  const rules = css.slice(css.indexOf("/* Out of Instagram's or TikTok's own browser"));
  assert.ok(rules.includes(".hop "), "the step's styles are there");
  for (const m of rules.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 16, `font-size ${m[1]}px`);
});
