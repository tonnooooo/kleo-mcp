#!/usr/bin/env python3
"""Build-time model warm-up: every model the Keou engine needs lands in the image's
HF cache (HF_HOME) so a Vast instance boots and renders without any download.
Reads the voice list from contract.py so the cache always matches the contract."""
import importlib.util, os, sys, time
from pathlib import Path

contract = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('contract', contract); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
LANG = {'en': None, 'fr': 'f', 'it': 'i'}
SAMPLE = {'en': 'The render pipeline is ready.', 'fr': 'Le moteur de rendu est prêt.', 'it': 'Il motore di rendering è pronto.'}

import numpy as np
from kokoro import KPipeline
from faster_whisper import WhisperModel

t0 = time.time()
for language, voices in sorted(mod.VOICES.items()):
    for voice in sorted(voices):
        lang = LANG.get(language) or ('b' if voice.startswith('b') else 'a')
        pipe = KPipeline(lang_code=lang, device='cpu', repo_id='hexgrad/Kokoro-82M')
        audio = np.concatenate([np.asarray(ch.audio) for ch in pipe(SAMPLE[language], voice=voice)])
        assert np.isfinite(audio).all() and len(audio) > 24000 * .3, f'{voice}: synthesis failed'
        print(f'PREWARM voice {language}/{voice} lang_code={lang} {len(audio)/24000:.2f}s', flush=True)
asr = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=2)
segments, _ = asr.transcribe(np.zeros(24000, dtype=np.float32), language='en', beam_size=1)
list(segments)
print(f'PREWARM asr small/int8 ok', flush=True)
import spacy; spacy.load('en_core_web_sm'); print('PREWARM spacy en_core_web_sm ok', flush=True)
print(f'PREWARM_DONE {time.time()-t0:.0f}s HF_HOME={os.environ.get("HF_HOME")}', flush=True)
