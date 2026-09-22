#!/usr/bin/env python3
"""
The pure part of worker/keou/prepare.py — the caption groups cut from the aligned words — without Kokoro, Whisper,
numpy or a GPU. What is under test is the rule of 22 September 2026: a caption too brief to read is repaired, never
fatal. The first probe of that day (gt_hxed87em) rendered; the second (gt_xrnffqsx, same words) died three times in
the voice pass on "Caption too brief" because trim_edges had cut the silent tail the last one-word group used to
live on. Five credits and a rented card for a caption.

Run: python3 -m unittest worker.test_keou_prepare       (from the repo root)
"""
import importlib.util, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KEOU = os.path.join(HERE, "keou")


def load_prepare():
    sys.path.insert(0, KEOU)   # prepare.py imports its sibling contract.py by name
    spec = importlib.util.spec_from_file_location("keou_prepare_under_test", os.path.join(KEOU, "prepare.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pp = load_prepare()


def heard_for(script, per_word=0.32, tail=0.0):
    """A recogniser that heard every word, one every `per_word` seconds; the audio ends `tail` s after the last."""
    words = script.split()
    heard = [{"word": w, "start": i * per_word, "end": i * per_word + per_word * 0.8} for i, w in enumerate(words)]
    return heard, len(words) * per_word + tail


class CaptionRepairTest(unittest.TestCase):
    def test_a_brief_last_group_is_merged_into_the_one_before_it_never_fatal(self):
        # Seven words a group in landscape: "page." lands alone in a last group that ends where the trimmed audio ends.
        script = "The hand finally lifts the pencil, hovers, and its worn tip touches the blank page."
        heard, duration = heard_for(script, per_word=0.32, tail=0.18)
        groups, score = pp.caption_groups(script, heard, duration)
        self.assertGreaterEqual(score, 0.99)
        for g in groups:
            self.assertGreaterEqual(g["end"] - g["start"], 0.55, groups)
        self.assertEqual(" ".join(g["text"] for g in groups), script, "every word is still shown once")
        self.assertTrue(groups[-1]["text"].endswith("page."))

    def test_a_brief_group_in_the_middle_borrows_time_from_a_neighbour_when_it_cannot_merge(self):
        # Two long groups around a short one, at the character ceiling: no merge fits, the boundary moves instead.
        script = "Extraordinary graphite particles drift slowly upward tonight. Yes. Extraordinary graphite particles drift slowly upward tonight."
        heard, duration = heard_for(script, per_word=0.6, tail=0.3)
        heard[7]["start"] = 7 * 0.6
        groups, _ = pp.caption_groups(script, heard, duration)
        for g in groups:
            self.assertGreaterEqual(g["end"] - g["start"], 0.55, groups)
        for a, b in zip(groups, groups[1:]):
            self.assertLessEqual(a["end"], b["start"] + 1e-9, "groups never overlap after the repair")

    def test_portrait_and_compact_keep_their_own_floors(self):
        script = "One line crosses the page slow uneven real."
        heard, duration = heard_for(script, per_word=0.3, tail=0.1)
        for kw, floor in (({"portrait": True}, 0.55), ({"compact": True}, 0.25)):
            groups, _ = pp.caption_groups(script, heard, duration, **kw)
            for g in groups:
                self.assertGreaterEqual(g["end"] - g["start"], floor, (kw, groups))

    def test_trim_edges_keeps_the_words_and_drops_the_silence(self):
        import array
        sr = 100
        quiet, loud = [0.0] * 60, [0.5, -0.5] * 30
        audio = quiet + loud + quiet          # 0.6 s of nothing, 0.6 s of sound, 0.6 s of nothing
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy is not installed here")
        out = pp.trim_edges(np.asarray(audio, dtype="float32"), sr)
        self.assertAlmostEqual(len(out) / sr, 0.6 + 0.12 + 0.18, delta=0.03)
        self.assertEqual(len(pp.trim_edges(np.zeros(50, dtype="float32"), sr)), 50, "silence is returned as it is")


if __name__ == "__main__":
    unittest.main()
