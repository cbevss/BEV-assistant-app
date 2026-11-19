import type { Settings } from "@/state/settings";
import { makeProvider, modelsFor } from "@/ai/factory";
import { addresseeHeuristic } from "./turns";

/**
 * Was this follow-up meant for BEV? Rules first; when they can't tell, a
 * quick yes/no from the fast model (1.8 s cap). If that fails, BEV assumes
 * it was meant for it only when it had just asked a question, so friend
 * chatter in a call isn't answered.
 */
export async function isForBev(utterance: string, lastReply: string, expectAnswer: boolean, s: Settings): Promise<boolean> {
  const h = addresseeHeuristic(utterance, expectAnswer);
  if (h !== "unsure") return h === "bev";
  try {
    const provider = makeProvider(s);
    const fast = modelsFor(s, s.provider).fast;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1800);
    try {
      const r = await provider.chat({
        system:
          "You decide whether speech picked up by a voice assistant's microphone was addressed to the assistant (BEV) or to other people, such as friends in a voice call or someone in the room. Answer with exactly YES or NO.",
        messages: [
          {
            role: "user",
            content: `BEV just said: "${lastReply.slice(0, 300)}"\nThen the microphone heard: "${utterance.slice(0, 300)}"\nWas that addressed to BEV?`,
          },
        ],
        tools: [],
        maxTokens: 3,
        temperature: 0,
        model: fast || undefined,
        signal: ctl.signal,
      });
      return /^\s*yes/i.test(r.text);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return expectAnswer;
  }
}
