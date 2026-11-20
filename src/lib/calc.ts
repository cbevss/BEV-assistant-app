/**
 * Exact maths and unit conversion, so BEV never does arithmetic in its head.
 * A small recursive-descent parser: no eval, no access to anything but numbers.
 */

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log: Math.log10,
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Evaluate an expression like "(12.5 + 3) * 4^2", "15% of 80", "sqrt(2)". Degrees for trig. */
export function calculate(input: string): number {
  const src = input
    .toLowerCase()
    .replace(/[×x](?=\s*[\d(.])/g, "*")
    .replace(/÷/g, "/")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/\bof\b/g, "*")
    .trim();
  if (!src) throw new Error("nothing to calculate");
  let i = 0;
  const peek = () => {
    while (src[i] === " ") i++;
    return src[i];
  };
  const eat = (c: string) => {
    if (peek() === c) {
      i++;
      return true;
    }
    return false;
  };

  const primary = (): number => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = expr();
      if (!eat(")")) throw new Error("missing )");
      return v;
    }
    if (c === "-") {
      i++;
      return -power();
    }
    if (c === "+") {
      i++;
      return power();
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    const word = /^[a-z]+/.exec(src.slice(i));
    if (word) {
      i += word[0].length;
      const w = word[0];
      if (w in CONSTS) return CONSTS[w];
      if (w in FUNCS) return FUNCS[w](primary());
      throw new Error(`unknown word "${w}"`);
    }
    throw new Error(c === undefined ? "expression ends too soon" : `unexpected "${c}"`);
  };

  const postfix = (): number => {
    let v = primary();
    for (;;) {
      if (eat("%")) v /= 100;
      else if (eat("!")) {
        if (v < 0 || v > 170 || !Number.isInteger(v)) throw new Error("factorial needs a whole number 0-170");
        let f = 1;
        for (let k = 2; k <= v; k++) f *= k;
        v = f;
      } else return v;
    }
  };

  const power = (): number => {
    const base = postfix();
    if (eat("^")) return Math.pow(base, unary());
    if (peek() === "*" && src[i + 1] === "*") {
      i += 2;
      return Math.pow(base, unary());
    }
    return base;
  };
  const unary = (): number => (eat("-") ? -unary() : power());

  const term = (): number => {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === "*" && src[i + 1] !== "*") {
        i++;
        v *= unary();
      } else if (c === "/") {
        i++;
        const d = unary();
        if (d === 0) throw new Error("can't divide by zero");
        v /= d;
      } else if (c === "(" ) {
        v *= unary(); // 2(3+4)
      } else return v;
    }
  };

  function expr(): number {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (peek() === "-") {
        i++;
        v -= term();
      } else return v;
    }
  }

  const v = expr();
  if (peek() !== undefined) throw new Error(`unexpected "${src[i]}"`);
  if (!Number.isFinite(v)) throw new Error("the answer isn't a finite number");
  return v;
}

/** Tidy a number for speech: no float noise, thousands separators. */
export function formatNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toLocaleString("en-GB");
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e15)) return v.toPrecision(6);
  return parseFloat(v.toPrecision(10)).toLocaleString("en-GB", { maximumFractionDigits: 6 });
}

// ---------------------------------------------------------------------------
// Units: each to a base unit per dimension.

type Dim = "length" | "mass" | "volume" | "time" | "speed" | "data" | "area" | "energy" | "temp";
const U: Record<string, [Dim, number]> = {};
const def = (dim: Dim, factor: number, ...names: string[]) => names.forEach((n) => (U[n] = [dim, factor]));

def("length", 1, "m", "meter", "meters", "metre", "metres");
def("length", 1000, "km", "kilometer", "kilometers", "kilometre", "kilometres");
def("length", 0.01, "cm", "centimeter", "centimeters", "centimetre", "centimetres");
def("length", 0.001, "mm", "millimeter", "millimeters", "millimetre", "millimetres");
def("length", 0.0254, "in", "inch", "inches");
def("length", 0.3048, "ft", "foot", "feet");
def("length", 0.9144, "yd", "yard", "yards");
def("length", 1609.344, "mi", "mile", "miles");
def("mass", 1, "kg", "kilo", "kilos", "kilogram", "kilograms");
def("mass", 0.001, "g", "gram", "grams");
def("mass", 1e-6, "mg", "milligram", "milligrams");
def("mass", 0.45359237, "lb", "lbs", "pound", "pounds");
def("mass", 0.028349523125, "oz", "ounce", "ounces");
def("mass", 6.35029318, "st", "stone", "stones");
def("mass", 1000, "t", "tonne", "tonnes");
def("volume", 1, "l", "liter", "liters", "litre", "litres");
def("volume", 0.001, "ml", "milliliter", "milliliters", "millilitre", "millilitres");
def("volume", 0.56826125, "pint", "pints");
def("volume", 4.54609, "gallon", "gallons");
def("volume", 3.785411784, "usgallon", "usgallons");
def("volume", 0.2365882365, "cup", "cups");
def("volume", 0.0147867648, "tbsp", "tablespoon", "tablespoons");
def("volume", 0.00492892159, "tsp", "teaspoon", "teaspoons");
def("time", 1, "s", "sec", "secs", "second", "seconds");
def("time", 0.001, "ms", "millisecond", "milliseconds");
def("time", 60, "min", "mins", "minute", "minutes");
def("time", 3600, "h", "hr", "hrs", "hour", "hours");
def("time", 86400, "day", "days");
def("time", 604800, "week", "weeks");
def("time", 31557600, "year", "years");
def("speed", 1, "m/s", "mps");
def("speed", 1 / 3.6, "km/h", "kmh", "kph");
def("speed", 0.44704, "mph");
def("speed", 0.514444, "knot", "knots");
def("data", 1, "b", "byte", "bytes");
def("data", 1e3, "kb", "kilobyte", "kilobytes");
def("data", 1e6, "mb", "megabyte", "megabytes");
def("data", 1e9, "gb", "gigabyte", "gigabytes");
def("data", 1e12, "tb", "terabyte", "terabytes");
def("data", 1024, "kib");
def("data", 1024 ** 2, "mib");
def("data", 1024 ** 3, "gib");
def("data", 1024 ** 4, "tib");
def("data", 0.125, "bit", "bits");
def("data", 125000, "mbit", "megabit", "megabits");
def("data", 125000000, "gbit", "gigabit", "gigabits");
def("area", 1, "m2", "sqm");
def("area", 1e6, "km2");
def("area", 0.09290304, "ft2", "sqft");
def("area", 4046.8564224, "acre", "acres");
def("area", 10000, "hectare", "hectares", "ha");
def("energy", 1, "j", "joule", "joules");
def("energy", 4184, "kcal", "calorie", "calories");
def("energy", 3.6e6, "kwh");
def("temp", 1, "c", "°c", "celsius", "f", "°f", "fahrenheit", "k", "kelvin");

const norm = (u: string) => u.trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, "");

function toKelvin(v: number, u: string): number {
  if (u.endsWith("f") || u === "fahrenheit") return ((v - 32) * 5) / 9 + 273.15;
  if (u === "k" || u === "kelvin") return v;
  return v + 273.15;
}
function fromKelvin(k: number, u: string): number {
  if (u.endsWith("f") || u === "fahrenheit") return ((k - 273.15) * 9) / 5 + 32;
  if (u === "k" || u === "kelvin") return k;
  return k - 273.15;
}

/** Convert `value` between two units of the same kind ("5 miles" → km, "180 lb" → kg). */
export function convertUnits(value: number, from: string, to: string): number {
  const f = norm(from);
  const t = norm(to);
  const a = U[f];
  const b = U[t];
  if (!a) throw new Error(`unknown unit "${from}"`);
  if (!b) throw new Error(`unknown unit "${to}"`);
  if (a[0] !== b[0]) throw new Error(`can't convert ${a[0]} (${from}) to ${b[0]} (${to})`);
  if (a[0] === "temp") return fromKelvin(toKelvin(value, f), t);
  return (value * a[1]) / b[1];
}
