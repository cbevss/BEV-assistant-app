/** Weather from Open-Meteo (free, no key): current conditions and a few days ahead. */
import { fetch } from "@tauri-apps/plugin-http";

const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};
export const describeCode = (c: number) => WMO[c] ?? "mixed weather";

export interface Forecast {
  place: string;
  now: { temp: number; feels: number; code: number; wind: number };
  days: Array<{ date: string; max: number; min: number; rain: number; code: number }>;
}

/** Pure: the forecast in a few sentences. */
export function describeForecast(f: Forecast, days = 3): string {
  const r = (n: number) => Math.round(n);
  const today = f.days[0];
  const lines = [`${f.place}: ${r(f.now.temp)}°C and ${describeCode(f.now.code)} now (feels like ${r(f.now.feels)}°C, wind ${r(f.now.wind)} km/h).`];
  if (today) lines.push(`Today ${r(today.min)} to ${r(today.max)}°C, ${today.rain}% chance of rain.`);
  for (const d of f.days.slice(1, days)) {
    const name = new Date(`${d.date}T12:00`).toLocaleDateString("en-GB", { weekday: "long" });
    lines.push(`${name}: ${describeCode(d.code)}, ${r(d.min)} to ${r(d.max)}°C, ${d.rain}% rain.`);
  }
  return lines.join(" ");
}

export async function getForecast(place: string, days = 3): Promise<Forecast> {
  const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(place)}`);
  const geo = (await g.json()) as { results?: Array<{ name: string; country?: string; admin1?: string; latitude: number; longitude: number }> };
  const loc = geo.results?.[0];
  if (!loc) throw new Error(`couldn't find a place called "${place}"`);
  const q = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    timezone: "auto",
    forecast_days: String(Math.min(Math.max(days, 1), 7)),
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!res.ok) throw new Error(`the weather service said ${res.status}`);
  const d = (await res.json()) as {
    current: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
    daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[]; weather_code: number[] };
  };
  return {
    place: [loc.name, loc.admin1 && loc.admin1 !== loc.name ? loc.admin1 : null, loc.country].filter(Boolean).join(", "),
    now: { temp: d.current.temperature_2m, feels: d.current.apparent_temperature, code: d.current.weather_code, wind: d.current.wind_speed_10m },
    days: d.daily.time.map((date, i) => ({ date, max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i], rain: d.daily.precipitation_probability_max[i] ?? 0, code: d.daily.weather_code[i] })),
  };
}
