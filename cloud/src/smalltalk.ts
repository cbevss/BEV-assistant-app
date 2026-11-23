/**
 * Short replies for plain "thanks" / sign-off messages on Telegram, so BEV says
 * "No worries." instead of recapping everything. Answered without the AI.
 */
export const THANKS_REPLIES = ["No worries.", "Any time.", "No problem.", "You're welcome.", "Sure thing.", "Happy to help.", "Not a problem.", "Cheers.", "Glad to help.", "Of course."];
export const SIGNOFF_REPLIES = ["Okay, I'll leave you to it.", "Alright.", "Got it.", "Okay.", "Sure.", "Catch you later.", "I'm here if you need me.", "Shout if you need me.", "Okay, later.", "Right you are."];

const FILLER = new Set(["hey", "yo", "bev", "ok", "okay", "alright", "right", "oh", "good", "great", "nice", "perfect", "lovely", "brilliant", "sound", "awesome", "legend", "cool", "mate", "so", "much", "very", "you", "a", "lot", "lots", "for", "that", "this", "it", "appreciate", "appreciated", "again", "x", "one"]);
const THANKS = new Set(["thanks", "thank", "cheers", "ta", "thx", "ty", "tysm", "thankyou"]);
const SIGNOFF_FILLER = new Set(["hey", "yo", "bev", "ok", "okay", "alright", "right", "oh", "cool", "mate", "so", "good", "great"]);
const SIGNOFF = /^(thats (all|it)|thats everything|im (done|good)|all good|nothing else|no thats (all|it)|bye|later|see (you|ya)|night|goodnight|good night)$/;

const words = (text: string) => text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z ]+/g, " ").trim().split(/\s+/).filter(Boolean);

/** "thanks" / "signoff" when the message is only that (no question or request in it), else null. */
export function smallTalk(text: string): "thanks" | "signoff" | null {
  if (text.length > 60 || /\?/.test(text)) return null;
  const w = words(text);
  if (!w.length) return null;
  const rest = w.filter((x) => !THANKS.has(x) && !FILLER.has(x));
  if (w.some((x) => THANKS.has(x))) return rest.length === 0 || SIGNOFF.test(w.filter((x) => !THANKS.has(x) && !SIGNOFF_FILLER.has(x) && x !== "you").join(" ")) ? "thanks" : null;
  return SIGNOFF.test(w.filter((x) => !SIGNOFF_FILLER.has(x)).join(" ")) ? "signoff" : null;
}

export function smallTalkReply(kind: "thanks" | "signoff", rand = Math.random): string {
  const list = kind === "thanks" ? THANKS_REPLIES : SIGNOFF_REPLIES;
  return list[Math.floor(rand() * list.length) % list.length];
}
