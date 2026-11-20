import { describe, it, expect } from "vitest";
import { pronounce } from "./pronounce";

describe("pronounce", () => {
  it("says units in full after numbers", () => {
    expect(pronounce("You have 16 GB of video memory and 1.5TB free.")).toBe("You have 16 gigabytes of video memory and 1.5 terabytes free.");
    expect(pronounce("Only 1 GB left")).toBe("Only 1 gigabyte left");
    expect(pronounce("Core at 3120 MHz, 4.6GHz boost")).toBe("Core at 3120 megahertz, 4.6 gigahertz boost");
    expect(pronounce("71°C, hotspot 88 °C")).toBe("71 degrees, hotspot 88 degrees");
    expect(pronounce("GPU 97% busy, fan 1650 RPM, 158 W")).toBe("GPU 97 percent busy, fan 1650 RPM, 158 watts");
    expect(pronounce("Download at 45 MB/s, 300 Mbps line")).toBe("Download at 45 megabytes per second, 300 megabits per second line");
    expect(pronounce("4 min 10 s left, 1 h 5 min played")).toBe("4 minutes 10 seconds left, 1 hour 5 minutes played");
  });
  it("leaves other text alone", () => {
    expect(pronounce("The GB News channel and my MB drivers")).toBe("The GB News channel and my MB drivers");
    expect(pronounce("the 90s, took 2.5 s on v3W")).toBe("the 90s, took 2.5 seconds on v3W");
    expect(pronounce("RTX 4090s")).toBe("RTX 4090s");
  });
});
