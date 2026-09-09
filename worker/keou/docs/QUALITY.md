# Quality and acceptance

The package retains the approved layout system and adds the cyber motion modes described in CYBER-STYLE.md. Check VALIDATION.md for what was actually tested and what is only documented.

## Automated gates

- Contract, supported language/voice, scene counts, asset containment and script identity.
- Actual speech durations; ASR agreement with the script of at least 85% per scene.
- Captions derived from original text; groups must last at least 0.55 seconds.
- Moving layout sampled at entrance, settled state, caption changes and exit; full-frame bounds checked during encoding.
- Complete MP4 decode, required dimensions, frame count and audio stream.
- Audio: 48 kHz stereo, integrated loudness between -18.5 and -14 LUFS, true peak no higher than -0.8 dBTP.
- No detected black intervals; identical sampled frames limited by the QA threshold.
- Local delivery files compared to their SHA-256 manifest before remote deletion.

Inspect qa.py and FINAL-QA.json for exact measures. A transcription may write “26,000” for “twenty six thousand”; inspect the transcript instead of assuming a lower score is a pronunciation error.

## Human/agent acceptance

Watch the preview, check language and pronounceability, inspect every scene image, read the script against its factual sources, and confirm the images are meaningful and legally usable. Verify that the ending follows the hook and the captions can be read comfortably. A reference being liked is evidence of user taste, not audience-performance testing.

## Useful commands

```bash
python -m unittest discover -s tests -v
python tests/layout_matrix.py
python kit.py verify projects/my-topic/project.json
```

The matrix requires Node/Chromium and tests eight compositions across three palettes and two aspect ratios. It creates synthetic timelines solely for layout inspection. It does not prove a complete rendered film in every format.

Output marker `delivery.json` is written only after the successful pipeline. On a rerun, an earlier delivery marker is invalidated first. Never hand off a partial MP4 or layout fixture as a finished production.
