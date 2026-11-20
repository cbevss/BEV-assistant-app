/**
 * Internet speed test against Cloudflare's public speed test servers:
 * latency (median of small requests), download (a 25 MB file) and upload
 * (10 MB). Takes about 15 seconds.
 */
import { fetch } from "@tauri-apps/plugin-http";

const BASE = "https://speed.cloudflare.com";

export interface SpeedResult {
  pingMs: number;
  jitterMs: number;
  downMbps: number;
  upMbps: number | null;
}

/** Pure: median, and jitter as the mean gap between consecutive samples. */
export function pingStats(samples: number[]): { ping: number; jitter: number } {
  const s = [...samples].sort((a, b) => a - b);
  const ping = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const gaps = samples.slice(1).map((v, i) => Math.abs(v - samples[i]));
  return { ping, jitter: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0 };
}

export const mbps = (bytes: number, ms: number) => (bytes * 8) / (ms / 1000) / 1_000_000;

async function timedDownload(bytes: number, signal?: AbortSignal): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/__down?bytes=${bytes}`, { signal, cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`speed test server said ${res.status}`);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
  }
  return mbps(got, performance.now() - t0);
}

export async function runSpeedTest(signal?: AbortSignal): Promise<SpeedResult> {
  const pings: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    const r = await fetch(`${BASE}/__down?bytes=0`, { signal, cache: "no-store" });
    await r.arrayBuffer();
    pings.push(performance.now() - t0);
  }
  // First request includes connection setup; drop it.
  const { ping, jitter } = pingStats(pings.slice(1));
  // Warm up, then measure the big one.
  await timedDownload(1_000_000, signal);
  const downMbps = await timedDownload(25_000_000, signal);
  let upMbps: number | null = null;
  try {
    const body = new Uint8Array(10_000_000);
    const t0 = performance.now();
    const r = await fetch(`${BASE}/__up`, { method: "POST", body, signal });
    await r.arrayBuffer();
    upMbps = mbps(body.byteLength, performance.now() - t0);
  } catch {
    /* upload is best effort */
  }
  return { pingMs: Math.round(ping), jitterMs: Math.round(jitter), downMbps, upMbps };
}

export function describeSpeed(r: SpeedResult): string {
  const f = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
  const verdict = r.downMbps >= 100 ? "Plenty for gaming, streaming and big downloads." : r.downMbps >= 30 ? "Fine for gaming and HD streaming." : r.downMbps >= 10 ? "OK for browsing and video; big downloads will be slow." : "Slow: video and downloads will struggle.";
  const lag = r.pingMs > 80 || r.jitterMs > 30 ? " Latency is high enough to notice in online games." : "";
  return `Download ${f(r.downMbps)} Mbps, upload ${r.upMbps == null ? "not measured" : `${f(r.upMbps)} Mbps`}, ping ${r.pingMs} ms (jitter ${r.jitterMs} ms). ${verdict}${lag}`;
}
