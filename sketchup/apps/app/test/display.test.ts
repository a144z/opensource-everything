import { describe, expect, it } from "vitest";
import { formatFeetInches, formatLengthIn, formatSizeIn, isUnit, parseIn, UNIT_IDS, UNIT_MENU } from "../src/display.js";

/**
 * Units (task L4-1/L4-2). The document is millimetres; this module is the only
 * place a number becomes text. The cases that matter are the ones a user notices:
 * an architectural fraction that does not reduce, a negative, and a zero.
 */
describe("formatFeetInches", () => {
  it("writes whole feet and inches the way a tape reads", () => {
    expect(formatFeetInches(0)).toBe('0"');
    expect(formatFeetInches(25.4)).toBe('1"');
    expect(formatFeetInches(304.8)).toBe(`1' 0"`);
    expect(formatFeetInches(304.8 + 101.6)).toBe(`1' 4"`);
  });

  it("reduces sixteenths to the smallest fraction", () => {
    // 1/2" = 12.7 mm, 3/8" = 9.525 mm, 1/16" = 1.5875 mm.
    expect(formatFeetInches(12.7)).toBe('1/2"');
    expect(formatFeetInches(9.525)).toBe('3/8"');
    expect(formatFeetInches(1.5875)).toBe('1/16"');
    expect(formatFeetInches(25.4 * 1.5)).toBe('1 1/2"');
  });

  it("rounds to the nearest sixteenth, not down", () => {
    // 1/32" above 1" must read 1", and 3/32" must round up to 1/8".
    expect(formatFeetInches(25.4 + 0.79)).toBe('1"');
    expect(formatFeetInches(25.4 + 2.38)).toBe('1 1/8"');
  });

  it("keeps the sign in front of the feet", () => {
    expect(formatFeetInches(-304.8)).toBe(`-1' 0"`);
  });

  it("gives an empty string for a non-finite length rather than NaN", () => {
    expect(formatFeetInches(Number.NaN)).toBe("");
    expect(formatFeetInches(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("formatLengthIn", () => {
  it("uses each unit's own precision so 12 mm and 1.20 cm do not both read 12.00", () => {
    expect(formatLengthIn("mm", 12)).toMatch(/^12(\.0)?mm$/);
    expect(formatLengthIn("cm", 12)).toMatch(/^1\.2\dcm$/);
    expect(formatLengthIn("m", 1234)).toMatch(/^1\.2\d+m$/);
  });

  it("routes inches through the architectural formatter", () => {
    expect(formatLengthIn("in", 304.8)).toBe(`1' 0"`);
  });
});

describe("formatSizeIn", () => {
  it("joins the axes with the multiplication sign and one unit", () => {
    const text = formatSizeIn("mm", [600, 400, 300]);
    expect(text).toContain("600");
    expect(text).toContain("400");
    expect(text).toContain("300");
    expect(text.endsWith("mm")).toBe(true);
  });

  it("states the unit on every inch because an inch reads without one", () => {
    expect(formatSizeIn("in", [609.6, 304.8])).toBe(`2' 0" × 1' 0"`);
  });
});

describe("parseIn", () => {
  it("reads a bare number in the display unit", () => {
    expect(parseIn("mm", "600")).toBe(600);
    expect(parseIn("cm", "60")).toBe(600);
    expect(parseIn("m", "0.6")).toBe(600);
  });

  it("lets an explicit suffix win over the display unit", () => {
    expect(parseIn("in", "25mm")).toBe(25);
    expect(parseIn("mm", `2'`)).toBe(609.6);
  });

  it("returns null for text that is not a length", () => {
    expect(parseIn("mm", "wide")).toBeNull();
    expect(parseIn("mm", "")).toBeNull();
  });
});

describe("the unit table", () => {
  it("has a formatter for every id it offers", () => {
    for (const unit of UNIT_IDS) {
      expect(UNIT_MENU.some((u) => u.id === unit)).toBe(true);
      expect(formatLengthIn(unit, 100)).not.toBe("");
    }
  });

  it("recognises only ids it offers", () => {
    expect(isUnit("mm")).toBe(true);
    expect(isUnit("in")).toBe(true);
    expect(isUnit("furlong")).toBe(false);
  });
});
