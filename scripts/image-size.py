#!/usr/bin/env python3
"""
Quanto pesa l'immagine del worker, strato per strato, e con quale compressione.

    python3 scripts/image-size.py                 confronta :keou con :keou-zstd
    python3 scripts/image-size.py keou latest     due tag qualunque

Perche' esiste: fino a meta' del tempo di consegna di un video e' una scheda noleggiata, accesa e pagata, che
scompatta questo file. E NON e' la rete — ghcr serve 7,8 GB in circa tre minuti e il pull ne dura tredici-venti.
gzip scompatta con un thread per strato, e due strati fanno 7 GB dei 7,8: sono due thread per quasi tutto il peso.
Da cui le due leve, in docs/PULL-IMMAGINE.md: strati piu' piccoli, o zstd al posto di gzip.

Questo script legge SOLO il registro pubblico via HTTP. Non scarica l'immagine, non noleggia niente, non tocca la
GPU e non usa un credito. Il numero che conta davvero — quanto dura il pull su una macchina vera — lo misura
scripts/pulltest.py, che quello si' noleggia.
"""
import json, sys, urllib.request, urllib.error

REPO = "tonnooooo/kleo-worker"
ACCEPT = ",".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def get(url, token=None, accept=ACCEPT):
    req = urllib.request.Request(url, headers={"Accept": accept})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def token():
    return get(f"https://ghcr.io/token?scope=repository:{REPO}:pull&service=ghcr.io", accept="application/json")["token"]


def manifest(tag, tk):
    """Il manifesto amd64, seguendo l'indice quando il tag ne ha uno."""
    d = get(f"https://ghcr.io/v2/{REPO}/manifests/{tag}", tk)
    if "manifests" in d:
        amd = [m for m in d["manifests"] if (m.get("platform") or {}).get("architecture") == "amd64"]
        if not amd:
            raise SystemExit(f"{tag}: nessun manifesto amd64")
        d = get(f"https://ghcr.io/v2/{REPO}/manifests/{amd[0]['digest']}", tk)
    return d


def kind(media):
    """gzip o zstd, dal tipo di media dello strato."""
    m = (media or "").lower()
    return "zstd" if "zstd" in m else "gzip" if "gzip" in m else m.rsplit(".", 1)[-1] or "?"


def report(tag, tk):
    try:
        d = manifest(tag, tk)
    except urllib.error.HTTPError as e:
        print(f"  {tag:<12} non c'e' ancora ({e.code}) — costruiscilo con il workflow worker-image-zstd")
        return None
    layers = d.get("layers") or []
    total = sum(l.get("size", 0) for l in layers)
    comp = sorted({kind(l.get("mediaType")) for l in layers})
    big = sorted((l.get("size", 0) for l in layers), reverse=True)[:2]
    share = sum(big) / total * 100 if total else 0
    print(f"  {tag:<12} {len(layers):>2} strati · {total / 1e9:5.2f} GB · {'+'.join(comp)}")
    print(f"  {'':<12} i due piu' grossi: {big[0] / 1e9:.2f} + {big[1] / 1e9:.2f} GB = {share:.0f}% del peso"
          if len(big) > 1 else "")
    return total


def main():
    tags = sys.argv[1:] or ["keou", "keou-zstd"]
    tk = token()
    print(f"\nghcr.io/{REPO}\n")
    sizes = {t: report(t, tk) for t in tags}
    got = {t: s for t, s in sizes.items() if s}
    if len(got) > 1:
        a, b = list(got)[:2]
        d = (got[b] - got[a]) / got[a] * 100
        print(f"\n  {b} pesa il {abs(d):.0f}% {'in piu' if d > 0 else 'in meno'} di {a}.")
    print("\n  Il peso non e' il collo di bottiglia: lo e' la scompattazione. Il numero che decide e' quanto dura")
    print("  il pull su una macchina vera:  python3 scripts/pulltest.py " + " ".join(tags) + "\n")


if __name__ == "__main__":
    main()
