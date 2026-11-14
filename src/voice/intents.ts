/**
 * Recognises when the user is ending the conversation, so BEV stops at once
 * instead of waiting for a reply or sending the words to the AI.
 *
 * - "stop": cut BEV off (stop, cancel, shut up). Ends silently.
 * - "dismiss": the user is done, or wasn't talking to BEV at all ("that's
 *   all", "I wasn't talking to you", "thanks, I'm done"). BEV says a short
 *   goodbye and closes.
 */
export type EndIntent = "stop" | "dismiss" | null;

function normalise(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[’']/g, "") // "that's" → "thats", "wasn't" → "wasnt"
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that pad an ending phrase without changing it ("ok thanks bev, that's all for now"). */
const FILLER = new Set([
  "hey", "yo", "bev", "ok", "okay", "alright", "right", "oh", "sorry", "no", "nah", "yeah", "yes", "um", "uh", "er",
  "thanks", "thank", "you", "cheers", "mate", "please", "now", "for", "then", "actually", "so", "well", "ta",
]);

function core(u: string): string {
  const words = u.split(" ");
  let a = 0;
  let b = words.length;
  // Strip filler from both ends; keep inner words ("thats all for now" → "thats all").
  while (a < b && FILLER.has(words[a])) a++;
  while (b > a && FILLER.has(words[b - 1])) b--;
  return words.slice(a, b).join(" ");
}

const STOP = /^(stop|stop it|stop talking|cancel|cancel that|shut up|be quiet|quiet|silence|enough)$/;

/** Phrases that mean "I wasn't talking to you", anywhere in the utterance. */
const NOT_FOR_BEV = /\b(wasnt|was not|werent|were not|not|im not|i am not) talking to (you|bev)\b|\btalking to (someone|somebody) else\b|^not you$/;

const DONE = new RegExp(
  "^(" +
    [
      "thats (all|it|everything|enough)( i (need|needed|wanted))?",
      "that (is|will be|ll be) (all|it|everything)",
      "thatll be all",
      "(im|i am|were|we are) (done|finished|good|all good|sorted|all set)",
      "all (done|good|set|sorted)",
      "done",
      "finished",
      "nothing( else)?",
      "no thanks?",
      "never ?mind",
      "nevermind",
      "forget (it|about it)",
      "leave it( there)?",
      "go away",
      "(good ?)?bye( bye)?",
      "see (you|ya)( later)?",
      "later",
      "goodnight|good night|night",
    ].join("|") +
    ")$"
);

export function endIntent(utterance: string): EndIntent {
  const u = normalise(utterance);
  if (!u) return null;
  const c = core(u);
  if (STOP.test(c)) return "stop";
  if (NOT_FOR_BEV.test(u)) return "dismiss";
  // Only filler and thanks ("thanks", "thank you bev", "cheers mate"): done.
  if (c === "" && /\b(thanks|thank|cheers|ta)\b/.test(u)) return "dismiss";
  if (c && DONE.test(c)) return "dismiss";
  return null;
}

export const DISMISS_REPLY = "Okay, I'll leave you to it.";
