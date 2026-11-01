import { describe, expect, it } from "vitest";
import { createBox } from "../src/index.js";
import {
  boundsQuadrants,
  faceCentres,
  footOnSegment,
  infer,
  perpendicularFeet,
  type SnapCandidate,
} from "../src/inference.js";

/** A 100 x 50 x 20 box with its min corner at the origin. */
const box = createBox({ width: 100, height: 50, depth: 20 });

const near = (a: readonly number[], b: readonly number[]): boolean =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-6;

describe("face centres", () => {
  it("gives one centre per plane, not per triangle", () => {
    const centres = faceCentres(box.positions);
    // A box has six faces; two triangles each would give twelve centres, and
    // the cursor would find two "Centre" points a few mm apart.
    expect(centres).toHaveLength(6);
    const keys = new Set(centres.map((c) => c.point.map((v) => v.toFixed(3)).join(",")));
    expect(keys.size).toBe(6);
  });

  it("puts the top face centre where a user expects to pull", () => {
    const centres = faceCentres(box.positions);
    const top = centres.find((c) => near(c.point, [50, 25, 20]));
    expect(top, JSON.stringify(centres.map((c) => c.point))).toBeDefined();
  });

  it("carries the face normal, so a pull knows which way to go", () => {
    const centres = faceCentres(box.positions);
    const top = centres.find((c) => near(c.point, [50, 25, 20]))!;
    expect(top.normal).toBeDefined();
    expect(top.normal![2]).toBeCloseTo(1, 6);
    const bottom = centres.find((c) => near(c.point, [50, 25, 0]))!;
    expect(bottom.normal![2]).toBeCloseTo(-1, 6);
  });

  it("survives degenerate triangles without inventing a centre", () => {
    // Two coincident points and the same point again: zero area, no plane.
    const flat = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(faceCentres(flat)).toHaveLength(0);
  });

  it("is an empty list for an empty mesh", () => {
    expect(faceCentres(new Float32Array())).toHaveLength(0);
  });
});

describe("quadrant points", () => {
  it("gives the four side midpoints at top and bottom", () => {
    const q = boundsQuadrants([0, 0, 0], [100, 50, 20]);
    expect(q).toHaveLength(8);
    for (const c of q) expect(c.kind).toBe("quadrant");
    expect(q.some((c) => near(c.point, [50, 0, 0]))).toBe(true);
    expect(q.some((c) => near(c.point, [100, 25, 20]))).toBe(true);
  });

  it("does not put a quadrant at a corner", () => {
    // Corners are vertices; a quadrant there would fight the endpoint snap at
    // equal distance and make the glyph flicker.
    const q = boundsQuadrants([0, 0, 0], [100, 50, 20]);
    expect(q.some((c) => near(c.point, [0, 0, 0]))).toBe(false);
  });

  it("works for an object that does not start at the origin", () => {
    const q = boundsQuadrants([-10, 40, 5], [10, 60, 5]);
    expect(q.every((c) => c.point[2] === 5)).toBe(true);
    expect(q.some((c) => near(c.point, [0, 40, 5]))).toBe(true);
  });
});

describe("foot of a perpendicular", () => {
  it("drops onto the middle of a segment", () => {
    expect(near(footOnSegment([50, 80, 0], [0, 0, 0], [100, 0, 0]), [50, 0, 0])).toBe(true);
  });

  it("clamps to the segment rather than escaping past an end", () => {
    // A "perpendicular" past the end is not on the edge at all.
    expect(near(footOnSegment([200, 80, 0], [0, 0, 0], [100, 0, 0]), [100, 0, 0])).toBe(true);
    expect(near(footOnSegment([-40, 0, 0], [0, 0, 0], [100, 0, 0]), [0, 0, 0])).toBe(true);
  });

  it("handles a zero-length segment without dividing by zero", () => {
    expect(near(footOnSegment([5, 5, 5], [1, 1, 1], [1, 1, 1]), [1, 1, 1])).toBe(true);
  });

  it("finds feet on an object's edges that are within reach", () => {
    const feet = perpendicularFeet([50, 400, 20], box.positions, 1000);
    expect(feet.length).toBeGreaterThan(0);
    for (const f of feet) expect(f.kind).toBe("perpendicular");
    // The top-back edge at y=50, z=20 has its foot directly above the origin.
    expect(feet.some((f) => near(f.point, [50, 50, 20]))).toBe(true);
  });

  it("finds nothing when the edges are further than the tolerance", () => {
    expect(perpendicularFeet([50, 5000, 20], box.positions, 10)).toHaveLength(0);
  });
});

describe("ranking the new points", () => {
  const cursor = [50, 0, 0] as const;
  const at = (kind: SnapCandidate["kind"], point: readonly [number, number, number]): SnapCandidate => ({ kind, point });

  it("prefers a quadrant to a centre at the same place", () => {
    const r = infer({
      cursor: [...cursor],
      candidates: [at("centre", cursor), at("quadrant", cursor)],
      mmPerPixel: 1,
    });
    expect(r.glyph.kind).toBe("quadrant");
  });

  it("prefers an endpoint to a quadrant", () => {
    const r = infer({
      cursor: [...cursor],
      candidates: [at("quadrant", cursor), at("vertex", cursor)],
      mmPerPixel: 1,
    });
    expect(r.glyph.kind).toBe("vertex");
  });

  it("passes a face normal through to the caller", () => {
    const r = infer({
      cursor: [50, 25, 20],
      candidates: faceCentres(box.positions),
      mmPerPixel: 1,
    });
    expect(r.glyph.kind).toBe("centre");
    expect(r.normal?.[2]).toBeCloseTo(1, 6);
  });

  it("leaves the normal absent for a plain vertex", () => {
    // A candidate with no normal must never report one from its neighbour.
    const r = infer({ cursor: [0, 0, 0], candidates: [{ kind: "vertex", point: [0, 0, 0] }], mmPerPixel: 1 });
    expect(r.glyph.kind).toBe("vertex");
    expect(r.normal).toBeUndefined();
  });

  it("an edge midpoint carries no normal of its own", () => {
    const mid: SnapCandidate = { kind: "midpoint", point: [50, 0, 0] };
    const r = infer({ cursor: [50, 0, 0], candidates: [mid], mmPerPixel: 1 });
    expect(r.normal).toBeUndefined();
  });
});
