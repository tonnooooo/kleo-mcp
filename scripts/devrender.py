#!/usr/bin/env python3
"""
Render one storyboard on the Vast dev box, with no Cloudflare server in the loop — the fast way to LOOK at a style
before spending a production job on it. Runs ON the dev box (send it there with scripts/devbox.py):

    python3 scripts/devrender.py test/fixtures/cartoon-pirates.json          full render + contact sheet
    python3 scripts/devrender.py test/fixtures/realistic-space.json --scenes 2   only the first 2 scenes (quick look)
    python3 scripts/devrender.py <file> --no-render                          pictures + project.json only

What it does: overlays this repo's engine and worker onto the image's /opt/kleo (which already has node_modules,
the Python venv, Chromium and the models), makes sure the two style fonts are there, draws every shot picture on
the box's own GPU (KLEO_PICTURES=local, so no server is called), writes project.json, runs the Keou engine, then
extracts frames and stitches a contact sheet at out/sheet.jpg.
"""
import argparse, glob, json, os, shutil, subprocess, sys, time

IMAGE_ENGINE = os.environ.get("KLEO_KEOU_DIR", "/opt/kleo/keou")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = {"cartoon.ttf": "https://github.com/google/fonts/raw/main/ofl/baloo2/Baloo2%5Bwght%5D.ttf",
         "real.ttf": "https://github.com/google/fonts/raw/main/ofl/oswald/Oswald%5Bwght%5D.ttf"}


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), **kw)


def overlay():
    """This repo's engine + worker on top of the image's, keeping node_modules / .venv / models."""
    src = os.path.join(REPO, "worker", "keou")
    for rel in ("engine", "contract.py", "run.py", "prepare.py", "qa.py", "settings.py", "watchdog.py"):
        s, d = os.path.join(src, rel), os.path.join(IMAGE_ENGINE, rel)
        if not os.path.exists(s):
            continue
        if os.path.isdir(s):
            for root, _, files in os.walk(s):
                for f in files:
                    if "node_modules" in root or f.endswith(".orig"):
                        continue
                    sp = os.path.join(root, f)
                    dp = os.path.join(d, os.path.relpath(sp, s))
                    os.makedirs(os.path.dirname(dp), exist_ok=True)
                    shutil.copy2(sp, dp)
        else:
            shutil.copy2(s, d)
    shutil.copy2(os.path.join(REPO, "worker", "kleo_worker.py"), "/opt/kleo/kleo_worker.py")
    shutil.copy2(os.path.join(REPO, "worker", "kleo_pictures.py"), "/opt/kleo/kleo_pictures.py")
    assets = os.path.join(IMAGE_ENGINE, "engine", "assets")
    for name, url in FONTS.items():
        p = os.path.join(assets, name)
        if not (os.path.isfile(p) and os.path.getsize(p) > 100_000):
            sh(["curl", "-fsSL", "-o", p, url])
            print(f"  font {name}: {os.path.getsize(p) if os.path.isfile(p) else 0} bytes", flush=True)
    print("  engine overlaid from the repo", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("storyboard")
    ap.add_argument("--scenes", type=int, default=0, help="keep only the first N scenes (the last stays the closing)")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--workers", default=os.environ.get("KLEO_KEOU_WORKERS", "8"))
    a = ap.parse_args()

    os.environ["KLEO_PICTURES"] = "local"          # never call a server: this box draws every picture itself
    os.environ["KLEO_KEOU_WORKERS"] = a.workers
    os.environ.setdefault("KLEO_API", "http://127.0.0.1:9")
    os.environ.setdefault("KLEO_JOB_ID", "devrender")
    os.environ.setdefault("KLEO_SECRET", "dev")
    overlay()
    sys.path.insert(0, "/opt/kleo")
    import kleo_worker as kw
    kw.progress = lambda track, percent, eta_min=None, message=None: print(f"  [{percent:>3}%] {track}: {message}", flush=True)

    sb = json.load(open(a.storyboard if os.path.isabs(a.storyboard) else os.path.join(REPO, a.storyboard)))
    if a.scenes and len(sb["scenes"]) > a.scenes:
        sb["scenes"] = sb["scenes"][:a.scenes - 1] + [sb["scenes"][-1]]
    job = {"id": "devrender", "storyboard": sb, "template": "viral-short", "prompt": sb.get("description", "dev"),
           "params": {}, "format": sb.get("format", "9:16"), "language": sb.get("language", "en"),
           "duration_s": sb.get("max_duration", 60)}
    projects = os.path.join(IMAGE_ENGINE, "projects")
    shutil.rmtree(os.path.join(projects, sb.get("id", "devrender")), ignore_errors=True)
    t0 = time.time()
    project, pdir = kw.prepare_project(job, IMAGE_ENGINE, projects)
    print(f"  project {project['id']}: {len(project['scenes'])} scenes, style {project.get('style')}, "
          f"look {project.get('look')}, {time.time() - t0:.0f}s", flush=True)
    if a.no_render:
        print(json.dumps(project, indent=1)[:2000]); return

    t1 = time.time()
    kw.run_keou(IMAGE_ENGINE, os.path.join(pdir, "project.json"), len(project["scenes"]),
                os.path.join(pdir, "log.txt"))
    master = os.path.join(pdir, "out", "master.mp4")
    if not os.path.isfile(master):
        print("NO master.mp4 — tail of the log:"); sh(f"tail -40 {pdir}/log.txt"); sys.exit(1)
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=width,height,r_frame_rate", "-show_entries", "format=duration",
                            "-of", "csv=p=0", master], capture_output=True, text=True).stdout.strip().replace("\n", " ")
    print(f"  master.mp4 {os.path.getsize(master)} bytes · {probe} · render {time.time() - t1:.0f}s "
          f"· total {time.time() - t0:.0f}s", flush=True)

    out = os.path.join(pdir, "out")
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", master],
                               capture_output=True, text=True).stdout.strip() or 40)
    n = 8
    for f in glob.glob(os.path.join(out, "f_*.png")):
        os.remove(f)
    for i in range(n):
        t = dur * (i + 0.5) / n
        sh(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", master, "-frames:v", "1",
            "-vf", "scale=340:-1", os.path.join(out, f"f_{i:02d}.png")])
    frames = sorted(glob.glob(os.path.join(out, "f_*.png")))
    sheet = os.path.join(out, "sheet.jpg")
    sh(["ffmpeg", "-v", "error", "-y", *sum(([["-i", f][0], f] for f in frames), []),
        "-filter_complex", f"{''.join(f'[{i}]' for i in range(len(frames)))}hstack={len(frames)}",
        "-q:v", "3", sheet])
    print("  sheet:", sheet, os.path.getsize(sheet) if os.path.isfile(sheet) else 0, "bytes")
    print("  master:", master)


if __name__ == "__main__":
    main()
