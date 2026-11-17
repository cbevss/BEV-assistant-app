/**
 * Background watchers (while proactive monitoring is on): app crashes and
 * freezes, the internet dropping and coming back, disks filling up, and an
 * unexpected shutdown last time. Light: no polling faster than once a minute,
 * and the event log is read every 10 minutes.
 */
import { native, type EventFacts, type NetworkFacts } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { raise, deliverPending } from "./notices";

const on = () => useSettings.getState().settings.proactiveMonitoring;
const watching = (k: "crashes" | "network" | "disk") => on() && useSettings.getState().settings.watch?.[k] !== false;

// ---- crashes ------------------------------------------------------------

const seenEvents = new Set<string>();

/** New crash/freeze notices from an event-log read. Pure-ish; tested. */
export function crashNotices(e: EventFacts, seen: Set<string>): Array<{ title: string; body: string; key: string }> {
  const out: Array<{ title: string; body: string; key: string }> = [];
  for (const a of e.app) {
    const id = `${a.t}|${a.app}|${a.kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const app = a.app.replace(/\.exe$/i, "") || "An app";
    out.push({
      key: `crash:${a.app}`,
      title: a.kind === "hang" ? `${app} stopped responding` : `${app} crashed`,
      body: "Ask BEV to look into it if it keeps happening.",
    });
  }
  for (const s of e.system) {
    const id = `${s.t}|${s.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      s.id === 1001
        ? { key: "bsod", title: "Windows blue-screened", body: "Ask BEV to check stability if it happens again." }
        : { key: "unexpected-shutdown", title: "The PC shut down unexpectedly", body: "Often power or overheating. Ask BEV to check stability." }
    );
  }
  return out;
}

async function checkCrashes(minutes: number) {
  if (!watching("crashes")) return;
  const e = await native.diagEvents(minutes).catch(() => null);
  if (!e) return;
  for (const n of crashNotices(e, seenEvents)) await raise(n.key.startsWith("crash") ? "crash" : "stability", n.title, n.body, { key: n.key, cooldownMs: 60 * 60_000 });
}

// ---- network ------------------------------------------------------------

export interface NetState {
  downSince: number | null;
  misses: number;
}

/** Next network state and any notice to raise. Pure; tested. */
export function netStep(prev: NetState, facts: NetworkFacts, now: number): { next: NetState; notice?: { title: string; body: string } } {
  const up = facts.direct.some(([, p]) => p.ok);
  if (up) {
    if (prev.downSince !== null) {
      const mins = Math.max(1, Math.round((now - prev.downSince) / 60_000));
      return { next: { downSince: null, misses: 0 }, notice: { title: "Internet is back", body: `It was down for about ${mins} minute${mins === 1 ? "" : "s"}.` } };
    }
    return { next: { downSince: null, misses: 0 } };
  }
  const misses = prev.misses + 1;
  // Two misses in a row before calling it down (one can be a blip).
  if (misses === 2 && prev.downSince === null) {
    const dnsOnly = facts.dns.ok;
    return {
      next: { downSince: now - 60_000, misses },
      notice: { title: "Internet connection dropped", body: dnsOnly ? "Names resolve but nothing connects: a VPN or firewall may be blocking it." : "Nothing outside this PC can be reached." },
    };
  }
  return { next: { ...prev, misses } };
}

let net: NetState = { downSince: null, misses: 0 };
async function checkNetwork() {
  if (!watching("network")) return;
  const f = await native.diagNetwork().catch(() => null);
  if (!f) return;
  const { next, notice } = netStep(net, f, Date.now());
  net = next;
  if (notice) await raise("network", notice.title, notice.body, { key: `net:${notice.title}`, cooldownMs: 5 * 60_000 });
}

// ---- disks --------------------------------------------------------------

async function checkDisks() {
  if (!watching("disk")) return;
  const s = await native.diagSystem().catch(() => null);
  for (const d of s?.disks ?? []) {
    const pct = d.total_gb ? (d.free_gb / d.total_gb) * 100 : 100;
    if (pct < 5 || d.free_gb < 5)
      await raise("disk", `${d.mount} is almost full`, `${d.free_gb.toFixed(1)} GB free. Ask BEV to help free up space.`, { key: `disk:${d.mount}`, cooldownMs: 24 * 3600_000 });
  }
}

// -------------------------------------------------------------------------

let started = false;
export function startWatchers() {
  if (started) return;
  started = true;
  // At start-up: did the PC go down badly since yesterday?
  setTimeout(() => checkCrashes(24 * 60).catch(() => {}), 30_000);
  setInterval(() => checkNetwork().catch(() => {}), 60_000);
  setInterval(() => checkCrashes(15).catch(() => {}), 10 * 60_000);
  setInterval(() => checkDisks().catch(() => {}), 30 * 60_000);
  // Deliver anything held back during a game once it's over.
  setInterval(() => deliverPending().catch(() => {}), 30_000);
}
