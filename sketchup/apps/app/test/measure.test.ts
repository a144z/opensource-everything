import { describe, expect, it } from "vitest";
import {
  NO_MEASURE,
  angleOnGround,
  angleValue,
  formatAngle,
  lengthValue,
  rectangleSize,
  round2,
  sizeValue,
  statusLine,
  typedRectangleSize,
  typedValue,
} from "../src/measure.js";

/**
 * Live measurements (task L4-1). The important property is not any single number
 * but that a *proposal* never reads like a *commit*: the phase is carried, so the
 * view can style "you are proposing 600" differently from "600 was committed".
 */
describe("statusLine", () => {
  it("puts the value first, then the label, then the prompt", () => {
    const line = statusLine(lengthValue("Length", 600, "mm", "click to finish"));
    expect(line.startsWith("600")).toBe(true);
    expect(line).toContain("Length");
    expect(line).toContain("click to finish");
  });

  it("leaves no stray separators when a part is empty", () => {
    expect(statusLine(NO_MEASURE)).toBe("");
    const line = statusLine(lengthValue("Length", 600, "mm"));
    expect(line.includes("··")).toBe(false);
    expect(line.endsWith(" ")).toBe(false);
  });
});

describe("phases", () => {
  it("defaults to proposed, so nothing claims to be committed by accident", () => {
    expect(lengthValue("Length", 10, "mm").phase).toBe("proposed");
    expect(sizeValue("Width", [1, 2], "mm").phase).toBe("proposed");
    expect(angleValue(90).phase).toBe("proposed");
  });

  it("keeps each phase when one is given", () => {
    expect(lengthValue("Length", 10, "mm", "", "committed").phase).toBe("committed");
    expect(lengthValue("Length", 10, "mm", "", "typed").phase).toBe("typed");
    expect(typedValue("600,400", "Enter to build").phase).toBe("typed");
  });

  it("formats in the unit handed in, not a global", () => {
    expect(lengthValue("Length", 600, "mm").text).toMatch(/^600/);
    expect(lengthValue("Length", 600, "cm").text).toMatch(/^60/);
    expect(lengthValue("Length", 304.8, "in").text).toBe(`1' 0"`);
  });
});

describe("angleOnGround", () => {
  it("counts counter-clockwise from +X, 0..360", () => {
    expect(angleOnGround([0, 0], [10, 0])).toBe(0);
    expect(angleOnGround([0, 0], [0, 10])).toBe(90);
    expect(angleOnGround([0, 0], [-10, 0])).toBe(180);
    expect(angleOnGround([0, 0], [0, -10])).toBe(270);
  });

  it("returns 0 for a zero-length move rather than NaN", () => {
    expect(angleOnGround([5, 5], [5, 5])).toBe(0);
  });
});

describe("formatAngle", () => {
  it("drops a trailing .0 but keeps one decimal when it means something", () => {
    expect(formatAngle(90)).toBe("90°");
    expect(formatAngle(45.04)).toBe("45°");
    expect(formatAngle(45.06)).toBe("45.1°");
  });
});

describe("rectangleSize", () => {
  it("reports both edges as positive, from either drag direction", () => {
    expect(rectangleSize([0, 0], [600, 400])).toEqual([600, 400]);
    expect(rectangleSize([600, 400], [0, 0])).toEqual([600, 400]);
    expect(rectangleSize([0, 0], [-600, 400])).toEqual([600, 400]);
  });

  it("rounds to hundredths of a millimetre", () => {
    expect(rectangleSize([0, 0], [1.23456, 2])).toEqual([1.23, 2]);
    expect(round2(2.675)).toBe(2.68);
    // Binary floats: 1.005 does not round up. Pinned so nobody "fixes" round2
    // into a decimal library for a value no drawing can reach.
    expect(round2(1.005)).toBe(1);
  });
});

describe("typedRectangleSize", () => {
  it("reads two numbers separated by comma, x, semicolon or space", () => {
    expect(typedRectangleSize("600,400")).toEqual([600, 400]);
    expect(typedRectangleSize("600x400")).toEqual([600, 400]);
    expect(typedRectangleSize("600;400")).toEqual([600, 400]);
    expect(typedRectangleSize("600 400")).toEqual([600, 400]);
  });

  it("refuses one number: which edge was meant has no answer the app may invent", () => {
    expect(typedRectangleSize("600")).toBeNull();
  });

  it("refuses three numbers, zero, negative and non-numeric", () => {
    expect(typedRectangleSize("600,400,300")).toBeNull();
    expect(typedRectangleSize("0,400")).toBeNull();
    expect(typedRectangleSize("-600,400")).toBeNull();
    expect(typedRectangleSize(",,")).toBeNull();
  });
});
