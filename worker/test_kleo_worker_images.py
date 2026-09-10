#!/usr/bin/env python3
"""
Unit tests for the Kleo picture handling in kleo_worker.py: no engine, no rendering, no network beyond 127.0.0.1.
A tiny http.server plays the Kleo API (POST /internal/jobs/:id/images, POST .../progress) and the signed /dl route
(a real PNG, a JPEG, a 404 and an HTML page). The worker must download the pictures into <project>/img/<sceneId>.<ext>,
set scene.image, strip kleo_style / image_prompt, leave broken scenes without picture, and write a project.json the
engine's own contract.validate() accepts (only contract.py is imported from the engine; run.py is never executed).
Run: python3 worker/test_kleo_worker_images.py -v      (wrapped for `node --test` by test/worker-images.test.mjs)
"""
import copy, importlib.util, json, os, shutil, struct, tempfile, threading, unittest, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENGINE = os.path.join(HERE, "keou")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "cartoon-pirates.json")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kw = load_module("kleo_worker_under_test", os.path.join(HERE, "kleo_worker.py"))
contract = load_module("keou_contract_under_test", os.path.join(ENGINE, "contract.py"))


def tiny_png(w=4, h=4, rgb=(200, 80, 40)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG = tiny_png()
JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(64) + b"\xff\xd9"
IDS = ["01-hook", "02-ship", "03-storm", "04-treasure", "05-closing"]


def storyboard(style="cartoon"):
    """A minimal cinema storyboard in the Kleo shape: 4 cinema scenes + closing, an image_prompt on every scene."""
    voices = ["Captain Mara buried her treasure on Skull Beach.", "Her ship was the fastest in the Caribbean.",
              "Then came the storm.", "The boy kept the map his whole life.", "Is the treasure still there? Follow for part two."]
    scenes = []
    for i, (sid, v) in enumerate(zip(IDS, voices)):
        scenes.append({"id": sid, "kind": "closing" if i == 4 else "cinema", "chapter": f"0{i + 1} PART", "accent": "amber",
                       "title": f"part {i + 1}", "voice": v, "beats": [{"kind": "icon", "name": "wave"}],
                       "image_prompt": f"picture for scene {i + 1}", "hold": 0.2})
    return {"schema_version": 1, "editorial_status": "ready", "title": "Pirates test", "brand": "Kleo", "style": "cinema",
            "format": "9:16", "language": "en", "voice": "am_michael", "kleo_style": style, "scenes": scenes}


def job_for(sb):
    return {"job_id": "j1", "template": "did-you-know", "prompt": "Pirates", "brand": "Kleo",
            "params": {"format": "9:16", "language": "en", "duration_s": 45}, "storyboard": sb}


class FakeKleo(BaseHTTPRequestHandler):
    """Records every request. `images_replies` is a list of (status, body) consumed in order by POST .../images."""
    state = None

    def log_message(self, *a):
        pass

    def _send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        st = FakeKleo.state
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        st["requests"].append(("POST", self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        if self.path.endswith("/progress"):
            st["progress"].append(json.loads(body or b"{}"))
            return self._send(200, b'{"ok":true}')
        if self.path.endswith("/images"):
            if not st["images_replies"]:
                return self._send(500, b'{"error":"no scripted reply"}')
            status, reply = st["images_replies"].pop(0)
            return self._send(status, reply if isinstance(reply, bytes) else json.dumps(reply).encode())
        self._send(404, b'{"error":"not found"}')

    def do_GET(self):
        st = FakeKleo.state
        st["requests"].append(("GET", self.path, {k.lower(): v for k, v in self.headers.items()}, b""))
        path = self.path.split("?")[0]
        if path.endswith("/img/01-hook.png"):
            return self._send(200, PNG, "image/png")
        if path.endswith("/img/02-ship.jpg"):
            return self._send(200, JPG, "image/jpeg")
        if path.endswith("/img/04-treasure.png"):  # an expired link answering HTML: must not become a picture
            return self._send(200, b"<html>This link has expired.</html>", "text/html")
        self._send(404, b"Not found", "text/plain")


class PicturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeKleo)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        kw.API, kw.JOB, kw.SECRET, kw.IMAGES_RETRY_WAIT_S = cls.base, "j1", "wk_test", 0

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeKleo.state = {"requests": [], "images_replies": [], "progress": []}
        self.tmp = tempfile.mkdtemp(prefix="kleo-img-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def dl(self, name):
        return f"{self.base}/dl/j1/img/{name}?exp=9999999999&sig=abc"

    def images(self):
        return {"01-hook": self.dl("01-hook.png"), "02-ship": self.dl("02-ship.jpg"),
                "03-storm": self.dl("03-storm.png"), "04-treasure": self.dl("04-treasure.png")}

    def posts(self, suffix):
        return [r for r in FakeKleo.state["requests"] if r[0] == "POST" and r[1].endswith(suffix)]

    # -- download + placement ------------------------------------------------------------------
    def test_attach_pictures_downloads_and_places(self):
        project = storyboard()
        ready, missing = kw.attach_pictures(project, self.tmp, {"images": self.images(), "missing": ["05-closing"]})
        self.assertEqual(ready, ["01-hook", "02-ship"])
        self.assertEqual(missing, ["03-storm", "04-treasure", "05-closing"])
        s = {sc["id"]: sc for sc in project["scenes"]}
        self.assertEqual(s["01-hook"]["image"], "img/01-hook.png")
        self.assertEqual(s["02-ship"]["image"], "img/02-ship.jpg")
        for sid in ("03-storm", "04-treasure", "05-closing"):
            self.assertNotIn("image", s[sid], sid)
        with open(os.path.join(self.tmp, "img", "01-hook.png"), "rb") as f:
            self.assertEqual(f.read(), PNG)
        with open(os.path.join(self.tmp, "img", "02-ship.jpg"), "rb") as f:
            self.assertTrue(f.read().startswith(b"\xff\xd8\xff"))
        self.assertEqual(sorted(os.listdir(os.path.join(self.tmp, "img"))), ["01-hook.png", "02-ship.jpg"])
        gets = [r for r in FakeKleo.state["requests"] if r[0] == "GET"]
        self.assertEqual(len(gets), 4)
        for _, _, headers, _ in gets:
            self.assertEqual(headers.get("user-agent"), kw.UA)
            self.assertNotIn("authorization", headers, "signed links carry no bearer")

    def test_attach_pictures_tolerates_empty_or_absent_reply(self):
        project = storyboard()
        self.assertEqual(kw.attach_pictures(project, self.tmp, {"images": {}, "missing": IDS}), ([], IDS))
        self.assertEqual(kw.attach_pictures(project, self.tmp, None), ([], IDS))
        self.assertFalse(any("image" in s for s in project["scenes"]))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "img")))

    def test_download_picture_rejects_bad_ids_and_links(self):
        self.assertIsNone(kw.download_picture(self.dl("01-hook.png"), self.tmp, "../etc"))
        self.assertIsNone(kw.download_picture(self.dl("01-hook.png"), self.tmp, "Bad Id"))
        self.assertIsNone(kw.download_picture("file:///etc/passwd", self.tmp, "01-hook"))
        self.assertIsNone(kw.download_picture(None, self.tmp, "01-hook"))
        self.assertIsNone(kw.download_picture(f"http://127.0.0.1:9/never", self.tmp, "01-hook"))
        self.assertEqual(kw.download_picture(self.dl("01-hook.png"), self.tmp, "01-hook"), "01-hook.png")
        self.assertEqual(kw.image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "), ".webp")
        self.assertIsNone(kw.image_ext(b"<svg/>"))

    def test_strip_kleo_fields(self):
        project = storyboard()
        project["scenes"][0]["image"] = "img/01-hook.png"
        kw.strip_kleo_fields(project)
        self.assertNotIn("kleo_style", project)
        self.assertFalse(any("image_prompt" in s for s in project["scenes"]))
        self.assertEqual(project["scenes"][0]["image"], "img/01-hook.png")

    def test_wants_pictures(self):
        self.assertTrue(kw.wants_pictures(storyboard("cartoon")))
        self.assertTrue(kw.wants_pictures(storyboard("realistic")))
        self.assertFalse(kw.wants_pictures(storyboard("cyber")))
        self.assertFalse(kw.wants_pictures(storyboard("stickman")))
        sb = storyboard()
        del sb["kleo_style"]
        self.assertFalse(kw.wants_pictures(sb), "no kleo_style means the plain Keou look")
        sb = storyboard()
        for s in sb["scenes"]:
            s.pop("image_prompt")
        self.assertFalse(kw.wants_pictures(sb))
        self.assertEqual(kw.picture_scene_ids(storyboard()), IDS)

    # -- the images call -------------------------------------------------------------------------
    def test_fetch_pictures_retries_once_after_5xx(self):
        FakeKleo.state["images_replies"] = [(503, {"error": "ai busy"}), (200, {"images": self.images(), "missing": ["05-closing"]})]
        reply = kw.fetch_pictures("j1")
        self.assertEqual(reply, {"images": self.images(), "missing": ["05-closing"]})
        posts = self.posts("/internal/jobs/j1/images")
        self.assertEqual(len(posts), 2)
        for _, _, headers, body in posts:
            self.assertEqual(headers.get("authorization"), "Bearer wk_test")
            self.assertEqual(headers.get("user-agent"), kw.UA)
            self.assertEqual(body, b"", "empty body")

    def test_fetch_pictures_retries_garbled_reply(self):
        FakeKleo.state["images_replies"] = [(200, b"<html>cloudflare</html>"), (200, {"images": {}, "missing": []})]
        self.assertEqual(kw.fetch_pictures("j1"), {"images": {}, "missing": []})
        self.assertEqual(len(self.posts("/images")), 2)

    def test_fetch_pictures_4xx_is_final(self):
        FakeKleo.state["images_replies"] = [(404, {"error": "not found"})]
        self.assertIsNone(kw.fetch_pictures("j1"))
        self.assertEqual(len(self.posts("/images")), 1)

    def test_fetch_pictures_gives_up_after_the_second_failure(self):
        FakeKleo.state["images_replies"] = [(500, {"error": "a"}), (502, {"error": "b"})]
        self.assertIsNone(kw.fetch_pictures("j1"))
        self.assertEqual(len(self.posts("/images")), 2)

    def test_fetch_pictures_network_error(self):
        api = kw.API
        kw.API = "http://127.0.0.1:9"  # nothing listens there: connection refused, twice
        try:
            self.assertIsNone(kw.fetch_pictures("j1"))
        finally:
            kw.API = api

    def test_fetch_pictures_normalises_odd_shapes(self):
        FakeKleo.state["images_replies"] = [(200, {"images": ["not", "a", "map"], "missing": "nope"})]
        self.assertEqual(kw.fetch_pictures("j1"), {"images": {}, "missing": []})

    # -- the whole preparation, exactly what render_keou runs before the engine -------------------
    def test_prepare_project_writes_pictures_into_the_project(self):
        FakeKleo.state["images_replies"] = [(200, {"images": self.images(), "missing": ["05-closing"]})]
        project, pdir = kw.prepare_project(job_for(storyboard()), ENGINE, self.tmp)
        self.assertEqual(pdir, os.path.join(self.tmp, "j1"))
        pj = os.path.join(pdir, "project.json")
        with open(pj) as f:
            written = json.load(f)
        self.assertEqual(written, project)
        self.assertNotIn("kleo_style", written)
        self.assertFalse(any("image_prompt" in s for s in written["scenes"]))
        s = {sc["id"]: sc for sc in written["scenes"]}
        self.assertEqual(s["01-hook"]["image"], "img/01-hook.png")
        self.assertEqual(s["02-ship"]["image"], "img/02-ship.jpg")
        for sid in ("03-storm", "04-treasure", "05-closing"):
            self.assertNotIn("image", s[sid])
        self.assertTrue(os.path.isfile(os.path.join(pdir, "img", "01-hook.png")))
        self.assertTrue(os.path.isfile(os.path.join(pdir, "img", "02-ship.jpg")))
        self.assertIn("2 pictures ready, 3 missing", [p.get("message") for p in FakeKleo.state["progress"]])
        self.assertEqual(len(self.posts("/images")), 1)
        contract.validate(pj)  # the engine's own validator: image paths resolve inside the project, everything else intact

    def test_prepare_project_without_any_picture(self):
        FakeKleo.state["images_replies"] = [(500, {"error": "a"}), (500, {"error": "b"})]
        project, pdir = kw.prepare_project(job_for(storyboard()), ENGINE, self.tmp)
        self.assertFalse(any("image" in s or "image_prompt" in s for s in project["scenes"]))
        self.assertIn("0 pictures ready, 5 missing", [p.get("message") for p in FakeKleo.state["progress"]])
        contract.validate(os.path.join(pdir, "project.json"))

    def test_prepare_project_cyber_never_asks_for_pictures(self):
        project, pdir = kw.prepare_project(job_for(storyboard("cyber")), ENGINE, self.tmp)
        self.assertEqual(self.posts("/images"), [])
        self.assertNotIn("kleo_style", project)
        self.assertFalse(any("image_prompt" in s or "image" in s for s in project["scenes"]))
        contract.validate(os.path.join(pdir, "project.json"))

    def test_build_project_drops_a_client_supplied_image(self):
        sb = storyboard()
        sb["scenes"][0]["image"] = "../../etc/passwd"
        project = kw.build_project(job_for(sb), ENGINE)
        self.assertNotIn("image", project["scenes"][0])
        self.assertEqual(project["kleo_style"], "cartoon", "kept until prepare_project strips it")
        self.assertEqual(project["scenes"][0]["image_prompt"], "picture for scene 1")

    def test_fixture_cartoon_pirates_prepares_and_validates(self):
        with open(FIXTURE) as f:
            sb = json.load(f)
        self.assertEqual(sb["kleo_style"], "cartoon")
        self.assertTrue(kw.wants_pictures(sb))
        self.assertEqual(kw.picture_scene_ids(sb), [s["id"] for s in sb["scenes"]], "a prompt on every scene")
        self.assertTrue(all(len(s["image_prompt"]) <= 240 for s in sb["scenes"]))
        FakeKleo.state["images_replies"] = [(200, {"images": self.images(), "missing": ["05-closing"]})]
        project, pdir = kw.prepare_project(job_for(copy.deepcopy(sb)), ENGINE, self.tmp)
        self.assertEqual([s.get("image") for s in project["scenes"]], ["img/01-hook.png", "img/02-ship.jpg", None, None, None])
        contract.validate(os.path.join(pdir, "project.json"))


if __name__ == "__main__":
    unittest.main()
