import { describe, expect, it } from "vitest";
import {
  CIRCLE_SEGMENTS,
  arcPoints,
  circlePoints,
  closedArc,
  counterClockwise,
  polygonArea,
  polylineLength,
  signedArea,
} from "@apexus/geometry";
import { Session, addSolid, analyzeSolid } from "@apexus/engine";

describe("circle ring", () => {
  it("has the requested segment count and radius", () => {
    const ring = circlePoints([0, 0, 0], [10, 0, 0], 10);
    expect(ring).toHaveLength(CIRCLE_SEGMENTS);
    for (const p of ring) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 6);
  });

  it("starts where the user dragged, so the preview never jumps", () => {
    const ring = circlePoints([5, 5, 0], [5, 25, 0], 20);
    expect(ring[0]![0]).toBeCloseTo(5, 6);
    expect(ring[0]![1]).toBeCloseTo(25, 6);
  });

  it("is counter-clockwise and encloses pi r squared for large n", () => {
    const ring = circlePoints([0, 0, 0], [10, 0, 0], 10, 4096);
    const area = polygonArea(ring);
    expect(area).toBeCloseTo(Math.PI * 100, 0);
    // Shoelace sign decides winding; extruding needs one consistent direction.
    let signed = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      signed += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
    }
    expect(signed).toBeGreaterThan(0);
  });

  it("refuses a zero radius instead of emitting a degenerate solid", () => {
    expect(() => circlePoints([0, 0, 0], [0, 0, 0], 0)).toThrow(RangeError);
  });

  it("extrudes into a closed solid whose volume is the cylinder volume", () => {
    const radius = 25;
    const height = 40;
    const ring = circlePoints([0, 0, 0], [radius, 0, 0], radius, 256);
    const s = new Session();
    s.execute(
      addSolid({
        kind: "loop",
        points: ring,
        plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
        distance: height,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      }),
    );
    const id = [...s.document.solids.keys()][0]!;
    const geo = s.analyse(id);
    expect(geo.volume).toBeGreaterThan(Math.PI * radius * radius * height * 0.99);
    expect(geo.volume).toBeLessThan(Math.PI * radius * radius * height * 1.01);
  });
});

describe("three-point arc", () => {
  it("a semicircle passes through the middle point and ends on the start", () => {
    const arc = arcPoints(
      [
        [0, 0, 0],
        [50, 50, 0],
        [100, 0, 0],
      ],
      null,
    );
    expect(arc[0]).toEqual([0, 0]);
    expect(arc[arc.length - 1]).toEqual([100, 0]);
    // Half of a circle of radius 50.
    expect(polylineLength(arc)).toBeCloseTo(Math.PI * 50, 0);
    const mid = arc[Math.floor(arc.length / 2)]!;
    expect(mid[1]).toBeCloseTo(50, 0);
  });

  it("the arc that bulges below the chord sweeps the other way", () => {
    const arc = arcPoints(
      [
        [0, 0, 0],
        [50, -50, 0],
        [100, 0, 0],
      ],
      null,
    );
    const mid = arc[Math.floor(arc.length / 2)]!;
    expect(mid[1]).toBeCloseTo(-50, 0);
  });

  it("collinear points degrade to the chord instead of NaN", () => {
    const arc = arcPoints(
      [
        [0, 0, 0],
        [50, 0, 0],
        [100, 0, 0],
      ],
      null,
    );
    expect(arc).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("with two points and a moving third, the preview always tracks it", () => {
    const preview = arcPoints([[0, 0, 0]], [100, 0, 0]);
    expect(preview).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("a closed arc extrudes into a solid segment", () => {
    const arc = counterClockwise(
      closedArc(
        arcPoints(
          [
            [0, 0, 0],
            [50, 50, 0],
            [100, 0, 0],
          ],
          null,
        ),
      ),
    );
    const s = new Session();
    s.execute(
      addSolid({
        kind: "loop",
        points: arc,
        plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
        distance: 20,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      }),
    );
    const id = [...s.document.solids.keys()][0]!;
    const geo = s.analyse(id);
    // Semicircle area pi r^2 / 2 = 3927 mm2, times 20 mm depth.
    expect(geo.volume).toBeCloseTo(3927 * 20, -3);
  });

  it("counterClockwise fixes the winding an arc inherits from its sweep", () => {
    const cw = closedArc(
      arcPoints(
        [
          [0, 0, 0],
          [50, 50, 0],
          [100, 0, 0],
        ],
        null,
      ),
    );
    expect(signedArea(cw)).toBeLessThan(0); // arc + chord drawn that way is clockwise
    const fixed = counterClockwise(cw);
    expect(signedArea(fixed)).toBeCloseTo(-signedArea(cw), 6);
    expect(polygonArea(fixed)).toBeCloseTo(polygonArea(cw), 6); // same shape
  });
});
