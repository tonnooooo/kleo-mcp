#!/usr/bin/env python3
"""
Unit tests for the Kleo picture handling in kleo_worker.py: no engine, no rendering, no network beyond 127.0.0.1.
A tiny http.server plays the Kleo API (POST /internal/jobs/:id/images, POST .../progress) and the signed /dl route
(a real PNG, a JPEG, a 404 and an HTML page). Pictures are shots (docs/PICTURE-STYLE.md): one picture per shot, id
`<sceneId>-s<n>`. The worker must download them into <project>/img/<pictureId>.<ext>, set shot.image (and scene.image
= the scene's first picture), strip kleo_style / every image_prompt, write the engine's top-level `look`, leave broken
shots without picture, and write a project.json the engine's own contract.validate() accepts (only contract.py is
imported from the engine; run.py is never executed).
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
# The engine side of docs/PICTURE-STYLE.md lands separately; until contract.py knows the style, picture projects are
# checked by this file only (the cyber/cinema projects still go through the engine's validator on every run).
ENGINE_KNOWS_PICTURE = "picture" in getattr(contract, "STYLES", set())


def tiny_png(w=4, h=4, rgb=(200, 80, 40)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG = tiny_png()
JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(64) + b"\xff\xd9"
IDS = ["01-hook", "02-ship", "03-storm", "04-treasure", "05-closing"]
SHOTS = {"01-hook": 2, "02-ship": 2, "03-storm": 1, "04-treasure": 1, "05-closing": 1}  # 7 pictures over 5 scenes
PICTURES = ["01-hook-s1", "01-hook-s2", "02-ship-s1", "02-ship-s2", "03-storm-s1", "04-treasure-s1", "05-closing-s1"]
VOICES = ["Captain Mara buried her treasure on Skull Beach.", "Her ship was the fastest in the Caribbean.",
          "Then came the storm.", "The boy kept the map his whole life.", "Is the treasure still there? Follow for part two."]


def storyboard(style="cartoon"):
    """cartoon / realistic: the picture style (shots, no beats). cyber / stickman: the cinema shape with beats and a
    legacy scene-level image_prompt, which the worker must ignore entirely."""
    picture = style in ("cartoon", "realistic")
    scenes = []
    for i, (sid, v) in enumerate(zip(IDS, VOICES)):
        s = {"id": sid, "kind": "closing" if i == 4 else "cinema", "chapter": f"0{i + 1} PART", "accent": "amber",
             "title": f"part {i + 1}", "voice": v, "hold": 0.2}
        if picture:
            s["shots"] = [{"image_prompt": f"picture for {sid} shot {n + 1}", "caption": f"PART {i + 1}"}
                          for n in range(SHOTS[sid])]
        else:
            s["beats"] = [{"kind": "icon", "name": "wave"}]
            s["image_prompt"] = f"picture for scene {i + 1}"
        scenes.append(s)
    return {"schema_version": 1, "editorial_status": "ready", "title": "Pirates test", "brand": "Kleo",
            "style": "picture" if picture else "cinema", "format": "9:16", "language": "en", "voice": "am_michael",
            "kleo_style": style, "scenes": scenes}


def legacy_storyboard(style="cartoon"):
    """The pre-shots format: one image_prompt on the scene, no shots. The server normalises it away before storing,
    but the worker stays lenient and treats it as the scene's shot 1."""
    sb = storyboard(style)
    for i, s in enumerate(sb["scenes"]):
        s.pop("shots", None)
        s["image_prompt"] = f"picture for scene {i + 1}"
    return sb


def job_for(sb):
    return {"job_id": "j1", "template": "did-you-know", "prompt": "Pirates", "brand": "Kleo",
            "params": {"format": "9:16", "language": "en", "duration_s": 45}, "storyboard": sb}


def expected_pictures(sb):
    """The picture ids a storyboard must produce, read off the storyboard itself (shots, or the legacy scene prompt)."""
    out = []
    for s in sb["scenes"]:
        shots = s.get("shots") or ([{"image_prompt": s["image_prompt"]} for _ in (1,)] if s.get("image_prompt") else [])
        out += [f"{s['id']}-s{n + 1}" for n, sh in enumerate(shots) if (sh.get("image_prompt") or "").strip()]
    return out


class FakeKleo(BaseHTTPRequestHandler):
    """Records every request. `images_replies` is a list of (status, body) consumed in order by POST .../images."""
    state = None
    # what the signed /dl route serves, by file name: two good pictures, one expired link answering HTML, the rest 404
    routes = {"01-hook-s1.png": (200, PNG, "image/png"), "01-hook-s2.jpg": (200, JPG, "image/jpeg"),
              "02-ship-s2.png": (200, PNG, "image/png"),
              "03-storm-s1.png": (200, b"<html>This link has expired.</html>", "text/html")}

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
        route = FakeKleo.routes.get(self.path.split("?")[0].rsplit("/", 1)[-1])
        if route:
            return self._send(*route)
        self._send(404, b"Not found", "text/plain")


class PicturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeKleo)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        kw.API, kw.JOB, kw.SECRET, kw.IMAGES_RETRY_WAIT_S = cls.base, "j1", "wk_test", 0
        # These tests describe what the SERVER delivers, so the local GPU path must stay out of the way: on a machine
        # that really has CUDA and diffusers (the Vast dev box runs the worker image) "auto" would draw the missing
        # pictures for real and every "missing" assertion would flip. PolicyTest covers the local path with fakes.
        cls.saved_policy = kw.PICTURES_POLICY
        kw.PICTURES_POLICY = "server"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        kw.PICTURES_POLICY = cls.saved_policy

    def setUp(self):
        FakeKleo.state = {"requests": [], "images_replies": [], "progress": []}
        self.tmp = tempfile.mkdtemp(prefix="kleo-img-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def dl(self, name):
        return f"{self.base}/dl/j1/img/{name}?exp=9999999999&sig=abc"

    def images(self):
        """The server's answer: five links (two of them broken), 04-treasure-s1 and 05-closing-s1 left to the worker."""
        return {"01-hook-s1": self.dl("01-hook-s1.png"), "01-hook-s2": self.dl("01-hook-s2.jpg"),
                "02-ship-s1": self.dl("02-ship-s1.png"), "02-ship-s2": self.dl("02-ship-s2.png"),
                "03-storm-s1": self.dl("03-storm-s1.png")}

    def reply(self):
        return {"images": self.images(), "missing": ["04-treasure-s1", "05-closing-s1"]}

    def posts(self, suffix):
        return [r for r in FakeKleo.state["requests"] if r[0] == "POST" and r[1].endswith(suffix)]

    def shot_images(self, project):
        """picture id → the image path on its shot (or on the scene, for a legacy scene-level picture)."""
        out = {}
        for s in project["scenes"]:
            shots = s.get("shots") or []
            for n, sh in enumerate(shots):
                out[f"{s['id']}-s{n + 1}"] = sh.get("image")
            if not shots:
                out[f"{s['id']}-s1"] = s.get("image")
        return out

    def scene_images(self, project):
        return {s["id"]: s.get("image") for s in project["scenes"]}

    def validate_engine(self, project_json):
        """The engine's own validator, whenever it already knows the style of what we wrote."""
        with open(project_json) as f:
            written = json.load(f)
        if written.get("style") == "picture" and not ENGINE_KNOWS_PICTURE:
            return None
        return contract.validate(project_json)

    # -- picture units (shots) -----------------------------------------------------------------
    def test_picture_units_are_shots_in_scene_order(self):
        sb = storyboard()
        units = kw.picture_units(sb)
        self.assertEqual([u["id"] for u in units], PICTURES)
        self.assertEqual(kw.picture_ids(sb), PICTURES)
        self.assertEqual([u["image_prompt"] for u in units[:3]],
                         ["picture for 01-hook shot 1", "picture for 01-hook shot 2", "picture for 02-ship shot 1"])
        for u in units:  # every unit points at the live scene / shot objects, so attaching writes into the storyboard
            self.assertIs(u["scene"], next(s for s in sb["scenes"] if s["id"] == u["id"].rsplit("-s", 1)[0]))
            self.assertIs(u["shot"], u["scene"]["shots"][int(u["id"].rsplit("-s", 1)[1]) - 1])

    def test_picture_units_fall_back_to_a_scene_level_prompt(self):
        sb = legacy_storyboard()
        units = kw.picture_units(sb)
        self.assertEqual([u["id"] for u in units], [f"{sid}-s1" for sid in IDS], "a scene prompt is that scene's shot 1")
        self.assertTrue(all(u["shot"] is None for u in units))
        self.assertEqual(units[0]["image_prompt"], "picture for scene 1")
        sb["scenes"][0]["shots"] = [{"image_prompt": "the real shot"}]  # shots win over the legacy prompt
        self.assertEqual(kw.picture_units(sb)[0]["image_prompt"], "the real shot")
        self.assertEqual(kw.picture_ids(sb), ["01-hook-s1"] + [f"{sid}-s1" for sid in IDS[1:]])

    def test_picture_units_skip_malformed_entries(self):
        sb = {"scenes": [
            {"id": "Bad Id", "kind": "cinema", "shots": [{"image_prompt": "no"}]},
            {"id": "../etc", "kind": "cinema", "shots": [{"image_prompt": "no"}]},
            {"id": 7, "kind": "cinema", "shots": [{"image_prompt": "no"}]},
            {"id": "a" * 51, "kind": "cinema", "shots": [{"image_prompt": "too long a slug"}]},
            "not a scene",
            {"id": "ok-scene", "kind": "cinema", "shots": ["nope", {}, {"image_prompt": "   "}, {"image_prompt": "yes"},
                                                          {"image_prompt": "also yes"}]},
            {"id": "no-prompt", "kind": "cinema", "shots": [{"caption": "HELLO"}]},
            {"id": "empty-shots", "kind": "cinema", "shots": [], "image_prompt": "legacy still counts"},
        ]}
        self.assertEqual(kw.picture_ids(sb), ["ok-scene-s4", "ok-scene-s5", "empty-shots-s1"])
        self.assertEqual(kw.picture_ids({}), [])
        self.assertEqual(kw.picture_ids({"scenes": "nope"}), [])
        long_scene = "a" * 50  # 50-char slug + "-s4" = a legal picture id and a legal file name
        self.assertEqual(kw.picture_ids({"scenes": [{"id": long_scene, "kind": "cinema",
                                                     "shots": [{"image_prompt": "x"}] * 4}]})[3], long_scene + "-s4")

    def test_picture_units_ignore_a_duplicate_id(self):
        sb = {"scenes": [{"id": "twice", "kind": "cinema", "shots": [{"image_prompt": "a"}]},
                         {"id": "twice", "kind": "cinema", "shots": [{"image_prompt": "b"}]}]}
        self.assertEqual(kw.picture_ids(sb), ["twice-s1"], "two files would collide")

    # -- download + placement ------------------------------------------------------------------
    def test_attach_pictures_downloads_and_places(self):
        project = storyboard()
        ready, missing = kw.attach_pictures(project, self.tmp, self.reply())
        self.assertEqual(ready, ["01-hook-s1", "01-hook-s2", "02-ship-s2"])
        self.assertEqual(missing, ["02-ship-s1", "03-storm-s1", "04-treasure-s1", "05-closing-s1"])
        self.assertEqual(self.shot_images(project),
                         {"01-hook-s1": "img/01-hook-s1.png", "01-hook-s2": "img/01-hook-s2.jpg", "02-ship-s1": None,
                          "02-ship-s2": "img/02-ship-s2.png", "03-storm-s1": None, "04-treasure-s1": None,
                          "05-closing-s1": None})
        self.assertEqual(self.scene_images(project),  # the scene keeps its first shot picture
                         {"01-hook": "img/01-hook-s1.png", "02-ship": "img/02-ship-s2.png", "03-storm": None,
                          "04-treasure": None, "05-closing": None})
        with open(os.path.join(self.tmp, "img", "01-hook-s1.png"), "rb") as f:
            self.assertEqual(f.read(), PNG)
        with open(os.path.join(self.tmp, "img", "01-hook-s2.jpg"), "rb") as f:
            self.assertTrue(f.read().startswith(b"\xff\xd8\xff"))
        self.assertEqual(sorted(os.listdir(os.path.join(self.tmp, "img"))),
                         ["01-hook-s1.png", "01-hook-s2.jpg", "02-ship-s2.png"])
        gets = [r for r in FakeKleo.state["requests"] if r[0] == "GET"]
        self.assertEqual(len(gets), 5, "one GET per link the server handed out")
        for _, _, headers, _ in gets:
            self.assertEqual(headers.get("user-agent"), kw.UA)
            self.assertNotIn("authorization", headers, "signed links carry no bearer")

    def test_attach_pictures_places_a_legacy_picture_on_the_scene(self):
        project = legacy_storyboard()
        ready, missing = kw.attach_pictures(project, self.tmp, {"images": {"01-hook-s1": self.dl("01-hook-s1.png")},
                                                               "missing": [f"{sid}-s1" for sid in IDS[1:]]})
        self.assertEqual(ready, ["01-hook-s1"])
        self.assertEqual(missing, [f"{sid}-s1" for sid in IDS[1:]])
        self.assertEqual(project["scenes"][0]["image"], "img/01-hook-s1.png", "no shot to hold it: it goes on the scene")
        self.assertNotIn("shots", project["scenes"][0])
        self.assertFalse(any("image" in s for s in project["scenes"][1:]))

    def test_attach_pictures_tolerates_empty_or_absent_reply(self):
        project = storyboard()
        self.assertEqual(kw.attach_pictures(project, self.tmp, {"images": {}, "missing": PICTURES}), ([], PICTURES))
        self.assertEqual(kw.attach_pictures(project, self.tmp, None), ([], PICTURES))
        self.assertFalse(any("image" in s for s in project["scenes"]))
        self.assertFalse(any("image" in sh for s in project["scenes"] for sh in s["shots"]))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "img")))

    def test_attach_pictures_refuses_a_scene_kind_without_pictures(self):
        project = storyboard()
        project["scenes"][0]["kind"] = "metric"
        ready, missing = kw.attach_pictures(project, self.tmp, self.reply())
        self.assertEqual(ready, ["02-ship-s2"])
        self.assertIn("01-hook-s1", missing)
        self.assertFalse(any("image" in sh for sh in project["scenes"][0]["shots"]))

    def test_download_picture_rejects_bad_ids_and_links(self):
        self.assertIsNone(kw.download_picture(self.dl("01-hook-s1.png"), self.tmp, "../etc"))
        self.assertIsNone(kw.download_picture(self.dl("01-hook-s1.png"), self.tmp, "Bad Id"))
        self.assertIsNone(kw.download_picture("file:///etc/passwd", self.tmp, "01-hook-s1"))
        self.assertIsNone(kw.download_picture(None, self.tmp, "01-hook-s1"))
        self.assertIsNone(kw.download_picture(f"http://127.0.0.1:9/never", self.tmp, "01-hook-s1"))
        self.assertEqual(kw.download_picture(self.dl("01-hook-s1.png"), self.tmp, "01-hook-s1"), "01-hook-s1.png")
        self.assertEqual(kw.image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "), ".webp")
        self.assertIsNone(kw.image_ext(b"<svg/>"))

    # -- stripping and the engine's `look` -------------------------------------------------------
    def test_strip_kleo_fields_writes_look_for_the_picture_style(self):
        for style in ("cartoon", "realistic"):
            project = storyboard(style)
            project["scenes"][0]["shots"][0]["image"] = "img/01-hook-s1.png"
            project["scenes"][0]["image"] = "img/01-hook-s1.png"
            kw.strip_kleo_fields(project)
            self.assertEqual(project["look"], style)
            self.assertNotIn("kleo_style", project)
            self.assertFalse(any("image_prompt" in s for s in project["scenes"]))
            self.assertFalse(any("image_prompt" in sh for s in project["scenes"] for sh in s["shots"]))
            self.assertEqual(project["scenes"][0]["shots"][0]["image"], "img/01-hook-s1.png")
            self.assertEqual(project["scenes"][0]["image"], "img/01-hook-s1.png")
            self.assertEqual(project["scenes"][0]["shots"][0]["caption"], "PART 1", "the rest of the shot is untouched")

    def test_strip_kleo_fields_never_writes_look_for_cyber_or_stickman(self):
        for style in ("cyber", "stickman"):
            project = storyboard(style)
            project["look"] = "cartoon"  # a client cannot smuggle one in either
            kw.strip_kleo_fields(project)
            self.assertNotIn("look", project)
            self.assertNotIn("kleo_style", project)
            self.assertFalse(any("image_prompt" in s for s in project["scenes"]))

    def test_strip_kleo_fields_leaves_a_legacy_cinema_project_without_look(self):
        project = legacy_storyboard()
        project["style"] = "cinema"  # cartoon on a non-picture style: the engine would refuse a look there
        kw.strip_kleo_fields(project)
        self.assertNotIn("look", project)
        self.assertNotIn("kleo_style", project)

    def test_wants_pictures(self):
        self.assertTrue(kw.wants_pictures(storyboard("cartoon")))
        self.assertTrue(kw.wants_pictures(storyboard("realistic")))
        self.assertTrue(kw.wants_pictures(legacy_storyboard("cartoon")))
        self.assertFalse(kw.wants_pictures(storyboard("cyber")))
        self.assertFalse(kw.wants_pictures(storyboard("stickman")))
        sb = storyboard()
        del sb["kleo_style"]
        self.assertFalse(kw.wants_pictures(sb), "no kleo_style means the plain Keou look")
        sb = storyboard()
        for s in sb["scenes"]:
            s["shots"] = [{"caption": "NO PROMPT"}]
        self.assertFalse(kw.wants_pictures(sb))

    # -- the images call -------------------------------------------------------------------------
    def test_fetch_pictures_retries_once_after_5xx(self):
        FakeKleo.state["images_replies"] = [(503, {"error": "ai busy"}), (200, self.reply())]
        self.assertEqual(kw.fetch_pictures("j1"), self.reply())
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
        FakeKleo.state["images_replies"] = [(200, self.reply())]
        project, pdir = kw.prepare_project(job_for(storyboard()), ENGINE, self.tmp)
        self.assertEqual(pdir, os.path.join(self.tmp, "j1"))
        pj = os.path.join(pdir, "project.json")
        with open(pj) as f:
            written = json.load(f)
        self.assertEqual(written, project)
        self.assertEqual(written["look"], "cartoon")
        self.assertNotIn("kleo_style", written)
        self.assertFalse(any("image_prompt" in s for s in written["scenes"]))
        self.assertFalse(any("image_prompt" in sh for s in written["scenes"] for sh in s["shots"]))
        shots = {s["id"]: [sh.get("image") for sh in s["shots"]] for s in written["scenes"]}
        self.assertEqual(shots, {"01-hook": ["img/01-hook-s1.png", "img/01-hook-s2.jpg"],
                                 "02-ship": [None, "img/02-ship-s2.png"], "03-storm": [None],
                                 "04-treasure": [None], "05-closing": [None]})
        self.assertEqual(self.scene_images(written), {"01-hook": "img/01-hook-s1.png", "02-ship": "img/02-ship-s2.png",
                                                      "03-storm": None, "04-treasure": None, "05-closing": None})
        for name in ("01-hook-s1.png", "01-hook-s2.jpg", "02-ship-s2.png"):
            self.assertTrue(os.path.isfile(os.path.join(pdir, "img", name)), name)
        self.assertIn("3 pictures from server, 0 generated on the GPU, 4 missing",
                      [p.get("message") for p in FakeKleo.state["progress"]])
        self.assertEqual(len(self.posts("/images")), 1)
        self.validate_engine(pj)  # image paths resolve inside the project, everything else intact

    def test_prepare_project_without_any_picture(self):
        FakeKleo.state["images_replies"] = [(500, {"error": "a"}), (500, {"error": "b"})]
        project, pdir = kw.prepare_project(job_for(storyboard()), ENGINE, self.tmp)
        self.assertEqual(project["look"], "cartoon", "the look does not depend on the pictures")
        self.assertFalse(any("image" in s or "image_prompt" in s for s in project["scenes"]))
        self.assertFalse(any("image" in sh for s in project["scenes"] for sh in s["shots"]))
        self.assertIn("0 pictures from server, 0 generated on the GPU, 7 missing",
                      [p.get("message") for p in FakeKleo.state["progress"]])
        self.validate_engine(os.path.join(pdir, "project.json"))

    def test_prepare_project_cyber_never_asks_for_pictures(self):
        project, pdir = kw.prepare_project(job_for(storyboard("cyber")), ENGINE, self.tmp)
        self.assertEqual(self.posts("/images"), [])
        self.assertNotIn("kleo_style", project)
        self.assertNotIn("look", project)
        self.assertFalse(any("image_prompt" in s or "image" in s for s in project["scenes"]))
        contract.validate(os.path.join(pdir, "project.json"))

    def test_build_project_drops_client_supplied_images(self):
        sb = storyboard()
        sb["scenes"][0]["image"] = "../../etc/passwd"
        sb["scenes"][0]["shots"][0]["image"] = "../../etc/shadow"
        sb["look"] = "realistic"
        project = kw.build_project(job_for(sb), ENGINE)
        self.assertNotIn("image", project["scenes"][0])
        self.assertNotIn("image", project["scenes"][0]["shots"][0])
        self.assertNotIn("look", project, "only strip_kleo_fields writes the engine's look")
        self.assertEqual(project["kleo_style"], "cartoon", "kept until prepare_project strips it")
        self.assertEqual(project["scenes"][0]["shots"][0]["image_prompt"], "picture for 01-hook shot 1")

    def test_fixture_cartoon_pirates_prepares_and_validates(self):
        with open(FIXTURE) as f:
            sb = json.load(f)
        self.assertEqual(sb["kleo_style"], "cartoon")
        self.assertTrue(kw.wants_pictures(sb))
        ids = kw.picture_ids(sb)
        self.assertEqual(ids, expected_pictures(sb), "one picture per shot, <sceneId>-s<n>, in scene order")
        self.assertEqual(sorted({i.rsplit("-s", 1)[0] for i in ids}), sorted(s["id"] for s in sb["scenes"]),
                         "every scene of the fixture is pictured")
        self.assertTrue(all(len(u["image_prompt"]) <= 240 for u in kw.picture_units(sb)))
        first = ids[0]
        FakeKleo.state["images_replies"] = [(200, {"images": {first: self.dl("01-hook-s1.png")}, "missing": ids[1:]})]
        project, pdir = kw.prepare_project(job_for(copy.deepcopy(sb)), ENGINE, self.tmp)
        self.assertEqual(first, "01-hook-s1")
        self.assertEqual(project["scenes"][0]["image"], "img/01-hook-s1.png")
        self.assertEqual([s.get("image") for s in project["scenes"][1:]], [None] * (len(project["scenes"]) - 1))
        self.assertIn(f"1 pictures from server, 0 generated on the GPU, {len(ids) - 1} missing",
                      [p.get("message") for p in FakeKleo.state["progress"]])
        self.validate_engine(os.path.join(pdir, "project.json"))


if __name__ == "__main__":
    unittest.main()
