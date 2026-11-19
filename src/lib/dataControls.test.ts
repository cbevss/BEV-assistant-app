import { describe, expect, it } from "vitest";
import { KNOWN_SECRETS, secretNames } from "./dataControls";
import { ELEVEN_SECRET } from "@/voice/tts";
import { BRAVE_KEY } from "@/research/search";
import { HA_TOKEN } from "@/integrations/homeassistant";
import { GOOGLE_SECRET } from "@/integrations/google";
import { CLOUD_KEY_SECRET } from "@/lib/bevCloud";
import { GH_TOKEN } from "@/integrations/github";
import { DISCORD_TOKEN } from "@/integrations/discord";
import { secretNameFor } from "@/ai/factory";
import { useSettings } from "@/state/settings";

describe("deleting saved keys", () => {
  it("covers every secret name the app uses", () => {
    const used = [ELEVEN_SECRET, BRAVE_KEY, HA_TOKEN, GOOGLE_SECRET, CLOUD_KEY_SECRET, GH_TOKEN, DISCORD_TOKEN, "oauth_spotify", "oauth_google"];
    for (const n of Object.values(secretNameFor)) if (n) used.push(n);
    for (const n of used) expect(KNOWN_SECRETS).toContain(n);
  });

  it("includes each MCP server's token", () => {
    const s = useSettings.getState().settings;
    useSettings.setState({ settings: { ...s, integrations: { ...s.integrations, mcp: [{ id: "notion" } as never] } } });
    expect(secretNames()).toContain("mcp_notion_token");
    useSettings.setState({ settings: s });
  });
});
