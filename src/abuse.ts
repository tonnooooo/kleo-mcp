import type { Env } from "./env";

/**
 * ONE GIFT PER PERSON (15 October 2026, the owner: "qualcuno esce, rientra, crea nuovi account solo per sfruttare Kleo …
 * mi prosciuga il credito … bloccami l'IP se crea più account"). The free credits stay — people try Kleo before paying —
 * but a new account receives them only when nothing says this person already had them:
 *
 *   · the CONNECTION: one gift per address (an IPv6 visitor is its /64, src/accounts.ts ipBucket) every GIFT_WINDOW_DAYS,
 *     decided inside the INSERT that opens the account (src/db.ts createUserIfUnderCaps), so two presses at once cannot
 *     both win it;
 *   · the BROWSER: a gifted account leaves a long-lived `__Host-kleo_gift` cookie, and a browser that carries it opens
 *     its next accounts empty;
 *   · the NETWORK: Tor exits (Cloudflare's country "T1") and the server farms VPNs and proxies rent from (HOSTING_ASNS,
 *     or a network Cloudflare names as hosting) open accounts at zero — a real home or phone connection gets the gift;
 *   · the E-MAIL (Studio): a throwaway mailbox, or a domain that cannot receive mail, is refused, and one inbox written
 *     another way (Gmail dots, any "+tag") is the account that inbox already has (canonicalEmail).
 *
 * And the ADDRESS BLOCK: an address that opened MAX_ACCOUNTS_PER_ADDRESS accounts inside the window is blocked for
 * BLOCK_DAYS (blocked_addresses): no new account from it, and the never-paid accounts it opened stop generating for free.
 * Accounts that paid are never touched: an office or a phone network shares one address, and a customer is a customer.
 * The owner can block or free an address by hand in that table (the fingerprint is users.ip_hash, never the raw address).
 */

export const GIFT_COOKIE = "__Host-kleo_gift";
const YEAR_S = 400 * 24 * 60 * 60;
export const giftCookie = (): string => `${GIFT_COOKIE}=1; Path=/; Max-Age=${YEAR_S}; HttpOnly; Secure; SameSite=Lax`;

const int = (v: string | undefined, d: number): number => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : d; };
export const giftWindowDays = (env: Partial<Env>): number => int((env as Env).GIFT_WINDOW_DAYS, 30);
export const giftsPerAddress = (env: Partial<Env>): number => int((env as Env).MAX_GIFTS_PER_ADDRESS, 1);
export const accountsPerAddress = (env: Partial<Env>): number => int((env as Env).MAX_ACCOUNTS_PER_ADDRESS, 3);
export const blockDays = (env: Partial<Env>): number => int((env as Env).ADDRESS_BLOCK_DAYS, 30);

/**
 * Networks of data centres and hosting companies: where VPNs, proxies and scripts run, not where people live. Cloudflare
 * (13335, WARP and iCloud Private Relay), Akamai (36183, Private Relay), Fastly (54113) and Apple (714) are left out on
 * purpose: millions of iPhones browse through them.
 */
export const HOSTING_ASNS = new Set<number>([
  16509, 14618, 8987, // Amazon AWS
  396982, 19527, // Google Cloud
  8075, 8068, // Microsoft Azure
  14061, // DigitalOcean
  63949, // Linode / Akamai Cloud
  20473, // Vultr / Choopa
  16276, // OVH
  24940, 213230, // Hetzner
  51167, // Contabo
  12876, // Scaleway
  60781, 28753, 16265, 30633, // Leaseweb
  9009, // M247 (many VPNs)
  60068, // Datacamp / CDN77 (many VPNs)
  62240, // Clouvider
  21859, // Zenlayer
  31898, // Oracle Cloud
  45102, 37963, // Alibaba Cloud
  132203, 45090, // Tencent Cloud
  47583, // Hostinger
  8560, // IONOS
  40676, // Psychz
  8100, // QuadraNet
  36352, // ColoCrossing
  203020, // HostRoyale
  207137, // PacketHub (NordVPN)
  212238, // Datacamp
  4224, // Calyx (VPN)
  53667, // FranTech / BuyVM
  46562, // Performive
  395954, // Leaseweb USA
  11878, // tzulo
  35916, // MULTA (VPN)
  136787, // TEFINCOM (NordVPN)
  202425, // IP Volume
  204957, // Green Floid (VPN)
]);
const HOSTING_ORG = /\b(hosting|host|server|servers|datacenter|data cent(?:er|re)|vps|vpn|colo(?:cation)?|cloud)\b/i;
const PEOPLE_ASNS = new Set<number>([13335, 36183, 54113, 714, 6185]);

/** What the request says about the visitor, for the gift. */
export interface Visitor { ip: string | null; country: string | null; asn: number | null; org: string | null; giftedBrowser: boolean }

export function visitorOf(request: Request): Visitor {
  const cf = (request as unknown as { cf?: { asn?: number; asOrganization?: string; country?: string } }).cf ?? {};
  const cookie = request.headers.get("cookie") ?? "";
  return {
    ip: request.headers.get("cf-connecting-ip"),
    country: request.headers.get("cf-ipcountry") ?? cf.country ?? null,
    asn: Number(cf.asn) || null,
    org: cf.asOrganization ?? null,
    giftedBrowser: new RegExp(`(?:^|;\\s*)${GIFT_COOKIE}=`).test(cookie),
  };
}

/** Why this visitor gets no gift whatever the address says, or null. */
export function giftBlocker(v: Visitor): "tor" | "hosting" | "browser" | null {
  if (v.giftedBrowser) return "browser";
  if ((v.country ?? "").toUpperCase() === "T1") return "tor";
  if (v.asn && !PEOPLE_ASNS.has(v.asn) && (HOSTING_ASNS.has(v.asn) || (v.org && HOSTING_ORG.test(v.org)))) return "hosting";
  return null;
}

/**
 * One inbox, one spelling: lower case, no "+tag" (Gmail, Outlook, iCloud, Proton, Fastmail all deliver it to the same
 * box), and for Gmail no dots either. Used to find the account an inbox already has, never shown.
 */
export function canonicalEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at), domain = e.slice(at + 1);
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** Throwaway-mailbox services (the most used ones; a domain that cannot receive mail at all is caught by mailDomainOk). */
export const DISPOSABLE = new Set<string>(`
0-mail.com 10minutemail.com 10minutemail.net 10minutemail.co.uk 10minemail.com 20minutemail.com 33mail.com
anonaddy.me burnermail.io byom.de chacuo.net clrmail.com crazymailing.com discard.email discardmail.com
disposablemail.com dispostable.com dropmail.me emailondeck.com emailfake.com emailnax.com emailtemporanea.com
emailtemporanea.net emltmp.com fakeinbox.com fakemail.net fakemailgenerator.com getairmail.com getnada.com
guerrillamail.biz guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org
guerrillamailblock.com grr.la harakirimail.com inboxbear.com inboxkitten.com incognitomail.org jetable.org
kasmail.com linshiyouxiang.net mail.tm mail-temp.com mail7.io mailcatch.com maildrop.cc mailinator.com
mailinator.net mailinator2.com mailnesia.com mailpoof.com mailsac.com mailtemp.info mintemail.com mohmal.com
moakt.com mvrht.net mytemp.email mytrashmail.com nada.email nwytg.net one-time.email owlymail.com
pokemail.net receivemail.org sharklasers.com spam4.me spambog.com spamgourmet.com spamex.com
tempail.com tempinbox.com tempm.com tempmail.com tempmail.dev tempmail.net tempmail.plus tempmailo.com
temp-mail.io temp-mail.org tempmailaddress.com tempr.email throwawaymail.com tmail.ws tmpmail.net tmpmail.org
trash-mail.com trashmail.com trashmail.de trashmail.io trashmail.net trashmail.ws yopmail.com yopmail.fr yopmail.net
cool.fr.nf jetable.fr.nf nospam.ze.tc nomail.xl.cx mega.zik.dj speed.1s.fr courriel.fr.nf moncourrier.fr.nf
monemail.fr.nf monmail.fr.nf 1secmail.com 1secmail.net 1secmail.org esiix.com wwjmp.com xojxe.com yoggm.com
dcctb.com vjuum.com laafd.com txcct.com rteet.com dpptd.com kzccv.com qiott.com ezztt.com icznn.com
emailhippo.com spamdecoy.net mailforspam.com tempmailer.com tempemail.net fexpost.com fexbox.org
mailbox.in.ua rover.info tempmail.us.com zeroe.ml tmails.net luxusmail.org minimail.gq
`.split(/\s+/).filter(Boolean));

/** A mailbox can exist at this domain: not a throwaway service, and the domain answers for mail (MX, or an address). */
export async function mailDomainOk(domain: string): Promise<boolean> {
  const d = domain.trim().toLowerCase();
  if (!d || DISPOSABLE.has(d) || [...DISPOSABLE].some((x) => d.endsWith(`.${x}`))) return false;
  // Answers how many records of the type exist (0 for a domain that does not exist), or null when the lookup could not
  // say: a person is never refused because DNS was slow or answered something unexpected.
  const ask = async (type: "MX" | "A", codes: number[]): Promise<number | null> => {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=${type}`, {
        headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2500),
      });
      const j = (await r.json()) as { Status?: unknown; Answer?: { type?: number }[] };
      if (j.Status === 3) return 0; // NXDOMAIN: no such domain
      if (j.Status !== 0) return null;
      return (j.Answer ?? []).filter((x) => codes.includes(Number(x.type))).length;
    } catch {
      return null;
    }
  };
  const mx = await ask("MX", [15]);
  if (mx === null || mx > 0) return true;
  const a = await ask("A", [1, 5]); // an address (or an alias to one) receives mail when there is no MX (RFC 5321 5.1)
  return a === null || a > 0;
}

/** True while the address (its fingerprint) is blocked. */
export async function addressBlocked(env: Pick<Env, "DB">, ipHash: string | null): Promise<boolean> {
  if (!ipHash) return false;
  const r = await env.DB.prepare("SELECT 1 AS one FROM blocked_addresses WHERE ip_hash = ? AND until > strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    .bind(ipHash).first<{ one: number }>().catch(() => null);
  return !!r;
}

/** Blocks an address for `days` (a later block only ever extends it). */
export async function blockAddress(env: Pick<Env, "DB">, ipHash: string, reason: string, days: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO blocked_addresses (ip_hash, reason, until) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || ?3 || ' days'))
     ON CONFLICT(ip_hash) DO UPDATE SET reason = excluded.reason, until = MAX(until, excluded.until)`,
  ).bind(ipHash, reason, days).run();
}

/** The sentence a person reads when their new account starts without the gift. */
export const NO_GIFT_SENTENCE =
  "Free credits are one per person, and this connection or browser has already had them. Your account is ready: a credit pack starts at 5 EUR.";
