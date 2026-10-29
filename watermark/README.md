# kleo-watermark

Burns "Made with Kleo" (`made-with-kleo.png`, the same file as `kleooai.com/brand/made-with-kleo.png`) into the
clips of Kleo Studio accounts that never paid, so every free clip shared online advertises Kleo. Paying accounts,
admins and Kleo Creators get no mark. The rules and the picture side live in `src/studio/watermark.ts`.

```
kleo-studio (src/studio/watermark.ts markVideo)
  └─ WATERMARK service binding ──► kleo-watermark Worker (worker.js)
                                     └─ one of 3 Containers "basic" (1/4 vCPU, 1 GiB, 4 GB disk)
                                          └─ server.py: ffprobe + ffmpeg overlay, libx264, audio copied
```

## Why a Cloudflare Container

Workers cannot run ffmpeg. Measured or quoted on 28 Oct 2026 for one 10-second 720p clip:

| Road | Per clip | Fixed | Latency | Effort |
|---|---|---|---|---|
| **Cloudflare Containers (chosen)** | $0.000125 measured, after the allowance; $0 inside it | $0 (in Workers Paid) | 16 s measured, + a cold start of a few seconds | this folder |
| Cloudflare Stream watermark profile | ~$0.00017 (10 s delivered once) | $5/month prepaid storage | upload + encode + MP4 download, ~30-90 s | Stream subscription and a Stream token |
| Vast.ai batch | ~$0.02 per batch (box minimum) | none | minutes to hours | queue, boot, image pull, guarding the box |
| Media Transformations | - | - | - | no overlay option: cannot draw a mark |

Containers cost nothing extra on Workers Paid until 375 vCPU-minutes, 25 GiB-hours and 200 GB-hours a month
(thousands of free clips), then $0.000020 per vCPU-second, $0.0000025 per GiB-second and $0.00000007 per
GB-second. An idle box bills memory and disk until it sleeps (2 minutes): about $0.0003 per wake-up. The exact
measured numbers of every build are in the summary of the `watermark` workflow run (`try.sh`, on 1/4 vCPU).

Measured on 28 Oct 2026 (`try.sh` on a GitHub runner capped at 1/4 vCPU and 1 GiB, like "basic"; test-pattern clips
with sound, H.264 in, H.264 out, audio copied):

| Clip | CPU | Wall | $ per clip after the allowance | Clips inside the monthly allowance |
|---|---|---|---|---|
| 10 s 1280x720 16:9 | 3.98 s | 16.4 s | $0.000125 | 5,491 |
| 10 s 480x854 9:16 (the free tier) | 1.93 s | 8.1 s | $0.000061 | 11,111 |

Memory (1 GiB for the whole wall time) is what runs out first. Real footage has more detail than a test pattern and
may take somewhat longer; `studio.marked` in the audit records the CPU seconds of every real clip.

## Deploy (owner's OK first)

**29 Oct 2026, the owner: no mark on videos. Do not run these steps.** With the `WATERMARK` binding on, free clips
would be marked: kleo-studio's `STUDIO_WATERMARK` covers pictures and clips together, and turning it off would take the
mark off the pictures too.

1. Copy `github-workflow.yml` to `.github/workflows/watermark.yml` (GitHub's web editor: Add file, Create new file).
   Pushing workflow files needs the `workflow` scope, which Claude's GitHub token does not have.
2. Add the repository secret `CLOUDFLARE_API_TOKEN` (a token on the Kleo account with Workers Scripts: Edit and
   Containers: Edit).
3. Actions, `watermark`, "Run workflow" on `main` with deploy ticked. wrangler builds the image on GitHub's runner
   and pushes it to Cloudflare's registry. Every run also tries the image on two test clips and prints the cost.
4. In `wrangler.studio.jsonc`, uncomment the `WATERMARK` service binding, then deploy kleo-studio from main.

Until step 4 free clips are kept and served clean (fail open); free pictures are marked as soon as kleo-studio is
deployed with the `IMAGES` binding.

Studio sends only its own clips here (480p to 1080p, at most 15 s). Animatics are 4K 60 fps and are marked on the GPU
box instead (`worker/kleo_mark.py`, decided by kleo-mcp in `src/mark.ts`); since 29 Oct 2026 that mark is switched off
(`STUDIO_WATERMARK=off` in `wrangler.jsonc`, the owner: no mark on videos).

## Changing the mark

Replace `made-with-kleo.png` here, in `studio-web/` and in `worker/` (a test checks the three are identical), and keep
`MARK_W`/`MARK_H` in `server.py`, `worker/kleo_mark.py` and `src/studio/watermark.ts` equal to its size. Where it sits
on pictures and clips is `placement()` in `server.py` and `markPlacement()` in `src/studio/watermark.ts`: change both
together (a test checks they agree). Renders use their own spot, clear of the engine's chapter pill, brand and captions:
`placement()` in `worker/kleo_mark.py`.
