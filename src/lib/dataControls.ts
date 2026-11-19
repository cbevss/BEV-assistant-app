/**
 * Deleting BEV's data on this PC, one kind at a time or all of it
 * (Settings → Advanced → Your data).
 *
 * While signed in to a BEV account, memories and notes sync: deleting them
 * here deletes them on your other devices too, on the next sync.
 */
import { native } from "./native";
import { useSettings } from "@/state/settings";
import { useRoutines } from "@/routines/store";
import { loadWakeModels, removeWakeModel } from "@/voice/oww/model-store";
import { useAccount } from "@/account/account";
import { useAssistant } from "@/state/assistant";

/**
 * Every secret BEV keeps in Windows Credential Manager. Keep in step with the
 * names used across the app (dataControls.test.ts checks the shared constants).
 */
export const KNOWN_SECRETS = [
  "anthropic_api_key",
  "openai_api_key",
  "brave_search_key",
  "elevenlabs_key",
  "github_token",
  "homeassistant_token",
  "discord_bot_token",
  "google_client_secret",
  "bev_cloud_key",
  "oauth_spotify",
  "oauth_google",
] as const;

/** Secret names for this PC: the known ones plus each MCP server's token. */
export function secretNames(): string[] {
  const mcp = useSettings.getState().settings.integrations.mcp ?? [];
  return [...KNOWN_SECRETS, ...mcp.map((m) => `mcp_${m.id}_token`)];
}

export const dataActions = {
  conversations: async () => {
    await native.convClear();
    useAssistant.getState().clearMessages?.();
  },
  memories: () => native.memoriesClear(),
  notes: () => native.notesClear(),
  activity: () => native.activityClear(),
  /** Drop what screen replay is holding right now (it carries on if it's on). */
  replay: async () => {
    const s = useSettings.getState().settings;
    await native.replayConfigure(false);
    if (s.screenReplay) await native.replayConfigure(true);
  },
  secrets: async () => {
    for (const n of secretNames()) await native.deleteSecret(n).catch(() => {});
  },
};

/**
 * Erase everything BEV keeps on this PC: conversations, memories, notes,
 * activity, routines, custom wake phrases, saved keys and sign-ins, and every
 * setting (the app starts again from first-run setup). Signs this PC out of
 * the BEV account but doesn't delete the account.
 */
export async function eraseEverything(): Promise<void> {
  const account = useAccount.getState();
  // Sign out first, so emptying the PC isn't synced as "delete everywhere".
  if (account.status === "ready" || account.status === "locked" || account.status === "setup") await account.signOut();
  await dataActions.conversations();
  await dataActions.memories();
  await dataActions.notes();
  await dataActions.activity();
  await native.replayConfigure(false).catch(() => {});
  const routines = useRoutines.getState();
  for (const r of [...routines.routines]) await routines.remove(r.id);
  for (const m of await loadWakeModels().catch(() => [])) await removeWakeModel(m.name).catch(() => {});
  await dataActions.secrets();
  await useSettings.getState().update({ ...(await import("@/state/settings")).defaultSettings, onboarded: false });
}
