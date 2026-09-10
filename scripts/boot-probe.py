#!/usr/bin/env python3
"""
Perche' una macchina noleggiata non dice mai niente. Noleggia UNA istanza esattamente come la noleggia la
produzione e racconta secondo per secondo cosa fa Vast, invece di guardare un job vero e indovinare.

    python3 scripts/boot-probe.py               10 minuti di osservazione
    python3 scripts/boot-probe.py 15            quindici

Il fatto da spiegare (11 settembre 2026): il job `gt_7f7gnsjt` e' rimasto in `loading` per 23 minuti su TRE host
diversi senza che il worker parlasse mai, ed e' morto. Ma il download dell'immagine dura **tre** minuti, misurato
con scripts/pulltest.py. Quindi quei venti minuti non erano il download, e nessuno sa cosa fossero.

Questa sonda copia la produzione (src/backends/vast.ts) fin dove conta: gli stessi filtri sull'offerta, la stessa
immagine, `runtype: "ssh"`, lo stesso onstart e la stessa forma di ambiente. L'unica differenza e' che l'id del job
e' finto, e questa e' proprio la cosa utile: il worker parte, chiede il job al server, riceve un rifiuto pulito e
si spegne. Quindi:

    l'istanza arriva a `running` in pochi minuti  -> il container e' sano, e il buco e' DOPO l'avvio
    l'istanza resta in `loading` a lungo          -> il guasto e' riprodotto, per pochi centesimi
    l'istanza sparisce da sola                    -> il worker E' PARTITO davvero (si e' auto-distrutto)

Costa un noleggio di pochi minuti. Distrugge sempre quello che ha noleggiato, anche su Ctrl-C.
"""
import json, os, signal, sys, time
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://console.vast.ai/api/v0"
IMAGE = os.environ.get("VAST_IMAGE", "ghcr.io/tonnooooo/kleo-worker:keou")
PUBLIC_URL = os.environ.get("KLEO_PUBLIC_URL", "https://kleo-mcp.plural-juice.workers.dev")
DISK_GB = int(os.environ.get("VAST_DISK_GB", "80"))
MAX_DPH = float(os.environ.get("VAST_MAX_DPH", "0.40"))
rented = []


def key():
    for line in open(os.path.join(ROOT, ".secrets.local")):
        if line.startswith("VAST_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("VAST_API_KEY non e' in .secrets.local")


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + key(), "Content-Type": "application/json",
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"vast {method} {path} -> {e.code}: {e.read().decode()[:200]}")
    return json.loads(raw) if raw.strip() else {}


def offer():
    """Gli STESSI filtri della produzione (src/backends/vast.ts searchOffers): una sonda che noleggia una classe
    di macchina diversa non riproduce niente."""
    q = {"verified": {"eq": True}, "rentable": {"eq": True}, "external": {"eq": False}, "num_gpus": {"eq": 1},
         "inet_down": {"gte": 800}, "cpu_cores_effective": {"gte": 16}, "cpu_ram": {"gte": 32 * 1024},
         "reliability2": {"gte": 0.98}, "disk_space": {"gte": DISK_GB}, "dph_total": {"lte": MAX_DPH},
         "cuda_max_good": {"gte": 12.4}, "type": "on-demand", "allocated_storage": DISK_GB,
         "order": [["dph_total", "asc"]], "limit": 10}
    got = api("POST", "/bundles/", q).get("offers") or []
    if not got:
        raise SystemExit(f"nessuna offerta sotto {MAX_DPH} $/h passa i filtri di produzione")
    return got[0]


def rent(o):
    # onstartScript(env) con VAST_BOOTSTRAP_URL non configurato: e' esattamente questo, due comandi.
    onstart = "env >> /etc/environment; cd /opt/kleo && nohup python3 kleo_worker.py >> /var/log/kleo.log 2>&1 &"
    body = {"client_id": "me", "image": IMAGE, "disk": DISK_GB, "label": "kleo-bootprobe",
            "runtype": "ssh", "cancel_unavail": True, "onstart": onstart,
            "env": {"KLEO_API": PUBLIC_URL, "KLEO_JOB_ID": "gt_bootprobe", "KLEO_SECRET": "probe-not-a-real-secret",
                    "KLEO_SELF_DESTRUCT_MIN": "12", "KLEO_RENDER_TIMEOUT_MIN": "8",
                    "KLEO_DPH": str(o.get("dph_total")), "KLEO_KEOU_WORKERS": "4", "KLEO_ENGINE": "keou"}}
    r = api("PUT", f"/asks/{o['id']}/", body)
    if not r.get("success"):
        raise SystemExit(f"noleggio rifiutato: {json.dumps(r)[:200]}")
    iid = r["new_contract"]
    rented.append(iid)
    print(f"  istanza {iid} · {o.get('gpu_name')} · {o.get('inet_down')} Mbit · {o.get('cpu_cores_effective')} core · "
          f"${o.get('dph_total'):.3f}/h · {o.get('geolocation')}", flush=True)
    return iid


def look(iid):
    try:
        r = api("GET", f"/instances/{iid}/")
    except SystemExit:
        return "SPARITA", ""
    i = r.get("instances") if isinstance(r.get("instances"), dict) else r
    if not isinstance(i, dict) or not i:
        return "SPARITA", ""
    return (i.get("actual_status") or i.get("cur_state") or "?"), (i.get("status_msg") or "").strip()


def destroy_all():
    for iid in list(rented):
        try:
            api("DELETE", f"/instances/{iid}/", {})
            print(f"  distrutta {iid}", flush=True)
        except SystemExit as e:
            print(f"  NON SONO RIUSCITO A DISTRUGGERE {iid}: {e}", flush=True)
        rented.remove(iid)


def main():
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 10
    signal.signal(signal.SIGINT, lambda *_: (destroy_all(), sys.exit(130)))
    try:
        t0 = time.time()
        iid = rent(offer())
        seen, last_msg = None, None
        while time.time() - t0 < minutes * 60:
            st, msg = look(iid)
            el = (time.time() - t0) / 60
            if st != seen:
                print(f"  [{el:4.1f} min] stato: {st}", flush=True)
                seen = st
            if msg and msg != last_msg:
                print(f"  [{el:4.1f} min] {msg[:110]}", flush=True)
                last_msg = msg
            if st == "SPARITA":
                print(f"\n  L'ISTANZA SI E' DISTRUTTA DA SOLA dopo {el:.1f} min: il worker E' PARTITO davvero,\n"
                      f"  ha chiesto il job finto, ha ricevuto un rifiuto e si e' spento come deve.", flush=True)
                rented.clear()
                return
            if st == "running" and el > 0.5:
                print(f"  [{el:4.1f} min] il container gira. Aspetto ancora, il worker deve parlare o spegnersi.", flush=True)
            time.sleep(20)
        print(f"\n  Dopo {minutes:.0f} minuti l'istanza e' ancora '{seen}'. Se e' 'loading', IL GUASTO E' RIPRODOTTO.", flush=True)
    finally:
        destroy_all()


if __name__ == "__main__":
    main()
