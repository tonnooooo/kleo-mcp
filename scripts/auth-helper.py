#!/usr/bin/env python3
"""
Local authorization helper. Keeps a fresh Cloudflare (wrangler) login attempt and a fresh GitHub
device-flow attempt alive, because both expire on their own, and serves http://127.0.0.1:8977
with links that are always valid. Exits when both authorizations succeeded.
Status file: /tmp/claude-1000/auth-status.json
"""
import json, os, re, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = "/tmp/claude-1000/auth-status.json"
state = {"cf_url": "", "cf_done": False, "cf_attempts": 0, "gh_code": "", "gh_done": False, "gh_attempts": 0, "log": []}
lock = threading.Lock()


def save():
    with lock:
        json.dump(state, open(STATUS, "w"), indent=1)


def log(msg):
    with lock:
        state["log"] = (state["log"] + [time.strftime("%H:%M:%S ") + msg])[-30:]
    save()


def cf_loop():
    while not state["cf_done"]:
        state["cf_attempts"] += 1
        p = subprocess.Popen([os.path.join(ROOT, "node_modules/.bin/wrangler"), "login", "--browser=false"],
                             cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            m = re.search(r"(https://dash\.cloudflare\.com/oauth2/auth\S+)", line)
            if m:
                state["cf_url"] = m.group(1)
                save()
            if "Successfully logged in" in line:
                state["cf_done"] = True
                log("Cloudflare: logged in")
        p.wait()
        if p.returncode == 0:
            state["cf_done"] = True
            log("Cloudflare: login ok")
            save()
            break
        log("Cloudflare attempt %d expired, new link" % state["cf_attempts"])
        time.sleep(1)


def gh_loop():
    while not state["gh_done"]:
        state["gh_attempts"] += 1
        p = subprocess.Popen(["gh", "auth", "refresh", "-h", "github.com", "-s", "write:packages,read:packages,delete:packages"],
                             cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            m = re.search(r"one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})", line)
            if m:
                state["gh_code"] = m.group(1)
                save()
        p.wait()
        if p.returncode == 0:
            state["gh_done"] = True
            log("GitHub: packages scope granted")
            save()
            break
        log("GitHub attempt %d expired, new code" % state["gh_attempts"])
        time.sleep(1)


PAGE = """<!doctype html><html lang="it"><meta charset="utf-8"><meta http-equiv="refresh" content="20"><title>Kleo · autorizzazioni</title>
<style>body{font:17px/1.5 system-ui,sans-serif;background:#0F1216;color:#ECEAE4;max-width:640px;margin:40px auto;padding:0 20px}
.c{border:1px solid #262C36;border-radius:12px;padding:20px;margin:16px 0;background:#151920}.ok{color:#5ED28A}.b{display:inline-block;background:#F3B53F;color:#1A1200;padding:12px 18px;border-radius:10px;font-weight:600;text-decoration:none}
code{font-size:1.6em;letter-spacing:.1em;background:#0F1216;padding:6px 12px;border-radius:8px}small{color:#838B99}</style>
<h1>Kleo · due autorizzazioni</h1><p><small>Questa pagina gira solo sul tuo computer e si aggiorna da sola: i link sono sempre validi.</small></p>
<div class="c"><h2>1. Cloudflare → wrangler</h2>%CF%</div>
<div class="c"><h2>2. GitHub → immagine del worker su ghcr.io</h2>%GH%</div>
<p><small>Quando entrambe sono verdi puoi chiudere questa pagina: Claude continua da solo.</small></p></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="text/html; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/cf":
            return self.send(302, extra={"Location": state["cf_url"] or "/"})
        if self.path == "/gh":
            return self.send(302, extra={"Location": "https://github.com/login/device"})
        if self.path == "/status":
            return self.send(200, json.dumps(state).encode(), "application/json")
        if state["cf_done"]:
            cf = '<p class="ok">✔ Fatto: wrangler è collegato al tuo account Cloudflare.</p>'
        elif state["cf_url"]:
            cf = '<p><a class="b" href="/cf" target="_blank">Apri Cloudflare e clicca Allow</a></p><p><small>Sei già dentro Cloudflare: si apre la pagina di consenso.</small></p>'
        else:
            cf = "<p>Preparo il link…</p>"
        if state["gh_done"]:
            gh = '<p class="ok">✔ Fatto: GitHub ha concesso il permesso per i pacchetti.</p>'
        elif state["gh_code"]:
            gh = '<p>Codice: <code>%s</code></p><p><a class="b" href="/gh" target="_blank">Apri GitHub e inserisci il codice</a></p>' % state["gh_code"]
        else:
            gh = "<p>Preparo il codice…</p>"
        self.send(200, PAGE.replace("%CF%", cf).replace("%GH%", gh).encode())


if __name__ == "__main__":
    save()
    threading.Thread(target=cf_loop, daemon=True).start()
    threading.Thread(target=gh_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", 8977), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log("helper up on http://127.0.0.1:8977")
    while not (state["cf_done"] and state["gh_done"]):
        time.sleep(3)
    time.sleep(20)
    srv.shutdown()
    log("all done")
