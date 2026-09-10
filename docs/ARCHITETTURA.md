# Kleo — fattibilità e architettura

*Bozza del 9 settembre 2026, aggiornata il 10 settembre con lo stato reale (sezione 0). "Kleo" è un nome provvisorio. Prezzi verificati alla data, fonti in fondo.*

## 0. Decisione presa (9 settembre, sera)

**Server MCP su Cloudflare Workers, nessuna macchina virtuale, sito su GitHub Pages.** Costo fisso: 0 €. Motivi: un solo account da creare, HTTPS e OAuth già gestiti, nessun server da tenere aggiornato, e Oracle Always Free si è rivelato inadatto (quota dimezzata a giugno 2026, capacità spesso assente, istanze inattive spente, registrazione con carta che fallisce spesso). Il piano con la VM resta valido come alternativa (Hetzner, 6 €/mese), non Oracle. Il server è scritto e testato: vedi la cartella `kleo-mcp` e `DEPLOY.md`.

**Aggiornamento del 10 settembre.** Il motore di render in produzione non è la pipeline Wan/LTX/SeedVR2/RIFE descritta sotto ma **Keou**, il tuo motore di motion design: le scene sono disegnate da Chromium fotogramma per fotogramma, la voce è Kokoro (inglese e italiano), i sottotitoli sono allineati con whisper, il montaggio lo fa ffmpeg. Niente modelli video da scaricare: l'immagine (~11 GB) è pronta su `ghcr.io/tonnooooo/kleo-worker:keou` e il render è lavoro di CPU. Gli strumenti sono sette (si aggiunge `kleo_storyboard_guide`, con cui l'assistente scrive lo storyboard). Tempi reali: uno Short circa 10–20 minuti, un video lungo fino a circa un'ora; risoluzione 2160×3840 per i 9:16 e 1920×1080 per i 16:9, 60 fps. Stato aggiornato in `DEPLOY.md`, guida agli strumenti e ai client in `MCP-GUIDA.md`.

Le sezioni che seguono sono l'analisi di fattibilità originale: restano utili come ragionamento sui costi, con la sostituzione "VM Hetzner" → "Cloudflare Worker + D1 + R2 + KV + cron" e "modelli video" → "motore Keou".

## 1. Verdetto

Il progetto è fattibile e l'architettura che hai in mente è quella giusta: un server MCP pubblico, una coda di lavori, GPU accese solo durante il render, un link finale. È lo stesso schema che usano i servizi "remote MCP" già in produzione. Tre punti del piano vanno però corretti, perché così come sono descritti non funzionerebbero.

### Correzione 1: la chiamata MCP non può durare 30 minuti
Un tool MCP deve rispondere in secondi. Claude, ChatGPT e Grok chiudono la richiesta molto prima di 25 minuti. Il pattern corretto è asincrono:

- `kleo_create_video` mette il lavoro in coda e risponde subito con un `job_id`.
- `kleo_get_job` risponde con stato, percentuale, tempo stimato. L'assistente lo chiama quando l'utente chiede "a che punto è?".
- `kleo_get_result` risponde con i link di download.
- In più, notifica via email o Telegram quando è pronto, così l'utente non deve tenere la chat aperta.

Lo standard MCP (revisione 2026-07-28) ha anche l'estensione ufficiale **Tasks**: `tools/call` può restituire un handle e il client fa `tasks/get`. Usala quando i client la supportano, ma tieni sempre `kleo_get_job` come via di riserva.

### Correzione 2: il video non "arriva sul computer di Cristiano"
Un server MCP non può spingere un file da 500 MB dentro la chat. Il risultato è un **link firmato** a un file su storage (valido per esempio 7 giorni). Cristiano clicca e scarica. In Claude Code o Cursor, l'assistente può anche lanciare `curl` e scaricare nella cartella del progetto, ma è sempre un link.

### Correzione 3: il cold start su Vast.ai è il collo di bottiglia
"Creo l'istanza, scarico tutto, renderizzo, distruggo" è corretto ed è il modo più economico, ma se ogni volta scarichi 40–60 GB di modelli perdi 10–20 minuti e paghi la GPU mentre aspetta. Rimedi, in ordine di efficacia:

1. **Immagine Docker tua** con ComfyUI, nodi custom, ffmpeg, SeedVR2, RIFE già installati (Vast supporta immagini da Docker Hub e le salva come "template"). Niente `pip install` a ogni avvio.
2. **Modelli su Cloudflare R2**: egress gratuito, quindi scaricare 50 GB a ogni avvio costa zero. Filtra le offerte Vast con `inet_down > 500` e scarica in parallelo (`aria2c -x16` o `rclone`): 50 GB in 2–4 minuti.
3. **Script di avvio con autodistruzione**: l'istanza si distrugge da sola dopo N ore anche se il tuo orchestratore muore. È la protezione più importante contro una bolletta a sorpresa.
4. Valuta i **volumi** Vast e il loro **Serverless** (worker group con autoscaling) quando i volumi lo giustificano.

## 2. Il flusso

```
Cristiano ──(chat)──▶ Claude / ChatGPT / Grok
                         │  tools/call kleo_create_video
                         ▼
              ┌──────────────────────┐
              │  VM piccola (Hetzner) │  Caddy (HTTPS) + server MCP (FastMCP)
              │  Postgres: utenti,    │  OAuth 2.1 (login Google) + crediti
              │  job, crediti         │
              └──────────┬───────────┘
                         │ orchestratore: prende il job in coda
                         ▼
              ┌──────────────────────┐   1. vastai create instance (template Kleo)
              │  GPU effimera Vast.ai │   2. avvio: scarica modelli da R2, render
              │  RTX 4090 / 5090      │   3. upload MP4+SRT+JPG su R2, ping alla VM
              └──────────┬───────────┘   4. vastai destroy instance
                         ▼
              Cloudflare R2 ──(link firmato, 7 gg)──▶ kleo_get_result ──▶ chat di Cristiano
```

Il sito pubblico non ha bisogno della VM: è statico, sta gratis su **Cloudflare Pages** (`kleo.ai`), mentre la VM serve solo `mcp.kleo.ai`. Se preferisci tutto in un posto, Caddy sulla VM serve anche il sito senza problemi.

## 3. Tre livelli di infrastruttura, dal più semplice al più economico

| Livello | Cosa gestisci | Costo GPU per Short 45 s (4K 60) | Costo per video 5 min | Cold start | Tempo per andare online |
|---|---|---|---|---|---|
| **C. API** (fal.ai: Wan 2.2 720p $0,08/s; LTX-2 Pro 4K $0,24/s; Veo 3.1 $0,20–0,40/s) | niente GPU, solo orchestrazione + ffmpeg | $3,6 (Wan) – $10,8 (LTX 4K) | $24 – $72 | nessuno | giorni |
| **B. GPU serverless** (RunPod 4090 $1,10/h; Modal L40S $1,95/h) | immagine + volume modelli | $0,45 – $0,80 | $1,10 – $2,00 | 8 s (warm) – 2 min (freddo) | 1–2 settimane |
| **A. Vast.ai orchestrato** (4090 $0,30–0,39/h; 5090 $0,38/h; spot 4090 $0,13/h) | tutto: immagine, boot, retry, kill | $0,13 – $0,17 | $0,30 – $0,40 | 3–5 min ottimizzato, 10–20 min senza ottimizzare | 3–4 settimane |

Conclusione: il tuo piano (A) è 3 volte più economico del serverless e 20–60 volte più economico delle API. Ha senso **perché hai già la pipeline funzionante a mano**. Il consiglio è costruire il server MCP con un'interfaccia worker neutra (`render(job) -> file`) e partire con il worker Vast.ai, tenendo pronto un worker di riserva su RunPod per quando Vast non ha GPU disponibili o un host va male.

Prezzi indicativi di vendita coerenti con i costi sopra: Short 0,90 €, video lungo 3,50 €, abbonamento Creator 24 €/mese per 20 Short. Margine lordo sopra l'80% anche contando VM, storage e qualche retry.

## 4. Costi fissi

| Voce | Costo |
|---|---|
| VM Hetzner CX23 (2 vCPU, 4 GB, IPv4) | 5,99 €/mese |
| Alternativa: Oracle Always Free A1 (2 OCPU, 12 GB) | 0 € |
| Cloudflare R2 (storage) | $0,015/GB al mese, egress gratis, primi 10 GB gratis |
| Cloudflare Pages (sito) | 0 € |
| Dominio | ~10 €/anno |

Un video 4K 60 fps H.265 da 5 minuti pesa 0,8–1,5 GB; con cancellazione dopo 7 giorni, 1 000 video al mese costano circa 3–5 $ di storage.

## 5. Stack consigliato

- **Server MCP**: Python + FastMCP, trasporto Streamable HTTP, endpoint `/mcp`. FastMCP include i provider OAuth (Google, GitHub, WorkOS AuthKit): l'utente fa "Accedi con Google" la prima volta e i client MCP gestiscono il resto. Claude.ai, ChatGPT e Grok richiedono un server HTTPS pubblico; Claude.ai accetta anche server senza auth, ma un server pubblico senza auth vuol dire GPU pagate da te per chiunque.
- **Database**: Postgres (utenti, crediti, job, log). SQLite va bene per l'MVP.
- **Orchestratore**: un processo Python con loop: prende job `queued`, cerca offerta Vast (`vastai search offers 'gpu_name=RTX_4090 inet_down>500 reliability>0.98'`), crea istanza dal template, passa `job_id` e URL firmati come variabili d'ambiente, aspetta il callback, distrugge l'istanza. Timeout duro e retry su un altro host.
- **Worker (dentro l'istanza)**: immagine Docker con ComfyUI + nodi, script `render.py` che esegue le cinque tracce: script (LLM via API), voce (TTS), clip (Wan 2.2 A14B o LTX-2.5, in parallelo per scena), montaggio (ffmpeg: tagli sulla voce, sottotitoli ASS, musica), finitura (SeedVR2 a 2160p, RIFE a 60 fps, encode H.265). Carica su R2 e chiama `POST /internal/jobs/{id}/done`.
- **Storage**: R2 con URL firmati; bucket `renders/` con lifecycle di 7 giorni; bucket `models/` per i pesi.
- **Sito**: `index.html` statico (già pronto in questa cartella), Cloudflare Pages.
- **Notifiche**: email (Resend) o Telegram quando il job è `done`.

Nota sui modelli: LTX-2.5 (agosto 2026, pesi aperti) genera già 4K con audio da 16 GB di VRAM; Wan 2.2 resta il più solido a 720p e poi si scala con SeedVR2. Prova entrambi sul template Short e tieni quello con il miglior rapporto qualità/minuti.

## 6. Strumenti MCP (schema proposto)

```
kleo_list_templates()                      -> [{id, nome, formati, durata_min, durata_max, voci, crediti}] + crediti disponibili
kleo_storyboard_guide(template?, durata_s?) -> il formato dello storyboard con esempi (l'assistente lo scrive lui)
kleo_create_video(template, prompt, durata_s?, formato?, lingua?, voce?, notifica?, storyboard?)
                                      -> {job_id, eta_min, crediti}
kleo_get_job(job_id?)                      -> {stato, traccia, percentuale, eta_min}  (senza job_id: i video recenti)
kleo_get_result(job_id)                    -> {video_url, subtitles_url, thumbnail_url, expires_at}
kleo_generate_thumbnail(job_id | prompt)   -> non ancora attivo (risponde con un avviso)
kleo_cancel_job(job_id)                    -> {stato, crediti_restituiti}
```

Questo è lo schema realizzato (`src/mcp.ts`); la proposta originale aveva sei strumenti, senza la guida allo storyboard.

Regole di sicurezza da mettere dal primo giorno:
- crediti scalati alla creazione del job, non alla fine;
- massimo N job contemporanei per utente e massimo M istanze GPU in totale (es. 5), così il tetto di spesa oraria è noto;
- autodistruzione dell'istanza dopo 2 ore;
- log di ogni chiamata con utente e costo;
- prompt filtrati per contenuti vietati prima di spendere GPU.

## 7. Roadmap

1. **Settimana 1**: dominio, sito su Cloudflare Pages, VM con Caddy, server MCP con i sei strumenti (render finto), login Google, test da Claude.ai, Claude Code e ChatGPT.
2. **Settimana 2**: immagine Docker del worker, modelli su R2, script di render per il template "Short virale" (la tua procedura manuale, automatizzata), primo video reale end-to-end da una chat.
3. **Settimana 3**: gli altri template, sottotitoli, musica, upscale e 60 fps, notifiche, crediti con Stripe.
4. **Settimana 4**: beta chiusa con pochi amici, limiti di spesa, monitoraggio, poi lista d'attesa aperta.

## Fonti (settembre 2026)

- Vast.ai prezzi: getdeploying.com/vast-ai · CLI e API: docs.vast.ai/cli, docs.vast.ai/api-reference · template e immagini: docs.vast.ai/instances/templates
- RunPod: runpod.io/pricing, docs.runpod.io/serverless/pricing · Modal: modal.com/pricing
- fal.ai: fal.ai/pricing e pagine dei modelli Wan 2.2, LTX-2, Kling 2.5, Veo 3.1
- Hetzner: costgoat.com/pricing/hetzner · Oracle Always Free: docs.oracle.com (FreeTier) · R2: developers.cloudflare.com/r2/pricing · Pages: developers.cloudflare.com/pages
- Connettori: claude.com/docs/connectors/custom/remote-mcp · developers.openai.com/apps-sdk/deploy/connect-chatgpt · docs.x.ai/developers/tools/remote-mcp · support.google.com/gemini/answer/17209137 · code.claude.com/docs/en/mcp · cursor.com/docs/context/mcp · geminicli.com/docs/tools/mcp-server
- Specifica MCP 2026-07-28: modelcontextprotocol.io/specification/2026-07-28/changelog
- Modelli: github.com/Wan-Video/Wan2.2 · LTX-2.5 (opensourceforu.com, agosto 2026) · huggingface.co/tencent/HunyuanVideo-1.5 · github.com/numz/ComfyUI-SeedVR2_VideoUpscaler
