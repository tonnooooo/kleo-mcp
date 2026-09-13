/**
 * A treatment the planner accepts, for tests that need one without a model (test/storyboard.test.mjs's fake AI
 * answers the treatment call with it; test/treatment.test.mjs takes it apart). `duration` sets the acts' seconds
 * so it fits whatever film a test plans. Nothing here mirrors src/treatment.ts limits by value: the repair is what
 * fits it, and the tests assert on the result.
 */
export const TREATMENT_FIXTURE = (duration = 45) => ({
  logline: "A stolen car reveals how forty seconds of radio silence let two thieves walk away with a family's morning.",
  angle: "The relay attack is not hacking; it is a conversation the car has with a key that is not there.",
  device: "cold-open-mystery",
  opening: "An empty driveway at dawn, tyre marks still dark on the wet tarmac, one kitchen window lit.",
  ending: "The same driveway at dusk, the car back, the key in a fabric pouch on the kitchen bench, the window dark.",
  acts: [
    { name: "THE EMPTY DRIVEWAY", purpose: "The viewer feels the loss before understanding it.", seconds: Math.round(duration * 0.25) },
    { name: "THE CONVERSATION", purpose: "The viewer understands the relay: the car believed the key was near.", seconds: Math.round(duration * 0.5) },
    { name: "THE POUCH", purpose: "The viewer knows the one cheap fix and why it works.", seconds: duration - Math.round(duration * 0.25) - Math.round(duration * 0.5) },
  ],
  visual: "Long lens, compressed suburban streets; cold blue dawn light outside, warm tungsten inside; palette of wet grey, sodium orange and one red tail light; the camera drifts and never hurries.",
  pacing: "Four to six seconds a shot in the first act, quickening to three in the second, then one long held shot of the pouch at the end.",
  narrator: "Second person, present tense, sentences under fourteen words; never says 'imagine', never asks a question in a row.",
  motifs: ["the lit kitchen window", "tyre marks on wet tarmac", "the fabric pouch"],
  decisions: ["Set in an ordinary suburb at dawn rather than a city", "One family, seen only through their house and car, no faces", "The fix shown as an object, not explained as advice"],
  prose: Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: we hold on the driveway, then the window, then the pouch; the narrator says one thing at a time and the camera drifts past it. `).join(""),
});
