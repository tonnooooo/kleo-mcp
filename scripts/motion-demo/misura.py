#!/usr/bin/env python3
"""Is there GENERATED motion in this film, or only a still being zoomed? A meter the generator does not optimise.

    python3 scripts/motion-demo/misura.py <video.mp4> <timeline.json | projects dir>
    python3 scripts/motion-demo/misura.py --selftest

A Ken Burns move is a similarity transform: between two frames a second apart, every pixel moved by one zoom and
one pan. So for each scene we take two frames a second apart, find the single zoom+pan that best maps the first
onto the second, and measure how much difference REMAINS. On a zoomed still almost nothing remains (only
resampling noise and the text layer, which is why the measure is taken on the middle band of the frame, away from
the captions at the bottom and the title at the top). On footage where water, spray or silt actually move, most
of the difference remains, because no zoom explains it.

    unexplained ≈ 0.0-0.25   a still being moved (what was delivered three times and rejected)
    unexplained ≈ 0.5-1.0    something in the picture moved on its own

The number is `travel_px`'s opposite: travel_px is what the move planner writes down about itself; this is what
a viewer's eye is given. The two must be read together, never one for the other. The selftest builds a two
second zoompan of a still and a two second clip with an object crossing a static background and checks the meter
tells them apart — tiny clips, a probe of the ruler and not a render of anything.
"""
import glob, json, os, subprocess, sys, tempfile
import numpy as np

W = 320


def probe(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height:format=duration", "-of", "json", video],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    return int(s["width"]), int(s["height"]), float(j["format"]["duration"])


def frame(video, t, w, h):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
                          "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    if len(raw) != w * h:
        raise SystemExit(f"no frame at {t:.2f}s in {video}")
    return np.frombuffer(raw, np.uint8).reshape(h, w).astype(np.float32) / 255


class Warper:
    def __init__(self, h, w):
        self.h, self.w = h, w
        self.ys, self.xs = np.mgrid[0:h, 0:w].astype(np.float32)
        self.cx, self.cy = (w - 1) / 2, (h - 1) / 2

    def __call__(self, a, s, dx, dy):
        sx = self.cx + (self.xs - self.cx) / s + dx
        sy = self.cy + (self.ys - self.cy) / s + dy
        valid = (sx >= 0) & (sx <= self.w - 1) & (sy >= 0) & (sy <= self.h - 1)
        x0 = np.clip(np.floor(sx).astype(int), 0, self.w - 2); y0 = np.clip(np.floor(sy).astype(int), 0, self.h - 2)
        fx = np.clip(sx - x0, 0, 1); fy = np.clip(sy - y0, 0, 1)
        v = (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy)
             + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)
        return v, valid


def unexplained(a, b, band):
    """Share of |a-b| on `band` that the best single zoom+pan cannot remove. Coarse-to-fine grid search."""
    warp = Warper(*a.shape)

    def cost(s, dx, dy):
        v, ok = warp(a, s, dx, dy)
        m = ok & band
        return float(np.abs(v - b)[m].mean()) if m.sum() > 100 else 9.0

    base = float(np.abs(a - b)[band].mean())
    if base < 1e-4:
        return 0.0, (1.0, 0, 0), base
    best = min(((cost(s, 0, 0), s, 0, 0) for s in np.arange(0.86, 1.145, 0.005)))
    c, s, dx, dy = best
    best = min(((cost(s, x, y), s, x, y) for x in range(-14, 15, 2) for y in range(-14, 15, 2)))
    c, s, dx, dy = best
    best = min(((cost(s2, x, y), s2, x, y) for s2 in np.arange(s - .01, s + .0105, .0025)
                for x in range(dx - 2, dx + 3) for y in range(dy - 2, dy + 3)))
    c, s, dx, dy = best
    return c / base, (float(s), dx, dy), base


def band_mask(h, w):
    """The middle of the frame: away from the caption strip at the bottom and the chapter/title at the top."""
    m = np.zeros((h, w), bool)
    m[int(h * .24):int(h * .70), int(w * .08):int(w * .92)] = True
    return m


def measure(video, windows, gap=1.0, label=""):
    vw, vh, dur = probe(video)
    h = int(round(vh * W / vw / 2)) * 2
    band = band_mask(h, W)
    rows = []
    for name, start, end in windows:
        ta = start + max(0.35, (end - start - gap) / 2)
        tb = min(ta + gap, end - 0.2, dur - 0.05)
        if tb - ta < 0.4:
            continue
        a, b = frame(video, ta, W, h), frame(video, tb, W, h)
        u, (s, dx, dy), base = unexplained(a, b, band)
        rows.append((name, ta, tb, u, s, dx, dy, base))
        print(f"  {label}{name:<14} {ta:6.2f}->{tb:6.2f}s  unexplained {u:5.2f}   best zoom {s:.3f} pan ({dx:+d},{dy:+d})  raw diff {base:.3f}", flush=True)
    return rows


def windows_from_timeline(path):
    if os.path.isdir(path):
        found = sorted(glob.glob(os.path.join(path, "*", "build", "timeline.json")), key=os.path.getmtime)
        if not found:
            raise SystemExit(f"no */build/timeline.json under {path}")
        path = found[-1]
    tl = json.load(open(path))
    return [(sc["id"], float(sc["start"]), float(sc["end"])) for sc in tl["scenes"]]


def verdict(rows):
    if not rows:
        print("nothing measured"); return 2
    us = [r[3] for r in rows]
    moving = sum(u >= 0.5 for u in us); still = sum(u < 0.25 for u in us)
    print(f"\n  {len(rows)} scenes: {moving} with motion of their own (>=0.50), {still} that read as a moved still (<0.25), "
          f"{len(rows) - moving - still} in between; median unexplained {np.median(us):.2f}")
    if still:
        print("  VERDICT: at least one scene is a zoomed still. That is what was rejected."); return 1
    print("  VERDICT: every scene has motion that no zoom explains."); return 0


def selftest():
    d = tempfile.mkdtemp(prefix="misura-")
    rng = np.random.default_rng(7)
    # a smooth "photo": low-frequency noise upsampled, so that zoom and pan are well defined
    small = rng.random((9, 16)).astype(np.float32)
    pic = np.kron(small, np.ones((40, 40), np.float32))[:360, :640]
    from PIL import Image  # noqa
    Image.fromarray((pic * 255).astype(np.uint8)).save(os.path.join(d, "pic.png"))
    still = os.path.join(d, "still.mp4"); moving = os.path.join(d, "moving.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", os.path.join(d, "pic.png"), "-t", "2",
                    "-vf", "zoompan=z='1+0.1*on/50':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=640x360:fps=25",
                    "-pix_fmt", "yuv420p", still], check=True)
    # the same still, no zoom, and a box crossing it: motion no zoom can explain
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", os.path.join(d, "pic.png"),
                    "-f", "lavfi", "-i", "color=white:s=90x90:r=25", "-t", "2",
                    "-filter_complex", "[0][1]overlay=x='100+200*t':y=120:eval=frame,fps=25",
                    "-pix_fmt", "yuv420p", moving], check=True)
    print("selftest:")
    s = measure(still, [("zoomed-still", 0.0, 2.0)], label="")[0][3]
    m = measure(moving, [("box-crossing", 0.0, 2.0)], label="")[0][3]
    ok = s < 0.25 and m > 0.5
    print(f"  still {s:.2f} (< 0.25 wanted)   moving {m:.2f} (> 0.50 wanted)   ->", "OK" if ok else "THE METER IS BROKEN")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    print(f"motion in {sys.argv[1]}:")
    sys.exit(verdict(measure(sys.argv[1], windows_from_timeline(sys.argv[2]))))
