#!/usr/bin/env python3
"""
Time what a rented machine actually spends before it can render: rent one instance per image tag, watch Vast's own
status until the container is running, and print download-and-unpack time side by side.

    python3 scripts/pulltest.py keou zstd            compare two tags of ghcr.io/tonnooooo/kleo-worker
    python3 scripts/pulltest.py keou                 just measure one

Everything runs on Vast; nothing is pulled or unpacked on this computer. Instances are destroyed at the end, always,
including on Ctrl-C — an instance left running is money burning.
"""
import json, os, signal, sys, time
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://console.vast.ai/api/v0"
IMAGE = os.environ.get("PULLTEST_IMAGE", "ghcr.io/tonnooooo/kleo-worker")
MAX_DPH = float(os.environ.get("PULLTEST_MAX_DPH", "0.60"))
DISK_GB = int(os.environ.get("PULLTEST_DISK_GB", "80"))
MINUTES = float(os.environ.get("PULLTEST_MINUTES", "35"))
rented = []


def key():
    for line in open(os.path.join(ROOT, ".secrets.local")):
        if line.startswith("VAST_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("VAST_API_KEY missing from .secrets.local")


def api(method, path, body=None, base=API):
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + key(), "Content-Type": "application/json",
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"vast {method} {path} -> {e.code}: {e.read().decode()[:200]}")
    return json.loads(raw) if raw.strip() else {}


def offers(n):
    """The n cheapest machines that all pass the same bar, so the tags are compared on comparable hardware."""
    q = {"verified": {"eq": True}, "rentable": {"eq": True}, "external": {"eq": False}, "num_gpus": {"eq": 1},
         "cpu_cores_effective": {"gte": 16}, "cpu_ram": {"gte": 32 * 1024}, "reliability2": {"gte": 0.98},
         "disk_space": {"gte": DISK_GB}, "dph_total": {"lte": MAX_DPH}, "inet_down": {"gte": 800},
         "cuda_max_good": {"gte": 12.4}, "type": "on-demand", "allocated_storage": DISK_GB,
         "order": [["dph_total", "asc"]], "limit": 40}
    got = api("POST", "/bundles/", q).get("offers") or []
    seen, out = set(), []
    for o in got:                                   # one offer per machine: two containers on one host share its disk
        if o.get("machine_id") in seen:
            continue
        seen.add(o.get("machine_id"))
        out.append(o)
        if len(out) == n:
            break
    if len(out) < n:
        raise SystemExit(f"only {len(out)} machines match")
    return out


def rent(offer, tag):
    body = {"client_id": "me", "image": f"{IMAGE}:{tag}", "disk": DISK_GB, "label": f"kleo-pulltest-{tag}",
            "runtype": "args", "cancel_unavail": True, "onstart": "echo kleo-pulltest ready"}
    r = api("PUT", f"/asks/{offer['id']}/", body)
    if not r.get("success"):
        raise SystemExit(f"rent failed for {tag}: {json.dumps(r)[:200]}")
    iid = r["new_contract"]
    rented.append(iid)
    print(f"  {tag}: instance {iid} · {offer.get('gpu_name')} · {offer.get('inet_down')} Mbit · "
          f"${offer.get('dph_total'):.3f}/h · {offer.get('geolocation')}", flush=True)
    return iid


def status(iid):
    try:
        r = api("GET", f"/instances/{iid}/")
    except SystemExit:
        return None, ""
    i = r.get("instances") if isinstance(r.get("instances"), dict) else r
    if not isinstance(i, dict):
        return None, ""
    return i.get("actual_status"), (i.get("status_msg") or "").strip()


def destroy_all():
    for iid in list(rented):
        try:
            api("DELETE", f"/instances/{iid}/", {})
            print(f"  destroyed {iid}", flush=True)
        except SystemExit as e:
            print(f"  COULD NOT DESTROY {iid}: {e}", flush=True)
        rented.remove(iid)


def main():
    tags = sys.argv[1:] or ["keou"]
    signal.signal(signal.SIGINT, lambda *_: (destroy_all(), sys.exit(130)))
    try:
        offs = offers(len(tags))
        t0 = time.time()
        boxes = {tag: rent(offs[n], tag) for n, tag in enumerate(tags)}
        done, last = {}, {}
        deadline = t0 + MINUTES * 60
        while len(done) < len(boxes) and time.time() < deadline:
            for tag, iid in boxes.items():
                if tag in done:
                    continue
                st, msg = status(iid)
                if st == "running":
                    done[tag] = time.time() - t0
                    print(f"  {tag}: RUNNING after {done[tag] / 60:.1f} min", flush=True)
                elif msg and last.get(tag) != msg:
                    last[tag] = msg
                    print(f"  {tag}: [{int((time.time() - t0) / 60)} min] {msg[:70]}", flush=True)
            time.sleep(20)
        print("\n  --- download + unpack, minutes ---")
        for tag in tags:
            print(f"  {tag:>10}: {done[tag] / 60:.1f}" if tag in done else f"  {tag:>10}: not ready in {MINUTES:.0f} min")
    finally:
        destroy_all()


if __name__ == "__main__":
    main()
