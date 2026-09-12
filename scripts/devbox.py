#!/usr/bin/env python3
"""
Kleo dev box on Vast.ai — every heavy command runs on a rented machine, never on the owner's computer.

    python3 scripts/devbox.py up            rent a box (worker image, ssh) and wait until it answers
    python3 scripts/devbox.py sync          copy the repo (src, test, worker, package.json...) onto it
    python3 scripts/devbox.py run "<cmd>"   run a command there, in /opt/kleo/repo
    python3 scripts/devbox.py pull <remote> <local>   copy a file back (a rendered mp4, a frame)
    python3 scripts/devbox.py status        show the box and its price
    python3 scripts/devbox.py down          destroy it (always do this when finished)
    python3 scripts/devbox.py bg "<cmd>" <log>            start a LONG job detached, survives an ssh drop
    python3 scripts/devbox.py wait <log> <ok> [<fail> [min]]  poll the log until a sentinel appears
    python3 scripts/devbox.py guarded <script.sh>         run a local script and DESTROY the box whatever happens

THE RULE (11 September 2026): drive a box only through `guarded`, and run anything longer than a minute with
`bg` + `wait`. A render held open in one ssh session dropped at the worst moment, `set -e` skipped the final
`down`, and an RTX A6000 idled for 45 hours until the credit went negative; a user's video died in the queue for
lack of credit that day. `guarded` puts the destroy in a `finally` and on the signals, so no exit path skips it.

The box is labelled kleo-devbox. Its ssh key is ~/.ssh/id_ed25519_keou (added by the onstart script, so the
account key the owner uses by hand is never touched). State: scripts/.devbox.json (gitignored).
"""
import json, os, signal, subprocess, sys, time
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "scripts", ".devbox.json")
KEY = os.path.expanduser("~/.ssh/id_ed25519_keou")
LABEL = "kleo-devbox"
IMAGE = os.environ.get("DEVBOX_IMAGE", "ghcr.io/tonnooooo/kleo-worker:keou")
MAX_DPH = float(os.environ.get("DEVBOX_MAX_DPH", "0.60"))
MIN_CPU = int(os.environ.get("DEVBOX_MIN_CPU", "16"))
MIN_RAM_GB = int(os.environ.get("DEVBOX_MIN_RAM_GB", "32"))
DISK_GB = int(os.environ.get("DEVBOX_DISK_GB", "80"))
MIN_VRAM_GB = int(os.environ.get("DEVBOX_MIN_VRAM_GB", "0"))   # a video model needs the whole card
MIN_INET = int(os.environ.get("DEVBOX_MIN_INET", "400"))
MIN_COMPUTE_CAP = int(os.environ.get("DEVBOX_MIN_CC", "860"))  # 860 = Ampere; below that there are no bf16 tensor cores
API = "https://console.vast.ai/api/v0"
SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
            "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=20", "-i", KEY]


def key_secret():
    for line in open(os.path.join(ROOT, ".secrets.local")):
        if line.startswith("VAST_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("VAST_API_KEY missing from .secrets.local")


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + key_secret(),
                                          "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"vast {method} {path} -> {e.code}: {e.read().decode()[:300]}")
    return json.loads(raw) if raw.strip() else {}


def state(update=None):
    if update is not None:
        json.dump(update, open(STATE, "w"), indent=1)
        return update
    return json.load(open(STATE)) if os.path.exists(STATE) else {}


def pubkey():
    return subprocess.run(["ssh-keygen", "-y", "-f", KEY], capture_output=True, text=True, check=True).stdout.strip()


def search(n=1):
    q = {"verified": {"eq": True}, "rentable": {"eq": True}, "external": {"eq": False},
         "num_gpus": {"eq": 1}, "cpu_cores_effective": {"gte": MIN_CPU}, "cpu_ram": {"gte": MIN_RAM_GB * 1024},
         "reliability2": {"gte": 0.98}, "cuda_max_good": {"gte": 12.4}, "gpu_ram": {"gte": MIN_VRAM_GB * 1024},
         # Ampere or newer. A V100 has 32 GB and rents for pennies, and it is the wrong card: no bf16 tensor cores,
         # no flash attention, several times slower on exactly the diffusion work this box exists for.
         "compute_cap": {"gte": MIN_COMPUTE_CAP},
         "disk_space": {"gte": DISK_GB}, "dph_total": {"lte": MAX_DPH}, "inet_down": {"gte": MIN_INET},
         # Some regions cannot reach PyPI or Hugging Face at all (a Fujian host answered "no versions" for every
         # package), and a box that cannot install anything is not cheap, it is useless.
         "geolocation": {"notin": [c for c in os.environ.get("DEVBOX_SKIP_GEO", "CN,RU,IR").split(",") if c]},
         "type": "on-demand", "allocated_storage": DISK_GB, "order": [["dph_total", "asc"]], "limit": 20}
    offers = api("POST", "/bundles/", q).get("offers") or []
    seen, out = set(), []
    for o in offers:                       # one per machine: two of ours on one host would share its disk and network
        if o.get("machine_id") in seen:
            continue
        seen.add(o.get("machine_id"))
        out.append(o)
    if not out:
        raise SystemExit("no Vast offer matches (raise DEVBOX_MAX_DPH or lower DEVBOX_MIN_CPU)")
    return out[:max(1, n)]


def up(tries=None):
    """Rent a machine and wait for it to answer. A host whose ssh proxy never lets us in (it happens: the key is
    registered, the instance says running, the proxy still refuses) is destroyed and the next offer is taken — an
    instance nobody can reach is not a cheap machine, it is a bill for nothing."""
    st = state()
    if st.get("id") and instance(st["id"]):
        print("devbox already up:", st["id"])
        return wait_ssh(st["id"])
    tries = int(os.environ.get("DEVBOX_TRIES", "3")) if tries is None else tries
    # "No offer" is a statement about this second, not about the market: on 13 September three searches a minute
    # apart returned nothing, an A100 at 0.68, and nothing again. A single search that gives up is a coin toss,
    # so keep asking for a while (a 429 from Vast lands here too and is retried the same way).
    deadline = time.time() + float(os.environ.get("DEVBOX_OFFER_WAIT_MIN", "10")) * 60
    while True:
        try:
            offers = search(tries); break
        except SystemExit as e:
            if time.time() > deadline:
                raise
            print(f"  {e} — asking again in 30 s", flush=True)
            time.sleep(30)
    last = None
    for n, off in enumerate(offers):
        try:
            return rent_and_wait(off)
        except SystemExit as e:
            last = e
            print(f"  offer {n + 1}/{len(offers)} unusable: {e}", flush=True)
            st = state()
            if st.get("id"):
                try:
                    api("DELETE", f"/instances/{st['id']}/", {})
                    print(f"  destroyed {st['id']} (never answered)", flush=True)
                except SystemExit:
                    pass
            if os.path.exists(STATE):
                os.remove(STATE)
    raise SystemExit(f"no machine answered after {len(offers)} tries ({last})")


def rent_and_wait(off):
    onstart = ("mkdir -p /root/.ssh && echo %r >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys; "
               "mkdir -p /opt/kleo/repo; touch /opt/kleo/devbox-ready" % pubkey())
    body = {"client_id": "me", "image": IMAGE, "disk": DISK_GB, "label": LABEL, "runtype": "ssh",
            "cancel_unavail": True, "onstart": onstart, "env": {"KLEO_DEVBOX": "1"}}
    r = api("PUT", f"/asks/{off['id']}/", body)
    if not r.get("success"):
        raise SystemExit("rent failed: " + json.dumps(r)[:300])
    iid = r["new_contract"]
    add_key(iid)
    state({"id": iid, "dph": off.get("dph_total"), "gpu": off.get("gpu_name"), "cores": off.get("cpu_cores_effective"),
           "geo": off.get("geolocation")})
    print(f"rented instance {iid} · {off.get('gpu_name')} {round((off.get('gpu_ram') or 0)/1024)} GB · "
          f"{off.get('cpu_cores_effective')} cores · {off.get('inet_down')} Mbit · "
          f"${off.get('dph_total'):.3f}/h · {off.get('geolocation')}")
    return wait_ssh(iid)


def add_key(iid):
    """Vast's ssh proxy authenticates against the keys registered through the API, not against a key an onstart
    script appends to authorized_keys. Register ours on the account (the owner's own keys stay) and attach it to
    this instance. Both calls are idempotent enough to repeat."""
    pub = pubkey()
    keys = api("GET", "/ssh/") or []
    if not any(isinstance(k, dict) and k.get("public_key", "").split()[:2] == pub.split()[:2] for k in keys):
        api("POST", "/ssh/", {"ssh_key": pub})
    api("POST", f"/instances/{iid}/ssh/", {"ssh_key": pub})


def instance(iid):
    try:
        r = api("GET", f"/instances/{iid}/")
    except SystemExit:
        return None
    inst = r.get("instances") if isinstance(r.get("instances"), dict) else r
    return inst if isinstance(inst, dict) and inst.get("id") else None


def ssh_target(iid):
    inst = instance(iid) or {}
    host = inst.get("ssh_host") or inst.get("public_ipaddr")
    port = inst.get("ssh_port") or 22
    return host, port, (inst.get("actual_status") or inst.get("cur_state") or "?")


def wait_ssh(iid, minutes=float(os.environ.get("DEVBOX_SSH_WAIT_MIN", "7"))):
    deadline = time.time() + minutes * 60
    last = ""
    while time.time() < deadline:
        host, port, status = ssh_target(iid)
        if host and status == "running":
            p = subprocess.run(["ssh", *SSH_OPTS, "-p", str(port), f"root@{host}", "echo ok"],
                               capture_output=True, text=True)
            if p.returncode == 0 and "ok" in p.stdout:
                st = state(); st.update({"host": host, "port": port}); state(st)
                print(f"devbox ready: ssh -p {port} root@{host}")
                return st
        line = f"  {status} {host or ''}"
        if line != last:
            print(line, flush=True); last = line
        time.sleep(15)
    raise SystemExit("this host never answered on ssh")


def need():
    st = state()
    if not st.get("host"):
        st = up()
    return st


def run(cmd, capture=False, check=False):
    st = need()
    full = f"cd /opt/kleo/repo 2>/dev/null || cd /opt/kleo; {cmd}"
    argv = ["ssh", *SSH_OPTS, "-p", str(st["port"]), f"root@{st['host']}", full]
    if capture:
        p = subprocess.run(argv, capture_output=True, text=True)
        if check and p.returncode != 0:
            raise SystemExit(p.stdout + p.stderr)
        return p
    return subprocess.run(argv).returncode


def sync():
    st = need()
    paths = ["src", "test", "worker", "scripts", "package.json", "package-lock.json", "tsconfig.json",
             "wrangler.jsonc", "migrations", "docs"]
    have = [p for p in paths if os.path.exists(os.path.join(ROOT, p))]
    run("mkdir -p /opt/kleo/repo")
    rsync = ["rsync", "-az", "--delete", "--exclude", "node_modules", "--exclude", ".wrangler",
             "--exclude", "__pycache__", "--exclude", "*.pyc", "--exclude", ".devbox.json",
             "-e", "ssh " + " ".join(SSH_OPTS) + f" -p {st['port']}",
             *[os.path.join(ROOT, p) for p in have], f"root@{st['host']}:/opt/kleo/repo/"]
    rc = subprocess.run(rsync).returncode
    if rc:
        raise SystemExit("rsync failed")
    print("synced:", ", ".join(have))


def pull(remote, local):
    st = need()
    rc = subprocess.run(["scp", *SSH_OPTS, "-P", str(st["port"]), f"root@{st['host']}:{remote}", local]).returncode
    if rc:
        raise SystemExit("scp failed")
    print("pulled", remote, "->", local)


def down():
    st = state()
    if not st.get("id"):
        print("no devbox"); return
    api("DELETE", f"/instances/{st['id']}/", {})
    print("destroyed", st["id"])
    if os.path.exists(STATE):
        os.remove(STATE)


def bg(cmd, log):
    """Start a LONG job on the box detached from this ssh session, writing to `log`. Returns at once.

    The 11 September orphan: a render was run through a single ssh session held open for twenty minutes, the
    connection dropped ("exit 255") the moment the video model finished loading, `set -e` aborted the script before
    its final `down`, and an RTX A6000 sat idle for 45 hours until the credit hit zero and went negative. A user's
    video died in the queue that day for lack of credit. setsid+nohup makes the job survive the session; the caller
    then polls with `wait`, where every poll is a fresh, short ssh and a drop is just a retry."""
    st = need()
    quoted = cmd.replace("'", "'\\''")
    rc = run(f"mkdir -p $(dirname {log}); setsid nohup bash -lc '{quoted}' > {log} 2>&1 < /dev/null & "
             f"echo started pid $!")
    if rc:
        raise SystemExit("could not start the job on the box")


def wait(log, ok, fail, minutes=float(os.environ.get("DEVBOX_WAIT_MIN", "40"))):
    """Poll `log` on the box until it contains `ok` (return 0) or `fail` (return 1), or `minutes` pass (return 2).
    Prints new lines as they appear. Each poll is its own short ssh: a dropped connection costs one poll, not the
    job. Never rents: waiting for a log on a box that does not exist is an error, not a reason to buy one."""
    if not state().get("host"):
        raise SystemExit("no devbox to wait on")
    deadline, shown, misses = time.time() + minutes * 60, 0, 0
    while time.time() < deadline:
        p = run(f"cat {log} 2>/dev/null || true", capture=True)
        if p.returncode == 255:                       # ssh itself failed; the remote command cannot return 255
            misses += 1
            print(f"  (ssh did not answer, {misses}/8)", flush=True)
            if misses >= 8:
                raise SystemExit("the box stopped answering on ssh for eight polls in a row")
            time.sleep(15); continue
        misses = 0
        lines = p.stdout.splitlines()
        for line in lines[shown:]:
            print("  |", line[:160], flush=True)
        shown = len(lines)
        if ok and ok in p.stdout:
            return 0
        if fail and fail in p.stdout:
            return 1
        time.sleep(20)
    print(f"  timed out after {minutes:g} min without `{ok}` or `{fail}` in {log}", flush=True)
    return 2


def guarded(script):
    """Run a LOCAL shell script that drives the box, and DESTROY THE BOX WHATEVER HAPPENS: the script fails, it is
    killed, this process is interrupted, or it simply finishes. The destroy is in a `finally` of this very process
    and on the signal handlers, not at the end of somebody's script. This is the only way a session may drive a
    rented machine from now on; a bare `up` followed by a script that ends with `down` is exactly what left a card
    running for 45 hours."""
    def bye(sig, _):
        print(f"\nsignal {sig}: the box will be destroyed", flush=True)
        raise SystemExit(130)                          # unwinds into the finally below, which destroys once
    signal.signal(signal.SIGINT, bye)
    signal.signal(signal.SIGTERM, bye)
    rc = 1
    try:
        rc = subprocess.run(["bash", script], cwd=ROOT).returncode
    finally:
        try:
            down()
        except SystemExit as e:
            print("COULD NOT DESTROY THE BOX:", e, "-- run: python3 scripts/devbox.py down", flush=True)
    return rc


def status():
    st = state()
    if not st.get("id"):
        print("no devbox"); return
    inst = instance(st["id"]) or {}
    print(json.dumps({"id": st["id"], "status": inst.get("actual_status"), "host": st.get("host"),
                      "port": st.get("port"), "dph": st.get("dph"), "gpu": st.get("gpu"),
                      "cores": st.get("cores"), "geo": st.get("geo")}, indent=1))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "up": up()
    elif cmd == "sync": sync()
    elif cmd == "run": sys.exit(run(" ".join(sys.argv[2:])))
    elif cmd == "pull": pull(sys.argv[2], sys.argv[3])
    elif cmd == "down": down()
    elif cmd == "bg": bg(sys.argv[2], sys.argv[3])
    elif cmd == "wait": sys.exit(wait(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "",
                                      float(sys.argv[5]) if len(sys.argv) > 5 else float(os.environ.get("DEVBOX_WAIT_MIN", "40"))))
    elif cmd == "guarded": sys.exit(guarded(sys.argv[2]))
    elif cmd == "status": status()
    else: raise SystemExit(__doc__)
