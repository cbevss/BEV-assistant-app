export const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`argument "${name}" must be a non-empty string`);
  return v.trim();
};
export const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const num = (v: unknown, name: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || Number.isNaN(n)) throw new Error(`argument "${name}" must be a number`);
  return n;
};
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
