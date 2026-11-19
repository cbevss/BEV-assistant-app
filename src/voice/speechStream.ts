/**
 * Speaking a reply while it's still being written: text arrives in pieces,
 * is cut into sentences, and each sentence is spoken as soon as it's whole,
 * so BEV starts talking about a second after you finish instead of waiting
 * for the entire answer.
 */
import type { SpeechSynthesizer } from "./types";

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREV = /\b(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|incl|min|max|dept|fig)\.$/i;

/**
 * Pure: split complete sentences off the front of `buf`. A sentence ends at
 * . ! ? or … followed by a space, or at a line break; a very long run is cut
 * at a comma or space so speech never waits too long.
 */
export function takeSentences(buf: string, maxRun = 220): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  for (;;) {
    let cut = -1;
    const re = /([.!?…]+)(["')\]]*)(\s+)|\n+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      const end = m.index + (m[1] ? m[1].length + m[2].length : 0);
      const before = rest.slice(0, end);
      // "3.5", "e.g. this", "Mr. Smith" aren't sentence ends.
      if (m[1] === "." && (ABBREV.test(before) || /\d\.$/.test(before) && /^\d/.test(rest.slice(m.index + 1)))) continue;
      cut = m.index + m[0].length;
      break;
    }
    if (cut < 0 && rest.length > maxRun) {
      const window = rest.slice(0, maxRun);
      const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
      if (at > 40) cut = at + 1;
    }
    if (cut < 0) break;
    const s = rest.slice(0, cut).trim();
    rest = rest.slice(cut);
    if (s) sentences.push(s);
  }
  return { sentences, rest };
}

/** Markdown and code read badly aloud: strip it before speaking. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export class SpeechStream {
  private buf = "";
  private queue: string[] = [];
  private speaking: Promise<void> | null = null;
  private ended = false;
  private cancelled = false;
  private resolveDone!: () => void;
  private rejectDone!: (e: unknown) => void;
  private finished: Promise<void>;
  /** True once anything has been queued to speak. */
  started = false;

  /** A sentence is being spoken right now. */
  get speakingNow(): boolean {
    return this.speaking !== null;
  }
  /** Everything pushed so far (for checking what was said). */
  text = "";

  constructor(
    private tts: SpeechSynthesizer,
    private opts: { signal?: AbortSignal; onLevel?: (l: number) => void; onFirstSpeech?: () => void } = {}
  ) {
    this.finished = new Promise((res, rej) => {
      this.resolveDone = res;
      this.rejectDone = rej;
    });
    // Nobody may be awaiting yet; don't leave an unhandled rejection.
    this.finished.catch(() => {});
  }

  /** New text from the model. */
  push(delta: string) {
    if (this.cancelled || this.ended) return;
    this.text += delta;
    this.buf += delta;
    const { sentences, rest } = takeSentences(this.buf);
    this.buf = rest;
    for (const s of sentences) this.enqueue(s);
  }

  /** The model finished a reply (more may follow after tools run). */
  flush() {
    if (this.cancelled) return;
    const tail = this.buf.trim();
    this.buf = "";
    if (tail) this.enqueue(tail);
  }

  /** No more text is coming. */
  end() {
    this.flush();
    this.ended = true;
    if (!this.speaking) this.resolveDone();
  }

  /** Stop talking now and drop whatever is queued. */
  cancel() {
    this.cancelled = true;
    this.queue = [];
    this.tts.cancel();
    this.resolveDone();
  }

  /** Resolves when everything pushed has been spoken (or cancelled). */
  done(): Promise<void> {
    return this.finished;
  }

  private enqueue(sentence: string) {
    const s = speakable(sentence);
    if (!s || !/[\p{L}\p{N}]/u.test(s)) return;
    this.queue.push(s);
    if (!this.started) {
      this.started = true;
      this.opts.onFirstSpeech?.();
    }
    if (!this.speaking) this.speaking = this.drain();
  }

  private async drain() {
    try {
      while (this.queue.length && !this.cancelled) {
        if (this.opts.signal?.aborted) return this.cancel();
        // Whatever built up while the last part was being spoken goes out in
        // one go: fewer gaps (and fewer requests for online voices).
        const next = this.queue.splice(0).join(" ");
        await this.tts.speak(next, { signal: this.opts.signal, onLevel: this.opts.onLevel });
      }
    } catch (e) {
      if (!this.cancelled) {
        this.cancelled = true;
        this.rejectDone(e);
        return;
      }
    } finally {
      this.speaking = null;
    }
    if (this.ended || this.cancelled) this.resolveDone();
  }
}
