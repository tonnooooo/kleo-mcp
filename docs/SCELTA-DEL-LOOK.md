# Come Kleo sceglie il look, e quanto ci azzecca

*Misurato l'11 settembre 2026. Ogni numero qui dentro viene da una misura, non da un'impressione.*

## Le tre cose che scelgono, e non sono la stessa cosa

| chi sceglie | quando | precisione misurata |
|---|---|---|
| **L'assistente dell'utente** | scrive lui lo storyboard con la regia | non misurabile da qui: e' il suo modello, non il nostro |
| **Il modello di Kleo** (fase 0) | l'utente non manda uno storyboard | **nessun numero valido**: l'unica corsa sul modello vero non e' attribuibile a un commit (sotto) |
| **La lista di parole** (`pickKleoStyle`) | solo se la chiamata al modello fallisce | **26%** su richieste mai viste |

Il 26% e' stato citato per ore come "la precisione di Kleo". Non lo e': da quando `planFor` preferisce la
risposta della regia, quella lista decide soltanto quando il modello non risponde. E' la precisione della rete
di sicurezza, non del sistema.

## La misura che si poteva fare senza quota

Sei lettori indipendenti, nessuno dei quali poteva vedere le risposte attese, hanno scelto il look per le stesse
27 richieste mai viste, con due formulazioni diverse dell'istruzione. Non misura il modello di produzione:
misura **se l'istruzione e' scritta abbastanza bene da poter essere seguita**. Se nemmeno un lettore capace ci
riesce, il problema e' l'istruzione; se ci riesce e la produzione no, il problema e' il modello. Sono due
riparazioni diverse e prima non si sapeva quale servisse.

| | giuste | ha detto "non lo so" |
|---|---|---|
| istruzione di allora | 18/27 = **67%** | 16 su 27 |
| con l'explainer descritto | 22/27 = **81%** | 7 su 27 |

Sull'insieme di confine — le richieste che stanno fra il diagramma e lo spiegone disegnato — la descrizione
dell'explainer porta da **3/7 a 6/7**.

Il primo giro di questi stessi numeri diceva 56% e 63%. La differenza, quattordici e diciotto punti, non e' stata
una riformulazione: erano **etichette che avevo corrotto io**, ripristinate dopo (sezione sotto). La misura giusta
esisteva da subito e il metro storto la nascondeva.

Delle cinque che restano sbagliate, **quattro portano gia' scritto "non lo so"**: l'unico errore detto con
sicurezza e' il pane della nonna. Il sistema sbaglia soprattutto dove sa di non sapere.

La formulazione misurata qui e' **la mia**, non quella spedita: la sessione dell'explainer ha mandato in produzione
la propria (`8a09921`), che descrive tutti e cinque i look per la FORMA della risposta invece che per l'argomento.
Va rimisurata sopra quella.

## Il modello vero: una corsa fatta, e da buttare (12 settembre)

Ventisette richieste, una chiamata di fase 0 ciascuna a llama-4-scout — il modello di produzione, riconoscibile
dal costo, ~55 neuroni l'una — 19/27. E' l'unica corsa mai fatta sul modello vero, e **non vale come numero di
nessun prompt**: il banco era stato avviato dalla cartella condivisa, un'altra sessione stava scrivendo proprio
quel prompt in quella cartella durante la corsa (il testo `PARTS` era nell'albero alle 22:31 UTC e nel commit
`0a30b4a` alle 22:33), e `wrangler dev` ricarica il Worker a ogni salvataggio. Le 27 risposte possono appartenere
a due testi diversi. Il file dei risultati resta in `results/` con "NON ATTRIBUIBILE" nel nome, perche' la forma
dell'errore e' piu' utile del numero: **il banco impacchetta l'albero come il deploy, e si avvia da un worktree
staccato o non misura niente**.

Quello che quella corsa mostra comunque, come indizio e non come misura: explainer scelto 17 volte dove ne erano
attese 10, con la ragione "e' la scelta migliore per spiegare" — il modello sceglie per il verbo, cioe' fa cio'
che la riga gli vietava. Un modello da 17 miliardi non esegue una negazione; serve un bivio positivo prima delle
definizioni. E' la diagnosi da cui e' nato il ramo `explainer/parts-first`.

**Tre prompt, zero numeri validi sul modello vero.** `6f153e1` (verbi), `0a30b4a` (parti, in produzione),
`111c205` (parti come primo bivio, ramo). Il piano, gia' concordato e da fare da una sola sessione con la riga
in `QUOTA.md` prima: `0a30b4a` su scout due volte di fila (numero + soglia di rumore), poi `111c205`, poi
`6f153e1` come "prima" se i neuroni bastano. ~5.600 neuroni. Bloccato finche' la quota gratuita non torna: oggi
l'hanno svuotata due sessioni in parallelo.

## Il dato che vale piu' della precisione

Quando il lettore dichiara di essere **sicuro**, ha ragione 10 volte su 11 con l'istruzione di oggi.
Quando dichiara di **non sapere**, ha ragione 5 volte su 16.

L'incertezza e' informativa: chi sceglie sa quando non sa. Un sistema che chiede invece di indovinare, o che
almeno lo dice, guadagna piu' di qualunque ritocco alle parole.

## E la misura ha trovato un difetto nella misura, che avevo messo io

Otto dei dieci errori della formulazione migliore erano "voleva cyber, ha risposto explainer". Le motivazioni del
lettore erano buone, e il motivo e' che **sei etichette su ventisette erano sbagliate, e le avevo cambiate io**
copiando i due insiemi dentro `scripts/adaptation.mjs`.

Non e' stata una svista di trascrizione: e' una trasformazione sistematica, `explainer` -> `cyber`, applicata a
tutte e sole le richieste in cui i loro autori avevano scritto `explainer`.

| | richiesta | scritta dall'autore | nel file |
|---|---|---|---|
| A5 | cosa succede al corpo se smetti di bere alcol | explainer | cyber |
| A6 | i termosifoni freddi solo all'ultimo piano | explainer | cyber |
| A10 | perche' il lievito madre sa di solvente | explainer | cyber |
| B3 | perche' il telefono si scarica d'inverno | explainer | cyber |
| B5 | i tre errori quando si cuoce la pasta | explainer | cyber |
| B6 | come funziona davvero un reattore nucleare | explainer | cyber |

E non vale la scusa che l'explainer non esistesse: era uno stile vero da due ore e mezza (`98bd724` all'01:14,
la copia alle 03:42). Quello che ho normalizzato non e' una risposta che il PRODOTTO non sapeva dare — e' una
risposta che la LISTA DI PAROLE non sapeva dare. Poi ho usato il punto cieco della lista come risposta giusta
per misurare la lista.

**La forma generale, e vale oltre questo file:** chi scrive il metro non puo' anche riscrivere le risposte, o il
metro converge su se stesso e il numero non misura piu' il prodotto ma la propria coerenza interna. Un corpus che
dice `cyber` per un piatto di pasta non potra' mai riferire che l'explainer e' irraggiungibile. Le etichette sono
immutabili dopo la consegna: se sembrano sbagliate si chiede a chi le ha scritte, che e' come sono state
ripristinate — MAIN e la sessione dell'explainer hanno riletto i propri verbali, riga per riga.

Una sola e' rimasta com'era: il pane della nonna, etichettato `realistic` dal suo autore che l'ha confermato. Se
avessi ripristinato anche quella per simmetria avrei gonfiato il numero — ed e' esattamente lo stesso errore in
direzione opposta.

## Cosa si fa, in ordine

1. **Le etichette le rivedono le sessioni che le hanno scritte**, non io: chi ha scritto la richiesta sa cosa
   voleva vedere. Finche' non e' fatto, ogni percentuale su questi 27 e' sospetta.
2. **La formulazione con l'explainer descritto non e' stata spedita.** Vince su C (6/7 contro 3/7) ma perde su
   A (5/10 contro 6/10), e quella perdita e' quasi tutta sulle sei etichette dubbie. Si decide dopo il punto 1.
3. **La misura sul modello vero** (`scripts/direction-measure`) parte appena la quota gratuita torna. Costa 83
   neuroni a richiesta, 27 richieste sono un quinto della giornata.
4. **L'incertezza va usata.** Oggi Kleo indovina in silenzio quando non sa; il dato dice che sa di non sapere.

## Come rifare questa misura

Le 27 richieste stanno in `scripts/adaptation.mjs` (`HELD_OUT`, `HELD_OUT_2`, `HELD_OUT_3`, esportate apposta
perche' due copie degli stessi prompt sono due misure che divergono al primo ritocco; il file misura solo quando e'
lanciato da solo, importato sta zitto).

Sul modello vero: `KLEO_SESSION="chi-sei" bash scripts/direction-measure/tre-prompt.sh`. Per ogni commit del lotto
crea un worktree staccato, `run-rest.mjs` importa `src/storyboard.ts` **da quel worktree**, costruisce il prompt in
processo e lo manda a Workers AI via REST con la sessione OAuth di wrangler (il modello gira su Cloudflare; qui non
gira niente). Niente `wrangler dev`, niente porte: la prima versione faceva partire un Worker per commit, e il dev
server impacchetta la cartella in cui parte e ricarica a ogni salvataggio — e' cosi' che una corsa ha misurato un
prompt di nessun commit. Ogni corsa scrive il suo file in `results/` e due righe in `QUOTA.md`, prima e dopo.
A quota finita ogni chiamata torna `4006` a costo zero: e' il modo di provare la catena intera gratis, ed e' stato
fatto su tutti e quattro i commit del lotto.
