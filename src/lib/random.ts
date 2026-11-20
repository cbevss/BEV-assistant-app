/** Real randomness (crypto), for coin flips, dice, picks and passwords. */

/** Uniform integer in [0, n) without modulo bias. */
export function randInt(n: number, rnd: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a)): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error("range out of bounds");
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    const v = rnd(buf)[0];
    if (v < limit) return v % n;
  }
}

const SETS = { lower: "abcdefghijkmnpqrstuvwxyz", upper: "ABCDEFGHJKLMNPQRSTUVWXYZ", digits: "23456789", symbols: "!@#$%^&*-_=+?" };

/** A password with at least one of each chosen kind; look-alikes (l/1/O/0) left out. */
export function makePassword(length = 20, symbols = true): string {
  const len = Math.min(Math.max(Math.round(length), 8), 128);
  const kinds = [SETS.lower, SETS.upper, SETS.digits, ...(symbols ? [SETS.symbols] : [])];
  const all = kinds.join("");
  const chars = kinds.map((k) => k[randInt(k.length)]);
  while (chars.length < len) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
