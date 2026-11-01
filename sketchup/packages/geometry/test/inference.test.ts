import { describe, expect, it } from "vitest";
import { AXIS_COLOURS, axisInference } from "../src/inference.js";

const near = (a: readonly number[], b: readonly number[]): boolean =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-9;

describe("axis inference", () => {
  it("locks a segment along +x", () => {
    const r = axisInference([10, 20, 5], [110, 20, 5]);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("x");
    expect(near(r!.axis, [1, 0, 0])).toBe(true);
  });

  it("locks a segment along -y and keeps the sign", () => {
    // The arrow/label has to point the way the user is drawing, so a line run
    // backwards is on -Y, not Y.
    const r = axisInference([0, 50, 0], [0, -50, 0]);
    expect(r!.name).toBe("y");
    expect(near(r!.axis, [0, -1, 0])).toBe(true);
  });

  it("locks a segment along +z", () => {
    const r = axisInference([3, 4, 0], [3, 4, 200]);
    expect(r!.name).toBe("z");
    expect(near(r!.axis, [0, 0, 1])).toBe(true);
  });

  it("returns null for a diagonal", () => {
    // Both lateral drift and length, so no world axis describes it.
    expect(axisInference([0, 0, 0], [100, 100, 0])).toBeNull();
    expect(axisInference([0, 0, 0], [100, 100, 100])).toBeNull();
  });

  it("still locks when the drift is inside the default tolerance", () => {
    // 0.4 mm off the axis: under SketchUp's 0.5 mm threshold, so it locks.
    const r = axisInference([0, 0, 0], [100, 0.4, -0.4]);
    expect(r!.name).toBe("x");
    // "Within tolerance" is inclusive.
    expect(axisInference([0, 0, 0], [0.4, 100, 0])!.name).toBe("y");
  });

  it("returns null when the drift is outside the tolerance", () => {
    expect(axisInference([0, 0, 0], [100, 0.6, 0])).toBeNull();
    // A caller's tolerance is honoured too.
    expect(axisInference([0, 0, 0], [0, 100, 1], 2)!.name).toBe("y");
    expect(axisInference([0, 0, 0], [0, 100, 1], 0.5)).toBeNull();
  });

  it("falls back to the default tolerance when given one that is not positive", () => {
    expect(axisInference([0, 0, 0], [100, 0.4, 0], 0)!.name).toBe("x");
    expect(axisInference([0, 0, 0], [100, 0, 0], -1)!.name).toBe("x");
  });

  it("returns null for a zero-length segment", () => {
    expect(axisInference([5, 5, 5], [5, 5, 5])).toBeNull();
  });

  it("refuses a segment shorter than the tolerance along its own axis", () => {
    // Short enough to be a stray click, long enough not to be zero.
    expect(axisInference([0, 0, 0], [0.2, 0, 0])).toBeNull();
  });

  it("takes the longest qualifying component", () => {
    // 0.2 along x and 0.3 along y, 100 along z: every component is small enough
    // to be drift, so all three qualify and the longest wins — z, the axis the
    // segment really runs along. A slow-lock that named x here would put the
    // line on the wrong axis whenever the cursor barely moved.
    expect(axisInference([0, 0, 0], [0.2, 0.3, 100])!.name).toBe("z");
    expect(axisInference([0, 0, 0], [100, 0.2, 0.3])!.name).toBe("x");
    expect(axisInference([0, 0, 0], [0.2, 100, 0.3])!.name).toBe("y");
  });

  it("returns null when every component is inside the drift", () => {
    // No component clears the threshold, so no axis is longer than the drift:
    // this is a dot, not a line, and locking it would be a guess.
    expect(axisInference([0, 0, 0], [0.4, 0.4, 0.4])).toBeNull();
  });

  it("prefers a long axis over the shorter lateral one", () => {
    // 100 along x with 0.3 of y and 0.4 of z: all three clear the threshold, so
    // the axis itself is the longest and wins.
    expect(axisInference([0, 0, 0], [100, 0.3, 0.4])!.name).toBe("x");
  });

  it("draws every axis in SketchUp's colour", () => {
    const x = axisInference([0, 0, 0], [10, 0, 0])!;
    const y = axisInference([0, 0, 0], [0, 10, 0])!;
    const z = axisInference([0, 0, 0], [0, 0, 10])!;
    expect(x.colour).toBe(AXIS_COLOURS.x);
    expect(y.colour).toBe(AXIS_COLOURS.y);
    expect(z.colour).toBe(AXIS_COLOURS.z);
    // The table itself is the SketchUp palette, so a glyph and a test agree.
    expect(AXIS_COLOURS).toEqual({ x: 0xff3b30, y: 0x34c759, z: 0x0a84ff });
  });
});
