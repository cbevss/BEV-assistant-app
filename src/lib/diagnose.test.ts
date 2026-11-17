import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { systemFindings, networkFindings, eventFindings, audioFindings, formatFindings } from "./diagnose";
import type { SystemFacts, NetworkFacts } from "./native";

const sys = (o: Partial<SystemFacts> = {}): SystemFacts => ({
  cpu: 20,
  cores: 8,
  mem_used_mb: 8000,
  mem_total_mb: 16000,
  uptime_secs: 3600,
  disks: [{ mount: "C:\\", total_gb: 500, free_gb: 200 }],
  top_cpu: [{ name: "chrome.exe", cpu: 10, mem_mb: 3000 }],
  top_mem: [{ name: "chrome.exe", cpu: 10, mem_mb: 3000 }],
  pending_reboot: false,
  ...o,
});

describe("system findings", () => {
  it("healthy PC is all OK", () => {
    expect(systemFindings(sys()).every((f) => f.level === "ok")).toBe(true);
  });
  it("names the culprit when CPU or memory is high", () => {
    const f = systemFindings(sys({ cpu: 97, mem_used_mb: 15500 }));
    expect(f.find((x) => x.area === "CPU")).toMatchObject({ level: "problem" });
    expect(f.find((x) => x.area === "CPU")!.summary).toContain("chrome.exe");
    expect(f.find((x) => x.area === "Memory")).toMatchObject({ level: "problem" });
  });
  it("disk space, uptime and pending updates", () => {
    const f = systemFindings(sys({ disks: [{ mount: "C:\\", total_gb: 500, free_gb: 3 }], uptime_secs: 10 * 86400, pending_reboot: true }));
    expect(f.find((x) => x.area === "Disk")).toMatchObject({ level: "problem" });
    expect(f.some((x) => x.area === "Uptime")).toBe(true);
    expect(f.some((x) => x.area === "Updates")).toBe(true);
  });
});

const ok = (ms: number) => ({ ok: true, ms, error: null });
const bad = { ok: false, ms: null, error: "timed out" };
const net = (dns: boolean, direct: boolean, ms = 20): NetworkFacts => ({
  dns: dns ? ok(10) : bad,
  direct: [["1.1.1.1:443", direct ? ok(ms) : bad], ["8.8.8.8:443", direct ? ok(ms + 5) : bad]],
  named: dns && direct ? ok(30) : bad,
});

describe("network findings", () => {
  it("tells no internet, DNS trouble and blocked traffic apart", () => {
    expect(networkFindings(net(false, false))[0].summary).toMatch(/No internet/);
    expect(networkFindings(net(false, true))[0].area).toBe("DNS");
    expect(networkFindings(net(true, false))[0].summary).toMatch(/VPN|firewall/);
  });
  it("reports latency", () => {
    expect(networkFindings(net(true, true, 20))[0]).toMatchObject({ level: "ok" });
    expect(networkFindings(net(true, true, 300))[0]).toMatchObject({ level: "warn" });
  });
});

describe("event findings", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  it("groups app crashes and flags instability", () => {
    const f = eventFindings(
      {
        app: [
          { t: "2026-11-16T10:00:00Z", kind: "crash", app: "game.exe" },
          { t: "2026-11-15T10:00:00Z", kind: "crash", app: "game.exe" },
          { t: "2026-11-14T10:00:00Z", kind: "hang", app: "game.exe" },
          { t: "2026-11-14T10:00:00Z", kind: "hang", app: "word.exe" },
        ],
        system: [
          { t: "2026-11-16T22:00:00Z", id: 41, provider: "Microsoft-Windows-Kernel-Power" },
          { t: "2026-11-12T22:00:00Z", id: 1001, provider: "Microsoft-Windows-WER-SystemErrorReporting" },
        ],
      },
      now
    );
    expect(f[0]).toMatchObject({ level: "problem", area: "Apps" });
    expect(f[0].summary).toBe("game.exe crashed 2× and froze 1× in the last week.");
    expect(f.some((x) => /blue-screened 1×/.test(x.summary))).toBe(true);
    expect(f.some((x) => /unexpectedly 1× this week \(1 in the last 2 days\)/.test(x.summary))).toBe(true);
  });
  it("clean week", () => {
    expect(eventFindings({ app: [], system: [] }, now)).toEqual([{ level: "ok", area: "Stability", summary: "No app crashes or unexpected shutdowns in the last week." }]);
  });
});

describe("audio and formatting", () => {
  it("no microphone", () => {
    expect(audioFindings([], "", true)[0].level).toBe("problem");
  });
  it("problems first", () => {
    const out = formatFindings([
      { level: "ok", area: "CPU", summary: "fine." },
      { level: "problem", area: "Disk", summary: "full.", fix: "Clean up." },
    ]);
    expect(out.split("\n")[0]).toBe("PROBLEM · Disk: full. Fix: Clean up.");
  });
});
