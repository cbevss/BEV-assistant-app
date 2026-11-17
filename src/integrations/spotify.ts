/** Spotify: what's playing and playback control (Premium needed for control). */
import type { RegisteredTool } from "@/ai/tools";
import { useSettings } from "@/state/settings";
import { api, apiRaw, errorText } from "./http";
import { accessToken, type OAuthConfig } from "./oauth";
import { str, optStr } from "./args";

/** Register http://127.0.0.1:43117/callback as the app's Redirect URI. */
export const SPOTIFY_PORT = 43117;

export const spotifyOAuth = (): OAuthConfig => ({
  id: "spotify",
  authUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  clientId: useSettings.getState().settings.integrations.spotify.clientId,
  fixedPort: SPOTIFY_PORT,
  scopes: ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "playlist-read-private"],
});

const SP = "https://api.spotify.com/v1";
async function sp<T>(path: string, method = "GET", body?: unknown): Promise<T | null> {
  const token = await accessToken(spotifyOAuth());
  const r = await apiRaw(`${SP}${path}`, { token, method, body });
  if (r.status === 204 || !r.body.trim()) {
    if (r.status >= 400) throw new Error(errorText(r.status, null));
    return null;
  }
  const data = JSON.parse(r.body);
  if (r.status >= 400) {
    if (r.status === 404 && /NO_ACTIVE_DEVICE/i.test(r.body)) throw new Error("Spotify isn't open on any device: open it, then try again");
    if (r.status === 403) throw new Error("Spotify refused: controlling playback needs Spotify Premium");
    throw new Error(errorText(r.status, data));
  }
  return data as T;
}

interface Track {
  name: string;
  uri: string;
  artists?: Array<{ name: string }>;
  album?: { name: string };
}

export const describeTrack = (t: Track) => `"${t.name}"${t.artists?.length ? ` by ${t.artists.map((a) => a.name).join(", ")}` : ""}`;

export function spotifyTools(): Record<string, RegisteredTool> {
  return {
    spotify_now_playing: {
      spec: { name: "spotify_now_playing", description: "What's playing on Spotify right now, and on which device.", parameters: { type: "object", properties: {}, required: [] } },
      run: async () => {
        const p = await sp<{ is_playing: boolean; item?: Track; device?: { name: string; volume_percent?: number } }>("/me/player");
        if (!p || !p.item) return "Nothing is playing on Spotify.";
        return `${p.is_playing ? "Playing" : "Paused"}: ${describeTrack(p.item)}${p.device ? ` on ${p.device.name}${p.device.volume_percent != null ? ` at ${p.device.volume_percent}%` : ""}` : ""}.`;
      },
    },
    spotify_control: {
      spec: {
        name: "spotify_control",
        description: "Control Spotify playback: play, pause, next, previous, volume (0-100), shuffle on/off.",
        parameters: {
          type: "object",
          properties: { action: { type: "string", enum: ["play", "pause", "next", "previous", "volume", "shuffle_on", "shuffle_off"] }, value: { type: "number" } },
          required: ["action"],
        },
      },
      run: async (a) => {
        const action = str(a.action, "action");
        const map: Record<string, [string, string]> = {
          play: ["PUT", "/me/player/play"],
          pause: ["PUT", "/me/player/pause"],
          next: ["POST", "/me/player/next"],
          previous: ["POST", "/me/player/previous"],
          shuffle_on: ["PUT", "/me/player/shuffle?state=true"],
          shuffle_off: ["PUT", "/me/player/shuffle?state=false"],
        };
        if (action === "volume") {
          const v = Math.round(Math.max(0, Math.min(100, Number(a.value))));
          if (Number.isNaN(v)) throw new Error("volume needs a value 0-100");
          await sp(`/me/player/volume?volume_percent=${v}`, "PUT");
          return `Spotify volume set to ${v}%.`;
        }
        const m = map[action];
        if (!m) throw new Error(`unknown action ${action}`);
        await sp(m[1], m[0]);
        return `Done (${action.replace("_", " ")}).`;
      },
    },
    spotify_play: {
      spec: {
        name: "spotify_play",
        description: "Find and play something on Spotify: a song, artist, album or playlist (including the user's own playlists by name).",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, kind: { type: "string", enum: ["track", "artist", "album", "playlist"] } },
          required: ["query"],
        },
      },
      run: async (a) => {
        const q = str(a.query, "query");
        const kind = (optStr(a.kind) ?? "track") as "track" | "artist" | "album" | "playlist";
        if (kind === "playlist") {
          const mine = await sp<{ items: Array<{ name: string; uri: string }> }>("/me/playlists?limit=50");
          const own = mine?.items.find((p) => p.name.toLowerCase().includes(q.toLowerCase()));
          if (own) {
            await sp("/me/player/play", "PUT", { context_uri: own.uri });
            return `Playing your playlist "${own.name}".`;
          }
        }
        const res = await api<Record<string, { items: Array<Track & { uri: string }> }>>(`${SP}/search?type=${kind}&limit=1&q=${encodeURIComponent(q)}`, { token: await accessToken(spotifyOAuth()) });
        const hit = res[`${kind}s`]?.items?.[0];
        if (!hit) return `Couldn't find "${q}" on Spotify.`;
        await sp("/me/player/play", "PUT", kind === "track" ? { uris: [hit.uri] } : { context_uri: hit.uri });
        return `Playing ${kind === "track" ? describeTrack(hit) : `${kind} "${hit.name}"`}.`;
      },
    },
  };
}
