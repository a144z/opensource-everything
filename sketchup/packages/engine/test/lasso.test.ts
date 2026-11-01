import { describe, expect, it } from "vitest";
import {
  boxInsidePath,
  boxTouchesPath,
  isLassoPath,
  lassoDirection,
  pointInPolygon,
  selectByLasso,
  type ScreenBox,
} from "../src/marquee.js";

/**
 * A lasso must mean exactly what a rectangle drag means. The rule lives in the
 * same file as the rectangle rule so the two cannot drift: a user who learns
 * "drag left to right encloses, right to left crosses" gets both gestures free.
 */

const box = (minX: number, minY: number, maxX: number, maxY: number): ScreenBox => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** A clockwise ring around pixels 0..100. */
const ring = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
] as const;

/** The same ring drawn right-to-left, which means "crossing". */
const ringBackwards = [
  [100, 0],
  [100, 100],
  [0, 100],
  [0, 0],
] as const;

describe("point in polygon", () => {
  it("finds an interior point", () => {
    expect(pointInPolygon([50, 50], ring)).toBe(true);
  });

  it("rejects a point outside", () => {
    expect(pointInPolygon([150, 50], ring)).toBe(false);
    expect(pointInPolygon([-5, 50], ring)).toBe(false);
  });

  it("rejects a point in the notch of an L shape", () => {
    // The shape bites a quarter out of the top-right; the bite is outside.
    const l = [
      [0, 0],
      [50, 0],
      [50, 50],
      [100, 50],
      [100, 100],
      [0, 100],
    ] as const;
    expect(pointInPolygon([25, 75], l)).toBe(true);
    expect(pointInPolygon([80, 20], l)).toBe(false);
  });

  it("uses even-odd for a self-intersecting scribble", () => {
    // The path crosses itself at (50, 50), which cuts the loop into a left lobe
    // and a right lobe. Even-odd makes both inside; (50, 25) is in the notch
    // between the two arms, not in a lobe, so it stays out.
    const bow = [
      [0, 0],
      [100, 100],
      [100, 0],
      [0, 100],
    ] as const;
    expect(pointInPolygon([20, 50], bow)).toBe(true);
    expect(pointInPolygon([80, 20], bow)).toBe(true);
    expect(pointInPolygon([50, 25], bow)).toBe(false);
    expect(pointInPolygon([110, 50], bow)).toBe(false);
  });
});

describe("lasso path validity", () => {
  it("rejects a path too short to enclose anything", () => {
    expect(isLassoPath([])).toBe(false);
    expect(isLassoPath([{ x: 0, y: 0 }, { x: 50, y: 50 }])).toBe(false);
  });

  it("rejects a path that never moved, i.e. a click", () => {
    expect(
      isLassoPath([
        { x: 10, y: 10 },
        { x: 11, y: 10 },
        { x: 10, y: 11 },
      ]),
    ).toBe(false);
  });

  it("accepts a real loop", () => {
    expect(
      isLassoPath([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]),
    ).toBe(true);
  });
});

describe("lasso direction", () => {
  it("a path ending to the right of where it started is a window", () => {
    expect(lassoDirection(ring)).toBe("window");
  });

  it("a path that travelled left is a crossing", () => {
    expect(lassoDirection(ringBackwards)).toBe("crossing");
  });

  it("an empty path defaults to the safe rule", () => {
    expect(lassoDirection([])).toBe("window");
  });
});

describe("enclosure", () => {
  it("picks a box wholly inside the path", () => {
    expect(boxInsidePath(box(20, 20, 60, 60), ring)).toBe(true);
  });

  it("rejects a box that pokes out", () => {
    expect(boxInsidePath(box(80, 80, 160, 160), ring)).toBe(false);
  });

  it("rejects everything when the path is not a loop", () => {
    expect(boxInsidePath(box(20, 20, 60, 60), [[0, 0], [10, 10]] as const)).toBe(false);
  });
});

describe("crossing", () => {
  it("picks a box that straddles the path edge", () => {
    expect(boxTouchesPath(box(80, 80, 160, 160), ring)).toBe(true);
  });

  it("picks a box that entirely contains the lasso", () => {
    // A small loop drawn inside one big object must still select it.
    expect(boxTouchesPath(box(-10, -10, 200, 200), ring)).toBe(true);
  });

  it("picks a box whose only corner in the loop is not its top-left", () => {
    // Regression: checking only the min corner missed a loop tucked into the
    // bottom-right of an object, and selecting it then took an extra drag.
    const tucked = [
      [101, 101],
      [140, 101],
      [140, 140],
      [101, 140],
    ] as const;
    expect(boxTouchesPath(box(100, 100, 200, 200), tucked)).toBe(true);
  });

  it("rejects a box far away", () => {
    expect(boxTouchesPath(box(500, 500, 600, 600), ring)).toBe(false);
  });
});

describe("select by lasso", () => {
  const boxes: Record<string, ScreenBox> = {
    inside: box(20, 20, 60, 60),
    straddling: box(80, 80, 160, 160),
    outside: box(500, 500, 600, 600),
    offscreen: box(0, 0, 0, 0),
  };
  const project = (id: string): ScreenBox | null => (id === "offscreen" ? null : (boxes[id] ?? null));

  it("a window keeps only fully-enclosed objects", () => {
    expect(selectByLasso(Object.keys(boxes), ring, project)).toEqual(["inside"]);
  });

  it("a crossing keeps anything it touches", () => {
    expect(selectByLasso(Object.keys(boxes), ringBackwards, project)).toEqual(["inside", "straddling"]);
  });

  it("skips an object with no screen box instead of failing", () => {
    expect(selectByLasso(["offscreen"], ring, project)).toEqual([]);
  });

  it("preserves the order it was given", () => {
    expect(selectByLasso(["straddling", "inside"], ringBackwards, project)).toEqual(["straddling", "inside"]);
  });
});
