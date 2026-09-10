#!/usr/bin/env python3
"""Take the generated shots and make one film out of them: 3840x2160, 60 fps, graded as a single object.

    python3 assemble.py /workspace/clips /workspace/film/FILM.mp4 [16:9|9:16]

Order of stages, chosen for cost as much as for looks:
  1. each clip is trimmed (a generated clip settles in its first frames and drifts in its last), upscaled with
     Lanczos and interpolated to 60 fps. Neural upscalers shimmer on generated footage and cost minutes per clip;
     the grain pass at the end hides more than they would have added.
  2. the clips are concatenated with a short cross-dissolve, which is what stops eight independent generations
     reading as eight separate videos.
  3. ONE grade over the whole film, never per clip: lifted blacks, a cool shadow and a warm highlight, gentle
     contrast, film grain, and a 2.00:1 matte. This is the pass that makes them one film.
"""
import glob, json, os, subprocess, sys, time

XFADE = 0.35          # long enough to read as an edit, short enough not to lose a two-second shot
TRIM = 0.10
GRADE = ("curves=r='0/0.02 0.25/0.22 0.75/0.80 1/0.98':g='0/0.02 0.25/0.22 0.75/0.80 1/0.98':"
         "b='0/0.035 0.25/0.235 0.75/0.79 1/0.97',eq=saturation=0.94:contrast=1.05,"
         "unsharp=5:5:0.4:5:5:0,noise=alls=5:allf=t+u")


def run(cmd, what):
    t = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"  {what} FALLITO:\n{p.stderr[-1200:]}")
        raise SystemExit(1)
    return time.time() - t


def dur(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                capture_output=True, text=True).stdout.strip() or 0)


def main():
    src_dir, dst = sys.argv[1], sys.argv[2]
    fmt = sys.argv[3] if len(sys.argv) > 3 else "16:9"
    W, H = (3840, 2160) if fmt == "16:9" else (2160, 3840)
    clips = sorted(glob.glob(os.path.join(src_dir, "*.mp4")))
    if not clips:
        raise SystemExit("nessuna clip")
    work = os.path.join(os.path.dirname(dst) or ".", "work")
    os.makedirs(work, exist_ok=True)
    print(f"  {len(clips)} inquadrature -> {W}x{H} 60 fps", flush=True)

    # 1. every shot to the delivery format, still ungraded
    ready = []
    for i, c in enumerate(clips):
        out = os.path.join(work, f"{i:02d}.mp4")
        d = dur(c)
        keep = max(0.6, d - 2 * TRIM)
        # Interpolate FIRST, at the clip's own size, and only then enlarge. Motion-compensated interpolation costs
        # in proportion to the pixels it has to search: doing it at 3840x2160 took about seven minutes a clip, at
        # 1280x704 it takes seconds, and the frames it invents are then enlarged like any other.
        t = run(["ffmpeg", "-v", "error", "-y", "-ss", str(TRIM), "-t", str(keep), "-i", c,
                 "-vf", "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,"
                        f"scale={W}:{H}:flags=lanczos",
                 "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", out],
                f"scala {os.path.basename(c)}")
        ready.append(out)
        print(f"    {os.path.basename(c)}: {d:.1f}s -> {keep:.1f}s in {t:.0f}s", flush=True)

    # 2. one long cross-dissolved chain
    inputs, filt, prev, offset = [], [], None, 0.0
    for i, r in enumerate(ready):
        inputs += ["-i", r]
    for i, r in enumerate(ready):
        d = dur(r)
        if i == 0:
            prev, offset = "0:v", d - XFADE
            continue
        lab = f"x{i}"
        filt.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={XFADE}:offset={offset:.3f}[{lab}]")
        prev = lab
        offset += d - XFADE
    chain = ";".join(filt) if filt else None
    graded = f"[{prev}]{GRADE},crop={W}:{int(W/2.0)//2*2}:0:{(H-int(W/2.0))//2},pad={W}:{H}:0:{(H-int(W/2.0))//2}:black[v]" if fmt == "16:9" \
        else f"[{prev}]{GRADE}[v]"
    fc = (chain + ";" if chain else "") + graded
    t = run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", "[v]",
             "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", dst], "montaggio")
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=width,height,r_frame_rate", "-show_entries", "format=duration",
                            "-of", "csv=p=0", dst], capture_output=True, text=True).stdout.strip().replace("\n", " ")
    print(f"  FILM: {os.path.getsize(dst)} bytes · {probe} · montaggio {t:.0f}s", flush=True)


if __name__ == "__main__":
    main()
