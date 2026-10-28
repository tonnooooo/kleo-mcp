"""
The Kleo mark on a clip: the HTTP server inside the kleo-watermark Container (Dockerfile, worker.js).

  POST /mark   body: an MP4 (Content-Length or chunked). Answers the same clip with "Made with Kleo" burned in for its
               whole length, the audio copied untouched, and these headers:
                 x-mark-cpu-s   CPU seconds ffprobe + ffmpeg used (the Container bills active vCPU-seconds)
                 x-mark-wall-s  seconds from the first byte read to the answer
                 x-mark-size    the clip's width x height
  GET  /...    "ok" (the Container's readiness ping)

Where the mark goes is the rule of src/studio/watermark.ts markPlacement: change both together.
Kleo product code: it runs only in the Container and on GitHub's runners (.github/workflows/watermark.yml, from github-workflow.yml), never on
the owner's PC.
"""
import json
import os
import resource
import shutil
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "made-with-kleo.png")
MARK_W, MARK_H = 1428, 384
MARK_OPACITY = 0.9
MAX_BYTES = 400 * 1024 * 1024  # a one-minute 4K film is ~150 MB
PORT = int(os.environ.get("PORT", "8080"))


def js_round(x):
    """Math.round of JavaScript (half up; Python's round() halves to even), so both sides put the mark on the same pixel."""
    return int(x + 0.5)


def placement(w, h):
    """Size and top-left corner of the mark on a w x h frame (src/studio/watermark.ts markPlacement)."""
    if w < 64 or h < 64:
        return None
    tall = h >= w * 1.25
    margin = js_round(w * 0.04)
    room = w - 2 * margin
    width = min(room, max(96, js_round(w * (0.32 if tall else 0.22))))
    height = max(1, js_round(width * MARK_H / MARK_W))
    if height > h - 2 * margin:
        return None
    if tall:
        return width, height, margin, js_round(h * 0.08)
    return width, height, w - width - margin, h - height - margin


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True, timeout=60,
    ).stdout
    j = json.loads(out)
    s = (j.get("streams") or [{}])[0]
    return int(s.get("width") or 0), int(s.get("height") or 0), float((j.get("format") or {}).get("duration") or 0)


def mark(src, dst):
    w, h, seconds = probe(src)
    at = placement(w, h)
    if not at:
        raise ValueError(f"a {w}x{h} clip is too small for the mark")
    mw, mh, x, y = at
    # Short clips get the slower, finer encoder; an animatic of a minute must finish well inside Studio's wait.
    preset, crf = ("veryfast", "18") if seconds <= 20 else ("superfast", "19")
    graph = (
        f"[1:v]scale={mw}:{mh}:flags=lanczos,format=rgba,colorchannelmixer=aa={MARK_OPACITY}[m];"
        f"[0:v][m]overlay={x}:{y}:format=auto,format=yuv420p[v]"
    )
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src, "-i", MARK, "-filter_complex", graph,
         "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", preset, "-crf", crf, "-profile:v", "high",
         "-c:a", "copy", "-map_metadata", "0", "-movflags", "+faststart", dst],
        check=True, capture_output=True, timeout=600,
    )
    return w, h


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # one line per clip is written below; no access log
        pass

    def answer(self, status, body, ctype="text/plain", headers=None):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.answer(200, b"ok")

    def read_body(self, f):
        size = 0
        if self.headers.get("transfer-encoding", "").lower() == "chunked":
            while True:
                n = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if n == 0:
                    self.rfile.readline()
                    break
                size += n
                if size > MAX_BYTES:
                    raise ValueError("the clip is too big")
                f.write(self.rfile.read(n))
                self.rfile.readline()
            return size
        left = int(self.headers.get("content-length") or 0)
        if left <= 0 or left > MAX_BYTES:
            raise ValueError("a clip of 1 byte to 400 MB is expected")
        while left:
            chunk = self.rfile.read(min(left, 1 << 20))
            if not chunk:
                raise ValueError("the clip ended early")
            f.write(chunk)
            left -= len(chunk)
            size += len(chunk)
        return size

    def do_POST(self):
        if self.path.split("?")[0] != "/mark":
            return self.answer(404, b"not found")
        work = tempfile.mkdtemp(prefix="mark-")
        start = time.monotonic()
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        try:
            src, dst = os.path.join(work, "in.mp4"), os.path.join(work, "out.mp4")
            with open(src, "wb") as f:
                size_in = self.read_body(f)
            try:
                w, h = mark(src, dst)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as e:
                said = getattr(e, "stderr", b"") or str(e).encode()
                return self.answer(422, said[-400:] if isinstance(said, bytes) else str(said).encode()[-400:])
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu = (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)
            wall = time.monotonic() - start
            size_out = os.path.getsize(dst)
            print(json.dumps({"clip": f"{w}x{h}", "in": size_in, "out": size_out, "cpu_s": round_s(cpu), "wall_s": round_s(wall)}), flush=True)
            self.send_response(200)
            self.send_header("content-type", "video/mp4")
            self.send_header("content-length", str(size_out))
            self.send_header("x-mark-cpu-s", f"{cpu:.2f}")
            self.send_header("x-mark-wall-s", f"{wall:.2f}")
            self.send_header("x-mark-size", f"{w}x{h}")
            self.end_headers()
            with open(dst, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 1 << 20)
        except ValueError as e:
            self.answer(400, str(e).encode())
        finally:
            shutil.rmtree(work, ignore_errors=True)


def round_s(x):
    return float(f"{x:.2f}")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
