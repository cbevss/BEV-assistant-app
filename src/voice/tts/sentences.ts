/**
 * Splits a reply into chunks to synthesise one after another, so BEV can start
 * talking after the first sentence instead of waiting for the whole reply.
 * Very short sentences are merged with the next ("Sure. I've opened Steam."
 * sounds better as one chunk), and very long ones are broken at commas.
 */
export function splitForSpeech(text: string, maxLen = 220, minLen = 40): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ") // don't read code blocks aloud
    .replace(/[*_#`>]+/g, "") // markdown symbols
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];

  // Sentence ends: terminal punctuation (+ optional closing quote/bracket),
  // whitespace, then something that starts a sentence. "3.5" and "e.g. x" stay put.
  const sentences = clean.split(/(?<=[.!?…]["'”’)\]]?)\s+(?=["'“‘(]?[A-Z0-9])/);

  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= minLen) {
      chunks.push(...breakLong(buf, maxLen));
      buf = "";
    }
  }
  if (buf) {
    // A short tail joins the previous chunk if it fits.
    const last = chunks[chunks.length - 1];
    if (last && last.length + buf.length + 1 <= maxLen) chunks[chunks.length - 1] = `${last} ${buf}`;
    else chunks.push(...breakLong(buf, maxLen));
  }
  return chunks;
}

function breakLong(s: string, maxLen: number): string[] {
  if (s.length <= maxLen) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    // Prefer a clause break, then any space.
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "), window.lastIndexOf(" – "));
    cut = cut > maxLen * 0.4 ? cut + 1 : window.lastIndexOf(" ");
    if (cut <= 0) cut = maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
