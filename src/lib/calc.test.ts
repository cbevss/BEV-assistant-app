import { describe, expect, it } from "vitest";
import { calculate, convertUnits, formatNumber } from "./calc";

describe("calculate", () => {
  it("does arithmetic with precedence", () => {
    expect(calculate("2 + 3 * 4")).toBe(14);
    expect(calculate("(2 + 3) * 4")).toBe(20);
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-2^2")).toBe(-4);
    expect(calculate("2**10")).toBe(1024);
    expect(calculate("10 / 4")).toBe(2.5);
    expect(calculate("2(3+4)")).toBe(14);
    expect(calculate("1,250 x 4")).toBe(5000);
    expect(calculate("12 ÷ 3")).toBe(4);
  });
  it("handles percent, functions and constants", () => {
    expect(calculate("15% of 80")).toBeCloseTo(12);
    expect(calculate("sqrt(144)")).toBe(12);
    expect(calculate("sin(30)")).toBeCloseTo(0.5);
    expect(calculate("5!")).toBe(120);
    expect(calculate("2 * pi")).toBeCloseTo(6.283185);
    expect(calculate("1e3 + 1")).toBe(1001);
  });
  it("rejects junk", () => {
    expect(() => calculate("1/0")).toThrow(/zero/);
    expect(() => calculate("2 +")).toThrow();
    expect(() => calculate("alert(1)")).toThrow(/unknown/);
    expect(() => calculate("(1+2")).toThrow(/\)/);
    expect(() => calculate("")).toThrow();
  });
});

describe("convertUnits", () => {
  it("converts within a dimension", () => {
    expect(convertUnits(5, "miles", "km")).toBeCloseTo(8.04672);
    expect(convertUnits(180, "lb", "kg")).toBeCloseTo(81.6466);
    expect(convertUnits(1, "GB", "MB")).toBe(1000);
    expect(convertUnits(1, "GiB", "MB")).toBeCloseTo(1073.741824);
    expect(convertUnits(100, "Mbit", "MB")).toBeCloseTo(12.5);
    expect(convertUnits(2, "hours", "minutes")).toBe(120);
  });
  it("converts temperature", () => {
    expect(convertUnits(100, "C", "F")).toBeCloseTo(212);
    expect(convertUnits(32, "°F", "celsius")).toBeCloseTo(0);
    expect(convertUnits(0, "kelvin", "C")).toBeCloseTo(-273.15);
  });
  it("refuses mismatches", () => {
    expect(() => convertUnits(1, "kg", "km")).toThrow(/can't convert/);
    expect(() => convertUnits(1, "parsec", "km")).toThrow(/unknown/);
  });
});

describe("formatNumber", () => {
  it("strips float noise", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(2 / 3)).toBe("0.666667");
  });
});
