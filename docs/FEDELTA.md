# The fidelity engine (24 September 2026)

**The problem, in numbers.** The owner, 24 September: "Kleo makes videos at random; the adapt prompting is terrible;
it does not follow the images, it does not follow anything." Measured on 18 real production jobs (9-22 September):
of the 176 concrete requirements users wrote, 70% reached the film, 15% were watered down, 5% were lost and **10% were
contradicted** on screen (a red apron instead of a lilac one, three different women for one pastry chef, the hero
dressed as the villain); 22 inventions changed the films. 10 of 15 films ran longer than asked.

**The causes were in Kleo's method, not in the models.** Found with file:line evidence by six parallel readers:

| Cause | Where it was |
|---|---|
| A narrative "device" and an "opening" **drawn at random** for every film (the witness, the countdown, the empty room…), even for users who described their story scene by scene | `src/treatment.ts` `variationFor`, `DEVICES`, `OPENINGS` |
| The method ordered the writer to replace the user's story with an invented "angle", and the direction took the angle as its subject | `MASTER_PROMPT` step 1, `storyboard.ts` |
| Every film up to 90 s forced into the HOOK / REVEAL / PROOF / TURN explainer skeleton | `templates.ts` family `short-hook` |
| Request sentences containing "narrator", "vertical", "the 90s"… **deleted** before planning | `direction.ts` `storyRequest` |
| Every requirement with an appearance word ("hair", "apron", "tall") **dropped** from the list of facts | `direction.ts` `dropLookFacts` |
| The fidelity check: 60% of the words of 8 facts anywhere in the narration, and only as a warning | `direction.ts` `missingFacts` |
| The picture prompt **cut at 77 tokens** (SDXL's CLIP): scene 150 characters, character look 110, the world never sent | `worker/kleo_pictures.py` |
| Nobody looked at the pictures: a still was accepted when its file was not empty | `kleo_pictures.py`, `footage.ts` |
| The user's own images could not enter at all | `mcp.ts`, the contract |
| The intake's optional answers (what must appear, audience, tone) died before the planner | `mcp.ts`, `jobs.ts` |

## How it works now

1. **The spec** (`src/spec.ts`). Before any creative decision the request is taken apart into atomic, checkable
   requirements: characters with their COMPLETE look, places, objects, actions, **ordered events**, described shots,
   style, words to be read on screen, lines to be said, what must not appear, reference images. Each requirement has an
   id (R1, R2…), the **user's exact quote** (the proof it was not invented: an item without one is dropped) and whether
   it is a must. Two modes: **faithful** (the user described their film: it is their film) and **open** (only a
   subject, or "surprise me": Kleo invents, contradicting nothing).
2. **The treatment under the spec.** Faithful mode draws nothing (device `as-told`, opening `as-asked`), keeps no angle
   that replaces the story, runs at temperature 0.4, allows spectacle when asked, keeps the user's character names.
   Kleo's additions go into "decisions", which the user sees.
3. **Direction, outline and scenes under the spec.** The cast is the user's with the whole look (up to 420 characters);
   sections follow the treatment's acts, not the explainer skeleton; every scene says which requirements it covers;
   **every shot declares** `covers` (the requirements it shows), `cast` (who is in it) and `action` (what moves).
   Deterministic checks on every chunk of scenes — a must requirement not covered, events out of order, unknown ids —
   send it back. At the end a **judge** reads the plan against the spec and one repair round fixes losses (kept only
   when it is not worse).
4. **The server draws the stills** (`src/stills.ts`), before a GPU is rented, with **FLUX.2 klein** on Workers AI: long
   prompts (no 77-token cut), readable words when asked for. First a **character sheet** per cast member (from the
   user's photo when there is one), then every shot with the sheets of the characters in it as **reference images**:
   the same face in every scene.
5. **The vision judge** (`src/vision.ts`, Llama 4 Scout). Every still gets one yes/no question per requirement it
   claims, plus the characters' looks, the style, the exclusions and stray text. A failed must is redrawn with the
   failure written first in the prompt and a new seed; the best try is kept. Report in `renders/<job>/fidelity.json`,
   summarised in the result the user receives.
6. **The user's images** (`src/refs.ts`, `src/upload.ts`, tool `kleo_upload_link`): an https link, or a signed upload
   page (48 h, 8 images, 12 MB each, phone friendly). Kleo describes them, binds them to the character or object, and
   draws **from** them.
7. **The assistant flow** (Claude, ChatGPT): `kleo_adapt_prompt` hands over the spec method first, then the treatment
   method; the assistant shows the user in ONE message "this is what I understood" (characters, where, what happens in
   order, what is seen or said) and waits for a yes or corrections, which travel as `corrections`.

## Cost (the owner's rule: radical, but spend no more than today)

A 30 s animatic, before: Sonnet 5 planner on OpenRouter ≈ $0.12 + Vast box ≈ $0.05 = **≈ $0.17**.
Now: planner on Workers AI ≈ $0.03-0.06 + klein-4b stills ≈ $0.002 each (≈ $0.04 for 12 with redraws) + judge ≈ $0.01
+ a shorter Vast box (the GPU no longer draws) ≈ $0.035 = **≈ $0.12-0.15**.

- `STILL_MODEL` = `@cf/black-forest-labs/flux-2-klein-4b` ($0.000287 per 512² output tile, ≈ $0.0023 for a 896x1600
  still). `STILL_MODEL_STRONG` = klein-9b ($0.016) only for the last try of a still that failed a look, identity or text must; `none` = never.
- `STILL_ATTEMPTS` (2 since 24 Sep, was 3), `STILL_PASS` (0.85, only a tie-breaker between failed tries), `VISION_MODEL`
  (llama-4-scout), `STILLS_ENGINE` (`flux2`; `legacy` = the old SDXL on the GPU).
- An external planner that runs out of credit (401/402/403) falls back by itself to `PLAN_FALLBACK_MODEL` or
  `AI_MODEL` on Workers AI; a 429 stays a pause.

## How it is measured

`scripts/fidelity-bench/` (README there): 18 cases with hand-written requirement lists, planned by the old code
(`../wt-baseline`, dab7084) and by the new code on the same model, judged by a model different from the ones inside
Kleo; then the stills of a subset, drawn the old way and the new way, judged question by question.

## Benchmark results (24 September 2026)

**Plans** — 18 cases, 146 must requirements, independent judge (gemma-4, 3 votes), same planning model for both
(gpt-oss-120b on Workers AI):

| | old code (dab7084) | new code |
|---|---|---|
| plans that succeeded | 17/18 (the exclusion case failed twice) | 18/18 |
| fidelity (kept + ½ paraphrased) | 90% | **99%** |
| lost | 8% | 1% |
| events out of the user's order | 2 of 34 | 0 of 35 |
| major inventions | 2 | 0 |
| quoted lines / texts present | 6/8 | 8/8 |
| dictated narration (verbatim case) | 63% | 83%, then exact once the voice is set by code |
| exclusions ("no people", "no blood") | 33% | 100% |

Planning models on the 6 hardest cases (new code): gpt-oss-120b 97% at 481 s a film ($0.03); Kimi K2.6 94% at 172 s
($0.07); **Kimi for the scenes + gpt-oss for the spec and the judge: 98%, no contradiction, 313 s, $0.06** — the
production setting (`AI_MODEL`, `SPEC_MODEL`, `JUDGE_MODEL`). The old code on the same 6 cases: 80%.

**Stills** — 5 cases, 43-53 stills, every still asked one question per visual requirement by a vision model that is not
Kleo's in-loop judge:

| | old (SDXL, 77-token prompt) | new, klein-4b + judge | new, + klein-9b escalation |
|---|---|---|---|
| visual must requirements shown somewhere in the film | 41% | 61% | 65% |
| look attributes that hold when the character is in the picture | 38% (n 16) | 79% (n 42) | 75% (n 53) |
| same character across pictures | 0% (4 pairs) | 94% (16 pairs) | 90% (20 pairs) |
| cost per still, judge included | (GPU time) | ~$0.0086 | ~$0.016 |

Escalation to klein-9b buys four points for twice the price: it is off in production (`STILL_MODEL_STRONG` = `none`).
