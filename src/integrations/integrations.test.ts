import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { matchEntities, serviceFor, haSensitive, describeState } from "./homeassistant";
import { messageText, rawEmail } from "./google";
import { parseRpcBody, resultText, toolKey, slug, mcpTools, McpClient } from "./mcp";
import { pkceChallenge, randomString } from "./oauth";
import { errorText } from "./http";

const st = (entity_id: string, state: string, name?: string) => ({ entity_id, state, attributes: { friendly_name: name } });

describe("Home Assistant", () => {
  const states = [st("light.living_room", "on", "Living Room Light"), st("sensor.bedroom_temperature", "19.5", "Bedroom Temperature"), st("lock.back_door", "locked", "Back Door")];
  it("finds entities by words in names and ids", () => {
    expect(matchEntities(states, "living room").map((s) => s.entity_id)).toEqual(["light.living_room"]);
    expect(matchEntities(states, "temperature")[0].entity_id).toBe("sensor.bedroom_temperature");
    expect(matchEntities(states, "")).toHaveLength(3);
    expect(describeState({ ...states[1], attributes: { friendly_name: "Bedroom", unit_of_measurement: "°C" } })).toBe("Bedroom (sensor.bedroom_temperature): 19.5 °C");
  });
  it("maps actions to services", () => {
    expect(serviceFor("light.x", "on")).toEqual({ domain: "light", service: "turn_on", data: { entity_id: "light.x" } });
    expect(serviceFor("light.x", "set", "40").data).toMatchObject({ brightness_pct: 40 });
    expect(serviceFor("climate.house", "set", "21")).toMatchObject({ service: "set_temperature", data: { temperature: 21 } });
    expect(serviceFor("scene.movie", "on").service).toBe("turn_on");
    expect(serviceFor("lock.door", "unlock").service).toBe("unlock");
    expect(() => serviceFor("sensor.t", "set", "1")).toThrow(/doesn't know/);
  });
  it("asks first for locks, alarms and opening garage doors", () => {
    expect(haSensitive("lock.back_door", "lock")).toBe(true);
    expect(haSensitive("alarm_control_panel.home", "off")).toBe(true);
    expect(haSensitive("cover.garage_door", "open")).toBe(true);
    expect(haSensitive("cover.garage_door", "close")).toBe(false);
    expect(haSensitive("light.kitchen", "off")).toBe(false);
  });
});

describe("Gmail helpers", () => {
  const enc = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_");
  it("prefers plain text and strips HTML otherwise", () => {
    expect(messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: enc("<b>Hi</b>") } }, { mimeType: "text/plain", body: { data: enc("Hi there") } }] })).toBe("Hi there");
    expect(messageText({ mimeType: "text/html", body: { data: enc("<style>x{}</style><p>Hello&nbsp;<i>you</i></p>") } })).toBe("Hello you");
  });
  it("builds a draft message", () => {
    const raw = rawEmail("a@b.com", "Hello", "Body");
    const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).toContain("To: a@b.com\r\nSubject: Hello\r\n");
    expect(decoded.endsWith("\r\n\r\nBody")).toBe(true);
  });
});

describe("MCP", () => {
  it("names tools safely", () => {
    expect(slug("My Files!")).toBe("my_files");
    expect(toolKey("My Files", "read.file")).toBe("mcp_my_files_read_file");
    expect(toolKey("x", "a".repeat(100)).length).toBe(64);
  });
  it("reads JSON and SSE replies", () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json", 1)).toMatchObject({ id: 1 });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(parseRpcBody(sse, "text/event-stream", 2)).toMatchObject({ result: { ok: true } });
    expect(() => parseRpcBody("data: {}\n\n", "text/event-stream", 3)).toThrow();
  });
  it("turns results into text", () => {
    expect(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a\n[image not shown]");
    expect(resultText({ content: [{ type: "text", text: "bad" }], isError: true })).toBe("error: bad");
    expect(resultText({ structuredContent: { n: 1 } })).toBe('{"n":1}');
  });
  it("marks tools: outside content always, approval unless read-only or trusted", () => {
    const c = new McpClient({ id: "1", name: "Files", transport: "stdio", command: "x", enabled: true, confirmActions: true });
    c.status = { state: "ready", tools: [{ name: "read", annotations: { readOnlyHint: true } }, { name: "write" }] };
    const t = mcpTools(c);
    expect(t.mcp_files_read.spec.sensitive).toBe(false);
    expect(t.mcp_files_write.spec.sensitive).toBe(true);
    expect(t.mcp_files_write.untrustedOutput).toBe(true);
    const trusted = new McpClient({ ...c.cfg, confirmActions: false });
    trusted.status = c.status;
    expect(mcpTools(trusted).mcp_files_write.spec.sensitive).toBe(false);
  });
});

describe("OAuth and HTTP helpers", () => {
  it("PKCE challenge matches the RFC 7636 example", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(randomString(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it("explains HTTP errors", () => {
    expect(errorText(401, { message: "Bad credentials" })).toBe("not signed in or the token expired: Bad credentials");
    expect(errorText(500, "")).toBe("error 500");
    expect(errorText(404, { error: { message: "nope" } })).toBe("not found: nope");
  });
});

import { formatMessages } from "./discord";
describe("Discord", () => {
  it("formats messages oldest first", () => {
    const out = formatMessages([
      { id: "2", content: "second", timestamp: "2026-11-17T10:05:00Z", author: { username: "b" } },
      { id: "1", content: "", timestamp: "2026-11-17T10:00:00Z", author: { username: "a", global_name: "Alice" }, attachments: [{}] },
    ]);
    expect(out.split("\n")[0]).toMatch(/Alice: \[attachment\]$/);
    expect(out.split("\n")[1]).toMatch(/b: second$/);
  });
});

import { describeOverview, describeConfig, noticeFor, describePrices } from "./bevbot";
describe("BEV bot owner link", () => {
  it("summarises the bot", () => {
    const t = describeOverview({ online: true, version: "4.81", uptime_s: 90000, latency_ms: 40, server_count: 2, member_count: 1500, servers: [{ id: "123456", name: "Hub", members: 1000 }, { id: "234567", name: "Test", members: 500 }], global_off: ["economy"], recent_errors: [] });
    expect(t).toContain("online, up 1d");
    expect(t).toContain("Hub (123456, 1000)");
    expect(t).toContain("Switched off everywhere: economy");
  });
  it("shows one feature's settings with channel ids", () => {
    const c = { guild: { name: "Hub" }, features: [{ key: "leveling", name: "Leveling", enabled: true, setup_ok: true, category: "x", settings: [{ key: "level_channel", kind: "channel", value: "99999" }] }], channels: [{ id: "99999", name: "levels", type: "text" }], roles: [] };
    expect(describeConfig(c)).toContain("● leveling");
    const one = describeConfig(c, "Leveling");
    expect(one).toContain("level_channel [channel]");
    expect(one).toContain("#levels=99999");
    expect(describeConfig(c, "nope")).toContain("No feature");
  });
  it("groups repeated errors into one notice key", () => {
    expect(noticeFor({ id: 1, kind: "error", text: "KeyError: x" }).key).toBe(noticeFor({ id: 2, kind: "error", text: "KeyError: x" }).key);
    expect(noticeFor({ id: 3, kind: "server", text: "joined" }).key).not.toBe(noticeFor({ id: 4, kind: "server", text: "joined" }).key);
    expect(noticeFor({ id: 5, kind: "price", text: "Price drop: Lamp is now £39.99" }).title).toBe("Price drop");
    expect(noticeFor({ id: 6, kind: "price", text: "Now tracking Lamp" }).title).toBe("Price tracker");
    expect(describePrices([])).toContain("isn't tracking");
    expect(describePrices([{ id: 3, name: "Lamp", url: "https://s.com/l", price_text: "£49.99", target: 40, lowest: 49.99, currency: "GBP", problem: null }])).toBe("#3 Lamp: £49.99 (target 40) https://s.com/l");
  });
});
