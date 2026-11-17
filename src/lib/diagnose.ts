/**
 * Turns measured facts into plain findings for troubleshooting. Thresholds
 * live here (tested); the facts come from read-only native checks.
 */
import { native, type EventFacts, type NetworkFacts, type SystemFacts } from "./native";
import { winMics, endpointProblems, type WinInput } from "@/voice/mic";

export type Level = "ok" | "warn" | "problem";
export interface Finding {
  level: Level;
  area: string;
  summary: string;
  fix?: string;
}

const gb = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

export function systemFindings(s: SystemFacts): Finding[] {
  const out: Finding[] = [];
  const memPct = s.mem_total_mb ? (s.mem_used_mb / s.mem_total_mb) * 100 : 0;
  const topCpu = s.top_cpu[0];
  const topMem = s.top_mem[0];
  if (s.cpu >= 90) out.push({ level: "problem", area: "CPU", summary: `CPU is at ${s.cpu.toFixed(0)}%${topCpu ? `; ${topCpu.name} is using the most (${topCpu.cpu.toFixed(0)}%)` : ""}.`, fix: topCpu ? `Close ${topCpu.name} if you don't need it.` : undefined });
  else if (s.cpu >= 70) out.push({ level: "warn", area: "CPU", summary: `CPU is busy at ${s.cpu.toFixed(0)}%${topCpu ? ` (mostly ${topCpu.name})` : ""}.` });
  else out.push({ level: "ok", area: "CPU", summary: `CPU is at ${s.cpu.toFixed(0)}%.` });

  if (memPct >= 92) out.push({ level: "problem", area: "Memory", summary: `Memory is nearly full (${memPct.toFixed(0)}% of ${(s.mem_total_mb / 1024).toFixed(0)} GB)${topMem ? `; ${topMem.name} uses ${(topMem.mem_mb / 1024).toFixed(1)} GB` : ""}.`, fix: "Close apps you aren't using, starting with the biggest." });
  else if (memPct >= 80) out.push({ level: "warn", area: "Memory", summary: `Memory is ${memPct.toFixed(0)}% used${topMem ? ` (most by ${topMem.name})` : ""}.` });
  else out.push({ level: "ok", area: "Memory", summary: `Memory is ${memPct.toFixed(0)}% used.` });

  for (const d of s.disks) {
    const pct = d.total_gb ? (d.free_gb / d.total_gb) * 100 : 100;
    if (pct < 5 || d.free_gb < 5) out.push({ level: "problem", area: "Disk", summary: `${d.mount} is almost full: ${gb(d.free_gb)} GB free of ${gb(d.total_gb)} GB.`, fix: "Free space with Settings → System → Storage (Cleanup recommendations)." });
    else if (pct < 12 || d.free_gb < 20) out.push({ level: "warn", area: "Disk", summary: `${d.mount} is getting full: ${gb(d.free_gb)} GB free.` });
  }
  const days = s.uptime_secs / 86400;
  if (days >= 7) out.push({ level: "warn", area: "Uptime", summary: `The PC hasn't restarted in ${Math.floor(days)} days.`, fix: "A restart clears a lot of odd slowdowns." });
  if (s.pending_reboot) out.push({ level: "warn", area: "Updates", summary: "Windows is waiting for a restart to finish installing updates.", fix: "Restart when convenient." });
  return out;
}

export function networkFindings(n: NetworkFacts): Finding[] {
  const anyDirect = n.direct.some(([, p]) => p.ok);
  const best = Math.min(...n.direct.filter(([, p]) => p.ok && p.ms !== null).map(([, p]) => p.ms as number));
  if (!anyDirect && !n.dns.ok) return [{ level: "problem", area: "Internet", summary: "No internet connection: nothing outside this PC can be reached.", fix: "Check Wi-Fi or the cable, then restart the router. Settings → Network & internet → Network reset is the last resort." }];
  if (!anyDirect && n.dns.ok) return [{ level: "problem", area: "Internet", summary: "Names resolve but connections fail: a firewall, VPN or proxy may be blocking traffic.", fix: "Turn off any VPN or proxy and try again." }];
  if (anyDirect && !n.dns.ok) return [{ level: "problem", area: "DNS", summary: "The internet is reachable but website names don't resolve (DNS problem).", fix: "Restart the router, or set DNS to automatic/1.1.1.1 in your network adapter settings." }];
  const out: Finding[] = [];
  if (best > 150) out.push({ level: "warn", area: "Internet", summary: `Connected, but slow to respond (${best} ms).`, fix: "Something may be using the connection heavily, or Wi-Fi signal is weak." });
  else out.push({ level: "ok", area: "Internet", summary: `Connected (${Number.isFinite(best) ? `${best} ms` : "ok"}).` });
  if (!n.named.ok) out.push({ level: "warn", area: "Internet", summary: "Couldn't open a secure connection to microsoft.com." });
  return out;
}

const within = (iso: string, hours: number, now: number) => now - Date.parse(iso) <= hours * 3600_000;

export function eventFindings(e: EventFacts, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const counts = new Map<string, { crash: number; hang: number }>();
  for (const a of e.app) {
    const c = counts.get(a.app) ?? { crash: 0, hang: 0 };
    c[a.kind === "hang" ? "hang" : "crash"]++;
    counts.set(a.app, c);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].crash + b[1].hang - (a[1].crash + a[1].hang)).slice(0, 4);
  for (const [app, c] of top) {
    const parts = [c.crash ? `crashed ${c.crash}×` : "", c.hang ? `froze ${c.hang}×` : ""].filter(Boolean).join(" and ");
    out.push({ level: c.crash + c.hang >= 3 ? "problem" : "warn", area: "Apps", summary: `${app} ${parts} in the last week.`, fix: "Update or reinstall it; if it's a game, verify its files in the launcher." });
  }
  const bsod = e.system.filter((s) => s.id === 1001);
  const unexpected = e.system.filter((s) => s.id === 41 || s.id === 6008);
  if (bsod.length) out.push({ level: "problem", area: "Stability", summary: `Windows blue-screened ${bsod.length}× in the last week.`, fix: "Update graphics and chipset drivers; if it keeps happening, check RAM with Windows Memory Diagnostic." });
  if (unexpected.length) {
    const recent = unexpected.filter((s) => within(s.t, 48, now)).length;
    out.push({ level: unexpected.length >= 2 ? "problem" : "warn", area: "Stability", summary: `The PC shut down unexpectedly ${unexpected.length}× this week${recent ? ` (${recent} in the last 2 days)` : ""}.`, fix: "Often power or overheating: check temperatures, cables and the PSU." });
  }
  if (out.length === 0) out.push({ level: "ok", area: "Stability", summary: "No app crashes or unexpected shutdowns in the last week." });
  return out;
}

export function audioFindings(inputs: WinInput[], micLabel: string, usesWindowsEngine: boolean): Finding[] {
  if (inputs.length === 0) return [{ level: "problem", area: "Microphone", summary: "Windows sees no microphone.", fix: "Plug one in, or enable it in Settings → System → Sound → Input." }];
  const problems = endpointProblems(micLabel, inputs, usesWindowsEngine);
  if (problems.length === 0) return [{ level: "ok", area: "Microphone", summary: "The microphone is on and at a usable level." }];
  return problems.map((p) => ({ level: p.kind === "muted" ? "problem" : "warn", area: "Microphone", summary: p.message }));
}

export type Area = "all" | "performance" | "network" | "stability" | "audio";

export function formatFindings(fs: Finding[]): string {
  const order: Record<Level, number> = { problem: 0, warn: 1, ok: 2 };
  const icon: Record<Level, string> = { problem: "PROBLEM", warn: "Worth a look", ok: "OK" };
  return [...fs]
    .sort((a, b) => order[a.level] - order[b.level])
    .map((f) => `${icon[f.level]} · ${f.area}: ${f.summary}${f.fix ? ` Fix: ${f.fix}` : ""}`)
    .join("\n");
}

/** Run the checks for an area; any check that fails to run is reported, not hidden. */
export async function diagnose(area: Area, mic: { label: string; usesWindowsEngine: boolean }): Promise<Finding[]> {
  const want = (a: Area) => area === "all" || area === a;
  const jobs: Array<Promise<Finding[]>> = [];
  const guard = (name: string, p: Promise<Finding[]>) => p.catch((e) => [{ level: "warn" as Level, area: name, summary: `Couldn't check: ${e instanceof Error ? e.message : String(e)}` }]);
  if (want("performance")) jobs.push(guard("Performance", native.diagSystem().then(systemFindings)));
  if (want("network")) jobs.push(guard("Internet", native.diagNetwork().then(networkFindings)));
  if (want("stability")) jobs.push(guard("Stability", native.diagEvents().then((e) => eventFindings(e))));
  if (want("audio")) jobs.push(guard("Microphone", winMics.list().then((l) => audioFindings(l, mic.label, mic.usesWindowsEngine))));
  return (await Promise.all(jobs)).flat();
}
