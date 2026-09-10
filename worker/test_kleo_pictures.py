#!/usr/bin/env python3
"""
Unit tests for worker/kleo_pictures.py and the KLEO_PICTURES policy in kleo_worker.prepare_project(): no torch, no
diffusers, no GPU, no network. Fake `torch` / `diffusers` modules are injected through sys.modules (kleo_pictures imports
them inside its functions only); the fake StableDiffusionPipeline records every call and writes a solid PNG.
One picture per shot (docs/PICTURE-STYLE.md): the ids passed around are picture ids `<sceneId>-s<n>`, and the files are
named after them.
Run: python3 worker/test_kleo_pictures.py -v      or      cd worker && python3 -m unittest test_kleo_pictures -v
"""
import ast, importlib.util, os, shutil, struct, sys, tempfile, types, unittest, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "keou")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kp = load_module("kleo_pictures_under_test", os.path.join(HERE, "kleo_pictures.py"))
kw = load_module("kleo_worker_under_test", os.path.join(HERE, "kleo_worker.py"))
contract = load_module("keou_contract_under_test", os.path.join(ENGINE, "contract.py"))


def solid_png(w, h, rgb=(40, 120, 200)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# ---- fakes ----------------------------------------------------------------------------------------------------------
class FakeImage:
    def __init__(self, w, h):
        self.w, self.h = w, h

    def save(self, path, format=None):
        with open(path, "wb") as f:
            f.write(solid_png(self.w, self.h))


class FakeGenerator:
    def __init__(self, device=None):
        self.device, self.seed = device, None

    def manual_seed(self, seed):
        self.seed = seed
        return self


class FakePipe:
    """Records .to / enable_attention_slicing / every __call__; `fail_ids` makes those scene prompts raise."""
    def __init__(self, state):
        self.state = state
        self.scheduler = types.SimpleNamespace(config={"name": "pndm"})

    def to(self, device):
        self.state["device"] = device
        return self

    def enable_attention_slicing(self):
        self.state["slicing"] = True

    def set_progress_bar_config(self, **kw):
        self.state["progress_bar"] = kw

    def __call__(self, **kw):
        self.state["calls"].append(kw)
        for bad in self.state.get("fail_prompts", ()):
            if bad in kw["prompt"]:
                raise RuntimeError("CUDA out of memory (fake)")
        return types.SimpleNamespace(images=[FakeImage(kw["width"], kw["height"])])


def install_fakes(cuda=True, load_error=None):
    """sys.modules gets a fake torch + diffusers (+ huggingface_hub.constants). Returns the shared recording state."""
    state = {"calls": [], "loads": [], "cuda": cuda, "device": None, "slicing": False, "scheduler": None}
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: state["cuda"])
    torch.float16, torch.float32 = "float16", "float32"
    torch.Generator = FakeGenerator

    class StableDiffusionPipeline:
        @staticmethod
        def from_pretrained(model, **kw):
            state["loads"].append((model, kw, os.environ.get("HF_HUB_OFFLINE")))
            if load_error and len(state["loads"]) <= load_error:
                raise OSError("not in cache (fake)")
            return FakePipe(state)

    class DPMSolverMultistepScheduler:
        @staticmethod
        def from_config(config, **kw):
            state["scheduler"] = (config, kw)
            return "dpm++"

    diffusers = types.ModuleType("diffusers")
    diffusers.StableDiffusionPipeline = StableDiffusionPipeline
    diffusers.DPMSolverMultistepScheduler = DPMSolverMultistepScheduler
    hub = types.ModuleType("huggingface_hub")
    hub_constants = types.ModuleType("huggingface_hub.constants")
    hub_constants.HF_HUB_OFFLINE = True
    hub.constants = hub_constants
    sys.modules["torch"], sys.modules["diffusers"] = torch, diffusers
    sys.modules["huggingface_hub"], sys.modules["huggingface_hub.constants"] = hub, hub_constants
    return state


def remove_fakes():
    for name in ("torch", "diffusers", "huggingface_hub", "huggingface_hub.constants"):
        sys.modules.pop(name, None)


# What kleo_worker.generate_local_pictures() hands over: two shots of the first scene, one of the second.
SCENES = [{"id": "01-hook-s1", "image_prompt": "a pirate captain on a sandy beach, a ship at anchor"},
          {"id": "01-hook-s2", "image_prompt": "the fastest ship in the caribbean, full sails"},
          {"id": "02-ship-s1", "image_prompt": "the ship in a violent storm, dark waves"}]
MADE = ["01-hook-s1", "01-hook-s2", "02-ship-s1"]


class GeneratePicturesTest(unittest.TestCase):
    def setUp(self):
        kp._pipelines.clear()
        self.tmp = tempfile.mkdtemp(prefix="kleo-pics-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.addCleanup(remove_fakes)
        self.addCleanup(kp._pipelines.clear)
        for k in ("KLEO_PICTURES_CPU", "KLEO_PICTURES_DOWNLOAD", "HF_HUB_OFFLINE"):
            os.environ.pop(k, None)
        os.environ["HF_HUB_OFFLINE"] = "1"

    def test_file_naming_and_png_output(self):
        state = install_fakes(cuda=True)
        made = kp.generate_pictures(SCENES, "cartoon", "9:16", os.path.join(self.tmp, "img"))
        self.assertEqual(sorted(made), MADE)
        for sid, path in made.items():
            self.assertEqual(path, os.path.join(self.tmp, "img", sid + ".png"))
            with open(path, "rb") as f:
                data = f.read()
            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"), sid)
            self.assertEqual(struct.unpack(">II", data[16:24]), (512, 896), "9:16 → 512x896")
        self.assertEqual(sorted(os.listdir(os.path.join(self.tmp, "img"))), [s + ".png" for s in MADE])
        self.assertEqual(state["device"], "cuda")
        self.assertFalse(state["slicing"], "attention slicing stays off on CUDA (slower on a 24 GB card)")
        self.assertEqual(kp._pipelines, {}, "the pipeline is released after the batch (VRAM back before the Keou render)")
        self.assertEqual(state["progress_bar"], {"disable": True})
        self.assertEqual(state["scheduler"][1], {"use_karras_sigmas": True})
        model, kwargs, offline = state["loads"][0]
        self.assertEqual(model, "Lykon/dreamshaper-8")
        self.assertEqual(kwargs["torch_dtype"], "float16")
        self.assertIsNone(kwargs["safety_checker"])
        self.assertFalse(kwargs["requires_safety_checker"])
        self.assertEqual(kwargs["variant"], "fp16")
        self.assertTrue(kwargs["local_files_only"], "cached weights first")
        self.assertEqual(offline, "1")
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1", "the offline flag is restored")

    def test_bad_picture_ids_and_empty_prompts_are_skipped(self):
        state = install_fakes(cuda=True)
        scenes = SCENES + [{"id": "../etc", "image_prompt": "x"}, {"id": "Bad Id-s1", "image_prompt": "x"},
                           {"id": "04-empty-s1", "image_prompt": "   "}, "junk", {"id": 5, "image_prompt": "x"}]
        made = kp.generate_pictures(scenes, "realistic", "16:9", os.path.join(self.tmp, "img"))
        self.assertEqual(sorted(made), MADE)
        self.assertEqual(len(state["calls"]), 3)
        self.assertEqual(state["loads"][0][0], "SG161222/Realistic_Vision_V5.1_noVAE")
        with open(made["01-hook-s1"], "rb") as f:
            self.assertEqual(struct.unpack(">II", f.read(24)[16:24]), (896, 512), "16:9 → 896x512")

    def test_picture_ids_from_the_worker_are_accepted(self):
        """kleo_worker sends `<sceneId>-s<n>`: the slug rule here must accept it, up to the longest legal scene id."""
        for pid in ("01-hook-s1", "01-hook-s12", "a-s1", "a" * 50 + "-s4"):
            self.assertTrue(kp.SCENE_ID.fullmatch(pid), pid)
            self.assertTrue(kw.PICTURE_ID.fullmatch(pid), pid)
        for pid in ("01 hook-s1", "01-hook-s1/../x", "a" * 60 + "-s1"):
            self.assertIsNone(kp.SCENE_ID.fullmatch(pid), pid)
            self.assertIsNone(kw.PICTURE_ID.fullmatch(pid), pid)

    def test_seed_is_deterministic_per_picture_id(self):
        state = install_fakes(cuda=True)
        kp.generate_pictures(SCENES, "cartoon", "9:16", os.path.join(self.tmp, "a"))
        first = [c["generator"].seed for c in state["calls"]]
        kp._pipelines.clear()
        state["calls"].clear()
        kp.generate_pictures(list(reversed(SCENES)), "cartoon", "9:16", os.path.join(self.tmp, "b"))
        second = [c["generator"].seed for c in reversed(state["calls"])]
        self.assertEqual(first, second, "same id → same seed whatever the order or the run")
        self.assertEqual(first, [kp.seed_for(s["id"]) for s in SCENES])
        self.assertEqual(len(set(first)), 3, "different shots get different seeds")
        for seed in first:
            self.assertTrue(0 <= seed < 2 ** 31)
        self.assertEqual(kp.seed_for("01-hook-s1"), kp.seed_for("01-hook-s1"))
        self.assertNotEqual(kp.seed_for("01-hook-s1"), kp.seed_for("01-hook-s2"), "two shots of one scene differ")
        self.assertEqual(state["calls"][0]["generator"].device, "cuda")

    def test_style_suffix_negative_prompt_steps_guidance(self):
        state = install_fakes(cuda=True)
        kp.generate_pictures(SCENES[:1], "cartoon", "9:16", self.tmp)
        call = state["calls"][0]
        self.assertEqual(call["prompt"], SCENES[0]["image_prompt"] + ", " + kp.STYLE_SUFFIX["cartoon"])
        self.assertIn("flat vector cartoon illustration", call["prompt"])
        self.assertIn("no text, no letters", call["prompt"])
        self.assertEqual(call["negative_prompt"], kp.NEGATIVE_PROMPT)
        for word in ("text", "watermark", "letters", "deformed", "low quality"):
            self.assertIn(word, call["negative_prompt"])
        self.assertEqual((call["width"], call["height"], call["num_inference_steps"], call["guidance_scale"]), (512, 896, 22, 6.5))
        kp._pipelines.clear()
        state["calls"].clear()
        kp.generate_pictures(SCENES[:1], "realistic", "16:9", self.tmp)
        call = state["calls"][0]
        self.assertTrue(call["prompt"].endswith(", " + kp.STYLE_SUFFIX["realistic"]))
        self.assertIn("cinematic photograph, 35mm lens", call["prompt"])
        self.assertEqual((call["width"], call["height"], call["num_inference_steps"], call["guidance_scale"]), (896, 512, 22, 5.5))
        # long / messy prompts: trimmed to the contract limit, suffix always kept, punctuation tidy
        p = kp.full_prompt("  a   very " + "long " * 80 + "prompt.  ", "cartoon")
        self.assertTrue(p.endswith(", " + kp.STYLE_SUFFIX["cartoon"]))
        self.assertLessEqual(len(p), kp.PROMPT_MAX + 2 + len(kp.STYLE_SUFFIX["cartoon"]))
        self.assertNotIn("  ", p)
        self.assertEqual(kp.full_prompt("", "realistic"), kp.STYLE_SUFFIX["realistic"])
        self.assertEqual(kp.full_prompt("a ship,", "cartoon"), "a ship, " + kp.STYLE_SUFFIX["cartoon"])

    def test_no_cuda_returns_empty_without_loading_anything(self):
        state = install_fakes(cuda=False)
        self.assertEqual(kp.generate_pictures(SCENES, "cartoon", "9:16", os.path.join(self.tmp, "img")), {})
        self.assertEqual(state["loads"], [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "img")), "nothing is created")
        self.assertFalse(kp.can_generate())

    def test_no_torch_at_all_is_a_quiet_no(self):
        remove_fakes()
        sys.modules["torch"] = None  # `import torch` raises ImportError
        self.addCleanup(lambda: sys.modules.pop("torch", None))
        self.assertFalse(kp.cuda_available())
        self.assertFalse(kp.can_generate())
        os.environ["KLEO_PICTURES_CPU"] = "1"
        self.assertFalse(kp.can_generate(), "CPU mode still needs torch")
        self.assertEqual(kp.generate_pictures(SCENES, "cartoon", "9:16", self.tmp), {})

    def test_cpu_opt_in_generates_in_fp32(self):
        state = install_fakes(cuda=False)
        os.environ["KLEO_PICTURES_CPU"] = "1"
        self.assertTrue(kp.can_generate())
        made = kp.generate_pictures(SCENES[:1], "cartoon", "9:16", self.tmp)
        self.assertEqual(list(made), ["01-hook-s1"])
        self.assertEqual(state["device"], "cpu")
        self.assertEqual(state["loads"][0][1]["torch_dtype"], "float32")
        self.assertEqual(state["calls"][0]["generator"].device, "cpu")

    def test_unknown_style_and_empty_input(self):
        state = install_fakes(cuda=True)
        self.assertEqual(kp.generate_pictures(SCENES, "cyber", "9:16", self.tmp), {})
        self.assertEqual(kp.generate_pictures([], "cartoon", "9:16", self.tmp), {})
        self.assertEqual(kp.generate_pictures(None, "cartoon", "9:16", self.tmp), {})
        self.assertEqual(state["loads"], [])

    def test_one_failing_picture_does_not_sink_the_others(self):
        state = install_fakes(cuda=True)
        state["fail_prompts"] = ["violent storm"]
        made = kp.generate_pictures(SCENES, "cartoon", "9:16", os.path.join(self.tmp, "img"))
        self.assertEqual(sorted(made), ["01-hook-s1", "01-hook-s2"])
        self.assertEqual(len(state["calls"]), 3, "every shot was attempted")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "img", "02-ship-s1.png")))

    def test_model_load_falls_back_to_download_then_gives_up_cleanly(self):
        state = install_fakes(cuda=True, load_error=2)  # both offline attempts fail, the third (download allowed) works
        made = kp.generate_pictures(SCENES[:1], "cartoon", "9:16", self.tmp)
        self.assertEqual(list(made), ["01-hook-s1"])
        attempts = [(kw.get("variant"), kw["local_files_only"], offline) for _, kw, offline in state["loads"]]
        self.assertEqual(attempts, [("fp16", True, "1"), (None, True, "1"), ("fp16", False, "0")])
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1", "restored after the download attempt")
        self.assertEqual(sys.modules["huggingface_hub.constants"].HF_HUB_OFFLINE, True, "constant restored too")
        # downloads forbidden: only the two offline attempts, then {} (never raises)
        kp._pipelines.clear()
        state = install_fakes(cuda=True, load_error=99)
        os.environ["KLEO_PICTURES_DOWNLOAD"] = "0"
        self.assertEqual(kp.generate_pictures(SCENES, "cartoon", "9:16", self.tmp), {})
        self.assertEqual(len(state["loads"]), 2)

    def test_pipeline_is_cached_within_a_batch_and_released_after(self):
        state = install_fakes(cuda=True)
        made = kp.generate_pictures(SCENES, "cartoon", "9:16", self.tmp)
        self.assertEqual(len(made), 3)
        self.assertEqual(len(state["loads"]), 1, "one load for the whole batch")
        self.assertEqual(kp._pipelines, {}, "released at the end of the batch")
        kp.generate_pictures(SCENES[:1], "realistic", "9:16", os.path.join(self.tmp, "r"))
        self.assertEqual(len(state["loads"]), 2)
        self.assertEqual(kp._pipelines, {})
        kp.release()  # idempotent

    def test_full_prompt_keeps_the_style_suffix_for_long_prompts(self):
        long = "a " + "very detailed pirate cove with ships and parrots " * 6
        p = kp.full_prompt(long, "cartoon")
        self.assertTrue(p.endswith(kp.STYLE_SUFFIX["cartoon"]))
        self.assertLessEqual(len(p) - len(kp.STYLE_SUFFIX["cartoon"]) - 2, kp.BASE_MAX)
        self.assertNotIn("  ", p)

    def test_prewarm_model_table_matches(self):
        """prewarm_models.py keeps its own copy of the model table (so the 4 GB layer is not keyed on kleo_pictures.py)."""
        with open(os.path.join(HERE, "prewarm_models.py")) as f:
            tree = ast.parse(f.read())
        table = None
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "PICTURE_MODELS" for t in node.targets):
                table = ast.literal_eval(node.value)
        self.assertEqual(table, kp.MODELS)
        with open(os.path.join(HERE, "Dockerfile.keou")) as f:
            docker = f.read()
        self.assertIn("worker/kleo_pictures.py /opt/kleo/kleo_pictures.py", docker)
        self.assertIn("requirements-pictures.txt", docker)


# ---- the policy in kleo_worker.prepare_project ----------------------------------------------------------------------
# The engine side of docs/PICTURE-STYLE.md lands separately; until contract.py knows the style, picture projects are
# checked by this file only (the cyber project still goes through the engine's validator on every run).
ENGINE_KNOWS_PICTURE = "picture" in getattr(contract, "STYLES", set())
IDS = ["01-hook", "02-ship", "03-storm", "04-treasure", "05-closing"]
SHOTS = {"01-hook": 2, "02-ship": 1, "03-storm": 1, "04-treasure": 1, "05-closing": 1}  # 6 pictures over 5 scenes
PICTURES = ["01-hook-s1", "01-hook-s2", "02-ship-s1", "03-storm-s1", "04-treasure-s1", "05-closing-s1"]
SERVED = ["01-hook-s1", "01-hook-s2"]                    # what the fake server can make; the rest is for the GPU
MISSING = [p for p in PICTURES if p not in SERVED]


def storyboard(style="cartoon", fmt="9:16"):
    """cartoon / realistic: the picture style (shots). cyber / stickman: the cinema shape, which never asks for pictures."""
    picture = style in ("cartoon", "realistic")
    voices = ["Captain Mara buried her treasure on Skull Beach.", "Her ship was the fastest in the Caribbean.",
              "Then came the storm.", "The boy kept the map his whole life.", "Is the treasure still there? Follow for part two."]
    scenes = []
    for i, (sid, v) in enumerate(zip(IDS, voices)):
        s = {"id": sid, "kind": "closing" if i == 4 else "cinema", "chapter": f"0{i + 1} PART", "accent": "amber",
             "title": f"part {i + 1}", "voice": v, "hold": 0.2}
        if picture:
            s["shots"] = [{"image_prompt": f"picture for {sid} shot {n + 1}"} for n in range(SHOTS[sid])]
        else:
            s["beats"] = [{"kind": "icon", "name": "wave"}]
            s["image_prompt"] = f"picture for scene {i + 1}"
        scenes.append(s)
    return {"schema_version": 1, "editorial_status": "ready", "title": "Pirates test", "brand": "Kleo",
            "style": "picture" if picture else "cinema", "format": fmt, "language": "en", "voice": "am_michael",
            "kleo_style": style, "scenes": scenes}


def job_for(sb):
    return {"job_id": "j1", "template": "did-you-know", "prompt": "Pirates", "brand": "Kleo",
            "params": {"format": sb.get("format", "9:16"), "language": "en", "duration_s": 45}, "storyboard": sb}


class FakeKleoPictures(types.ModuleType):
    """Stands in for kleo_pictures inside kleo_worker: records the request, writes a PNG per picture except `fail`."""
    def __init__(self, gpu=True, fail=()):
        super().__init__("kleo_pictures")
        self.gpu, self.fail, self.calls = gpu, set(fail), []

    def can_generate(self):
        return self.gpu

    def generate_pictures(self, scenes, style, fmt, out_dir):
        self.calls.append({"ids": [s["id"] for s in scenes], "prompts": [s["image_prompt"] for s in scenes], "style": style,
                           "format": fmt, "out_dir": out_dir})
        os.makedirs(out_dir, exist_ok=True)
        made = {}
        for s in scenes:
            if s["id"] in self.fail:
                continue
            path = os.path.join(out_dir, s["id"] + ".png")
            with open(path, "wb") as f:
                f.write(solid_png(8, 14))
            made[s["id"]] = path
        return made


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-policy-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: getattr(kw, k) for k in ("request_pictures", "progress", "PICTURES_POLICY", "IMAGES_RETRY_WAIT_S", "JOB", "API", "SECRET")}
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        self.addCleanup(lambda: sys.modules.pop("kleo_pictures", None))
        kw.JOB, kw.API, kw.SECRET, kw.IMAGES_RETRY_WAIT_S = "j1", "http://127.0.0.1:9", "wk_test", 0
        self.progress = []
        kw.progress = lambda track, percent, eta_min=None, message=None: self.progress.append((track, percent, message))
        self.server_calls = []
        # the fake server can make 2 of the 6 pictures: real files served from a local directory via file:// is not
        # allowed by download_picture (http(s) only), so the reply points at a tiny local http server
        self.srv_dir = os.path.join(self.tmp, "srv")
        os.makedirs(self.srv_dir)
        for pid in SERVED:
            with open(os.path.join(self.srv_dir, pid + ".png"), "wb") as f:
                f.write(solid_png(4, 4))
        import http.server, threading
        srv_dir = self.srv_dir

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **k):
                super().__init__(*a, directory=srv_dir, **k)

            def log_message(self, *a):
                pass
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

        def request_pictures(job_id):
            self.server_calls.append(job_id)
            return {"images": {pid: f"{base}/{pid}.png" for pid in SERVED}, "missing": list(MISSING)}
        kw.request_pictures = request_pictures

    def prepare(self, policy, gpu=True, fail=(), style="cartoon", fmt="9:16"):
        kw.PICTURES_POLICY = policy
        fake = FakeKleoPictures(gpu=gpu, fail=fail)
        sys.modules["kleo_pictures"] = fake
        project, pdir = kw.prepare_project(job_for(storyboard(style, fmt)), ENGINE, self.tmp)
        pj = os.path.join(pdir, "project.json")
        if project.get("style") != "picture" or ENGINE_KNOWS_PICTURE:
            contract.validate(pj)  # the engine's own validator accepts what we wrote
        return project, pdir, fake

    def images_of(self, project):
        """picture id → the image path on its shot, read off the written project (the prompts are gone by then)."""
        out = {}
        for s in project["scenes"]:
            shots = s.get("shots") or []
            for n, sh in enumerate(shots):
                out[f"{s['id']}-s{n + 1}"] = sh.get("image")
            if not shots:
                out[f"{s['id']}-s1"] = s.get("image")
        return out

    def scene_images_of(self, project):
        return {s["id"]: s.get("image") for s in project["scenes"]}

    def messages(self):
        return [m for _, _, m in self.progress]

    def test_auto_server_first_then_gpu_for_the_rest(self):
        project, pdir, fake = self.prepare("auto", fail=["05-closing-s1"])
        self.assertEqual(self.server_calls, ["j1"], "the server is asked once")
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0]["ids"], MISSING, "only what the server could not make")
        self.assertEqual(fake.calls[0]["prompts"], ["picture for 02-ship shot 1", "picture for 03-storm shot 1",
                                                    "picture for 04-treasure shot 1", "picture for 05-closing shot 1"])
        self.assertEqual(fake.calls[0]["style"], "cartoon")
        self.assertEqual(fake.calls[0]["format"], "9:16")
        self.assertEqual(fake.calls[0]["out_dir"], os.path.join(pdir, "img"))
        self.assertEqual(self.images_of(project), {"01-hook-s1": "img/01-hook-s1.png", "01-hook-s2": "img/01-hook-s2.png",
                                                   "02-ship-s1": "img/02-ship-s1.png", "03-storm-s1": "img/03-storm-s1.png",
                                                   "04-treasure-s1": "img/04-treasure-s1.png", "05-closing-s1": None})
        self.assertEqual(self.scene_images_of(project), {"01-hook": "img/01-hook-s1.png", "02-ship": "img/02-ship-s1.png",
                                                         "03-storm": "img/03-storm-s1.png",
                                                         "04-treasure": "img/04-treasure-s1.png", "05-closing": None})
        self.assertEqual(sorted(os.listdir(os.path.join(pdir, "img"))),
                         ["01-hook-s1.png", "01-hook-s2.png", "02-ship-s1.png", "03-storm-s1.png", "04-treasure-s1.png"])
        self.assertIn("2 pictures from server, 3 generated on the GPU, 1 missing", self.messages())
        self.assertIn("generating 4 pictures on the GPU (cartoon)", self.messages())
        self.assertEqual(project["look"], "cartoon")
        self.assertNotIn("kleo_style", project)
        self.assertFalse(any("image_prompt" in s for s in project["scenes"]))
        self.assertFalse(any("image_prompt" in sh for s in project["scenes"] for sh in s["shots"]))

    def test_auto_without_gpu_keeps_the_server_pictures_only(self):
        project, pdir, fake = self.prepare("auto", gpu=False)
        self.assertEqual(self.server_calls, ["j1"])
        self.assertEqual(fake.calls, [], "no GPU: never asked")
        self.assertEqual(self.images_of(project), dict({p: f"img/{p}.png" for p in SERVED}, **{p: None for p in MISSING}))
        self.assertEqual(self.scene_images_of(project)["01-hook"], "img/01-hook-s1.png")
        self.assertIsNone(self.scene_images_of(project)["02-ship"])
        self.assertIn("2 pictures from server, 0 generated on the GPU, 4 missing", self.messages())

    def test_server_policy_never_generates_locally(self):
        project, pdir, fake = self.prepare("server", gpu=True)
        self.assertEqual(self.server_calls, ["j1"])
        self.assertEqual(fake.calls, [])
        self.assertIn("2 pictures from server, 0 generated on the GPU, 4 missing", self.messages())

    def test_local_policy_skips_the_server(self):
        project, pdir, fake = self.prepare("local", gpu=True, style="realistic", fmt="16:9")
        self.assertEqual(self.server_calls, [], "no images call at all")
        self.assertEqual(fake.calls[0]["ids"], PICTURES)
        self.assertEqual(fake.calls[0]["style"], "realistic")
        self.assertEqual(fake.calls[0]["format"], "16:9")
        self.assertEqual(self.images_of(project), {pid: f"img/{pid}.png" for pid in PICTURES})
        self.assertEqual(project["look"], "realistic")
        self.assertIn("0 pictures from server, 6 generated on the GPU, 0 missing", self.messages())
        self.assertFalse(any(m and m.startswith("fetching") for m in self.messages()))

    def test_local_policy_without_gpu_renders_without_pictures(self):
        project, pdir, fake = self.prepare("local", gpu=False)
        self.assertEqual(self.server_calls, [])
        self.assertEqual(fake.calls, [])
        self.assertFalse(any("image" in s for s in project["scenes"]))
        self.assertFalse(any("image" in sh for s in project["scenes"] for sh in s["shots"]))
        self.assertIn("0 pictures from server, 0 generated on the GPU, 6 missing", self.messages())

    def test_auto_when_the_server_fails_entirely(self):
        def boom(job_id):
            self.server_calls.append(job_id)
            raise OSError("connection refused")
        kw.request_pictures = boom
        project, pdir, fake = self.prepare("auto")
        self.assertEqual(self.server_calls, ["j1", "j1"], "fetch_pictures retries once, then gives up")
        self.assertEqual(fake.calls[0]["ids"], PICTURES, "everything is drawn locally")
        self.assertIn("0 pictures from server, 6 generated on the GPU, 0 missing", self.messages())

    def test_unknown_policy_value_means_auto(self):
        kw.PICTURES_POLICY = "whatever"
        self.assertEqual(kw.pictures_policy(), "auto")
        for v in ("auto", "server", "local"):
            kw.PICTURES_POLICY = v
            self.assertEqual(kw.pictures_policy(), v)

    def test_cyber_never_touches_server_or_gpu(self):
        project, pdir, fake = self.prepare("auto", style="cyber")
        self.assertEqual(self.server_calls, [])
        self.assertEqual(fake.calls, [])
        self.assertFalse(any("image" in s for s in project["scenes"]))
        self.assertNotIn("look", project, "look belongs to the picture style only")

    def test_generate_local_pictures_rejects_paths_outside_img(self):
        class Sneaky(FakeKleoPictures):
            def generate_pictures(self, scenes, style, fmt, out_dir):
                outside = os.path.join(self.tmp_root, "elsewhere.png")
                with open(outside, "wb") as f:
                    f.write(solid_png(2, 2))
                return {scenes[0]["id"]: outside, scenes[1]["id"]: "/nonexistent/x.png"}
        fake = Sneaky()
        fake.tmp_root = self.tmp
        sys.modules["kleo_pictures"] = fake
        project = storyboard()
        pdir = os.path.join(self.tmp, "p")
        os.makedirs(pdir)
        self.assertEqual(kw.generate_local_pictures(project, pdir, PICTURES), [])
        self.assertFalse(any("image" in s for s in project["scenes"]))
        self.assertFalse(any("image" in sh for s in project["scenes"] for sh in s["shots"]))

    def test_local_module_missing_is_not_fatal(self):
        sys.modules["kleo_pictures"] = None  # import raises ImportError
        kw.PICTURES_POLICY = "auto"
        self.assertFalse(kw.local_pictures_available())
        project, pdir = kw.prepare_project(job_for(storyboard()), ENGINE, self.tmp)
        self.assertIn("2 pictures from server, 0 generated on the GPU, 4 missing", self.messages())


if __name__ == "__main__":
    unittest.main()
