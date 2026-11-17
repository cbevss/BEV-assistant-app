import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { pageText } from "./page";
import { parseAnthropicSearch, formatSearch } from "./search";
import { deviceFindings } from "@/lib/diagnose";

describe("pageText", () => {
  it("keeps the readable content and drops scripts, nav and markup", () => {
    const html = `<html><head><title>Best monitors &amp; more</title><style>x{}</style></head><body>
      <nav>Home | Shop</nav><main><h1>Top 3</h1><p>The <b>Dell S2721DGF</b> is fast.</p><ul><li>165&nbsp;Hz</li><li>1440p</li></ul>
      <script>alert(1)</script></main><footer>© 2026</footer></body></html>`;
    const p = pageText(html);
    expect(p.title).toBe("Best monitors & more");
    expect(p.text).toContain("The Dell S2721DGF is fast.");
    expect(p.text).toContain("• 165 Hz");
    expect(p.text).not.toMatch(/Home \| Shop|alert|©/);
  });
  it("passes plain text through and truncates", () => {
    expect(pageText("a".repeat(50), "text/plain", 10)).toEqual({ title: "", text: "a".repeat(10), truncated: true });
  });
  it("decodes numeric entities", () => {
    expect(pageText("<p>&#8364;5 &#x2014; ok</p>").text).toBe("€5 — ok");
  });
});

describe("Anthropic web search parsing", () => {
  it("collects unique results and the summary", () => {
    const p = parseAnthropicSearch([
      { type: "server_tool_use" },
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.com", title: "A", page_age: "2 days ago" }, { type: "web_search_result", url: "https://a.com", title: "A again" }] },
      { type: "text", text: "Monitors are cheaper this week." },
    ]);
    expect(p.results).toEqual([{ title: "A", url: "https://a.com", age: "2 days ago" }]);
    expect(p.summary).toBe("Monitors are cheaper this week.");
    expect(formatSearch("monitors", { ...p, engine: "anthropic" })).toMatch(/1\. A \(https:\/\/a\.com\), 2 days ago[\s\S]*outside content/);
  });
  it("reports search errors", () => {
    expect(parseAnthropicSearch([{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }]).error).toBe("max_uses_exceeded");
  });
});

describe("device findings", () => {
  const now = Date.parse("2026-11-17");
  it("explains problem devices, stopped services and old graphics drivers", () => {
    const f = deviceFindings(
      {
        problems: [{ name: "USB Audio Device", class: "MEDIA", status: "Error", code: 10 }, { name: "Phone", class: "WPD", status: "Error", code: 45 }],
        stopped: [{ name: "Audiosrv", display: "Windows Audio" }],
        drivers: [{ device: "AMD Radeon RX 9060 XT", class: "DISPLAY", version: "32", date: "2025-06-01" }, { device: "Realtek", class: "NET", version: "1", date: "2019-01-01" }],
      },
      now
    );
    expect(f.map((x) => x.summary)).toEqual([
      "USB Audio Device can't start.",
      "Windows Audio isn't running but should be.",
      "The graphics driver for AMD Radeon RX 9060 XT is from 2025-06-01.",
    ]);
  });
  it("all clear", () => {
    expect(deviceFindings({ problems: [], stopped: [], drivers: [] }, now)[0].level).toBe("ok");
  });
});
