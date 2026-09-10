#!/usr/bin/env python3
"""Judge the probe clips on the box: is this real 3D motion, or a zoom on a photograph?
For each clip: mean optical flow magnitude (is anything moving at all), the share of flow explained by a pure
radial (zoom) model (high = it IS a Ken Burns in disguise), and a parallax score (foreground vs background speed).
Writes /workspace/out/judge.json and a contact sheet per clip."""
import glob, json, os, subprocess
import numpy as np, cv2

OUT = "/workspace/out"

def frames_of(path, n=16):
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    idx = np.linspace(0, total - 1, min(n, total)).astype(int)
    got, want = [], set(idx.tolist())
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok: break
        if i in want: got.append(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY))
        i += 1
    cap.release()
    return got

def radial_fit(flow):
    """R² of a pure zoom model: flow = k * (pixel - centre). A Ken Burns scores near 1."""
    h, w = flow.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    rx, ry = (xs - cx), (ys - cy)
    fx, fy = flow[..., 0], flow[..., 1]
    num = (fx * rx + fy * ry).sum()
    den = (rx * rx + ry * ry).sum() + 1e-9
    k = num / den
    res = ((fx - k * rx) ** 2 + (fy - k * ry) ** 2).sum()
    tot = (fx ** 2 + fy ** 2).sum() + 1e-9
    return max(0.0, 1.0 - res / tot), k

def parallax(flow):
    """Speed of the fastest tenth of the frame over the slowest tenth: a flat photo moves as one, a real
    3-D scene does not."""
    mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2).ravel()
    mag.sort()
    lo = mag[: max(1, len(mag) // 10)].mean()
    hi = mag[-max(1, len(mag) // 10):].mean()
    return float(hi / (lo + 1e-3))

def main():
    rows = []
    for path in sorted(glob.glob(os.path.join(OUT, "*.mp4"))):
        fs = frames_of(path)
        if len(fs) < 3: continue
        r2s, mags, pars = [], [], []
        for a, b in zip(fs[:-1], fs[1:]):
            fl = cv2.calcOpticalFlowFarneback(a, b, None, .5, 3, 21, 3, 5, 1.2, 0)
            r2, _ = radial_fit(fl)
            r2s.append(r2); pars.append(parallax(fl))
            mags.append(float(np.sqrt(fl[..., 0] ** 2 + fl[..., 1] ** 2).mean()))
        name = os.path.basename(path)[:-4]
        # Per-frame flow alone is misleading: the same camera travel spread over more frames reads as less motion,
        # so a longer clip looks stiller than it is. What matters is how far the frame actually travelled, which is
        # the per-frame flow times the number of frame pairs, sampled evenly across the clip.
        import cv2 as _cv
        cap = _cv.VideoCapture(path); total = int(cap.get(_cv.CAP_PROP_FRAME_COUNT)) or len(fs); cap.release()
        travel = float(np.median(mags)) * (total - 1)
        rows.append({"clip": name, "radial_r2": round(float(np.median(r2s)), 3),
                     "flow_px": round(float(np.median(mags)), 3), "travel_px": round(travel, 1),
                     "frames": total, "parallax": round(float(np.median(pars)), 2)})
        # a strip of four frames, for the eye
        sheet = os.path.join(OUT, name + "_sheet.jpg")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vf",
                        "select='eq(n\\,2)+eq(n\\,16)+eq(n\\,32)+eq(n\\,46)',scale=420:-1,tile=4x1",
                        "-frames:v", "1", sheet], check=False)
    json.dump(rows, open(os.path.join(OUT, "judge.json"), "w"), indent=1)
    print(f"{'clip':<26}{'fotogr.':>8}{'px/fotogr.':>11}{'viaggio px':>11}{'zoom R²':>9}   verdetto")
    for r in rows:
        # The gate is the travel: a clip whose frame moved less than ~20 px from start to end is a still.
        real = r["travel_px"] > 20 and r["radial_r2"] < .6
        print(f"{r['clip']:<26}{r['frames']:>8}{r['flow_px']:>11.2f}{r['travel_px']:>11.1f}{r['radial_r2']:>9.2f}   "
              + ("MOVIMENTO VERO" if real else ("FERMA" if r["travel_px"] <= 20 else "ZOOM MASCHERATO")))

if __name__ == "__main__":
    main()
