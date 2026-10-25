// Kleo Studio — signing up from Instagram's and TikTok's in-app browsers (25 October 2026).
//
// Google refuses its sign-in inside the browser an app embeds (WKWebView on iPhone, WebView on Android: "Error 403:
// disallowed_useragent", developers.google.com/identity/protocols/oauth2/web-server), and new Studio accounts are opened
// with Google only. Most of Kleo's social visitors tap a bio or post link inside Instagram or TikTok, so they could look
// around but never open an account. In those apps the sign-in screen first moves the page to the phone's own browser:
// on Android an intent:// link that opens Chrome, on iPhone the app's "•••, Open in browser" and a copied link for
// Safari. The address keeps the page's utm tags, so the new browser's first visit is tagged like the old one
// (src/studio/attribution.ts touchOf, the __Host-kleo_src cookie), even though the cookie itself stays behind.
//
// Pure functions, no DOM: test/studio-inapp.test.mjs runs them in Node.

/** In-app browsers and their app: the same list, in the same order, as IN_APP in src/studio/attribution.ts. */
const IN_APP = [
  [/\bInstagram\b/i, "instagram"],
  [/musical_ly|BytedanceWebview|\bTikTok\b|trill_|aweme/i, "tiktok"],
  [/\bBarcelona\b/, "threads"],
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/, "facebook"],
  [/\bTwitter(?:Android)?\b/i, "x"],
  [/\bSnapchat\b/i, "snapchat"],
  [/LinkedInApp/i, "linkedin"],
  [/\bPinterest\b/i, "pinterest"],
  [/\bLine\/\d/, "line"],
  [/\bDiscord\/\d/i, "discord"],
  [/com\.google\.ios\.youtube|\bYouTube\/\d/i, "youtube"],
];
/** The app whose in-app browser this is, or null for an ordinary browser. */
export function inAppOf(ua) {
  if (!ua) return null;
  for (const [re, app] of IN_APP) if (re.test(ua)) return app;
  return null;
}

/** The apps whose browser Google's sign-in refuses, with their name and the menu entry that opens the phone's browser. */
export const GOOGLE_BLOCKED = {
  instagram: { name: "Instagram", menu: "Open in external browser" },
  tiktok: { name: "TikTok", menu: "Open in browser" },
  facebook: { name: "Facebook", menu: "Open in external browser" },
  threads: { name: "Threads", menu: "Open in browser" },
};

/** "ios", "android" or null. An iPad can say "Macintosh"; it is the one with a touch screen. */
export function osOf(ua, touchPoints = 0) {
  if (!ua) return null;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return null;
}

/** The way out of one app's browser: which app, which phone, which browser to open. */
export function hopFor(app, os) {
  const known = Object.hasOwn(GOOGLE_BLOCKED, app) ? GOOGLE_BLOCKED[app] : null;
  if (!known) return null;
  const phone = os === "ios" || os === "android" ? os : null;
  return { app, name: known.name, menu: known.menu, os: phone, browser: phone === "android" ? "Chrome" : phone === "ios" ? "Safari" : "your browser" };
}
/** The way out for this browser, or null when Google's sign-in works here. */
export const signInHop = (ua, touchPoints = 0) => hopFor(inAppOf(ua), osOf(ua, touchPoints));

/** The tags that say where a visit came from (touchOf in src/studio/attribution.ts reads the same ones). */
export const SOURCE_TAGS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "src", "ref"];
/** Parameters that belong to one moment in this browser (a sign-in error, a payment coming back, a gift note). */
const ONE_TIME = ["signin_error", "linked", "gift", "paid"];

/**
 * The address to open in the phone's browser: this page, with the tags of the page the visit started on (the first
 * touch), else the tags it has now, else the app's own name (utm_medium=in-app), so the account is never "direct".
 */
export function hopAddress(current, landing, app) {
  const url = new URL(current);
  for (const k of ONE_TIME) url.searchParams.delete(k);
  const first = new URLSearchParams(landing || "");
  if (SOURCE_TAGS.some((k) => first.get(k))) {
    for (const k of SOURCE_TAGS) {
      url.searchParams.delete(k);
      if (first.get(k)) url.searchParams.set(k, first.get(k));
    }
  } else if (!SOURCE_TAGS.some((k) => url.searchParams.get(k)) && app) {
    url.searchParams.set("utm_source", app);
    url.searchParams.set("utm_medium", "in-app");
  }
  url.hash = "";
  return url.href;
}

/** An Android link that opens the address in Chrome instead of the app's own browser. */
export function chromeIntent(address) {
  const u = new URL(address);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(":", "")};package=com.android.chrome;end`;
}
