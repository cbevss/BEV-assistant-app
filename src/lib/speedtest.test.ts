import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { pingStats, mbps, describeSpeed } from "./speedtest";

describe("speed test", () => {
  it("works out ping, jitter and speed", () => {
    expect(pingStats([20, 22, 18, 30])).toEqual({ ping: 21, jitter: (2 + 4 + 12) / 3 });
    expect(mbps(25_000_000, 2000)).toBe(100);
  });
  it("explains the result", () => {
    expect(describeSpeed({ pingMs: 14, jitterMs: 2, downMbps: 512.3, upMbps: 48.25 })).toBe("Download 512 Mbps, upload 48.3 Mbps, ping 14 ms (jitter 2 ms). Plenty for gaming, streaming and big downloads.");
    expect(describeSpeed({ pingMs: 120, jitterMs: 5, downMbps: 8, upMbps: null })).toMatch(/upload not measured.*Slow.*noticeable|upload not measured.*Slow.*notice/);
  });
});
