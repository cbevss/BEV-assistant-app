import type { InstalledGame } from "./native";

/**
 * Picks the installed game a spoken request means. Speech gives loose names
 * ("rocket league", "counter strike two on steam", "the witcher 3"), so this
 * normalises both sides and scores exact, prefix and word matches.
 */

const FILLER = /\b(on|via|with|through|using|from)\s+steam\b|\b(the\s+)?game\b|\bplease\b|\b(open|launch|start|play|run|load)\b/g;
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
};

export function normaliseGameName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "") // "Baldur's" → "baldurs", not "baldur s"
    .replace(/[^a-z0-9]+/g, " ")
    // "cs2" / "bg3" → "cs 2" / "bg 3", so they line up with initials below.
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(" ");
}

function cleanQuery(q: string): string {
  return normaliseGameName(q.toLowerCase().replace(FILLER, " "))
    .replace(/^the /, "")
    .trim();
}

function score(query: string, game: string): number {
  if (!query) return 0;
  if (game === query) return 100;
  const g = game.replace(/^the /, "");
  if (g === query) return 95;
  // "witcher 3" → "the witcher 3 wild hunt"; "rocket league" → "rocket league"
  if (g.startsWith(query + " ") || game.startsWith(query + " ")) return 85;
  // Initials: "gta 5" → Grand Theft Auto V, "cs 2" → Counter-Strike 2.
  const words = g.split(" ");
  const letters = words.filter((w) => !/^\d+$/.test(w)).map((w) => w[0]).join("");
  const numbers = words.filter((w) => /^\d+$/.test(w));
  if (letters.length >= 2) {
    if (query === [letters, ...numbers].join(" ")) return 80;
    if (query === letters) return 60;
  }
  const qWords = query.split(" ");
  const gWords = new Set(game.split(" "));
  const hits = qWords.filter((w) => gWords.has(w)).length;
  if (hits === qWords.length) return 70;
  // Squashed spellings: "rocketleague", "csgo" vs "cs go"
  if (game.replace(/ /g, "").includes(query.replace(/ /g, ""))) return 65;
  const ratio = hits / Math.max(qWords.length, gWords.size);
  return ratio >= 0.5 ? Math.round(40 + ratio * 20) : 0;
}

export interface GameMatch {
  game: InstalledGame | null;
  /** Closest names, to suggest when nothing matched well. */
  suggestions: string[];
}

export function matchGame(query: string, games: InstalledGame[]): GameMatch {
  const q = cleanQuery(query);
  const ranked = games
    .map((g) => ({ g, s: score(q, normaliseGameName(g.name)) }))
    .filter((x) => x.s > 0)
    // Best score first; on a tie the shorter name is the more likely meaning.
    .sort((a, b) => b.s - a.s || a.g.name.length - b.g.name.length);
  const best = ranked[0];
  return {
    game: best && best.s >= 50 ? best.g : null,
    suggestions: ranked.slice(0, 3).map((x) => x.g.name),
  };
}
