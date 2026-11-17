/**
 * Installed-app engine (src-tauri/src/appengine): open / close apps by what
 * the user called them, with verified outcomes. This module turns the
 * engine's structured results into plain facts for the AI.
 */
import { invoke } from "@tauri-apps/api/core";

export type OpenResult =
  | { status: "opened"; app: string; window: string }
  | { status: "already_running"; app: string; window: string; focused: boolean }
  | { status: "starting"; app: string; detail: string }
  | { status: "unverified"; app: string; detail: string }
  | { status: "failed"; app: string; error: string }
  | { status: "ambiguous"; options: string[] }
  | { status: "not_installed"; query: string; suggestions: string[]; store_url: string | null };

export type CloseResult =
  | { status: "closed"; app: string }
  | { status: "not_running"; app: string }
  | { status: "still_open"; app: string; window: string }
  | { status: "force_closed"; app: string; processes: number }
  | { status: "failed"; app: string; error: string }
  | { status: "ambiguous"; options: string[] }
  | { status: "not_installed"; query: string };

export interface AppIndexStatus {
  count: number;
  scanned_at: number;
  scanning: boolean;
  last_error: string | null;
}

export interface AppRow {
  name: string;
  kind: "packaged" | "win32" | "system";
  source: string;
  exe_name: string | null;
  aliases: string[];
}

export const appsApi = {
  open: (query: string) => invoke<OpenResult>("apps_open", { query }),
  close: (query: string, force = false) => invoke<CloseResult>("apps_close", { query, force }),
  search: (query: string, limit = 8) =>
    invoke<Array<{ name: string; kind: string; score: number }>>("apps_search", { query, limit }),
  refresh: () => invoke<number>("apps_refresh"),
  status: () => invoke<AppIndexStatus>("apps_status"),
  list: () => invoke<AppRow[]>("apps_list"),
};

/** A tool failure the AI should report as a failure. */
export class AppActionError extends Error {}

const list = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");

/**
 * Engine result → what the AI is told. Success claims only when there's
 * evidence; failures throw so the tool call is marked failed.
 */
export function describeOpen(r: OpenResult): string {
  switch (r.status) {
    case "opened":
      return `Opened ${r.app} (its window "${r.window}" appeared).`;
    case "already_running":
      return r.focused
        ? `${r.app} was already open; brought it to the front.`
        : `${r.app} is already open, but Windows wouldn't bring it to the front (it should be flashing in the taskbar).`;
    case "starting":
      return `${r.app} is starting (${r.detail}). Don't say it's open yet; say it's starting up.`;
    case "unverified":
      return `Asked Windows to open ${r.app}, but couldn't confirm it opened (${r.detail}). Tell the user you're not sure it opened.`;
    case "failed":
      throw new AppActionError(`${r.app} didn't open: ${r.error}`);
    case "ambiguous":
      return `Several installed apps match: ${list(r.options)}. Ask the user which one they mean; don't guess.`;
    case "not_installed":
      return [
        `No installed app matches "${r.query}".`,
        r.suggestions.length ? `Closest installed: ${list(r.suggestions)} (only if one is clearly what they meant).` : "",
        r.store_url
          ? `It's on the Microsoft Store: ${r.store_url}. Offer to open that page; don't install anything without asking.`
          : "Offer to find its official download page. Don't install anything without asking.",
      ]
        .filter(Boolean)
        .join(" ");
  }
}

export function describeClose(r: CloseResult): string {
  switch (r.status) {
    case "closed":
      return `Closed ${r.app}.`;
    case "not_running":
      return `${r.app} wasn't running.`;
    case "still_open":
      return `Asked ${r.app} to close, but it's still open ("${r.window}"); it's probably asking to save changes. Tell the user. Only force-close if they ask, because unsaved work would be lost.`;
    case "force_closed":
      return `Force-closed ${r.app} (${r.processes} process${r.processes === 1 ? "" : "es"}).`;
    case "failed":
      throw new AppActionError(`Couldn't close ${r.app}: ${r.error}`);
    case "ambiguous":
      return `Several apps match: ${list(r.options)}. Ask the user which one to close.`;
    case "not_installed":
      return `No app called "${r.query}" was found.`;
  }
}
