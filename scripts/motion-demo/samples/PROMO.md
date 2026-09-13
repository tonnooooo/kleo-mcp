# Storyboard promozionali di Kleo (fatti da Kleo)

Tre storyboard scritti nel contratto di Kleo, con la regia obbligatoria, validati con `validateStoryboard`
(`requireDirection: true`) sul commit di main del 13 settembre 2026. Ogni affermazione nella voce e' presa dal sito
(`kleooai.com`) e verificata contro cio' che il motore fa: nessun tempo sotto i 15 minuti, nessun numero che non
esista, nessun logo o persona reale nelle immagini. Nei due look a immagini ogni inquadratura contiene qualcosa che
si muove da se' (vapore, pioggia, luci che tremolano): il modello del movimento congela le scene ferme.

| file | formato | look | template | voce | scene / immagini / parole |
|---|---|---|---|---|---|
| `promo-short-realistic.json` | 9:16, 40 s | realistic | viral-short | af_heart | 6 / 16 / 96 |
| `promo-trailer-16x9.json` | 16:9, 30 s | realistic | cinematic-trailer | am_michael | 6 / 16 / 74 |
| `promo-explainer-short.json` | 9:16, 40 s | explainer | explainer-short | bf_emma | 7 / 0 / 94 |

Il template e' un argomento di `kleo_create_video`, non un campo dello storyboard. Non sono ancora stati
renderizzati: si accodano alla serie dei campioni (`serie.sh`) o partono da `kleo_create_video` con lo storyboard
allegato, sul primo slot GPU libero. Sono file nuovi: i quattro campioni del sito non sono stati toccati.
