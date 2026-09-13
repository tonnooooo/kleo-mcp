#!/usr/bin/env python3
"""The film, pure: filmed shots under the narration, nothing drawn on top. Runs ON THE BOX (started by vero.sh).

13 September, the owner's reset: one style, realistic; no captions, no chapters, no music, no templates; the
still is only the reference frame each shot is animated from. So this is the whole pipeline now:

    storyboard -> reference frame per shot (SDXL) -> clip per shot (Wan 2.2, image-to-video) ->
    60 fps 4K track (kleo_video.build_footage) -> the narration mixed on top -> out/video.mp4

The Keou engine is used for two things only: the voice pass (Kokoro + the word alignment that decides where the
shots cut) and the shot plan. It draws nothing. Sentinels for the driver: "== FATTO ==" / "== FALLITO: ...".
"""
import importlib.util, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "..", "worker")
sys.path.insert(0, WORKER)
spec = importlib.util.spec_from_file_location("kw", os.path.join(WORKER, "kleo_worker.py"))
kw = importlib.util.module_from_spec(spec); spec.loader.exec_module(kw)
spec = importlib.util.spec_from_file_location("kv", os.path.join(WORKER, "kleo_video.py"))
kv = importlib.util.module_from_spec(spec); spec.loader.exec_module(kv)

t0 = time.time()
def progress(track, percent, eta_min=None, message=None):
    print(f"  [{(time.time()-t0)/60:5.1f} min] {track:>10} {percent:>3}%  {message or ''}", flush=True)
kw.progress = progress

# The narration chain of run.py, without the music bus: the voice alone, cleaned and normalised to -16 LUFS.
VOICE = ("aresample=48000,highpass=f=75,lowpass=f=12000,acompressor=threshold=0.15:ratio=2:attack=15:release=180,"
         "volume=1.6,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000,aformat=channel_layouts=stereo")


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout)[-600:])
    return r.stdout


def main():
    sb = json.load(open(os.environ.get("STORYBOARD", os.path.join(HERE, "moto.json"))))
    sb["backdrop"] = "video"                                    # this pipeline films, always
    sb["music"] = "none"                                        # titles/captions stay in the data (the contract wants
                                                                # them); nothing here draws them
    job_id = os.environ.get("JOB_ID", "gt_film")
    job = {"job_id": job_id, "storyboard": sb, "brand": "Kleo",
           "params": {"format": sb["format"], "duration_s": 60, "language": sb["language"]}, "prompt": sb["title"]}
    out = os.environ.get("OUT", "/opt/kleo/out")
    shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
    engine = os.path.abspath(kw.KEOU_DIR)
    print(f"== {sb['title']} · {sb['format']} · {sum(len(s.get('shots') or []) for s in sb['scenes'])} riprese ==", flush=True)
    try:
        project, pdir, units = kw.prepare_project(job, engine, os.path.join(engine, "projects"))
        print(f"== TIMELINE {os.path.join(pdir, 'build', 'timeline.json')} ==", flush=True)
        if not units:
            raise RuntimeError("no shot carries a description to film")
        log_path = os.path.join(out, "log.txt")
        if not kw.generate_footage(project, pdir, engine, log_path, units):
            raise RuntimeError("the shots did not film (see log.txt): there is no film without them")
        footage = os.path.join(pdir, "build", "footage.mp4"); voice = os.path.join(pdir, "build", "voice.wav")
        tl = json.load(open(os.path.join(pdir, "build", "timeline.json")))
        video = os.path.join(out, "video.mp4")
        progress("film", 80, message="the narration goes on the film")
        sh(["ffmpeg", "-v", "error", "-y", "-i", footage, "-i", voice, "-filter_complex", f"[1:a]{VOICE}[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            "-t", f"{float(tl['duration']):.3f}", video])
        # The delivery checks that matter for a film with nothing drawn on it: length, black, a frozen second.
        dur = float(sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).strip())
        if abs(dur - float(tl["duration"])) > 0.25:
            raise RuntimeError(f"the film is {dur:.2f} s, the narration {tl['duration']:.2f} s")
        dec = subprocess.run(["ffmpeg", "-nostdin", "-v", "info", "-i", video, "-vf", "scale=270:-2,blackdetect=d=0.15:pic_th=0.98:pix_th=0.02",
                              "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
        black = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", dec)
        if black:
            raise RuntimeError(f"black interval: {black}")
        worst = max((secs for _, secs in kv.frozen_runs(video)), default=0.0)
        if worst >= 1.0:
            raise RuntimeError(f"{worst:.1f} s without motion")
        sh(["ffmpeg", "-v", "error", "-y", "-ss", "1.5", "-i", video, "-frames:v", "1", "-q:v", "2", os.path.join(out, "thumbnail.jpg")])
        print(f"\n== FATTO ==\n  video.mp4  {os.path.getsize(video)/1e6:.0f} MB  {dur:.1f} s  longest still run {worst:.1f} s", flush=True)
    except Exception as e:
        print(f"\n== FALLITO: {type(e).__name__}: {e}", flush=True)
        raise
    finally:
        print(f"\n  tempo totale {(time.time()-t0)/60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
