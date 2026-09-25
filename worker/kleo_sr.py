#!/usr/bin/env python3
"""
The neural finish of the footage track: a learned upscale (Real-ESRGAN) on the clip's true frames, then learned
frame interpolation (RIFE 4.25) up to the film's 60 fps, on the finish box's own GPU.

It replaces exactly two things in kleo_video.build_footage and nothing else: Lanczos x4.5 from a 480p clip, and
minterpolate's block matching on the CPU. Cuts, shot lengths, the slow-down and hold decisions, dissolves, the grade
and the concat are decided where they always were; this module only turns one part's clip into a near-lossless
60 fps intermediate at SR size, which kleo_video then scales, grades and trims the same way (finish_vf_sr).

    source frames (24 fps)  ->  SR once per frame (xF, fp16)  ->  RIFE between SR frames at the film's timestamps
                            ->  raw rgb24 pipe  ->  ffmpeg libx264 crf 10 (mid.mp4)

WHY SR FIRST, ON THE 24 TRUE FRAMES. Each source frame goes through the upscaler once. The 60 fps in-betweens are
warps of upscaled frames, so the detail the model adds moves coherently with the picture instead of being invented
again sixty times a second (the per-frame shimmer the old Lanczos-only rule was written against).

WHY THE SLOW-DOWN IS A TIMESTAMP MAP. kleo_video's CPU chain is setpts=stretch*PTS then minterpolate to `fps`; here
output frame k sits at source position p = k * src_fps / (fps * stretch), between frames floor(p) and floor(p)+1 at
t = p - floor(p). Same frame count, same slow motion, to the frame (timeline(), unit-tested).

Everything that needs torch is imported inside the functions: CI imports this module without torch and tests the
pure parts (plan, timeline, the estimate, the weight table). available() never raises: any doubt is a reason, and
the caller falls back to today's chain.

Weights (every file sha256-pinned, the same table as worker/Dockerfile.keou; a test holds the two together):
  realesr-general-x4v3 (+ wdn companion)  BSD-3, xinntao/Real-ESRGAN v0.2.5.0   realistic footage, denoise blend 0.5
  realesr-animevideov3                    BSD-3, xinntao/Real-ESRGAN v0.2.5.0   animation / cartoon footage
  RealESRGAN_x2plus                       BSD-3, xinntao/Real-ESRGAN v0.2.1     x2 sources (1080p class)
  RIFE 4.25 flownet                       MIT, hzwer/Practical-RIFE (RIFEv4.25_0919.zip, mirrored on Hugging Face)

Kill switch: KLEO_SR=off (the server passes it to the box; no image rebuild).

THE CARD RUNS IN A CHILD PROCESS (Card, `kleo_sr.py serve`). A thread stuck inside a CUDA call (a Vast host with Xid
errors) can never be freed, and it would hold the card and every part waiting for it until the server's silence rule
killed a film the CPU chain would have delivered. So kleo_video never touches torch: it asks one child per film, with a
time limit on every request, and a request that overruns kills the child — the parent's thread comes back, the part
and the rest of the film fall back to today's chain.
"""
import hashlib, json, math, os, queue, subprocess, sys, threading, time

SR_DIR = os.environ.get("KLEO_SR_DIR", "/opt/kleo/sr")
MIN_CC = (7, 5)                                                        # torch 2.8 cu128 has no kernels below Turing
MIN_FREE_GB = float(os.environ.get("KLEO_SR_MIN_FREE_GB", "3"))
DENOISE = float(os.environ.get("KLEO_SR_DENOISE", "0.5"))              # realistic x4: x4v3*dn + wdn*(1-dn)
UA = "kleo-worker/1.0 (+https://kleooai.com)"

# name -> (urls, bytes, sha256). The first url is the author's release; the second a Hugging Face mirror pinned to a
# commit, whose published LFS sha256 is the value below (cross-checked on independent mirrors of the same size).
_HF_ESRGAN = "https://huggingface.co/leonelhs/realesrgan/resolve/6907f85a9095e201ec4b3c7e91bbb66cdec0f04d"
_GH_ESRGAN = "https://github.com/xinntao/Real-ESRGAN/releases/download"
WEIGHTS = {
    "realesr-general-x4v3.pth": ((f"{_GH_ESRGAN}/v0.2.5.0/realesr-general-x4v3.pth", f"{_HF_ESRGAN}/realesr-general-x4v3.pth"),
                                 4885111, "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292"),
    "realesr-general-wdn-x4v3.pth": ((f"{_GH_ESRGAN}/v0.2.5.0/realesr-general-wdn-x4v3.pth", f"{_HF_ESRGAN}/realesr-general-wdn-x4v3.pth"),
                                     4885111, "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca"),
    "realesr-animevideov3.pth": ((f"{_GH_ESRGAN}/v0.2.5.0/realesr-animevideov3.pth", f"{_HF_ESRGAN}/realesr-animevideov3.pth"),
                                 2504012, "b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d"),
    "RealESRGAN_x2plus.pth": ((f"{_GH_ESRGAN}/v0.2.1/RealESRGAN_x2plus.pth", f"{_HF_ESRGAN}/RealESRGAN_x2plus.pth"),
                              67061725, "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"),
}
# RIFE 4.25 is published by its author on Google Drive only; two Hugging Face copies of the same zip (same sha256)
# stand in for it. Only train_log/flownet.pkl is taken out of it: the network itself is vendored below (MIT).
RIFE_ZIP = (("https://huggingface.co/r3gm/RIFE/resolve/7ebada9b4387e6a599766e40816876ec500c93d0/RIFEv4.25_0919.zip",
             "https://huggingface.co/myfuturecsl/RIFE/resolve/3f5952a40952693dfad03d0606f64a815e7ad41d/RIFEv4.25_0919.zip"),
            22919050, "e63d481b7ae5d4a4e6ad7ac5b410ff78f3bf7be3b51b2e38ca8152747abde5b4")
RIFE_FILE = "rife425/flownet.pkl"
MANIFEST = "SHA256SUMS"          # written next to the weights when they are fetched: what available() re-checks

_models = {}
_checked = {}


# ---- pure: what to do, decided without torch ------------------------------------------------------------------------

def plan(src_w, src_h, width, height):
    """The SR factor for a clip of src_w x src_h going into a width x height film: 1 (RIFE only), 2 or 4.
    A source whose short side is two thirds of the delivery or more gets no SR (Lanczos does that last step
    honestly); otherwise the smallest of x2 / x4 that lands at 85% of the delivery or above, and ffmpeg's Lanczos
    closes the gap (480x864 -> x4 -> 1920x3456 -> 2160x3840; 1080x1920 -> x2 -> exactly 2160x3840)."""
    short, target = min(src_w, src_h), min(width, height)
    if short * 3 >= target * 2:
        return 1
    for s in (2, 4):
        if short * s >= 0.85 * target:
            return s
    return 4


def model_for(look, factor):
    """The upscaler for a look at a factor, by weight file stem; None when there is no SR (factor 1)."""
    if factor == 4:
        return "realesr-animevideov3" if (look or "").lower() in ("animation", "cartoon") else "realesr-general-x4v3"
    if factor == 2:
        return "RealESRGAN_x2plus"
    return None


def out_count(seconds, fps):
    """Frames of `seconds` at `fps`, as the CPU chain makes them (-t trims the rest)."""
    return max(1, int(math.ceil(seconds * fps - 1e-6)))


def timeline(src_fps, fps, stretch, seconds, n_src=None):
    """[(i, t)] per output frame: output frame k is source frame i blended toward i+1 by t (0 = frame i itself).
    Reproduces setpts=stretch*PTS + fps: p = k * src_fps / (fps * stretch). Past the last source frame the last
    frame is held (the tail's tpad does the same)."""
    out = []
    for k in range(out_count(seconds, fps)):
        p = k * src_fps / (fps * stretch)
        i = int(math.floor(p + 1e-9))
        t = p - i
        if t < 1e-3:
            t = 0.0
        elif t > 1 - 1e-3:
            i, t = i + 1, 0.0
        if n_src is not None and i >= n_src - 1:
            i, t = max(0, n_src - 1), 0.0
        out.append((i, round(t, 6)))
    return out


def estimate_minutes(bench, recipes, fps, src_fps=24.0):
    """Projected GPU minutes for the film from a benchmark ({"sr_s", "rife_s", "io_s"} seconds per frame) and the
    parts' recipes (src, usable, stretch, want, ...). 25% on top for what a 12-frame benchmark cannot see."""
    total = 0.0
    for r in recipes:
        usable, stretch, want = float(r[1]), float(r[2]), float(r[3])
        n_src = usable * src_fps
        n_out = min(want, usable * stretch) * fps
        total += n_src * bench.get("sr_s", 0.0) + n_out * (bench.get("rife_s", 0.0) + bench.get("io_s", 0.0))
    return 1.25 * total / 60.0


def is_oom(e):
    return type(e).__name__ == "OutOfMemoryError" or "out of memory" in str(e).lower()


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def weights_ok(root=None):
    """(ok, reason): every weight is in `root` and still hashes to what was verified when it was fetched. The .pth
    files are checked against the pinned table; the RIFE flownet (taken out of a pinned zip) against the manifest."""
    root = root or SR_DIR
    if root in _checked:
        return _checked[root]
    try:
        for name, (_, _, sha) in WEIGHTS.items():
            p = os.path.join(root, name)
            if not os.path.isfile(p):
                return False, f"{name} is not in {root}"
            if _sha256(p) != sha:
                return False, f"{name} does not match its pinned sha256"
        man = {}
        mp = os.path.join(root, MANIFEST)
        if os.path.isfile(mp):
            for line in open(mp):
                parts = line.split()
                if len(parts) == 2:
                    man[parts[1].lstrip("*")] = parts[0]
        rp = os.path.join(root, RIFE_FILE)
        if not os.path.isfile(rp):
            return False, f"{RIFE_FILE} is not in {root}"
        if man.get(RIFE_FILE) != _sha256(rp):
            return False, f"{RIFE_FILE} does not match {MANIFEST}"
    except Exception as e:
        return False, f"the weights could not be read ({e})"
    _checked[root] = (True, "ok")
    return _checked[root]


def available():
    """(ok, reason). Never raises. KLEO_SR=off, no torch, no CUDA, a card below Turing, less than MIN_FREE_GB free,
    a weight missing or altered, no spandrel: each is a reason, and the film is finished the old way."""
    if os.environ.get("KLEO_SR", "auto").strip().lower() in ("off", "0", "false", "no"):
        return False, "KLEO_SR=off"
    try:
        import torch
    except Exception as e:
        return False, f"no torch ({type(e).__name__})"
    try:
        if not torch.cuda.is_available():
            return False, "no CUDA device"
        cc = tuple(torch.cuda.get_device_capability(0))
        if cc < MIN_CC:
            return False, f"compute capability {cc[0]}.{cc[1]} is below {MIN_CC[0]}.{MIN_CC[1]}"
        free, _ = torch.cuda.mem_get_info(0)
        if free < MIN_FREE_GB * 1024 ** 3:
            return False, f"only {free / 1024 ** 3:.1f} GB of VRAM free"
    except Exception as e:
        return False, f"the GPU could not be read ({e})"
    ok, why = weights_ok()
    if not ok:
        return False, why
    try:
        import spandrel  # noqa: F401
    except Exception:
        return False, "spandrel is not installed"
    return True, "ok"


def gpu_name():
    try:
        import torch
        return torch.cuda.get_device_name(0)
    except Exception:
        return "unknown GPU"


# ---- fetching the weights (the probe box; the image does the same with curl in Dockerfile.keou) -----------------------

def _download(urls, size, sha, dest):
    import urllib.request
    last = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r, open(dest + ".part", "wb") as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            if os.path.getsize(dest + ".part") == size and _sha256(dest + ".part") == sha:
                os.replace(dest + ".part", dest)
                return dest
            last = f"{url.split('/')[2]}: size or sha256 mismatch"
        except Exception as e:
            last = f"{url.split('/')[2]}: {e}"
    raise RuntimeError(f"could not fetch {os.path.basename(dest)} ({last})")


def fetch_weights(root=None):
    """Every weight into `root`, verified, plus the manifest. What the image layer does, for a box on an older image."""
    import zipfile
    root = root or SR_DIR
    os.makedirs(os.path.join(root, os.path.dirname(RIFE_FILE)), exist_ok=True)
    for name, (urls, size, sha) in WEIGHTS.items():
        p = os.path.join(root, name)
        if not (os.path.isfile(p) and _sha256(p) == sha):
            _download(urls, size, sha, p)
    rp = os.path.join(root, RIFE_FILE)
    if not os.path.isfile(rp):
        z = _download(RIFE_ZIP[0], RIFE_ZIP[1], RIFE_ZIP[2], os.path.join(root, "rife425.zip"))
        with zipfile.ZipFile(z) as zf, open(rp, "wb") as f:
            f.write(zf.read("train_log/flownet.pkl"))
        os.remove(z)
    with open(os.path.join(root, MANIFEST), "w") as f:
        for name in list(WEIGHTS) + [RIFE_FILE]:
            f.write(f"{_sha256(os.path.join(root, name))}  {name}\n")
    _checked.pop(root, None)
    return root


# ---- the networks ---------------------------------------------------------------------------------------------------

def _rife_class():
    """IFNet of Practical-RIFE 4.25, inference path only.
    Copyright (c) 2021 hzwer (https://github.com/hzwer/Practical-RIFE), MIT License. Vendored from train_log/IFNet_HDv3.py
    of RIFEv4.25_0919 so that no downloaded code is ever executed; module names are kept so its flownet.pkl loads."""
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    grids = {}

    def warp(inp, flow):
        k = (str(flow.device), tuple(flow.shape))
        if k not in grids:
            n, _, h, w = flow.shape
            hor = torch.linspace(-1.0, 1.0, w, device=flow.device, dtype=torch.float32).view(1, 1, 1, w).expand(n, -1, h, -1)
            ver = torch.linspace(-1.0, 1.0, h, device=flow.device, dtype=torch.float32).view(1, 1, h, 1).expand(n, -1, -1, w)
            grids[k] = torch.cat([hor, ver], 1)
        flow = flow.float()
        flow = torch.cat([flow[:, 0:1] / ((inp.shape[3] - 1.0) / 2.0), flow[:, 1:2] / ((inp.shape[2] - 1.0) / 2.0)], 1)
        g = (grids[k] + flow).permute(0, 2, 3, 1)
        return F.grid_sample(input=inp.float(), grid=g, mode="bilinear", padding_mode="border", align_corners=True).to(inp.dtype)

    def conv(i, o, k=3, s=1, p=1, d=1):
        return nn.Sequential(nn.Conv2d(i, o, kernel_size=k, stride=s, padding=p, dilation=d, bias=True), nn.LeakyReLU(0.2, True))

    class Head(nn.Module):
        def __init__(self):
            super().__init__()
            self.cnn0 = nn.Conv2d(3, 16, 3, 2, 1)
            self.cnn1 = nn.Conv2d(16, 16, 3, 1, 1)
            self.cnn2 = nn.Conv2d(16, 16, 3, 1, 1)
            self.cnn3 = nn.ConvTranspose2d(16, 4, 4, 2, 1)
            self.relu = nn.LeakyReLU(0.2, True)

        def forward(self, x):
            x = self.relu(self.cnn0(x))
            x = self.relu(self.cnn1(x))
            x = self.relu(self.cnn2(x))
            return self.cnn3(x)

    class ResConv(nn.Module):
        def __init__(self, c, dilation=1):
            super().__init__()
            self.conv = nn.Conv2d(c, c, 3, 1, dilation, dilation=dilation, groups=1)
            self.beta = nn.Parameter(torch.ones((1, c, 1, 1)), requires_grad=True)
            self.relu = nn.LeakyReLU(0.2, True)

        def forward(self, x):
            return self.relu(self.conv(x) * self.beta + x)

    class IFBlock(nn.Module):
        def __init__(self, in_planes, c=64):
            super().__init__()
            self.conv0 = nn.Sequential(conv(in_planes, c // 2, 3, 2, 1), conv(c // 2, c, 3, 2, 1))
            self.convblock = nn.Sequential(*[ResConv(c) for _ in range(8)])
            self.lastconv = nn.Sequential(nn.ConvTranspose2d(c, 4 * 13, 4, 2, 1), nn.PixelShuffle(2))

        def forward(self, x, flow=None, scale=1):
            x = F.interpolate(x, scale_factor=1. / scale, mode="bilinear", align_corners=False)
            if flow is not None:
                flow = F.interpolate(flow, scale_factor=1. / scale, mode="bilinear", align_corners=False) * 1. / scale
                x = torch.cat((x, flow), 1)
            feat = self.convblock(self.conv0(x))
            tmp = F.interpolate(self.lastconv(feat), scale_factor=scale, mode="bilinear", align_corners=False)
            return tmp[:, :4] * scale, tmp[:, 4:5], tmp[:, 5:]

    class IFNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.block0 = IFBlock(7 + 8, c=192)
            self.block1 = IFBlock(8 + 4 + 8 + 8, c=128)
            self.block2 = IFBlock(8 + 4 + 8 + 8, c=96)
            self.block3 = IFBlock(8 + 4 + 8 + 8, c=64)
            self.block4 = IFBlock(8 + 4 + 8 + 8, c=32)
            self.encode = Head()

        def forward(self, img0, img1, timestep, scale_list):
            ts = (img0[:, :1].clone() * 0 + 1) * timestep
            f0, f1 = self.encode(img0[:, :3]), self.encode(img1[:, :3])
            w0, w1, flow, mask, feat = img0, img1, None, None, None
            for i, block in enumerate((self.block0, self.block1, self.block2, self.block3, self.block4)):
                if flow is None:
                    flow, mask, feat = block(torch.cat((img0[:, :3], img1[:, :3], f0, f1, ts), 1), None, scale=scale_list[i])
                else:
                    wf0, wf1 = warp(f0, flow[:, :2]), warp(f1, flow[:, 2:4])
                    fd, mask, feat = block(torch.cat((w0[:, :3], w1[:, :3], wf0, wf1, ts, mask, feat), 1), flow, scale=scale_list[i])
                    flow = flow + fd
                w0, w1 = warp(img0, flow[:, :2]), warp(img1, flow[:, 2:4])
            mask = torch.sigmoid(mask)
            return w0 * mask + w1 * (1 - mask)

    return IFNet


def load_rife(device="cuda", root=None):
    """The RIFE 4.25 network with its weights; raises if any of its parameters is missing from flownet.pkl."""
    import torch
    key = ("rife", str(device))
    if key in _models:
        return _models[key]
    net = _rife_class()()
    sd = torch.load(os.path.join(root or SR_DIR, RIFE_FILE), map_location="cpu", weights_only=True)
    sd = {(k[7:] if k.startswith("module.") else k): v for k, v in sd.items()}
    missing, _ = net.load_state_dict(sd, strict=False)
    if missing:
        raise RuntimeError(f"RIFE 4.25 weights lack {len(missing)} parameters, e.g. {missing[0]}")
    net.eval().to(device)
    _models[key] = net
    return net


def load_sr(name, device="cuda", root=None):
    """(descriptor, scale, half) for an upscaler by weight stem. realesr-general-x4v3 is blended with its denoise
    companion exactly as Real-ESRGAN's inference does (x4v3 * dn + wdn * (1 - dn))."""
    key = (name, str(device), DENOISE)
    if key in _models:
        return _models[key]
    import torch
    from spandrel import ModelLoader
    root = root or SR_DIR
    d = ModelLoader(device="cpu").load_from_file(os.path.join(root, name + ".pth"))
    if name == "realesr-general-x4v3" and DENOISE < 0.999:
        wdn = ModelLoader(device="cpu").load_from_file(os.path.join(root, "realesr-general-wdn-x4v3.pth"))
        a, b = d.model.state_dict(), wdn.model.state_dict()
        d.model.load_state_dict({k: (DENOISE * a[k].float() + (1 - DENOISE) * b[k].float()).to(a[k].dtype) for k in a})
    d.to(torch.device(device))
    d.eval()
    half = str(device).startswith("cuda") and bool(getattr(d, "supports_half", False))
    if half:
        d.half()
    _models[key] = (d, int(d.scale), half)
    return _models[key]


def release():
    """Hand the card back: drop the cached networks and the allocator's cache."""
    _models.clear()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def selfcheck(root=None):
    """Load every network on the CPU and run each once on a tiny input: the image build fails here, not a film."""
    import torch
    out = []
    for stem in ("realesr-general-x4v3", "realesr-animevideov3", "RealESRGAN_x2plus"):
        d, s, _ = load_sr(stem, "cpu", root)
        with torch.no_grad():
            y = d(torch.rand(1, 3, 32, 32))
        assert tuple(y.shape) == (1, 3, 32 * s, 32 * s), (stem, tuple(y.shape))
        out.append(f"{stem} x{s}")
    net = load_rife("cpu", root)
    with torch.no_grad():
        y = net(torch.rand(1, 3, 128, 128), torch.rand(1, 3, 128, 128), 0.5, [16, 8, 4, 2, 1])
    assert tuple(y.shape) == (1, 3, 128, 128), tuple(y.shape)
    out.append("RIFE 4.25")
    release()
    return "SR_OK " + ", ".join(out)


# ---- running them on a part -----------------------------------------------------------------------------------------

def _ratio(v):
    try:
        num, _, den = str(v or "").partition("/")
        r = float(num) / float(den or 1)
        return r if 1.0 <= r <= 240.0 else None
    except (ValueError, ZeroDivisionError):
        return None


def rate_of(st):
    """The frame rate the frames really come at, from an ffprobe stream entry. The timestamp map (timeline) is only
    as true as this number: r_frame_rate is the stream's base rate, and on a variable-rate clip it can say 48 or 50
    for a 24 fps picture — the part would play twice as fast and then freeze. nb_frames over the duration counts the
    frames actually there; avg_frame_rate is ffprobe's own count; r_frame_rate is the last resort."""
    try:
        n, d = int(st.get("nb_frames") or 0), float(st.get("duration") or 0)
        if n >= 3 and d > 0.1 and 1.0 <= n / d <= 240.0:
            return n / d
    except (TypeError, ValueError):
        pass
    return _ratio(st.get("avg_frame_rate")) or _ratio(st.get("r_frame_rate")) or 24.0


def probe(src):
    """(width, height, fps, matrix) of a clip's video stream. matrix is bt709 when tagged so, else bt601 (ffmpeg's
    own reading of an untagged stream), so the rgb round trip converts back with the matrix it came in with."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,color_space", "-of", "json", src],
                       capture_output=True, text=True)
    st = json.loads(r.stdout or "{}").get("streams", [{}])[0]
    return int(st["width"]), int(st["height"]), rate_of(st), ("bt709" if st.get("color_space") == "bt709" else "bt601")


def _to_tensor(raw, w, h, dev, half):
    import numpy as np
    import torch
    x = torch.from_numpy(np.frombuffer(raw, np.uint8).reshape(h, w, 3).copy()).to(dev)
    x = x.permute(2, 0, 1).unsqueeze(0)
    return (x.half() if half else x.float()) / 255.0


def _sr_frame(d, s, x, tile):
    """One frame through the upscaler, whole or in overlapping tiles."""
    import torch
    with torch.no_grad():
        if not tile:
            return d(x).clamp_(0, 1)
        _, c, h, w = x.shape
        out = x.new_zeros((1, c, h * s, w * s))
        pad = 16
        for y0 in range(0, h, tile):
            for x0 in range(0, w, tile):
                y1, x1 = min(h, y0 + tile), min(w, x0 + tile)
                ys, xs, ye, xe = max(0, y0 - pad), max(0, x0 - pad), min(h, y1 + pad), min(w, x1 + pad)
                o = d(x[:, :, ys:ye, xs:xe])
                out[:, :, y0 * s:y1 * s, x0 * s:x1 * s] = o[:, :, (y0 - ys) * s:(y1 - ys) * s, (x0 - xs) * s:(x1 - xs) * s]
        return out.clamp_(0, 1)


def _rife_frame(net, a, b, t, scale):
    """The frame at t between a and b (1x3xHxW, 0..1), padded the way Practical-RIFE pads."""
    import torch
    import torch.nn.functional as F
    _, _, h, w = a.shape
    m = max(128, int(128 / scale))
    ph, pw = ((h - 1) // m + 1) * m, ((w - 1) // m + 1) * m
    pa, pb = F.pad(a.float(), (0, pw - w, 0, ph - h)), F.pad(b.float(), (0, pw - w, 0, ph - h))
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16, enabled=a.is_cuda):
        y = net(pa, pb, float(t), [16 / scale, 8 / scale, 4 / scale, 2 / scale, 1 / scale])
    return y[:, :, :h, :w].float().clamp_(0, 1).to(a.dtype)


def _sync():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
    except Exception:
        pass


class _Frames:
    """Decoded source frames, upscaled on demand, only the current pair kept on the card."""

    def __init__(self, src, usable, sr, tile, dev, stats):
        self.w, self.h, self.fps, self.matrix = probe(src)
        self.sr, self.tile, self.dev, self.stats = sr, tile, dev, stats
        self.proc = subprocess.Popen(["ffmpeg", "-v", "error", "-t", f"{usable:.3f}", "-i", src, "-an",
                                      "-vf", f"scale=in_color_matrix={self.matrix},format=rgb24",
                                      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.cache, self.decoded, self.eof = {}, 0, False

    def _upscale(self, raw):
        import torch
        d, s, half = self.sr if self.sr else (None, 1, torch.cuda.is_available())
        x = _to_tensor(raw, self.w, self.h, self.dev, half)
        if not d:
            return x
        t0 = time.time()
        while True:
            try:
                y = _sr_frame(d, s, x, self.tile)
                break
            except Exception as e:
                if not is_oom(e) or self.tile == 256:
                    raise
                torch.cuda.empty_cache()
                self.tile = 512 if not self.tile else 256
                self.stats["tile"] = self.tile
        _sync()
        self.stats["sr_s"] += time.time() - t0
        return y

    def get(self, i):
        """Source frame i, upscaled. One frame past the end is the last frame (the hold, like tpad); more than one
        means the clip ran out before the timeline did — its frame rate is not the one it declared — and raises."""
        n = self.w * self.h * 3
        while i not in self.cache and not self.eof:
            raw = self.proc.stdout.read(n)
            if not raw or len(raw) < n:
                self.eof = True
                break
            j = self.decoded
            self.decoded += 1
            self.cache[j] = self._upscale(raw)
            for k in [k for k in self.cache if k < j - 1]:
                del self.cache[k]
        if i in self.cache:
            return self.cache[i]
        if not self.cache:
            raise RuntimeError("the clip gave no frame")
        if i > self.decoded:
            raise RuntimeError(f"the clip ran out at frame {self.decoded} where the timeline needs frame {i}: "
                               f"it is not {self.fps:.3f} fps")
        return self.cache[max(self.cache)]

    def drain(self):
        """Every source frame of the window, counted: the ones decoded plus the rest, read and dropped (no upscale)."""
        n = self.w * self.h * 3
        total = self.decoded
        while not self.eof:
            raw = self.proc.stdout.read(n)
            if not raw or len(raw) < n:
                self.eof = True
                break
            total += 1
        return total

    def close(self):
        try:
            self.proc.stdout.close()
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass
        self.proc.wait()


def enhance(src, mid, usable, stretch, want, fps, factor, look, tile=None):
    """One part: `usable` seconds of `src`, slowed by `stretch`, at `fps`, upscaled xfactor, written to `mid`
    (libx264 crf 10, SR size, min(want, usable*stretch) seconds; kleo_video's tail scales, grades and pads it).
    Returns {sr_fps, rife_fps, frames_in, frames_out, vram_peak_gb, tile}. Raises on any failure."""
    import torch
    import tempfile
    dev = torch.device("cuda")
    name = model_for(look, factor)
    sr = load_sr(name, "cuda") if name else None
    net = load_rife("cuda")
    torch.cuda.reset_peak_memory_stats()
    stats = {"sr_s": 0.0, "rife_s": 0.0, "tile": tile}
    frames = _Frames(src, usable, sr, tile, dev, stats)
    s = sr[1] if sr else 1
    sw, sh = frames.w * s, frames.h * s
    scale = 0.5 if min(sw, sh) >= 1080 else 1.0
    seconds = min(want, usable * stretch)
    n_src_est = max(1, int(round(usable * frames.fps)))
    tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] if frames.matrix == "bt709" else []
    err = tempfile.TemporaryFile()
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{sw}x{sh}", "-r", str(fps),
                            "-i", "-", "-an", "-vf", f"scale=out_color_matrix={frames.matrix}:out_range=tv,format=yuv420p", *tags,
                            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", mid], stdin=subprocess.PIPE, stderr=err)
    n_out = 0
    try:
        for i, t in timeline(frames.fps, fps, stretch, seconds, n_src=None):
            a = frames.get(i)
            if t and frames.eof and i + 1 >= frames.decoded:
                t = 0.0                                   # past the last frame: hold it, like tpad
            if t:
                b = frames.get(i + 1)
                t0 = time.time()
                y = a if b is a else _rife_frame(net, a, b, t, scale)
                _sync()
                stats["rife_s"] += time.time() - t0
            else:
                y = a
            enc.stdin.write((y[0] * 255.0).round_().clamp_(0, 255).to(torch.uint8).permute(1, 2, 0).contiguous().cpu().numpy().tobytes())
            n_out += 1
        # The map above trusted the clip's rate; the frames it really has in the window must agree with it, or the
        # part plays too fast or too slow for the same length and the checks downstream (size, rate, seconds) pass.
        frames_seen = frames.drain()
        if abs(frames_seen - n_src_est) > 2:
            raise RuntimeError(f"the clip has {frames_seen} frames in {usable:.2f} s, not the {n_src_est} of {frames.fps:.3f} fps")
        enc.stdin.close()
        rc = enc.wait()
        if rc != 0:
            err.seek(0)
            raise RuntimeError(f"the intermediate encode failed: {err.read().decode(errors='replace')[-300:]}")
    except BaseException:
        try:
            enc.kill()
        except Exception:
            pass
        raise
    finally:
        frames.close()
        err.close()
    frames_in = max(frames.decoded, 1)
    return {"sr_fps": round(frames_in / stats["sr_s"], 2) if stats["sr_s"] else None,
            "rife_fps": round(n_out / stats["rife_s"], 2) if stats["rife_s"] else None,
            "frames_in": frames.decoded, "frames_in_expected": n_src_est, "frames_seen": frames_seen, "frames_out": n_out, "size": f"{sw}x{sh}",
            "vram_peak_gb": round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2), "tile": stats["tile"]}


def benchmark(src, factor, look, n=12):
    """Seconds per frame for SR (per source frame), RIFE (per in-between) and the copy back (per output frame), on
    `n` frames of `src`, warm-up excluded. What the film-wide budget decision in kleo_video is made from."""
    import torch
    dev = torch.device("cuda")
    name = model_for(look, factor)
    sr = load_sr(name, "cuda") if name else None
    net = load_rife("cuda")
    w, h, _, matrix = probe(src)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-an", "-frames:v", str(n + 1), "-vf",
                          f"scale=in_color_matrix={matrix},format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True).stdout
    size = w * h * 3
    raws = [raw[k * size:(k + 1) * size] for k in range(len(raw) // size)]
    if len(raws) < 3:
        raise RuntimeError("the clip is too short to measure")
    stats = {"sr_s": 0.0, "rife_s": 0.0, "tile": None}
    fr = type("F", (), {})()
    fr.w, fr.h, fr.sr, fr.tile, fr.dev, fr.stats = w, h, sr, None, dev, stats
    ups = []
    for k, r in enumerate(raws):
        ups.append(_Frames._upscale(fr, r))
        if k == 0:
            stats["sr_s"] = 0.0                               # the first frame pays for cudnn's autotuning
    s = sr[1] if sr else 1
    scale = 0.5 if min(w * s, h * s) >= 1080 else 1.0
    t_rife = t_io = 0.0
    for k in range(len(ups) - 1):
        t0 = time.time()
        y = _rife_frame(net, ups[k], ups[k + 1], 0.5, scale)
        _sync()
        t1 = time.time()
        (y[0] * 255.0).round_().clamp_(0, 255).to(torch.uint8).permute(1, 2, 0).contiguous().cpu().numpy().tobytes()
        t2 = time.time()
        if k:
            t_rife += t1 - t0
            t_io += t2 - t1
    pairs = max(1, len(ups) - 2)
    return {"sr_s": stats["sr_s"] / max(1, len(ups) - 1), "rife_s": t_rife / pairs, "io_s": t_io / pairs}


# ---- the card in a child process ------------------------------------------------------------------------------------

class Overrun(RuntimeError):
    """A request to the card's child took longer than it was given; the child has been killed."""


def _pump(stream, q):
    try:
        for line in stream:
            q.put(line)
    except Exception:
        pass
    q.put(None)


class Card:
    """The GPU half of this module, in a child process (`kleo_sr.py serve`): one JSON line per request, one per
    answer, and a time limit on each. A request that overruns — a slow card, a card that throttles, a CUDA call that
    never returns — kills the child and raises Overrun; the caller's thread is free again and falls back. The next
    request starts a fresh child (models load again, on an emptied card). `lock` keeps one request on the card at a
    time; the parent never imports torch."""

    def __init__(self, argv=None):
        self.argv = argv or [sys.executable, "-u", os.path.abspath(__file__), "serve"]
        self.lock = threading.Lock()
        self.proc, self.answers = None, None

    def _start(self):
        self.proc = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.answers = queue.Queue()
        threading.Thread(target=_pump, args=(self.proc.stdout, self.answers), daemon=True).start()

    def call(self, op, timeout, **kw):
        """The child's answer to `op`, or an exception: Overrun past `timeout` seconds, RuntimeError on its error."""
        if self.proc is None or self.proc.poll() is not None:
            self._start()
        try:
            self.proc.stdin.write(json.dumps({"op": op, **kw}) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            self.kill()
            raise RuntimeError(f"the GPU process is gone ({e})")
        try:
            line = self.answers.get(timeout=max(0.01, float(timeout)))
        except queue.Empty:
            self.kill()
            raise Overrun(f"{op} took more than {timeout:.0f} s; the GPU process was killed")
        if line is None:
            self.kill()
            raise RuntimeError(f"the GPU process died during {op}")
        try:
            r = json.loads(line)
        except ValueError:
            self.kill()
            raise RuntimeError(f"the GPU process answered {line[:120]!r}")
        if not r.get("ok"):
            msg = str(r.get("error") or "unknown error")
            if r.get("oom") and not is_oom(RuntimeError(msg)):
                msg = "out of memory: " + msg
            raise RuntimeError(msg)
        return r.get("result")

    def available(self, timeout=180):
        """(ok, reason, gpu name), read by the child: the parent never opens a CUDA context of its own."""
        if os.environ.get("KLEO_SR", "auto").strip().lower() in ("off", "0", "false", "no"):
            return False, "KLEO_SR=off", None
        try:
            ok, why, name = self.call("available", timeout)
            return bool(ok), str(why), name
        except Exception as e:
            return False, f"the GPU process could not answer ({str(e)[:160]})", None

    def benchmark(self, src, factor, look, timeout=300):
        return self.call("benchmark", timeout, src=src, factor=factor, look=look)

    def enhance(self, src, mid, usable, stretch, want, fps, factor, look, tile=None, timeout=600):
        return self.call("enhance", timeout, src=src, mid=mid, usable=usable, stretch=stretch, want=want, fps=fps,
                         factor=factor, look=look, tile=tile)

    def kill(self):
        p, self.proc = self.proc, None
        if p is None:
            return
        try:
            p.kill()
        except Exception:
            pass
        try:
            p.wait(timeout=10)                    # a process stuck in the driver may never go; it is abandoned
        except Exception:
            pass

    def close(self):
        """Hand the card back: ask the child to quit, kill it if it does not."""
        p = self.proc
        if p is None:
            return
        try:
            p.stdin.write(json.dumps({"op": "quit"}) + "\n")
            p.stdin.flush()
            p.wait(timeout=20)
            self.proc = None
        except Exception:
            self.kill()


def serve():
    """The child's loop: a JSON request per line on stdin, a JSON answer per line on the real stdout. Anything else
    that writes to stdout (a library, an ffmpeg child) is sent to stderr, so the protocol line is never corrupted."""
    proto = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def _available():
        ok, why = available()
        return [ok, why, gpu_name() if ok else None]

    ops = {"available": _available, "benchmark": benchmark, "enhance": enhance, "release": release}
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        op = req.pop("op", None)
        if op == "quit":
            break
        try:
            if op not in ops:
                raise ValueError(f"unknown op {op!r}")
            proto.write(json.dumps({"ok": True, "result": ops[op](**req)}) + "\n")
        except Exception as e:
            proto.write(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"[:600], "oom": is_oom(e)}) + "\n")
    release()


if __name__ == "__main__":   # on a box: python3 kleo_sr.py fetch [dir] | check [dir] | serve (kleo_video's child)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    where = sys.argv[2] if len(sys.argv) > 2 else None
    if cmd == "serve":
        serve()
        sys.exit(0)
    if cmd == "fetch":
        print("fetched into", fetch_weights(where), flush=True)
    print(selfcheck(where) if cmd in ("check", "fetch") else available(), flush=True)
