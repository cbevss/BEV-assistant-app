/**
 * Say units and symbols the way a person would: "16 GB" → "16 gigabytes",
 * "3.2 GHz" → "3.2 gigahertz", "71°C" → "71 degrees", "45%" → "45 percent".
 * Voices otherwise read "GB" as letters or guess badly. Only abbreviations
 * right after a number are expanded, so words like "MB" in a name are kept.
 */
const UNITS: Array<[string, string, string]> = [
  // [abbreviation, singular, plural]
  ["TB", "terabyte", "terabytes"],
  ["GB", "gigabyte", "gigabytes"],
  ["MB", "megabyte", "megabytes"],
  ["KB", "kilobyte", "kilobytes"],
  ["kB", "kilobyte", "kilobytes"],
  ["Gbps", "gigabit per second", "gigabits per second"],
  ["Mbps", "megabit per second", "megabits per second"],
  ["MB/s", "megabyte per second", "megabytes per second"],
  ["GB/s", "gigabyte per second", "gigabytes per second"],
  ["GHz", "gigahertz", "gigahertz"],
  ["MHz", "megahertz", "megahertz"],
  ["Hz", "hertz", "hertz"],
  ["RPM", "RPM", "RPM"],
  ["rpm", "RPM", "RPM"],
  ["fps", "frames per second", "frames per second"],
  ["FPS", "frames per second", "frames per second"],
  ["ms", "millisecond", "milliseconds"],
  ["kW", "kilowatt", "kilowatts"],
  ["W", "watt", "watts"],
  ["min", "minute", "minutes"],
  ["mins", "minutes", "minutes"],
  ["h", "hour", "hours"],
  ["hrs", "hours", "hours"],
  ["s", "second", "seconds"],
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT_RE = new RegExp(String.raw`(^|[^\w.])${NUM}\s?(${UNITS.map((u) => esc(u[0])).sort((a, b) => b.length - a.length).join("|")})(?![\w/])`, "g");

export function pronounce(text: string): string {
  return text
    .replace(new RegExp(String.raw`${NUM}\s?°\s?C\b`, "g"), "$1 degrees")
    .replace(new RegExp(String.raw`${NUM}\s?°\s?F\b`, "g"), "$1 degrees Fahrenheit")
    .replace(new RegExp(String.raw`${NUM}\s?°`, "g"), "$1 degrees")
    .replace(new RegExp(String.raw`${NUM}\s?%`, "g"), "$1 percent")
    .replace(UNIT_RE, (m, pre: string, n: string, unit: string) => {
      const u = UNITS.find((x) => x[0] === unit)!;
      // One-letter units need a space ("10 s", "158 W"), so "4090s" or "the 90s" stay as they are.
      if (unit.length === 1 && !/\d\s[A-Za-z]$/.test(m)) return m;
      const one = Number(n.replace(",", ".")) === 1;
      return `${pre}${n} ${one ? u[1] : u[2]}`;
    });
}
