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
| **Cloudflare Containers (chosen)** | ~$0.0002 after the allowance, $0 inside it | $0 (in Workers Paid) | ~10-25 s, + ~3 s cold start | this folder |
| Cloudflare Stream watermark profile | ~$0.0002 (10 s delivered once) | $5/month prepaid storage | upload + encode + MP4 download, ~30-90 s | Stream subscription and a Stream token |
| Vast.ai batch | ~$0.02 per batch (box minimum) | none | minutes to hours | queue, boot, image pull, guarding the box |
| Media Transformations | - | - | - | no overlay option: cannot draw a mark |

Containers cost nothing extra on Workers Paid until 375 vCPU-minutes, 25 GiB-hours and 200 GB-hours a month
(thousands of free clips), then $0.000020 per vCPU-second, $0.0000025 per GiB-second and $0.00000007 per
GB-second. An idle box bills memory and disk until it sleeps (2 minutes): about $0.0003 per wake-up. The exact
measured numbers of every build are in the summary of the `watermark` workflow run (`try.sh`, on 1/4 vCPU).

## Deploy (owner's OK first)

1. Copy `github-workflow.yml` to `.github/workflows/watermark.yml` (GitHub's web editor: Add file, Create new file).
   Pushing workflow files needs the `workflow` scope, which Claude's GitHub token does not have.
2. Add the repository secret `CLOUDFLARE_API_TOKEN` (a token on the Kleo account with Workers Scripts: Edit and
   Containers: Edit).
3. Actions, `watermark`, "Run workflow" on `main` with deploy ticked. wrangler builds the image on GitHub's runner
   and pushes it to Cloudflare's registry. Every run also tries the image on two test clips and prints the cost.
4. In `wrangler.studio.jsonc`, uncomment the `WATERMARK` service binding, then deploy kleo-studio from main.

Until step 4 free clips are kept and served clean (fail open); free pictures are marked as soon as kleo-studio is
deployed with the `IMAGES` binding.

## Changing the mark

Replace `made-with-kleo.png` here and in `studio-web/`, and keep `MARK_W`/`MARK_H` in `server.py` and
`src/studio/watermark.ts` equal to its size. Where it sits is `placement()` in `server.py` and `markPlacement()` in
`src/studio/watermark.ts`: change both together.
