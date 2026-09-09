# Installation

## Recommended: light local controller + dedicated Vast worker

The controller runs on macOS or Linux. On Windows, run it inside WSL2 with Ubuntu; keep the project in the Linux home directory. Native Windows is not supported because the controller uses POSIX file locks, SSH and rsync.

Install Python **3.11+**, OpenSSH and rsync. On macOS with Homebrew, `brew install python@3.11 rsync` supplies the missing tools. On Ubuntu, install Python 3.11+ and its venv package using your distribution's supported packages, plus `openssh-client rsync`. Do not run the remote bootstrap script on your personal machine.

From the extracted folder:

```bash
# If python3 is older than 3.11, select your installed Python explicitly:
# KEOU_PYTHON=python3.11 bash scripts/setup-host.sh
bash scripts/setup-host.sh
source .venv-controller/bin/activate
python scripts/configure-vast.py
python kit.py doctor --vast
```

The setup creates `.venv-controller/` and installs Vast CLI 1.6.0, matching the validated controller. The interactive configuration hides API-key input and lets the Vast CLI store it outside the project. It creates a dedicated SSH key at `~/.ssh/id_ed25519_keou` only when neither key file already exists. This key has no passphrase for unattended batch use; it is used only for the job worker. Existing keys are preserved. You may instead set an already-configured key via `config.local.json`; it must work with SSH BatchMode.

Create your Vast API key in your own account: https://console.vast.ai/manage-keys/ . Follow the [official CLI setup](https://docs.vast.ai/cli/hello-world). Fund the account before rendering. No API key is needed for the example videos or layout checks.

`config.local.json` accepts only:

```json
{"ssh_key":"~/.ssh/id_ed25519_keou","protected_instance_ids":[]}
```

Add any unrelated production instance IDs you want explicitly protected. The controller also requires its own registry and matching labels before touching any worker. Never distribute config.local.json, private keys, run logs or CLI credential files.

## Optional local storyboard preview

Install Node **22+**, then:

```bash
npm ci
npx playwright install chromium
python kit.py doctor --local
python kit.py layout projects/my-first-film/project.json
```

On Linux, Chromium may need system libraries: `npx playwright install --with-deps chromium` (requires permission to install packages). The full `--local` doctor also checks FFmpeg and espeak-ng for audio rendering; these are not needed for an image-only layout preview.

## Optional full local rendering

This route is for an operator comfortable with Python ML dependencies. The fully validated production environment is the dedicated Linux GPU worker. A Mac CPU render is possible but has not been qualified as an installation target in this package.

Install FFmpeg/ffprobe, espeak-ng, Node 22+, Chromium, Python 3.11+, and a PyTorch build appropriate to your OS from the [official PyTorch installer](https://pytorch.org/get-started/locally/). Create a separate `.venv-render`, install PyTorch there, then `pip install -r requirements.txt`. CPU execution is supported by prepare.py; CUDA is used when available. Activate that environment and run `python keou.py run <project.json> --local`. Local mode does not rent or create a worker and has no runtime watchdog.

## Verify without spending money

```bash
python kit.py doctor
python keou.py status
python keou.py check examples/premier-resultat/project.json
python keou.py check examples/cyber-voice-scam/project.json
python -m unittest discover -s tests -v
```

The unit tests mock cloud operations and do not rent a machine. The core sources are protected by release.json; packaging has a separate file manifest.
