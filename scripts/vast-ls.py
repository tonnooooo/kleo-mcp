#!/usr/bin/env python3
"""
Chi sta bruciando il credito Vast, adesso.

    python3 scripts/vast-ls.py            elenca le macchine accese, dice di chi sono e quanto costano
    python3 scripts/vast-ls.py --stop ID  spegne UNA macchina, quella e basta

Il 10 settembre il credito e' finito con macchine accese che non stavano facendo niente. Il server si pulisce da
solo le GPU che ha noleggiato lui (orchestrator.ts, giro degli orfani), ma NESSUNO controlla quelle aperte a mano
da una sessione di lavoro: restano accese finche' qualcuno se ne ricorda.

Questo script non spegne niente da solo, di proposito. L'account Vast e' condiviso con un'altra persona, e una
macchina che questo script non riconosce puo' benissimo essere sua: spegnerla sarebbe distruggere il lavoro di
qualcuno per far tornare i conti a noi. Elenca, spiega, e ti prepara il comando; il dito sul bottone e' tuo.

Legge VAST_API_KEY da .secrets.local, come devbox.py. Non tocca scripts/.devbox.json (e' condiviso).
"""
import json, os, re, sys, time
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://console.vast.ai/api"


def key() -> str:
    for line in open(os.path.join(ROOT, ".secrets.local")):
        if line.startswith("VAST_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("VAST_API_KEY non e' in .secrets.local")


def api(path: str, method: str = "GET"):
    req = urllib.request.Request(f"{API}{path}", method=method,
                                 headers={"Authorization": f"Bearer {key()}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Vast ha risposto {e.code}: {e.read().decode()[:200]}")


# L'etichetta e' l'unico appiglio su una macchina accesa: src/backends/vast.ts la crea sempre come "kleo-<id job>".
def whose(label: str) -> tuple[str, bool]:
    """(descrizione, la sorveglia il server?)"""
    label = label or ""
    if re.fullmatch(r"kleo-gt_[a-z0-9]+", label):
        return f"render di produzione (video {label[5:]}) — il server la spegne da solo", True
    if label == "kleo-devbox":
        return "macchina di prova aperta a mano da una sessione — NESSUNO la spegne", False
    if label.startswith("keou-job-"):
        return "render lanciato a mano da una sessione — NESSUNO la spegne", False
    if not label:
        return "senza etichetta: non e' di Kleo, forse e' dell'altra persona sull'account", False
    return f"etichetta sconosciuta ({label}): non la riconosco, chiedi prima di spegnerla", False


def human(hours: float) -> str:
    if hours < 1:
        return f"{int(hours * 60)} min"
    return f"{int(hours)}h {int((hours % 1) * 60):02d}m"


def listing() -> int:
    d = api("/v1/instances/")
    rows = d.get("instances") or []
    credit = float(api("/v0/users/current/").get("credit") or 0)

    if not rows:
        print(f"Nessuna macchina accesa. Credito: {credit:.2f} $.")
        return 0

    now = time.time()
    print(f"{len(rows)} macchine accese · credito {credit:.2f} $\n")
    burn = 0.0
    unmanaged = []
    for i in rows:
        dph = float(i.get("dph_total") or 0)
        burn += dph
        started = float(i.get("start_date") or 0)
        up = (now - started) / 3600 if started else 0.0
        desc, managed = whose(i.get("label"))
        print(f"  id {i.get('id')}  {i.get('gpu_name', '?'):<14} {dph:>5.3f} $/h  accesa da {human(up):<9} "
              f"speso ~{dph * up:>5.2f} $  [{i.get('actual_status')}]")
        print(f"      {desc}")
        if not managed:
            unmanaged.append((i.get("id"), dph, up))
    print()
    print(f"  Totale: {burn:.3f} $/ora.", end=" ")
    if burn > 0:
        print(f"A questo ritmo il credito finisce fra {human(credit / burn)}.")
        print("  Quando il credito finisce, i video degli utenti smettono di partire.")
    else:
        print()

    if unmanaged:
        print(f"\n  {len(unmanaged)} macchine che nessun programma spegnera' mai da solo"
              f" ({sum(d for _, d, _ in unmanaged):.3f} $/h in tutto).")
        print("  Se hai finito di usarle:")
        for iid, _, _ in unmanaged:
            print(f"      python3 scripts/vast-ls.py --stop {iid}")
    return 0


def stop(iid: str) -> int:
    rows = (api("/v1/instances/").get("instances") or [])
    me = next((i for i in rows if str(i.get("id")) == str(iid)), None)
    if not me:
        raise SystemExit(f"La macchina {iid} non risulta accesa. `python3 scripts/vast-ls.py` per l'elenco vero.")
    desc, managed = whose(me.get("label"))
    print(f"id {iid} · {me.get('gpu_name')} · {float(me.get('dph_total') or 0):.3f} $/h\n  {desc}")
    if managed:
        # Un render di produzione non si spegne a mano: butti via il video di un utente a meta', e il server
        # rinoleggia comunque. Si mette in pausa Kleo (/internal/admin/pause), non si stacca la spina alla GPU.
        raise SystemExit("\nQuesta macchina sta rendendo il video di un utente e la spegne il server quando ha finito.\n"
                         "Per fermare la spesa usa la pausa di Kleo, non questo comando.")
    api(f"/v0/instances/{iid}/", method="DELETE")
    print("spenta.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--stop":
        sys.exit(stop(sys.argv[2]))
    if len(sys.argv) > 1:
        raise SystemExit(__doc__)
    sys.exit(listing())
