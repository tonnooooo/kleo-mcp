# Architecture

```text
User brief / script
        ↓
Assistant editorial preparation → project.json + script.txt + assets
        ↓
Contract + frozen-source checks
        ↓
keou.py → dedicated Vast controller (or explicit local mode)
        ↓
prepare.py → measured voice, ASR alignment, captions, original music
        ↓
run.py → FFmpeg audio mix → Canvas/Playwright frame rendering
        ↓
qa.py → full decode + timing/layout/audio/content checks
        ↓
master + preview + captions + metadata + hash manifest
        ↓
verified local copy → owned-worker deletion → latest links
```

## Modules

- contract.py: validation and safe project asset containment.
- prepare.py: English/French Kokoro, measured WAV segments and transcript-aligned captions.
- engine/film.js: typography, compositions, geometry, motion and drawing.
- engine/render.mjs: browser hosting, images, frame workers and validated encoding caches.
- run.py: stage lock, audio assembly, rendering, QA and deliverables.
- qa.py: audio/video/content checks.
- vast_worker.py / watchdog.py: isolated paid compute, recovery and lifecycle.
- keou.py: primary production CLI and persistent queue.
- settings.py: purchaser-local SSH path and protected instance IDs.
- kit.py: onboarding, draft copies, diagnostics and layout previews.

The template's settings/onboarding adapt the tested engine for another machine. Speech preparation, audio pipeline and QA retain the original production logic. The cyber edition extends the approved revision 1.1 with three optional native diagrams (voice-signal, ai-network and data-flow) and configurable labels. New projects default to the black/green terminal cyber example. Its bundled JetBrains Mono font, terminal frame, typed code and cursor are part of the renderer; the font bytes also contribute to the render-cache fingerprint. This is a separate renderer edition; the original editorial template remains intact. Exact source hashes are recorded in release.json.

## Data and network

The AI assistant reads the project according to its own provider's data handling. Vast receives the script, assets and allowlisted renderer files. Public dependencies/models download from their upstream registries. The kit does not send credentials to the worker or publish your media. Captions, logs and source scripts may contain customer content; keep the project private as appropriate.

The downloadable kit contains source, original example assets and demo videos. It does not bundle a language model, GPU rental credit, full Python/Node dependency installation or third-party service subscriptions.

Some unchanged core diagnostics use the historical assistant name Pearl; this means the editorial assistant operating the folder, with no external account dependency.
