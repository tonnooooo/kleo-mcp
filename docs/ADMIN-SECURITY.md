# Admin console security

The admin console is at **https://app.kleooai.com/admin**. It moves to `https://kleooai.com/admin` when the app moves to the apex domain. The code is in `src/studio/admin.ts`, `src/studio/admin-auth.ts` and `studio-web/admin.js`.

## The locks

Every call to `/api/admin/*` passes all of these locks, checked on the server.

1. **The Kleo account.**
   - The browser is signed in to an account listed in `STUDIO_ADMINS` (wrangler.studio.jsonc), today `u_6avhjrtnzrsa`.
   - Any other account gets 404, as if the console did not exist.
2. **The code from the phone.**
   - A 6-digit code, RFC 6238 TOTP: SHA-1, 30 seconds, one step of clock drift either side.
   - The iPhone Passwords app shows it, as do Google Authenticator and 1Password.
   - Each code works once.
   - One of ten recovery codes works instead; each recovery code works once.
3. **The console's own session.** The code opens a second cookie, `__Host-kleo_admin`:
   - HttpOnly, Secure, SameSite=Strict, signed with `INTERNAL_SECRET`.
   - Bound to the account, to its Studio epoch and to the console's own epoch.
   - It ends after **30 minutes** without use and after **12 hours** at most.
   - It also ends at "Sign out everywhere" on the account page, and at "Sign out of the console everywhere" on the Security page.
4. **A new code for the dangerous actions.** These want a code typed in the last **5 minutes**:
   - deleting an account;
   - closing an account;
   - a credit change over 100;
   - a new Kleo key;
   - signing another account out everywhere.
5. **Lockout.** Five wrong codes in a row lock the console for **15 minutes**.
6. **E-mails to kleooai@gmail.com.** Each one gives the address, place, network and device. One is sent at:
   - every console sign-in;
   - every wrong code;
   - every lock;
   - a phone set up;
   - a recovery code used;
   - new recovery codes.
7. **The page itself.**
   - It loads nothing from other sites: its CSP is `script-src 'self'`, `connect-src 'self'`, `frame-src 'none'`.
   - The QR code is drawn by `studio-web/qr.js`, not by an online service.
   - `/admin` and `/api/admin/*` answer `cache-control: no-store` and `x-robots-tag: noindex`.
8. **Every action on an account needs a reason.** It is written to the `audit` table with the admin's id.

## The password

- An admin account's password needs **at least 14 characters**.
- It must not contain the account's e-mail or name.
- The rule is checked when the password is set, changed or reset, and when the phone is set up.
- A sentence of four or five words is easy to remember and hard to guess.
- Keep it in **iPhone Passwords**. Safari fills in the password, and the 6-digit code from the same entry.

## Signing in

1. Open **app.kleooai.com/admin**.
2. If Kleo asks, sign in with your e-mail and password. iPhone Passwords fills them in.
3. Type the 6-digit code for **"Kleo admin"** from iPhone Passwords. Safari usually offers it above the keyboard.

### The first time

1. Open **app.kleooai.com/admin** and type your Kleo password again. This proves a stolen session is not setting up its own phone.
2. **On the iPhone:** tap **Add to Passwords**, choose your Kleo entry, and save.
   **On a computer:** open Passwords on the iPhone, go to **Codes**, tap **+**, and scan the QR code.
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
   - Public hostname: domain `app.kleooai.com`, path `admin`.
   - **Add another public hostname**: domain `app.kleooai.com`, path `api/admin`.
   - When the app moves to `kleooai.com`, add the same two for `kleooai.com`.
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
