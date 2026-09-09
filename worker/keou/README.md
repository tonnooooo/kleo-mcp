# Keou Cyber — motion-design production kit

**Cybersecurity, hacker culture and AI explainers with meaningful internal motion.** A specialty edition by Kanaky Tech, built on the approved Keou editorial motion system.

Black-and-green terminal windows, JetBrains Mono typography, progressively typed code, blinking cursors and smooth native diagrams. Give your own coding assistant a script or topic; it prepares the story and runs the documented production workflow on your account.

**Start:** [Démarrage en français](docs/DEMARRAGE-FR.md) · [Install in English](docs/INSTALL.md) · [Cyber direction](docs/CYBER-STYLE.md) · [Brief and prompt](agent-prompts/START-HERE.md)

## Watch the reference

[That Voice Could Be Fake — English demo](examples/cyber-voice-scam/sample/master.mp4)

Source script, scene JSON, fallback SVGs and factual references live in `examples/cyber-voice-scam/`. The generic French and animated galaxy examples are retained as style references. The cyber film uses generic synthetic narration, not an imitation of a real person.

## Create your own film

Open this extracted folder in a local coding assistant. Ask it to read AGENTS.md and agent-prompts/START-HERE.md. Claude Code, Codex, OpenCode and other agents use the same files/terminal commands; a browser chat alone cannot operate your machine.

```bash
bash scripts/setup-host.sh
source .venv-controller/bin/activate
python scripts/configure-vast.py
python kit.py doctor --vast
python kit.py new my-cyber-film
```

The new draft uses the cyber example by default. Have your assistant change the narration, facts, titles and relevant diagrams. Complete editorial review and mark the project ready, then:

```bash
python keou.py check projects/my-cyber-film/project.json
python keou.py run projects/my-cyber-film/project.json --budget 1 --minutes 60
```

The run command creates paid compute on your own Vast account. Installation and project creation do not rent anything. Keep the controller host awake until download and cleanup finish. [Costs, ownership and recovery](docs/VAST.md).

## Included

| Component | Cyber edition |
|---|---|
| Default look | Terminal palette, JetBrains Mono, 1080 × 1920 at 60 fps |
| Native moving diagrams | Audio signals, AI network, verification/data flow |
| Reusable controls | Typed terminal lines, three configurable diagram labels, animated values |
| Story support | Brief form, cyber prompt, subject recipes and fact-checking guidance |
| Production | English/French speech, measured captions, music, QA, cache, dedicated-worker lifecycle |
| Deliverables | Master MP4, light preview, SRT and publication metadata |

The original eight compositions remain available, along with the astronomy motion modes from the base kit. Choose a diagram because it explains the subject, not because it looks technical.

## Documentation

[Cyber style and motion fields](docs/CYBER-STYLE.md) · [Topic recipes](docs/CYBER-RECIPES.md) · [Workflow](docs/WORKFLOW.md) · [Project contract](docs/PROJECT-CONTRACT.md) · [Agent compatibility](docs/AGENTS-GUIDE.md) · [Installation](docs/INSTALL.md) · [QA](docs/QUALITY.md) · [Recovery](docs/TROUBLESHOOTING.md) · [Automation](docs/AUTOMATION.md) · [Validation evidence](VALIDATION.md)

This is a video-production template. The graphics do not scan a network, detect a deepfake or execute hacking tools. Technical UI elements represent the story's concepts; they are not fabricated live findings. No account credentials, provider credits or publishing integration are bundled.

English demo; English/French production supported. Mac/Linux controller, Windows via WSL2 as a documented route. See installation and validation for tested limits. No site publication, YouTube upload or schedule is activated.

Commercial terms remain with the owner: [LICENSE](LICENSE), [internal seller notes](SELLER-NOTES.md). Upstream components retain their own terms in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
