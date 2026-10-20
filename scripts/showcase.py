"""
Builds studio-web/showcase.json, the videos the app shows on Explore, on the Create page and on the Video page
(14 October 2026: the owner wants every finished Kleo video inside the app, like Higgsfield's feed).

Sources:
  - the site's gallery (kleo-site gallery/films.json): the clips already on https://media.kleooai.com/gallery/
  - optionally the encode manifest written when new videos are uploaded (marketing/sito-video/bomb/manifest.json)

Every entry: slug, title, line, format (wide | tall | square), seconds, prompt (what to type to make something like
it), preview (short muted loop), full (the whole clip, muted), poster. None of these went through Kleo itself, so
the app credits "the Kleo team", never "made with Kleo".

Usage: python scripts/showcase.py <kleo-site>/gallery/films.json [manifest.json ...]
"""
import json
import re
import sys
from pathlib import Path

MEDIA = "https://media.kleooai.com/gallery"
OUT = Path(__file__).resolve().parent.parent / "studio-web" / "showcase.json"


def clean_prompt(p: str) -> str:
    # The site's prompts are written for an AI assistant ("Use Kleo to make a 15-second 16:9 film, realistic look:
    # ..."); in the app the person types the picture itself.
    # The colon that ends the instruction is never one between digits (the "16:9" before it).
    p = re.sub(r"^\s*Use Kleo to (?:make|create)\b.*?(?<!\d):(?!\d)\s*", "", (p or "").strip(), flags=re.I | re.S)
    return p[:1].upper() + p[1:] if p else p


def fmt_of(w, h, section=None):
    if section in ("wide", "tall", "square"):
        return section
    if w and h:
        r = w / h
        return "wide" if r > 1.2 else "tall" if r < 0.85 else "square"
    return "wide"


SECTION_FORMAT = {"wide": "wide", "ads-wide": "wide", "tall": "tall", "series": "tall", "ads-tall": "tall"}

# Videos the owner took out of the app on 20 October 2026: the older connector-era ads. They stay on the website.
HIDDEN = {
    "claude-chat-to-film-30s", "add-kleo-to-claude-p3", "opus-lighthouse-ad", "your-next-film-30s",
    "apex-in-claude-35s", "kleo-ad-v2-lighthouse", "kleo-reel-r3-tall",
    "tether-not-filmed-wide", "films-in-claude-52s", "type-the-film-30s",
}


def from_gallery(path):
    out = []
    for f in json.loads(Path(path).read_text(encoding="utf-8")):
        slug = f["slug"]
        line = f.get("line", "")
        # Ads carry no prompt: "Ask Kleo" then starts from what the ad shows.
        prompt = clean_prompt(f.get("prompt", "")) or (f"Make a short film like this: {line}" if line else "")
        # `full: false` in the site's list = only the clean loop may be shown (the whole cut has outdated parts).
        full = f"{MEDIA}/{slug}-p.mp4" if f.get("full") is False else f"{MEDIA}/{slug}.mp4"
        out.append({
            "slug": slug, "title": f.get("title", slug), "line": line,
            "format": SECTION_FORMAT.get(f.get("section")) or fmt_of(f.get("w"), f.get("h")),
            "seconds": f.get("dur"), "prompt": prompt, "kind": "ad" if str(f.get("section", "")).startswith("ads") else "film",
            "preview": f"{MEDIA}/{slug}-p.mp4", "full": full, "poster": f"{MEDIA}/{slug}.jpg",
        })
    return out


def from_manifest(path):
    out = []
    for m in json.loads(Path(path).read_text(encoding="utf-8")):
        files = m.get("files", {})
        url = lambda v: v if not v or v.startswith("http") else f"{MEDIA}/{v.split('/')[-1]}"
        out.append({
            "slug": m["slug"], "title": m.get("title", m["slug"]), "line": m.get("line", ""),
            "format": fmt_of(None, None, m.get("format")), "seconds": m.get("seconds"),
            "prompt": clean_prompt(m.get("prompt", "") or m.get("line", "")),
            "preview": url(files.get("preview")) or f"{MEDIA}/{m['slug']}-p.mp4",
            "full": url(files.get("full")) or f"{MEDIA}/{m['slug']}.mp4",
            "poster": url(files.get("poster")) or f"{MEDIA}/{m['slug']}.jpg",
        })
    return out


def main(args):
    if not args:
        sys.exit(__doc__)
    items, seen = [], set()
    for i, path in enumerate(args):
        for x in (from_gallery(path) if i == 0 else from_manifest(path)):
            if x["slug"] not in seen and x["slug"] not in HIDDEN:
                seen.add(x["slug"])
                items.append(x)
    OUT.write_text(json.dumps(items, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(items)} videos -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1:])
