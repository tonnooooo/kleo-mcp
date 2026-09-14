#!/usr/bin/env python3
"""
Before / after of the still prompts, on the box's own GPU, same seeds: the four pictures of a fixture drawn with the
prompt suffix and negative of 13 September and again with today's (sharp, concrete), then a number nobody can argue
with — the variance of the Laplacian (edge energy; higher = sharper) — and a side-by-side JPG per shot to LOOK at.
Runs ON the dev box like devrender.py (python3 scripts/sharpness-ab.py test/fixtures/realistic-layer.json --shots 4).
Never on the owner's computer.
"""
import argparse, json, os, sys, time
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD = {"suffix": "cinematic photograph, 35mm lens, dramatic natural light, high detail",
       "negative": "text, letters, words, watermark, logo, signature, caption, subtitles, blurry, deformed, low quality, worst quality"}


def laplacian_var(path):
    import numpy as np
    from PIL import Image
    g = np.asarray(Image.open(path).convert("L"), dtype=np.float64)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("storyboard"); ap.add_argument("--shots", type=int, default=4); ap.add_argument("--out", default="/opt/kleo/ab")
    a = ap.parse_args()
    sys.path.insert(0, "/opt/kleo")
    import kleo_pictures as kp
    sb = json.load(open(a.storyboard if os.path.isabs(a.storyboard) else os.path.join(REPO, a.storyboard)))
    # The first N shots of the film, scene ids kept (the picture ids are "<scene>-s<n>" and the seed comes from them).
    scenes, n = [], 0
    for s in sb["scenes"]:
        keep = (s.get("shots") or [])[:max(0, a.shots - n)]
        if not keep: break
        scenes.append({"id": s["id"], "shots": [dict(sh) for sh in keep], "accent": s.get("accent")}); n += len(keep)
    direction = sb.get("direction")
    fmt, style = sb.get("format", "9:16"), "realistic"
    results = {}
    for tag, suffix, negative in (("old", OLD["suffix"], OLD["negative"]), ("new", kp.STYLE_SUFFIX["realistic"], kp.NEGATIVE_PROMPT)):
        kp.STYLE_SUFFIX = dict(kp.STYLE_SUFFIX, realistic=suffix); kp.NEGATIVE_PROMPT = negative
        out = os.path.join(a.out, tag); os.makedirs(out, exist_ok=True)
        t0 = time.time()
        made = kp.generate_pictures(scenes, style, fmt, out, direction=direction)
        results[tag] = {"seconds": round(time.time() - t0, 1), "pictures": {k: {"path": v, "sharpness": round(laplacian_var(v), 1)} for k, v in made.items()}}
        print(f"{tag}: {len(made)} pictures in {results[tag]['seconds']} s", flush=True)
    # Side by side, old | new, per shot, at a size that still shows texture.
    from PIL import Image
    pairs = []
    for sid in results["old"]["pictures"]:
        if sid not in results["new"]["pictures"]: continue
        a_img, b_img = Image.open(results["old"]["pictures"][sid]["path"]), Image.open(results["new"]["pictures"][sid]["path"])
        h = 1200; a_img = a_img.resize((int(a_img.width * h / a_img.height), h)); b_img = b_img.resize((int(b_img.width * h / b_img.height), h))
        canvas = Image.new("RGB", (a_img.width + b_img.width + 24, h), (0, 0, 0)); canvas.paste(a_img, (0, 0)); canvas.paste(b_img, (a_img.width + 24, 0))
        p = os.path.join(a.out, f"ab-{sid}.jpg"); canvas.save(p, quality=90); pairs.append(p)
    summary = {sid: {"old": results["old"]["pictures"][sid]["sharpness"], "new": results["new"]["pictures"].get(sid, {}).get("sharpness")} for sid in results["old"]["pictures"]}
    json.dump({"summary": summary, "pairs": pairs, "old": OLD, "new": {"suffix": kp.STYLE_SUFFIX["realistic"], "negative": kp.NEGATIVE_PROMPT}}, open(os.path.join(a.out, "ab.json"), "w"), indent=1)
    print("SHARPNESS", json.dumps(summary), flush=True)
    print("== AB DONE ==", flush=True)


if __name__ == "__main__":
    main()
