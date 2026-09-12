#!/usr/bin/env python3
"""The real video from the real chain, with no server in the loop: mounts kleo_worker.render_keou by hand ON THE BOX.

Runs on the rented machine only (never on the owner's computer), started by vero.sh through `devbox.py bg` so
that it belongs to the box and not to an ssh session. It prints one of two sentinels that vero.sh waits for:

    == FATTO ==        the files are in /opt/kleo/out
    == FALLITO: ...    the exception, then the traceback
"""
import importlib.util, json, os, shutil, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))              # /opt/kleo/repo/scripts/motion-demo
WORKER = os.path.join(HERE, "..", "..", "worker")
sys.path.insert(0, WORKER)
spec = importlib.util.spec_from_file_location("kw", os.path.join(WORKER, "kleo_worker.py"))
kw = importlib.util.module_from_spec(spec); spec.loader.exec_module(kw)

# There is no server to call: without this every progress report costs 12 seconds of failed attempts.
t0 = time.time()
marks = []
def progress(track, percent, eta_min=None, message=None):
    marks.append((time.time() - t0, track, percent, message))
    print(f"  [{(time.time()-t0)/60:5.1f} min] {track:>10} {percent:>3}%  {message or ''}", flush=True)
kw.progress = progress

sb = json.load(open(os.environ.get("STORYBOARD", os.path.join(HERE, "moto.json"))))
job = {"job_id": "gt_demo", "storyboard": sb, "brand": "Kleo",
       "params": {"format": sb["format"], "duration_s": 35, "language": sb["language"]},
       "prompt": sb["title"]}
out = os.environ.get("OUT", "/opt/kleo/out")
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)

print(f"== {sb['title']} · {sb['format']} · {sum(len(s['shots']) for s in sb['scenes'])} inquadrature ==", flush=True)
try:
    files = kw.render_keou(job, out)
    print("\n== FATTO ==", flush=True)
    for n, p in files.items():
        print(f"  {n:<16} {os.path.getsize(p)/1e6:8.1f} MB   {p}", flush=True)
except Exception as e:
    print(f"\n== FALLITO: {type(e).__name__}: {e}", flush=True)
    raise
finally:
    print(f"\n  tempo totale {(time.time()-t0)/60:.1f} min", flush=True)
    for dt, track, pc, msg in marks:
        print(f"    {dt/60:5.1f}  {track:>10} {pc:>3}%  {msg or ''}", flush=True)
