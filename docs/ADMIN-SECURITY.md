# Admin console security

The admin console is at **https://admin.kleooai.com**, and **only there**. It opens only on the owner's own computer, the one with the Kleo admin client certificate. The code is in:

- `src/studio/admin-host.ts`: the host and the certificate;
- `src/studio/admin-auth.ts` and `src/studio/totp.ts`: the code from the phone and the console's session;
- `src/studio/admin.ts`: the console's API;
- `studio-web/admin.js`: the page.

## The locks

Every request passes all of these locks, checked on the server.

1. **The host.**
   - The console exists only on `ADMIN_HOST` (`admin.kleooai.com`).
   - On app.kleooai.com, kleooai.com and any other host, `/admin`, `/api/admin/*` and the console's files answer the site's 404, like a page that does not exist.
   - On the admin host nothing else answers: only the console page and its files, media previews, `/api/admin/*`, and the sign-in it needs (`/api/config`, `/api/me`, `/api/auth/signin`, `/api/auth/signout`). Customers' pages and routes are 404 there.
2. **The owner's computer.** Every request to the admin host must carry the owner's client certificate (mutual TLS):
   - presented, verified by Cloudflare's CA, and not revoked;
   - its SHA-256 fingerprint listed in `ADMIN_CERT_SHA256`.

   Cloudflare's WAF blocks a certificate that is unverified or revoked at the edge, and the Worker checks everything again.
   - With **no** certificate the answer is a bare `421 Misdirected Request`, and nothing is written. Chrome reuses its open connection to app.kleooai.com for admin.kleooai.com: both hosts share the `*.kleooai.com` certificate and the same addresses, and no client certificate is asked for on that connection. A 421 makes the browser retry on a connection of its own, where Cloudflare asks for the certificate (23 October 2026, the owner's first visit was blocked this way).
   - With a certificate that is not the owner's (unverified, revoked, or another fingerprint) the answer is a bare `403 Forbidden`.
   - Such a refusal is written to the audit (`admin.cert_refused`, at most once a minute per address).
   - The owner gets an e-mail, at most once an hour.
   - **With `ADMIN_CERT_SHA256` empty, the admin host opens for nobody.**
3. **The Kleo account.**
   - The browser is signed in to an account listed in `STUDIO_ADMINS` (wrangler.studio.jsonc), today `u_6avhjrtnzrsa`.
   - Any other account gets 404, as if the console did not exist.
4. **The code from the phone.**
   - A 6-digit code, RFC 6238 TOTP: SHA-1, 30 seconds, one step of clock drift either side.
   - The iPhone Passwords app shows it, as do Google Authenticator and 1Password.
   - Each code works once.
   - One of ten recovery codes works instead; each recovery code works once.
5. **The console's own session.** The code opens a second cookie, `__Host-kleo_admin`:
   - HttpOnly, Secure, SameSite=Strict, signed with `INTERNAL_SECRET`.
   - Bound to the account, to its Studio epoch and to the console's own epoch.
   - It ends after **30 minutes** without use and after **12 hours** at most.
   - It also ends at "Sign out everywhere" on the account page, and at "Sign out of the console everywhere" on the Security page.
6. **A new code for the dangerous actions.** These want a code typed in the last **5 minutes**:
   - deleting an account;
   - closing an account;
   - a credit change over 100;
   - a new Kleo key;
   - signing another account out everywhere.
7. **Lockout.** Five wrong codes in a row lock the console for **15 minutes**.
8. **E-mails to kleooai@gmail.com.** Each one gives the address, place, network and device. One is sent at:
   - every console sign-in;
   - every wrong code;
   - every lock;
   - a phone set up;
   - a recovery code used;
   - new recovery codes.
9. **The page itself.**
   - It loads nothing from other sites: its CSP is `script-src 'self'`, `connect-src 'self'`, `frame-src 'none'`.
   - The QR code is drawn by `studio-web/qr.js`, not by an online service.
   - Everything on the admin host answers `cache-control: no-store` and `x-robots-tag: noindex`.
10. **Session cookies are host-only.**
    - They use the `__Host-` prefix and no Domain.
    - A session made on app.kleooai.com never reaches the admin host, and the other way round.
    - The owner signs in on admin.kleooai.com itself, with the password. Google is not offered there: its sign-in has no redirect address registered for that host.
11. **Every action on an account needs a reason.** It is written to the `audit` table with the admin's id.

## The password

- An admin account's password needs **at least 14 characters**.
- It must not contain the account's e-mail or name.
- The rule is checked when the password is set, changed or reset, and when the phone is set up.
- A sentence of four or five words is easy to remember and hard to guess.
- Keep it in **iPhone Passwords**, with the 6-digit code on the same entry. Chrome on the PC can save the password too.

## Signing in

1. On your PC, open **https://admin.kleooai.com** in Chrome. Bookmark it.
2. If Chrome asks which certificate to use, choose **Kleo admin**.
3. Sign in with your e-mail and Kleo password.
4. Type the 6-digit code for **"Kleo admin"**: on the iPhone, open Passwords → Codes.

Any other device, your phone included, gets "Forbidden". That is the lock working.

### The first time

1. Open **https://admin.kleooai.com** on the PC, sign in, and type your Kleo password again. This proves a stolen session is not setting up its own phone.
2. On the iPhone, open Passwords → **Codes** → **+**, and scan the QR code shown on the PC.
3. Type the 6-digit code it shows.
4. Save the **ten recovery codes**, for example in the notes of the Kleo entry in iPhone Passwords. They are shown only once.

## If the phone is lost

- **With a recovery code:** on the code screen, tap **Use a recovery code** and type one, for example `k7m2-q9xd-4tpa`. Then, in **Security**, make new recovery codes.
- **To move the code to a new phone, or with no recovery code left:** reset the second factor from a terminal, in the `kleo-mcp` folder:

  ```bash
  CLOUDFLARE_ACCOUNT_ID=e4a5a1308df5b44c65497b85210c6845 npx wrangler d1 execute kleo-db --remote --command "DELETE FROM studio_admin WHERE user_id = 'u_6avhjrtnzrsa'"
  ```

  Then open `/admin` and set it up again. Setting up needs the password, and the owner is e-mailed.
- **To unlock early after five wrong codes:**

  ```bash
  CLOUDFLARE_ACCOUNT_ID=e4a5a1308df5b44c65497b85210c6845 npx wrangler d1 execute kleo-db --remote --command "UPDATE studio_admin SET failed = 0, locked_until = NULL WHERE user_id = 'u_6avhjrtnzrsa'"
  ```

- **If someone else may have the password:**
  1. Change it on the Account page. Every other session ends.
  2. Run the reset above, then set the phone up again.
- **If `INTERNAL_SECRET` is ever changed:** the sealed code secret can no longer be opened. Run the reset above and set the phone up again.

## Only the owner's computer: what is set up outside the code

These steps are done once, in this order, by the owner (or a Claude session he signs in for). The key never leaves the PC.

**Status on 23 October 2026: done.**
- The certificate is "CN=Kleo admin - owner PC, O=Kleo", from the Cloudflare Managed CA, ECDSA P-256, valid to 22 October 2028.
- Its SHA-256 is `47f40b62f8a92ed84e56a939ad3f929cd6b3b501fdb2b5ab5cd204226e929f18`.
- mTLS is on for `admin.kleooai.com` only.
- The WAF rule is live.
- The custom domain is on kleo-studio.

1. **The key and the request.** An ECDSA P-256 private key and a CSR are made on the PC, in `C:\Users\leona_wadij0y\KleoAdminCert`. This is already done.
2. **The certificate.** In the Cloudflare dashboard:
   1. Select the kleooai.com zone, then **SSL/TLS → Client Certificates → Create Certificate**.
   2. Choose **Use my private key and CSR**, paste the CSR, and pick a validity (for example 2 years).
   3. Save the certificate it returns as `kleo-admin.pem` next to the key.
3. **The host.** Still in **Client Certificates**, under **Hosts → Edit**, add `admin.kleooai.com`. Cloudflare then asks browsers on that host for a certificate.
4. **The custom domain.**
   1. Go to **Workers & Pages → kleo-studio → Settings → Domains & Routes → Add → Custom domain**, and add `admin.kleooai.com`.
   2. Then add `{ "pattern": "admin.kleooai.com", "custom_domain": true }` to `routes` in `wrangler.studio.jsonc`, so later deploys keep it.
5. **The WAF rule.** Go to **Security → WAF → Custom rules → Create**:
   - Name: `Admin only from the owner's certificate`.
   - Expression:

     ```text
     (http.host eq "admin.kleooai.com" and cf.tls_client_auth.cert_presented and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked)) or (http.host ne "admin.kleooai.com" and (lower(http.request.uri.path) eq "/admin" or starts_with(lower(http.request.uri.path), "/admin/") or starts_with(lower(http.request.uri.path), "/api/admin")))
     ```

   - Action: **Block**.
   - The rule also blocks the console's paths on every other host.
   - A request with no certificate at all is NOT blocked here. It goes on to the Worker, which answers 421 before any other work, so the browser retries on its own connection (see above). Blocking it at the edge left the owner's own Chrome stuck on "Sorry, you have been blocked".
   - The fingerprint itself is checked by the Worker (`ADMIN_CERT_SHA256`), on every request.
6. **The certificate in Windows.** In `C:\Users\leona_wadij0y\KleoAdminCert`, run:

   ```bash
   openssl pkcs12 -export -inkey kleo-admin.key -in kleo-admin.pem -name "Kleo admin" -out kleo-admin.p12
   ```

   Then double-click `kleo-admin.p12`:
   - choose **Current User**;
   - leave **Mark this key as exportable** off;
   - place it in **Personal**.

   Chrome on Windows uses this store.
7. **The fingerprint.**
   1. Run `openssl x509 -in kleo-admin.pem -noout -fingerprint -sha256`. Cloudflare also shows it.
   2. Put it in `ADMIN_CERT_SHA256` in `wrangler.studio.jsonc`. Colons and capitals are fine, and several fingerprints are separated by commas.
   3. Deploy kleo-studio.

   The fingerprint is not a secret. Until it is set, the admin host opens for nobody.
8. **Test.**
   - Chrome on the PC opens https://admin.kleooai.com after the certificate prompt.
   - The phone, and any other browser, get "Forbidden".
   - Each refusal is in the audit as `admin.cert_refused`.

- **A new computer:** install the same `.p12` there, or make a second certificate and add its fingerprint after a comma.
- **A stolen or lost PC:** revoke the certificate in **Client Certificates**, and remove its fingerprint from `ADMIN_CERT_SHA256`.

## Optional: an extra lock in front with Cloudflare Access

Cloudflare Access (Zero Trust) can ask for a one-time PIN, sent to your e-mail, before anyone even reaches the console. It is free for up to 50 people. The wrangler token cannot set it up, so these steps are done by hand in the dashboard.

1. Open **dash.cloudflare.com** → **Zero Trust**.
   - The first time, choose a team name (for example `kleo`) and the **Free** plan.
   - Cloudflare may ask for a card even on the Free plan; nothing is charged.
2. Go to **Settings → Authentication → Login methods**.
   - **One-time PIN** is there by default.
   - Optionally, add **Google** too.
3. Go to **Access → Applications → Add an application → Self-hosted**, and fill it in:
   - Name: `Kleo admin`. Session duration: `24 hours`.
   - Public hostname: domain `admin.kleooai.com`, with no path (the whole host).
4. Add a policy:
   - Name `Owner`, action **Allow**.
   - Include **Emails**: `kleooai@gmail.com` (and `leonardotononn2006@gmail.com` if you want to receive the PIN there).
5. Save, then test in a private window:
   1. `/admin` shows Cloudflare's page; type your e-mail.
   2. Type the PIN that arrives.
   3. Then come Kleo's own sign-in and the 6-digit code.

Notes:

- The console's calls carry the Access cookie by themselves, because they go to the same site.
- When the Access sign-in ends, the console says *"Your Cloudflare Access sign-in has ended. Reload the page to sign in again."*
- `/admin.js` and `/qr.js` are public code with no secrets in them, so they do not need Access.
- Access is a lock in front. The Kleo password and the 6-digit code still apply behind it.

## Changing provider keys from the console (not built)

- **What it would need:** a Cloudflare API token with **Workers Scripts: Edit**, stored as a Worker secret, which the console would use to write other secrets.
- **The risk:** anyone who got into the console, or read that one secret, could replace every key and the Worker's code itself.
- **Today:** keys change only from a terminal:

  ```bash
  npx wrangler secret put NAME --config wrangler.studio.jsonc
  ```
