/**
 * Reading streamed replies: server-sent events (Anthropic, OpenAI and the
 * OpenAI-compatible APIs) and newline-delimited JSON (Ollama).
 */

const decoder = () => new TextDecoder();

/** Lines of a streamed body, as they arrive. */
export async function* lines(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const dec = decoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        yield line;
      }
    }
    buf += dec.decode();
    if (buf) yield buf.replace(/\r$/, "");
  } finally {
    reader.releaseLock?.();
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Server-sent events: `event:` / `data:` lines, blank line ends an event. */
export async function* sse(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  let event = "message";
  let data: string[] = [];
  for await (const line of lines(body, signal)) {
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = "message";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue; // comment / keep-alive
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length) yield { event, data: data.join("\n") };
}

/** A body of lines from an array of strings (tests). */
export function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
