import { describe, expect, it } from "vitest";
import { polygonArea } from "../src/index.js";
import { polygonPoints } from "../src/rings.js";

const centre = [0, 0, 0] as const;
const right = [100, 0, 0] as const;

describe("polygon rings", () => {
  it("has exactly as many vertices as sides", () => {
    for (const n of [3, 4, 5, 6, 12]) {
      expect(polygonPoints(centre, right, 100, n)).toHaveLength(n);
    }
  });

  it("puts a vertex under the cursor", () => {
    // The first vertex is the one the user is dragging, so the shape never
    // appears to jump when they change the radius.
    const ring = polygonPoints(centre, [30, 40, 0], 50, 5);
    expect(ring[0]![0]).toBeCloseTo(30, 6);
    expect(ring[0]![1]).toBeCloseTo(40, 6);
  });

  it("keeps every vertex on the circumscribed circle", () => {
    for (const p of polygonPoints(centre, right, 100, 7)) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(100, 6);
    }
  });

  it("a square has exactly the area of a square", () => {
    // A 45-degree square of circumradius r has area 2r^2.
    const ring = polygonPoints(centre, right, 100, 4);
    expect(polygonArea(ring)).toBeCloseTo(2 * 100 * 100, 6);
  });

  it("a hexagon's area matches the closed form", () => {
    // (3*sqrt(3)/2) * r^2
    const ring = polygonPoints(centre, right, 100, 6);
    expect(polygonArea(ring)).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100 * 100, 6);
  });

  it("clamps an impossible side count rather than drawing nothing", () => {
    expect(polygonPoints(centre, right, 10, 2)).toHaveLength(3);
    expect(polygonPoints(centre, right, 10, 0)).toHaveLength(3);
    expect(polygonPoints(centre, right, 10, 5000)).toHaveLength(96);
  });

  it("rounds a fractional side count", () => {
    expect(polygonPoints(centre, right, 10, 6.6)).toHaveLength(7);
  });

  it("refuses a radius of zero, which has no shape", () => {
    expect(() => polygonPoints(centre, right, 0, 6)).toThrow(/radius/i);
    expect(() => polygonPoints(centre, right, -5, 6)).toThrow(/radius/i);
  });

  it("refuses a NaN side count instead of looping forever", () => {
    expect(() => polygonPoints(centre, right, 10, Number.NaN)).toThrow(/sides/i);
  });

  it("winds counter-clockwise, so the extrusion points up", () => {
    const ring = polygonPoints(centre, right, 100, 5);
    let signed = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      signed += a[0] * b[1] - b[0] * a[1];
    }
    expect(signed).toBeGreaterThan(0);
  });
});
