# From script to video

## 1. Create a project

For an exact supplied script: `python keou.py intake /absolute/path/script.txt --id my-topic`. This archives it and records `awaiting_editorial_preparation`; it does not generate a storyboard.

For a topic you want the assistant to develop: `python kit.py new my-topic`. This copies only the editable source/assets, not the old output, and marks the project `draft`. Do not render the untouched example under a new name and present it as original work.

## 2. Prepare editorially

Choose one question and one takeaway. Write a hook, a useful explanation and a concise ending. Use roughly 110–150 spoken words as a starting point for a short; actual voice timing determines duration. Avoid pronunciation-ambiguous abbreviations and spell numbers in narration. On-screen digits remain concise.

Use the existing compositions. Write short screen titles, choose visuals that explain the subject, source claims and record image credits. Save the final narration in script.txt exactly as the concatenated `voice` fields, apart from whitespace. When a supplied script must change, obtain its author's authorization first.

Set `editorial_status` to `ready` only after reviewing project.json and assets. `max_duration` is a ceiling, not a target or automatic trimming instruction.

## 3. Check before rendering

```bash
python keou.py check projects/my-topic/project.json
python kit.py layout projects/my-topic/project.json
```

Layout is optional and needs Node/Chromium. It writes `layout-preview/out/qa/`; the timing is explicitly synthetic, unsuitable for delivery. Inspect long headings, captions, small diagram labels and credits. Fix content before considering engine changes.

## 4. Produce

```bash
python keou.py run projects/my-topic/project.json --budget 1 --minutes 60
```

Keep the host awake. Setup on a fresh provider machine may take 10–20 minutes, depending on bandwidth. Narration, alignment, mixing, animation, verification and transfer follow. The worker renders two non-overlapping frame segments and can reuse verified caches.

## 5. Review and deliver

Run `python kit.py verify projects/my-topic/project.json`. Inspect `out/FINAL-QA.json`, scene images, captions and the real preview. Check language, pronunciation, pacing, story and factual accuracy. Confirm the run registry says `destroyed` with `download_verified: true`. The main controller automatically updates latest.json and the two media shortcuts only after success.

Keep one delivered master per project. Corrections should be justified by a specific issue. Record the change; do not launch repeated aesthetic redesigns when the user has approved the style.
