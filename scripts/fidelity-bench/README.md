# Fidelity bench

How faithfully Kleo turns a request into a **plan** (treatment → direction → scenes → image prompts) and into **pictures**,
measured the same way before and after the Fidelity Engine (24 September 2026). The owner's complaint it answers:
"Kleo makes videos at random … it does not follow anything". The production audit of 18 jobs found 70% of 176 user
requirements kept, 10% contradicted and 22 inventions; this bench makes that measurement repeatable on 18 fixed cases.

Everything runs on **Workers AI through the REST API** from this folder's scripts, with Kleo's own `src/*.ts` imported
directly (Node 24 strips the TypeScript types). Nothing is rendered, no GPU is rented, no kie.ai task is created.

## Files

| file | what it is |
|---|---|
| `cases.json` | 18 requests (Italian and English, realistic and animation, 15-60 s, 9:16 and 16:9) with a **gold list** each: 149 atomic requirements written by hand from the prompt's words only — never by a model, never by Kleo's spec writer. Four are real production failures (the pastry chef, the Star-Wars-like Short, the red/blue car race, the whale in Venice); the others each stress one loss type (several characters with distinct looks, a five-event story, a dictated narration, a described opening shot, on-screen text, exclusions, a style reference with a decade, a bare subject in open mode, a named fictional product, an animal's markings, spectacle). |
| `lib.mjs` | REST client (JSON, multipart, binary answers, retries on 429/5xx), the `env` shim src/ receives (`env.AI.run` returning the binding's `result`, an in-memory R2), the cost ledger, helpers. |
| `plan.mjs` | Step 1: plans every case with a given `src` tree. |
| `judge.mjs` | Step 2: an independent judge labels every gold item on every plan; writes the before/after report. |
| `stills.mjs` | Step 3: draws a subset's pictures with the new engine and with a legacy proxy, judges every picture, writes contact sheets. |
| `out/` | Everything the steps write (git-ignored). |

## Running it

The token is wrangler's OAuth token (`%APPDATA%\xdg.config\.wrangler\config\default.toml`, or `~/.config/.wrangler/…`),
or `CLOUDFLARE_API_TOKEN`. The OAuth token lasts about an hour: `npx wrangler whoami` refreshes it. Account
`e4a5a1308df5b44c65497b85210c6845` (override with `CLOUDFLARE_ACCOUNT_ID`). Write a line in
`scripts/direction-measure/QUOTA.md` before a full run: the Workers AI bill is shared by every session.

The old code is a second worktree at production `dab7084` (`C:\Users\leona_wadij0y\kleo\wt-baseline`, already there);
the new code is this worktree's `src`. From the repository root:

```sh
# 1. plan all 18 cases, old and new (same model, same job ids, so the same random draws in the old code)
node scripts/fidelity-bench/plan.mjs --src ../wt-baseline/src --run old
node scripts/fidelity-bench/plan.mjs --src src              --run new

# 2. judge both and write out/report-old-vs-new.md
node scripts/fidelity-bench/judge.mjs --runs old,new

# 3. pictures for a subset: the old plans drawn the old way, the new plans drawn by the new engine
node scripts/fidelity-bench/stills.mjs --runs old:legacy,new:new \
     --cases pastry-chef,treehouse-friends,diner-sign,odd-eyed-cat,flooded-town
#    → out/stills-report-old-legacy-vs-new-new.md, out/<run>/stills-<engine>/index.html
```

Useful options:

- `plan.mjs --model <id>` (default `@cf/moonshotai/kimi-k2.6`; production's `AI_MODEL` is `@cf/openai/gpt-oss-120b`),
  `--cases a,b`, `--concurrency 2`, `--retries 1` (a failed plan is retried once, as the orchestrator does),
  `--budget-min 12` (PLAN_BUDGET_MIN), `--vars SPEC_MODEL=…,JUDGE_MODEL=…` (any env var), `--force` (re-plan a case
  that already has a successful plan; otherwise it is reused).
- `plan.mjs --thinking off|on` (default **off**): kimi-k2.6 is a hybrid model. With thinking on, every planner call of
  the first smoke run came back empty — the reasoning ate the planner's `max_tokens` (1,800 for a treatment) — and a
  call given room would outlast storyboard.ts's 90-second call timeout. Off sends `chat_template_kwargs {thinking:false}`
  (kimi's instant mode: the same probe answered in 1 s instead of 19). `--min-max-tokens N` floors `max_tokens` instead.
  Both runs must use the same setting.
- `judge.mjs --judge <id>` (default `@cf/google/gemma-4-26b-a4b-it`), `--repeat 3` (majority vote per item; ties go to
  "paraphrased"), `--judge-thinking on` (default off: with thinking on, gemma spent 8,000 tokens and 103 s on one film
  and answered nothing), `--with-action` (also show the new shots' `action` to the judge; off by default because the
  animatic product never films it and the old plans have none).
- `stills.mjs --src <dir>` (the tree whose `stills.ts` draws; skipped when it has none), `--vision <id>` (the engine's
  in-loop judge, default VISION_MODEL = llama-4-scout), `--attempts 3`, `--pass 0.85`, `--max-shots N` (cap per case),
  `--max-pairs 6` (identity pairs per character), `--no-identity`, `--judge <id>` (default gemma-4: it must NOT be the
  in-loop model), `--force`. Pairs can mix freely: `old:new` draws an old plan with the new engine (no spec, so the
  direction's cast becomes the sheets), `new:legacy` a new plan the old way — that separates what the planner changed
  from what the drawing changed.

Every step is resumable: an existing successful plan, a drawn still, and a judge answer (keyed by model + prompt +
image bytes) are reused unless `--force`.

## What the numbers mean

**Plans (judge.mjs).** Only MUST gold items are scored; optional ones are listed but never counted.

- *kept* — delivered as specified, every specific (colour, number, name, who does what) present.
- *paraphrased* — present but weakened or partial; a VISUAL item that is only said in the narration and never described
  in a picture; a line said in other words.
- *lost* — absent.
- *contradicted* — the film shows or says something incompatible (brunette for blonde, the excluded thing appears,
  another ending that negates it).
- **fidelity** = (kept + ½ paraphrased) / judged must items — pooled over all items, and as a mean of cases. A case
  whose plan failed counts every item lost (and is listed as a failure); "mean of planned cases only" leaves failures out.
- *events out of order* — the user's ordered events, placed at the first shot the judge says shows them, that come
  before an earlier event.
- *major inventions* — additions that change what the film is about or what happens (new main character, different
  place, added twist, framing device), counted on FAITHFUL cases only; the open case (`octopus-open`) may invent.
- *quoted lines/texts present* — deterministic: the words the user quoted for the narrator are in the narration, the
  words for a sign are in a picture description or caption. When the model's label disagrees, `det_disagree` lists it.
- *Kleo's own score* — the new planner's self-judged fidelity (src/fidelity.ts), beside the independent one: how far to
  trust the in-loop judge.

The judge sees what a viewer gets — narration, every image_prompt, captions, the direction's cast looks and world —
and never Kleo's own claims (spec, `covers`, the fidelity report). The gold ids are the bench's, not the spec's.

**Pictures (stills.mjs).** Every still is asked one yes/no question per VISUAL gold item of its case, plus the look
(photograph vs 2D animation), by a vision model that is not the engine's in-loop judge. The questions are asked of
every picture because the gold ids cannot be mapped to a shot's `covers` (those name the spec's items).

- *visual must items shown somewhere* — an item counts when any picture of the film shows it (`"at": "first"|"last"`
  pins a framing to that picture). The picture-side equivalent of the plan's fidelity.
- *look attributes that hold* — over every picture where a character is present, the share where each of their look
  items (`who` in cases.json) is answered yes: "blonde, short, tied up, lilac apron" in every shot of the chef.
- *same character across pictures* — the first picture of each character against each later one (two images, "the same
  individual?"). Crowds (`"group": true`) are skipped.
- *exclusions broken* — an exclude item answered yes on any picture.
- The legacy proxy reproduces `worker/kleo_pictures.py` `full_prompt` exactly (image_prompt cut at 150 characters on a
  word, the cast's "name: look" in front only when it fits 110 characters whole, the look's style suffix, the per-film
  negative) and draws with SDXL-lightning (8 steps: at its default of 20 with a negative prompt it returned a black
  frame on the smoke run; a frame under 30 KB is redrawn once on the next seed and flagged `blank`). It is a proxy —
  RealVisXL / DreamShaper XL on the rented card are other SDXL checkpoints — but it carries the two defects that
  matter: the 77-token CLIP cut and no reference for a character's face.
- Judge prompts put the image FIRST and ask for a one-line description before the answers: with the text first, gemma-4
  answered "no" to all eight questions of a smoke still, "is this a photograph" included; image-first it was right on
  all eight. The description is on the contact sheet ("judge saw: …").

## Cost (Workers AI prices read 24 September 2026)

| model | price | used by |
|---|---|---|
| `@cf/moonshotai/kimi-k2.6` | $0.95 / M in, $4.00 / M out | planning |
| `@cf/google/gemma-4-26b-a4b-it` | $0.10 / M in, $0.30 / M out | plan judge, still judge |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | $0.27 / M in, $0.85 / M out | the engine's in-loop vision judge |
| `@cf/black-forest-labs/flux-2-klein-9b` | $0.015 first MP, $0.002 each further MP, $0.002 per input-image MP | new stills and character sheets |
| `@cf/bytedance/stable-diffusion-xl-lightning` | not on the price list (beta) | legacy proxy |

Measured on the smoke runs: one 15-second plan on the old code, kimi instant, 6 calls, 17 k tokens in / 3.4 k out,
**$0.03** in 56 s; judging it **$0.0003**; two new-engine stills with one redraw **$0.065** (≈ $0.02 per draw at
768×1344 with its judge); legacy stills free.

Estimate for a full bench: planning ≈ $0.04-0.10 per case old and ≈ $0.06-0.15 new (the spec, the plan judge and a
repair round add calls) → **$1-3 for both runs of 18 cases**, 20-40 minutes each at concurrency 2; judging ≈ $0.01
for both runs (×3 with `--repeat 3`); stills ≈ $0.2-0.4 per case with the new engine (6-12 shots, sheets, ~1.5 draws
each) → **$1-2 for five cases**, legacy free, still judging < $0.05. **About $3-5 all in.** Every script prints the
ledger's actual total at the end, and each output file carries its own cost.

## Notes from the smoke runs (24 September 2026)

- The old planner's scene ids on the diner case were `01-hook`, `02-reveal`, `03-proof`, `04-proof`, `05-turn`: the
  explainer skeleton imposed on a 15-second mood piece, as the audit said.
- The new engine drew "OPEN 24H" legibly at the first try (legacy: a garbled neon sign in an empty desert). On an OLD
  plan (no spec) its in-loop judge asks "no text in the picture?" and so failed the very sign the image_prompt asked for,
  and spent both of its attempts (--attempts 2) redrawing a correct picture: with a spec the sign is a `text` item and the check is not asked, but a spec-less film keeps
  paying for that redraw.
