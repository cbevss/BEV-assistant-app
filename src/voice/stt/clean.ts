/**
 * Whisper sometimes "hears" stock phrases in silence or noise (its training
 * data was full of video captions). Drop those rather than act on them.
 */
const NOISE_TAGS = /\[(?:blank_audio|music|noise|silence|inaudible|applause|laughter)[^\]]*\]|\((?:music|noise|silence|inaudible|applause|laughs?|sighs?)[^)]*\)|\*[^*]{0,30}\*/gi;

const PHANTOMS = new Set([
  "you", "thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
  "bye", "bye bye", "okay", "ok", "so", "um", "uh", "hmm", "the end", "subtitles by the amaraorg community",
  "please subscribe", "like and subscribe",
]);

export function cleanTranscript(text: string, speechMs: number): string {
  const t = text.replace(NOISE_TAGS, " ").replace(/\s+/g, " ").trim();
  if (!t || /^[\s.,!?…-]+$/.test(t)) return "";
  const key = t.toLowerCase().replace(/[^a-z ]/g, "").trim();
  // A stock phrase from under ~1.5 s of actual speech is almost always a phantom.
  if (PHANTOMS.has(key) && speechMs < 1500) return "";
  return t;
}
