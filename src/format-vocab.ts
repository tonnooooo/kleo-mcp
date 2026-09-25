/**
 * THE WORDS ABOUT THE VIDEO ITSELF. Two readers need the same lists: src/direction.ts, which asks whether a must_keep
 * item says anything about what is IN the film, and src/adaptive.ts, which cuts the talk about the video (its length,
 * format, look, music, subtitles, language) out of a request so the subject is what the film is about (25 September
 * 2026: "fammi un video in orizzontale, dei pirati di 15 secondi" became the subject "un video in orizzontale, dei
 * pirati di 15 secondi", and the treatment wrote about a horizontal video). One copy, so the two cannot drift.
 */

/** Content words of a phrase, for the "did the narration keep this" test: lowercase, punctuation dropped, stops kept. */
export const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Words too common to prove anything, in the two languages a job can be in. */
export const STOP = new Set(
  ("the a an and or of to in on at for with your you it is are was were be this that they them their its from by as if so we he she i not no but into one two " +
   "il lo la i gli le un uno una di a da in con su per tra fra e o che non ci si è sono era del della dei delle al alla ai alle nel nella come più anche")
    .split(" "),
);

/** The words a must_keep item about the FILM ITSELF is made of, beside the ones formatTalk() finds (all three languages). */
export const FORMAT_VOCAB = new Set(
  ("duration durata durée length lunghezza long lungo lunga seconds second secondi secondo secondes sec minutes minute minuti minuto min " +
   "scene scenes scena scène scènes shot shots inquadrature inquadratura circa about around approximately environ format formato " +
   "video film short shorts reel clip youtube tiktok vertical horizontal verticale orizzontale narrated narrato narrata narrator narration " +
   "narrazione narratore narrateur voiceover voice over italian english french italiano inglese francese italien anglais language lingua " +
   "langue animatic storyboard subtitles sottotitoli music musica aspect ratio")
    .split(" "),
);

/**
 * Everything the intake asks about, as words: FORMAT_VOCAB plus the request verbs, the looks, the platforms and the
 * music/subtitle answers. A clause of a request made only of these (", verticale", ", senza musica", ", 45 secondi")
 * says how the video is made, not what it is about, and never reaches the subject.
 */
export const INTAKE_VOCAB = new Set([
  ...FORMAT_VOCAB,
  ...("fammi creami crea creare genera generami generate voglio vorrei make create want can could please mi fai me " +
      "videos films clips reels movie filmato cortometraggio corto documentary documentario spot trailer cartone cartoni cartoon cartoons " +
      "animated animato animata animati animation animazione realistic realistico realistica cinematic cinematico cinematografico " +
      "2d 3d new nuovo breve landscape portrait widescreen 4k instagram reels stories tik tok secs mins " +
      "con senza without none niente nessuna soundtrack captions sottotitolato sottotitolata subtitled voce narrante animatico animatici")
    .split(" "),
]);
