/**
 * THE UPLOAD PAGE (24 September 2026): how a picture on the user's phone reaches Kleo.
 *
 * An assistant can SEE the photo a user attached to the chat, but it cannot hand Kleo the bytes: an MCP tool call
 * carries text. So kleo_upload_link gives the assistant a signed link (src/refs.ts makeUploadToken: the account, an
 * expiry 48 hours out, an HMAC with INTERNAL_SECRET), the assistant gives it to the user, the user opens it on the
 * device the photos are on and drops them in, and says so in the chat; the assistant then passes {upload: <token>}
 * and Kleo expands it to the handles stored here.
 *
 *   GET  /upload/<token>           the page: phone-first, several pictures, drag and drop, English and Italian
 *   POST /upload/<token>           multipart, one or more "file" fields (+ optional "role", "name"): each picture goes
 *                                  through ingestRef under the token's account; answers with handles and thumbnails
 *   GET  /upload/<token>/<handle>  the thumbnail of a picture uploaded through THIS link (nothing else is reachable)
 *
 * The page sends one picture per request, and since 24 September 2026 the SERVER holds every request to that size:
 * a POST whose body passes UPLOAD_MAX_BODY (one 12 MB picture plus the form around it) is refused, by its
 * content-length when it sends one and by a running byte count when it does not, before formData() buffers anything.
 * Until then the gate was 8 x 12 MB + 1 MB and a missing content-length read as 0, so one hand-built multipart POST of
 * eight 12 MB files was buffered whole and copied again per file for the vision call, past the isolate's 128 MB: the
 * isolate reset and took every other request it was serving with it. The link takes UPLOAD_MAX_FILES pictures in all,
 * counted on the link's own R2 list after each picture (src/refs.ts recordUploads), so two tabs or two devices
 * uploading at once cannot lose a picture or push the link past the cap. Pictures are kept REF_TTL_DAYS after their
 * last use (src/refs.ts purgeOldRefs), and the page says so. An expired or forged link gets a page that says so and
 * how to get a new one, never a stack trace.
 *
 * Plain TypeScript with .ts imports, so a test can drive it with a fake R2 and a fake vision model.
 */
import type { Env } from "./env";
import { ingestRef, listUploads, recordUploads, readBodyCapped, readUploadToken, refImage, RefError, REF_MAX_BYTES, REF_TTL_DAYS, UPLOAD_MAX_FILES } from "./refs.ts";
import { REF_ROLES, type RefRole } from "./spec.ts";

/** The largest upload POST: one picture at REF_MAX_BYTES plus 1 MB for the multipart envelope, the role and the name. */
export const UPLOAD_MAX_BODY = REF_MAX_BYTES + 1024 * 1024;

const CSP = "default-src 'none'; img-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const page = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP, "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } });
const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The two languages of the page. The script picks one from the browser; the server picks the same for its own pages. */
const TEXT = {
  en: {
    title: "Pictures for your Kleo film", lead: `Add the pictures Kleo should draw from: a person, a pet, an object, a place, or a style you like. They stay private to your account and are deleted ${REF_TTL_DAYS} days after Kleo last uses them.`,
    drop: "Drop pictures here, or tap to choose", limits: `PNG, JPEG or WebP, up to 12 MB each, ${UPLOAD_MAX_FILES} pictures per link. iPhone HEIC photos: share them as JPEG.`,
    role: "What they show", roles: { "": "let Kleo decide", character: "a character", object: "an object", place: "a place", style: "a style" }, name: "Name (optional, e.g. Mara)",
    sending: "sending…", done: "Done. Go back to the chat and say you uploaded them.", full: "This link is full: ask for a new one in the chat.", failed: "not taken",
    expired: "This upload link has expired (they last 48 hours). Ask in the chat for a new one: the assistant calls kleo_upload_link.", bad: "This is not a valid Kleo upload link. Ask in the chat for a new one.",
  },
  it: {
    title: "Immagini per il tuo film Kleo", lead: `Aggiungi le immagini da cui Kleo deve disegnare: una persona, un animale, un oggetto, un luogo o uno stile che ti piace. Restano private sul tuo account e vengono cancellate ${REF_TTL_DAYS} giorni dopo l'ultimo uso da parte di Kleo.`,
    drop: "Trascina qui le immagini, o tocca per sceglierle", limits: `PNG, JPEG o WebP, fino a 12 MB l'una, ${UPLOAD_MAX_FILES} immagini per link. Foto HEIC dell'iPhone: condividile come JPEG.`,
    role: "Cosa mostrano", roles: { "": "decide Kleo", character: "un personaggio", object: "un oggetto", place: "un luogo", style: "uno stile" }, name: "Nome (facoltativo, es. Mara)",
    sending: "invio…", done: "Fatto. Torna nella chat e scrivi che le hai caricate.", full: "Questo link è pieno: chiedine uno nuovo nella chat.", failed: "non accettata",
    expired: "Questo link di caricamento è scaduto (dura 48 ore). Chiedine uno nuovo nella chat: l'assistente chiama kleo_upload_link.", bad: "Questo non è un link di caricamento Kleo valido. Chiedine uno nuovo nella chat.",
  },
} as const;
const langOf = (req: Request): "en" | "it" => (/^it\b/i.test(req.headers.get("accept-language") ?? "") ? "it" : "en");

const STYLE = `:root{--bg:#0b0b10;--card:#15151d;--ink:#f2f2f5;--dim:#a1a1b3;--line:#2a2a36;--accent:#9d7bff;--ok:#5fd39a;--bad:#ff7a7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 48px}h1{font-size:1.35rem;margin:0 0 6px}p{color:var(--dim);margin:0 0 18px}
.brand{font-weight:700;letter-spacing:.08em;color:var(--accent);font-size:.8rem;text-transform:uppercase;margin-bottom:14px}
#drop{display:block;border:1.5px dashed var(--line);border-radius:14px;padding:30px 16px;text-align:center;background:var(--card);cursor:pointer}
#drop.over{border-color:var(--accent)}#drop input{display:none}.small{font-size:.85rem;color:var(--dim);margin-top:8px}
.row{display:flex;gap:10px;margin:14px 0}.row label{flex:1;font-size:.85rem;color:var(--dim)}select,input[type=text]{width:100%;margin-top:4px;padding:9px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:1rem}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;margin-top:16px}
.tile{position:relative;border-radius:10px;overflow:hidden;background:var(--card);aspect-ratio:1;border:1px solid var(--line)}.tile img{width:100%;height:100%;object-fit:cover;display:block}
.tile span{position:absolute;left:0;right:0;bottom:0;font-size:.72rem;padding:3px 6px;background:rgba(0,0,0,.65)}.tile.ok span{color:var(--ok)}.tile.bad span{color:var(--bad)}
#msg{margin-top:18px;color:var(--ok);min-height:1.5em}.err{color:var(--bad)!important}`;

function messagePage(req: Request, key: "expired" | "bad", status: number): Response {
  const t = TEXT[langOf(req)];
  return page(`<!doctype html><html lang="${langOf(req)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kleo</title><style>${STYLE}</style></head><body><main><div class="brand">Kleo</div><h1>${esc(t.title)}</h1><p class="err">${esc(t[key])}</p></main></body></html>`, status);
}

/** The page itself. Everything is inline (no external request), and the only dynamic values are the token (checked
 *  against the token pattern before it gets here) and the handles already uploaded through it. */
export function uploadPage(token: string, existing: string[], lang: "en" | "it"): string {
  const boot = JSON.stringify({ token, existing, max: UPLOAD_MAX_FILES, maxBytes: REF_MAX_BYTES, text: TEXT }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kleo</title><style>${STYLE}</style></head>
<body><main><div class="brand">Kleo</div><h1 id="title"></h1><p id="lead"></p>
<label id="drop"><input id="files" type="file" accept="image/png,image/jpeg,image/webp" multiple><strong id="droptext"></strong><div class="small" id="limits"></div></label>
<div class="row"><label><span id="rolelabel"></span><select id="role"></select></label><label><span id="namelabel"></span><input id="name" type="text" maxlength="60" autocomplete="off"></label></div>
<div id="grid"></div><div id="msg"></div></main>
<script>
(function(){
var B=${boot};var L=(navigator.language||"").toLowerCase().indexOf("it")===0?"it":"en";var T=B.text[L];document.documentElement.lang=L;
var $=function(id){return document.getElementById(id)};
$("title").textContent=T.title;$("lead").textContent=T.lead;$("droptext").textContent=T.drop;$("limits").textContent=T.limits;$("rolelabel").textContent=T.role;$("namelabel").textContent=T.name;
["","character","object","place","style"].forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=T.roles[k];$("role").appendChild(o)});
var count=B.existing.length;var grid=$("grid");var msg=$("msg");
function tile(src,label,cls){var d=document.createElement("div");d.className="tile "+(cls||"");var i=document.createElement("img");i.alt="";if(src)i.src=src;var s=document.createElement("span");s.textContent=label;d.appendChild(i);d.appendChild(s);grid.appendChild(d);return d}
var base="/upload/"+B.token;B.existing.forEach(function(h){tile(base+"/"+h,h,"ok")});
var queue=Promise.resolve();
function send(file){
  if(count>=B.max){msg.textContent=T.full;msg.className="err";return}
  count++;var local=URL.createObjectURL(file);var d=tile(local,T.sending,"");
  if(file.size>B.maxBytes){d.className="tile bad";d.lastChild.textContent=T.failed+": > 12 MB";count--;return}
  queue=queue.then(function(){
    var fd=new FormData();fd.append("file",file,file.name);fd.append("role",$("role").value);fd.append("name",$("name").value);
    return fetch(base,{method:"POST",body:fd}).then(function(r){return r.json()}).then(function(j){
      var up=(j.uploaded||[])[0];
      if(up){d.className="tile ok";d.lastChild.textContent=up.handle;msg.textContent=T.done;msg.className=""}
      else{count--;d.className="tile bad";d.lastChild.textContent=T.failed;var e=(j.errors||[])[0];msg.textContent=(e&&e.error)||j.error||T.failed;msg.className="err"}
    }).catch(function(){count--;d.className="tile bad";d.lastChild.textContent=T.failed});
  });
}
function take(list){for(var k=0;k<list.length;k++)send(list[k])}
$("files").addEventListener("change",function(e){take(e.target.files);e.target.value=""});
var drop=$("drop");
["dragenter","dragover"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.className="over"})});
["dragleave","drop"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.className=""})});
drop.addEventListener("drop",function(e){if(e.dataTransfer)take(e.dataTransfer.files)});
})();
</script></body></html>`;
}

const isRole = (x: unknown): x is RefRole => typeof x === "string" && (REF_ROLES as readonly string[]).includes(x);

/** GET/POST /upload/<token>[/<handle>]. */
export async function handleUpload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/upload\/([A-Za-z0-9_.-]{1,400})(?:\/(kref_[0-9a-f]{8}))?\/?$/);
  if (!m) return new Response("Not found", { status: 404 });
  const token = m[1], thumb = m[2];
  const lang = langOf(request);

  // A thumbnail: only a picture uploaded through THIS link, even after it expired (the user may reopen the page).
  if (thumb) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const t = await readUploadToken(env, token, { allowExpired: true });
    if (!t.ok) return new Response("Not found", { status: 404 });
    if (!(await listUploads(env, t.userId, token)).includes(thumb)) return new Response("Not found", { status: 404 });
    const img = await refImage(env, t.userId, thumb);
    if (!img) return new Response("Not found", { status: 404 });
    return new Response(img.bytes, { headers: { "content-type": img.mime ?? "image/jpeg", "cache-control": "private, max-age=3600" } });
  }

  const t = await readUploadToken(env, token);
  if (!t.ok) {
    if (request.method === "POST") return answer({ ok: false, error: TEXT[lang][t.error] }, t.error === "expired" ? 410 : 403);
    return messagePage(request, t.error, t.error === "expired" ? 410 : 403);
  }
  if (request.method === "GET" || request.method === "HEAD") return page(uploadPage(token, await listUploads(env, t.userId, token), lang));
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!env.RENDERS) return answer({ ok: false, error: "Kleo cannot keep pictures on this server (no file store is configured)." }, 503);
  // The body is bounded BEFORE anything buffers it: first by the declared length (a lie or no header at all is not
  // trusted), then by counting the bytes as they stream, and only a body inside UPLOAD_MAX_BODY reaches formData().
  const tooBig = () => answer({ ok: false, error: `Too much at once: send one picture at a time, up to ${REF_MAX_BYTES / 1024 / 1024} MB.` }, 413);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\s*\d+\s*$/.test(declared)) return answer({ ok: false, error: "The upload did not arrive as a form with pictures." }, 400);
    if (Number(declared) > UPLOAD_MAX_BODY) return tooBig();
  }
  let form: FormData;
  try {
    const body = await readBodyCapped(request.body, UPLOAD_MAX_BODY);
    if (!body) return tooBig();
    form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch { return answer({ ok: false, error: "The upload did not arrive as a form with pictures." }, 400); }
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && typeof (f as File).arrayBuffer === "function");
  if (!files.length) return answer({ ok: false, error: "No picture in the upload." }, 400);
  const roleIn = form.get("role");
  const role = isRole(roleIn) ? roleIn : null;
  const nameIn = form.get("name");
  const name = typeof nameIn === "string" && nameIn.trim() ? nameIn.trim().slice(0, 60) : null;

  // `all` is the link's list as the store last told it; the authoritative cap is recordUploads', after each picture.
  let all = await listUploads(env, t.userId, token);
  const uploaded: { handle: string; description: string; thumb: string }[] = [];
  const errors: { name: string; error: string }[] = [];
  const full = (fname: string) => errors.push({ name: fname, error: `This link takes ${UPLOAD_MAX_FILES} pictures, and it is full. Ask in the chat for a new link.` });
  for (const f of files) {
    const fname = String(f.name || "picture").slice(0, 80);
    if (all.length >= UPLOAD_MAX_FILES) { full(fname); continue; }   // no vision call for a picture that cannot stay
    if (f.size > REF_MAX_BYTES) { errors.push({ name: fname, error: `${fname} is larger than 12 MB. Send a smaller copy.` }); continue; }
    try {
      const r = await ingestRef(env, t.userId, { bytes: new Uint8Array(await f.arrayBuffer()), role, name, source: "upload" });
      const rec = await recordUploads(env, t.userId, token, [r.handle]);
      all = rec.all;
      if (rec.full.includes(r.handle)) { full(fname); continue; }
      if (!uploaded.some((u) => u.handle === r.handle)) uploaded.push({ handle: r.handle, description: r.description, thumb: `/upload/${token}/${r.handle}` });
    } catch (e) {
      errors.push({ name: fname, error: e instanceof RefError ? e.message.replace(/ Nothing was charged\.$/, "") : "Kleo could not take this picture just now. Try again in a moment." });
    }
  }
  return answer({ ok: uploaded.length > 0, uploaded, errors, total: all.length, remaining: Math.max(0, UPLOAD_MAX_FILES - all.length) }, uploaded.length || !errors.length ? 200 : 422);
}
