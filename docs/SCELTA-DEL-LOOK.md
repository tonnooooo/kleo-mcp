# Come Kleo sceglie il look, e quanto ci azzecca

*Misurato l'11 settembre 2026. Ogni numero qui dentro viene da una misura, non da un'impressione.*

## Le tre cose che scelgono, e non sono la stessa cosa

| chi sceglie | quando | precisione misurata |
|---|---|---|
| **L'assistente dell'utente** | scrive lui lo storyboard con la regia | non misurabile da qui: e' il suo modello, non il nostro |
| **Il modello di Kleo** (fase 0) | l'utente non manda uno storyboard | **mai misurata**: quota gratuita esaurita |
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
| istruzione di oggi | 15/27 = **56%** | 16 su 27 |
| con l'explainer descritto | 17/27 = **63%** | 7 su 27 |

Sull'insieme di confine — le richieste che stanno fra il diagramma e lo spiegone disegnato — la descrizione
dell'explainer porta da **3/7 a 6/7**. Oggi `directionSchema` offre al modello cinque look e l'istruzione ne
descrive quattro: `explainer` sta nell'elenco delle risposte possibili senza che una parola lo definisca.

## Il dato che vale piu' della precisione

Quando il lettore dichiara di essere **sicuro**, ha ragione 10 volte su 11 con l'istruzione di oggi.
Quando dichiara di **non sapere**, ha ragione 5 volte su 16.

L'incertezza e' informativa: chi sceglie sa quando non sa. Un sistema che chiede invece di indovinare, o che
almeno lo dice, guadagna piu' di qualunque ritocco alle parole.

## E la misura ha trovato un difetto nella misura

Otto dei dieci errori della formulazione migliore sono "voleva cyber, ha risposto explainer". Le motivazioni
del lettore sono buone, e il motivo e' che **le etichette attese non reggono la definizione che il prodotto da'
di cyber**: *"the dark motion-design look with glowing icons and big type, no pictures (tech, security, AI,
code)"* (`src/mcp.ts`).

Sei delle tredici richieste etichettate `cyber` non parlano ne' di tecnologia, ne' di sicurezza, ne' di codice:

| | richiesta | di cosa parla |
|---|---|---|
| A5 | cosa succede al corpo quando smetti di bere alcol | biologia |
| A6 | i termosifoni sono freddi solo all'ultimo piano | impianti |
| A10 | perche' il lievito madre sa di solvente | chimica |
| B5 | i tre errori quando si cuoce la pasta | cucina |
| B6 | come funziona davvero un reattore nucleare | fisica |
| C7 | quanto della bolletta e' davvero la rete | economia |

Queste richieste sono state etichettate `cyber` quando l'explainer non esisteva ancora come scelta descrivibile:
era l'unica casella per "spiegami una cosa". Cioe' **Kleo non aveva un look per la domanda piu' comune che
esista**, e la lista delle risposte giuste porta ancora quel buco dentro.

Non e' una scusa per il 56%: e' la ragione per cui il 100% non e' raggiungibile contro queste etichette. Un
esame con le risposte sbagliate non si supera studiando.

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
perche' due copie degli stessi prompt sono due misure che divergono al primo ritocco). Il banco sul modello vero
e' `scripts/direction-measure/`, con le due formulazioni gia' dentro come varianti confrontabili.
