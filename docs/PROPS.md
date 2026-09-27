# Props: recurring objects that stay the same object

*27 September 2026 — `src/direction.ts` (`props`, `propsFor`), `src/stills.ts`, `src/footage.ts`, `src/storyboard.ts`*

## The defect

The test films of 22 September drew the same pencil yellow in one shot and brown in the next, and its line read as
blue ink in a third. Characters did not drift like that, because each cast member has one `look` that Kleo pastes
into every picture that shows them. Objects had nothing of the kind: `direction.objects` is a vocabulary of nouns that
only the planner reads, and every image prompt re-invented the pencil in its own words. The same films drew one very
old hand among young ones: the film's only person was seen as hands, and "a hand draws a line" named nobody, so no
look was attached.

## The fix

- **`direction.props`** (optional, up to 6): `{name ≤36, look ≤300}`. The look is the prop maker's description —
  material, colour, shape, size, markings, wear, and for a tool the mark it leaves. A prop never has a character's
  name, and a look under five words is refused by the contract (the planner drops such a prop instead, so a bad prop
  never costs a film its direction). `objects` is unchanged.
- **`shot.props`** (authoring field, like `cast`): the names of the props in the picture. Stripped before the GPU box.
  When a shot has no list, the prompt's words decide (the prop's name, or its head noun when no other prop shares it).
- **Stills** (`compileStill`): one line `NAME: look` per prop after the characters; shortened after the world and
  before the cast looks when the prompt is long. A soft vision check `prop:<name>` asks whether the object matches its
  description: it counts in the score (the better of two tries wins) and in the report, and never buys a redraw.
- **Clips**: the kie.ai prompt pastes the look after the characters. The Seedance prompt with a first frame only
  *names* the props beside the characters ("Mara and the pencil stay exactly as in the first frame, every object with
  the same shape, colour and markings") — a look written out again is the second picture Seedance morphs towards.
  Text-to-video pastes the look.
- **Planner**: the direction prompt asks for props and the schema decodes them; the English pass translates them; every
  scene writer sees them; the shot grammar offers `props` as an enum of the final names; the repair keeps them.
- **Plan judge**: sees the props and which shot lists them.
- **Hands**: in a one-character film, a hand, fingers, a forearm, a palm, a wrist or knuckles belong to that character
  (`PRONOUN_HINTS`, mirrored in `worker/kleo_pictures.py`).
- **GPU fallback** (`kleo_pictures.py`): props after the cast inside the 110-character context, whole or not at all.

## Not done

- No object reference sheets: the four reference-image slots are taken by character sheets, the user's pictures and
  the style anchor.
- The prop check is soft. If the reports (`GET /internal/admin/reports`) show props still drifting, make it a must for
  close shots only.
