# Il download dell'immagine NON è il collo di bottiglia (misurato l'11 settembre 2026)

**Questo documento diceva il contrario stamattina, e diceva una cosa falsa.** La versione precedente sosteneva che
il pull dell'immagine durasse 13-20 minuti e prescriveva zstd come cura. La misura vera dice 3 minuti. La
correzione resta visibile invece di essere riscritta in silenzio, perché due altre sessioni stavano già
ragionando su quel numero.

## La misura, con lo strumento che affitta come la produzione

`scripts/pulltest.py`, due tag fianco a fianco, dal noleggio a `actual_status == running`:

| tag | compressione | peso | host | tempo |
|---|---|---|---|---|
| `keou` | gzip | 7,85 GB | RTX 3060, Connecticut, 5175 Mbit | **3,0 min** |
| `keou-zstd` | zstd | 7,37 GB | RTX 4060, Quebec, 1650 Mbit | **5,8 min** |

**Il numero che conta è il primo, non la differenza: tre minuti, non venti.**

**La differenza fra i due NON è concludente** e va detto prima che qualcuno la citi: i due host non sono uguali,
e quello con gzip aveva **tre volte la banda** dell'altro. Con questa coppia non si può dire se zstd sia più
lento, più veloce o uguale. Si può dire che **non è una cura da 15 minuti**, perché quei 15 minuti non c'erano.

## Da dove veniva il numero sbagliato

Il 13-20 minuti veniva dall'osservare i job di produzione passare dal noleggio al primo messaggio del worker, e
poi dall'attribuire quel tempo al download. È un errore di attribuzione: quel tratto contiene il pull **e tutto
quello che viene dopo**. Il pull è la parte piccola.

Il resto dell'analisi vecchia era coerente ma partiva da lì: «46,6 MB/s disponibili contro 6,5 effettivi, quindi
è la scompattazione». I 6,5 MB/s erano calcolati dividendo il peso per un tempo che non era il tempo del
download. Con il tempo giusto il conto torna e non c'è niente da spiegare.

## Cosa resta vero

Il peso e la forma dell'immagine sono quelli: **23 strati, 7,85 GB compressi, e i due strati più grossi sono
l'89% del peso**. `scripts/image-size.py` lo legge dal registro senza scaricare niente. Resta vero anche che gzip
scompatta con un thread per strato. Semplicemente, a 3 minuti totali, non è un problema che valga la pena
risolvere.

## E quindi il vero problema è un altro, e non è risolto

Il job di produzione `gt_7f7gnsjt` è stato dato per «ancora in download» per più di venti minuti, tre volte di
fila, su tre host diversi, senza che il worker dicesse mai niente. Adesso sappiamo che **non stava scaricando**:
il download è di tre minuti. Stava facendo altro, o non stava facendo niente.

Tutto quello che era facile da incolpare è stato controllato ed è sano:

- **l'immagine**: `Cmd` è `python3 /opt/kleo/kleo_worker.py`, `WorkingDir` è `/opt/kleo`, nessun entrypoint rotto (letto dal registro).
- **il disco**: 80 GB richiesti, sia in produzione sia nella prova.
- **il copione di avvio**: `VAST_BOOTSTRAP_URL` non è configurato, quindi non c'è nessun `apt-get` all'avvio; l'onstart è due comandi.
- **il tag mutabile**: `worker-image.yml` riscrive `:keou` a ogni push, ma il secondo dei tre tentativi è fallito senza nessuna ricostruzione in corso.

### La catena di avvio funziona, e funziona in un minuto

`scripts/boot-probe.py` noleggia una macchina con i filtri, l'immagine, il `runtype`, l'onstart e la forma di
ambiente della produzione, ma con un id di job **finto**. Esito, 11 settembre:

    0,1 min   running
    0,4 min   loading            <- lo stato oscilla durante l'avvio
    1,1 min   running            "success, running ghcr.io/tonnooooo/kleo-worker_keou/ssh"
    1,5 min   l'istanza non esiste più
    fine      DELETE -> 404 no_such_instance

**L'istanza si è distrutta da sola dopo un minuto e mezzo.** Una macchina può auto-distruggersi solo se il worker
ha girato: quindi il container è partito, le variabili d'ambiente sono arrivate, il worker si è avviato, **ha
raggiunto il server**, ha ricevuto il 401 che meritava per un job inesistente, e ha ripulito dietro di sé.

Aggiungendo le cinque misure indipendenti della sessione explainer (mediana 3,2 min al primo SSH riuscito, due
host su cinque sotto il minuto perché avevano l'immagine in cache), **tutta la catena di avvio è verificata e
sana**: noleggio, download, container, ambiente, worker, rete verso il server.

**Il guasto non è riproducibile.** Su quattro strumenti diversi e otto macchine, nessuna si è comportata come i
tre tentativi di `gt_7f7gnsjt`. Il che è a sua volta un risultato: se la catena è sana e il guasto compare
comunque, allora **è dell'host, non del sistema**, e la cura non è ripararla — è accorgersene e cambiare macchina
in fretta. Che è esattamente la riparazione arrivata stamattina: fino a ieri il tentativo che doveva «cambiare
host» ne ripescava lo stesso, perché il ricordo dell'host fallito veniva cancellato subito prima di riprovare.

**Una cosa da sapere per chi legge `actual_status`**: durante l'avvio oscilla, `running` → `loading` → `running`
nel giro di un minuto. Chi decide qualcosa su una singola lettura di quel campo decide su un fotogramma di una
cosa che si muove.

**Cosa resta da guardare, se ricapita**: `/var/log/kleo.log` su una macchina viva, con le variabili di un job
vero. È l'unico posto dove il worker scrive quando non riesce a parlare col server, ed è l'unica cosa che nessuno
ha ancora letto.

## La regola, che è la parte che sopravvive

Il tempo fra il noleggio e il primo messaggio del worker **non è il tempo del download**. Chi vuole il tempo del
download lo misura, e lo misura con uno strumento che affitta la macchina **nello stesso modo** in cui la affitta
la produzione (`runtype: "ssh"`); altrimenti misura una macchina che la produzione non affitta mai.
