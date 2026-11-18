import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { renderToStaticMarkup } from "react-dom/server";
import { groupMessages } from "./pages/Assistant";
import { matchScore } from "./shell/CommandPalette";
import { Markdown } from "./assistant/Markdown";
import { toolLabel, summary } from "./assistant/tools";
import { hexToRgb } from "@/lib/appearance";
import { Core } from "./components/Core";
import type { ChatMessage } from "@/state/assistant";

const msg = (role: ChatMessage["role"], content: string, i: number): ChatMessage => ({ id: String(i), role, content, at: i });

describe("conversation grouping", () => {
  it("runs of tool events become one group between messages", () => {
    const g = groupMessages([msg("user", "a", 1), msg("tool", "x", 2), msg("tool", "y", 3), msg("assistant", "b", 4), msg("tool", "z", 5)]);
    expect(g.map((x) => (x.kind === "tools" ? `tools:${x.items.length}` : x.msg.role))).toEqual(["user", "tools:2", "assistant", "tools:1"]);
  });
});

describe("command palette matching", () => {
  it("needs every word, ranks label starts first", () => {
    expect(matchScore("voice", "Voice & microphone")).toBe(3);
    expect(matchScore("mic", "Voice & microphone")).toBe(2);
    expect(matchScore("whisper", "Voice & microphone", "speech whisper")).toBe(1);
    expect(matchScore("spotify banana", "Connected services", "spotify")).toBe(0);
    expect(matchScore("", "Anything")).toBe(1);
  });
});

describe("Markdown", () => {
  it("renders the basics and never injects HTML", () => {
    const html = renderToStaticMarkup(<Markdown text={"**Bold** and `code`\n\n- one\n- two\n\n<script>alert(1)</script> [site](https://example.com)"} />);
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toContain("<li>one</li>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.com"');
  });
  it("ignores javascript: links", () => {
    expect(renderToStaticMarkup(<Markdown text="[x](javascript:alert(1))" />)).not.toContain("href=");
  });
});

describe("tool presentation", () => {
  it("labels known tools plainly and humanises the rest", () => {
    expect(toolLabel("launch_app")).toBe("Opened an app");
    expect(toolLabel("spotify_play")).toBe("Played on Spotify");
    expect(toolLabel("some_new_tool")).toBe("Some new tool");
    expect(toolLabel("mcp_files_read_file")).toBe("files: read file");
    expect(summary("<<<untrusted>>>\nfirst line\nsecond")).toBe("first line");
  });
});

describe("appearance", () => {
  it("parses accent colours", () => {
    expect(hexToRgb("#4ecdde")).toEqual([78, 205, 222]);
    expect(hexToRgb("nope")).toBeNull();
  });
});

describe("Core", () => {
  it("labels its state for screen readers and lights ticks with the mic level", () => {
    const quiet = renderToStaticMarkup(<Core state="listening" level={0} />);
    const loud = renderToStaticMarkup(<Core state="listening" level={1} />);
    expect(quiet).toContain('aria-label="BEV is listening"');
    const lit = (h: string) => (h.match(/stroke="rgb\(var\(--accent\)\)"/g) ?? []).length;
    expect(lit(loud)).toBeGreaterThan(lit(quiet));
    expect(renderToStaticMarkup(<Core state="off" />)).toContain("not listening");
  });
});
