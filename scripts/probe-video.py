#!/usr/bin/env python3
"""First probe: does Wan 2.2 make real motion, and does it obey a camera instruction?
Runs on the rented box only. Writes mp4 clips and a contact sheet to /workspace/out."""
import os, sys, time, json
import torch
from diffusers import AutoencoderKLWan, WanPipeline
from diffusers.utils import export_to_video

MODEL = "/workspace/models/wan22-ti2v-5b"
OUT = "/workspace/out"
os.makedirs(OUT, exist_ok=True)

NEG = ("blurry, low quality, worst quality, jpeg artifacts, watermark, text, logo, deformed, "
       "morphing, extra fingers, warping face, floating objects, static image, still frame")

# Three subjects x three camera moves, in the vendor dialect the shot grammar uses.
SUBJECTS = [
    ("face", "close-up portrait of a weathered fisherman in his sixties, grey stubble, wool cap, "
             "harbour lights bokeh behind him, overcast late afternoon, 35mm anamorphic, shallow depth of field"),
    ("land", "a wide empty coastal road cutting through black volcanic rock at dawn, low mist, "
             "cold blue light, distant ocean, cinematic, 35mm"),
    ("object", "a brass ship compass on a worn wooden table, candlelight from the left, dust in the air, "
               "macro detail, warm shadows, cinematic"),
]
MOVES = [
    ("push_in", "the camera pushes slowly forward toward the subject at a constant lens height, "
                "decelerating into a static hold. NOT a zoom, NOT a pull-back."),
    ("track_right", "the camera tracks laterally to the right at a constant speed, the foreground passing "
                    "faster than the background. NOT a pan, NOT a zoom."),
    ("crane_down", "the camera cranes slowly downward from above toward eye level, the horizon rising in frame. "
                   "NOT a tilt, NOT a zoom."),
]

def main():
    steps = int(os.environ.get("STEPS", "30"))
    frames = int(os.environ.get("FRAMES", "49"))     # 5B is 24 fps: 49 frames ~ 2.0 s
    w, h = int(os.environ.get("W", "1280")), int(os.environ.get("H", "704"))
    t0 = time.time()
    vae = AutoencoderKLWan.from_pretrained(MODEL, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanPipeline.from_pretrained(MODEL, vae=vae, torch_dtype=torch.bfloat16)
    pipe.to("cuda")
    pipe.enable_vae_tiling()
    print(f"pipeline pronta in {time.time()-t0:.0f}s", flush=True)
    report = []
    for sname, subject in SUBJECTS:
        for mname, move in MOVES:
            tag = f"{sname}__{mname}"
            t1 = time.time()
            g = torch.Generator(device="cuda").manual_seed(abs(hash(tag)) % (2**31))
            out = pipe(prompt=f"{subject}. {move}", negative_prompt=NEG, height=h, width=w,
                       num_frames=frames, num_inference_steps=steps, guidance_scale=5.0, generator=g)
            path = os.path.join(OUT, tag + ".mp4")
            export_to_video(out.frames[0], path, fps=24)
            dt = time.time() - t1
            report.append({"clip": tag, "seconds": round(dt, 1), "bytes": os.path.getsize(path)})
            print(f"  {tag}: {dt:.0f}s -> {path}", flush=True)
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    print("TOTALE %.0f s" % (time.time() - t0), flush=True)

if __name__ == "__main__":
    main()
