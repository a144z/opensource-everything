import { describe, expect, it } from "vitest";
import { angleFromText, deltaFromText } from "../src/input.js";

describe("typed move offsets", () => {
  it("one number moves along X", () => {
    expect(deltaFromText("500", "mm")).toEqual([500, 0, 0]);
  });

  it("three numbers are X, Y, Z", () => {
    expect(deltaFromText("500,0,-250", "mm")).toEqual([500, 0, -250]);
  });

  it("a blank axis means zero on that axis", () => {
    // The only way to type a pure Y move without counting positions.
    expect(deltaFromText(",500", "mm")).toEqual([0, 500, 0]);
    expect(deltaFromText(",,-30", "mm")).toEqual([0, 0, -30]);
  });

  it("accepts a semicolon separator as well as a comma", () => {
    expect(deltaFromText("10;20;30", "mm")).toEqual([10, 20, 30]);
  });

  it("reads the user's unit, not always millimetres", () => {
    const inches = deltaFromText("2,0", "in");
    expect(inches).not.toBeNull();
    expect(inches![0]).toBeCloseTo(50.8, 6);
  });

  it("refuses junk rather than guessing a direction", () => {
    // Wrong numbers move real objects; a refusal does not.
    expect(deltaFromText("abc", "mm")).toBeNull();
    expect(deltaFromText("1,2,3,4", "mm")).toBeNull();
    expect(deltaFromText("1,x", "mm")).toBeNull();
  });

  it("allows a leading minus for the other direction", () => {
    expect(deltaFromText("-120", "mm")).toEqual([-120, 0, 0]);
  });
});

describe("typed angles", () => {
  it("reads plain degrees, including the degree sign", () => {
    expect(angleFromText("45")).toBe(45);
    expect(angleFromText("-30")).toBe(-30);
    expect(angleFromText("12.5")).toBe(12.5);
    expect(angleFromText("90\u00b0")).toBe(90);
  });

  it("refuses anything that is not a finite number", () => {
    expect(angleFromText("")).toBeNull();
    expect(angleFromText("half")).toBeNull();
    expect(angleFromText("Infinity")).toBeNull();
  });
});
