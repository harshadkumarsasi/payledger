import { describe, expect, it } from "vitest";

import { formatMinor, parseRupeesToMinor } from "@/lib/money";

describe("integer money helpers", () => {
  it("parses rupee strings into integer paise", () => {
    expect(parseRupeesToMinor("500")).toBe(50_000);
    expect(parseRupeesToMinor("500.5")).toBe(50_050);
    expect(parseRupeesToMinor("1,234.56")).toBe(123_456);
    expect(parseRupeesToMinor("0.99")).toBe(99);
    expect(parseRupeesToMinor("0.9")).toBe(90);
    expect(parseRupeesToMinor("0.09")).toBe(9);
    // Explicit requested test cases:
    expect(parseRupeesToMinor("42.50")).toBe(4_250);
    expect(parseRupeesToMinor("0.07")).toBe(7);
    expect(parseRupeesToMinor(" 100 ")).toBe(10_000);
  });

  it("rejects malformed, negative, and over-precise input", () => {
    expect(parseRupeesToMinor("")).toBeNull();
    expect(parseRupeesToMinor("abc")).toBeNull();
    expect(parseRupeesToMinor("-5")).toBeNull();
    expect(parseRupeesToMinor("1.234")).toBeNull();
    expect(parseRupeesToMinor("1e3")).toBeNull();
    expect(parseRupeesToMinor(".")).toBeNull();
    // Explicit requested test cases:
    expect(parseRupeesToMinor("100.999")).toBeNull();
    expect(parseRupeesToMinor("999999999999999999999999999999")).toBeNull();
  });

  it("formats paise as rupees without floating point rounding", () => {
    expect(formatMinor(50_000)).toBe("₹500.00");
    expect(formatMinor(123_456)).toBe("₹1,234.56");
    expect(formatMinor(9)).toBe("₹0.09");
    expect(formatMinor(-900_000)).toBe("-₹9,000.00");
    expect(formatMinor(0)).toBe("₹0.00");
  });
});
