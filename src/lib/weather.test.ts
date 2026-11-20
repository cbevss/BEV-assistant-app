import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { describeForecast, describeCode } from "./weather";

describe("weather", () => {
  it("reads naturally", () => {
    const f = {
      place: "Leeds, England, United Kingdom",
      now: { temp: 7.4, feels: 4.6, code: 61, wind: 18.2 },
      days: [
        { date: "2026-11-20", max: 9.1, min: 3.2, rain: 80, code: 63 },
        { date: "2026-11-21", max: 8, min: 1.6, rain: 10, code: 2 },
      ],
    };
    expect(describeForecast(f)).toBe("Leeds, England, United Kingdom: 7°C and light rain now (feels like 5°C, wind 18 km/h). Today 3 to 9°C, 80% chance of rain. Saturday: partly cloudy, 2 to 8°C, 10% rain.");
    expect(describeCode(1234)).toBe("mixed weather");
  });
});
