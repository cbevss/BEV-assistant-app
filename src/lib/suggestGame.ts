/**
 * "What should I play?": pick from installed games, favouring ones not
 * played lately (from play time), with real randomness so it isn't always
 * the same answer. Tools and redistributables are skipped.
 */
import { native } from "./native";
import { allSessions } from "./playtime";
import { randInt } from "./random";
import { formatDuration } from "./timers";

const NOT_GAMES = /redistributable|runtime|proton|steamworks|soundtrack|dedicated server|\bsdk\b|wallpaper engine|benchmark|directx|vc\+\+|\btools?\b/i;

/** Pure: weights for each game: higher for longer since last played (never = highest). */
export function weights(names: string[], lastPlayed: Map<string, number>, now: number): number[] {
  return names.map((n) => {
    const last = lastPlayed.get(n.toLowerCase());
    if (last === undefined) return 6;
    const days = (now - last) / 86_400_000;
    return days < 1 ? 1 : days < 7 ? 2 : days < 30 ? 4 : 5;
  });
}

/** Pure: weighted pick with a supplied random integer source. */
export function weightedPick<T>(items: T[], w: number[], rand: (n: number) => number): T {
  const total = w.reduce((a, b) => a + b, 0);
  let r = rand(total);
  for (let i = 0; i < items.length; i++) {
    r -= w[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

export async function suggestGame(exclude: string[] = [], now = Date.now()): Promise<string> {
  const games = (await native.listGames()).filter((g) => !NOT_GAMES.test(g.name) && !exclude.some((x) => g.name.toLowerCase().includes(x.toLowerCase())));
  if (!games.length) return "I couldn't find any installed games to pick from.";
  const last = new Map<string, number>();
  const total = new Map<string, number>();
  for (const s of allSessions(now)) {
    const k = s.game.toLowerCase();
    last.set(k, Math.max(last.get(k) ?? 0, s.end));
    total.set(k, (total.get(k) ?? 0) + (s.end - s.start));
  }
  const names = games.map((g) => g.name);
  const pick = weightedPick(games, weights(names, last, now), randInt);
  const k = pick.name.toLowerCase();
  const history = last.has(k) ? `You last played it ${Math.max(1, Math.round((now - last.get(k)!) / 86_400_000))} day(s) ago (${formatDuration(total.get(k) ?? 0)} in the last 90 days).` : "You haven't played it in the last 90 days.";
  return `How about ${pick.name}? ${history} (Picked from ${games.length} installed games. Say "launch it" to start it.)`;
}
