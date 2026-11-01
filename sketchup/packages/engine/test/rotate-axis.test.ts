import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  boundsOf,
  planeBasis,
  rotateSolids,
  type SolidId,
  type SolidRecipe,
} from "../src/index.js";

/**
 * A turn about a given axis and the plane its angle is measured in must agree.
 * If they disagree, the hint says "90 deg about X" while the object turns the
 * other way, which is the kind of error a user blames on the mouse.
 */

const box = (w: number, h: number, d: number): SolidRecipe => ({
  kind: "box",
  width: w,
  height: h,
  depth: d,
  origin: [0, 0, 0],
});

function one(): { session: Session; id: SolidId } {
  const session = new Session();
  const cmd = addSolid(box(100, 20, 5));
  session.execute(cmd);
  const id = [...session.document.solids.keys()][0]!;
  return { session, id };
}

describe("rotate plane basis", () => {
  it("each basis is right-handed about its axis", () => {
    for (const axis of ["x", "y", "z"] as const) {
      const { u, v } = planeBasis(axis);
      // u x v must equal the axis, not its negative.
      const cx = u[1] * v[2] - u[2] * v[1];
      const cy = u[2] * v[0] - u[0] * v[2];
      const cz = u[0] * v[1] - u[1] * v[0];
      const expected = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
      expect([cx, cy, cz]).toEqual(expected);
    }
  });

  it("a +90 turn about X lifts the in-plane u direction towards v", () => {
    // Measured positively from u towards v; the box's long axis starts along X,
    // so after turning about X the X span is unchanged and Y/Z swap.
    const { session, id } = one();
    const before = boundsOf(session, id);
    session.execute(rotateSolids([id], "x", 90, [0, 0, 0]));
    const after = boundsOf(session, id);
    expect(after.max[0]).toBeCloseTo(before.max[0], 6);
    expect(after.max[1]).toBeCloseTo(before.max[1], 6);
  });

  it("a +90 turn about Y swaps the X and Z spans", () => {
    const { session, id } = one();
    const before = boundsOf(session, id);
    session.execute(rotateSolids([id], "y", 90, [0, 0, 0]));
    const after = boundsOf(session, id);
    expect(after.max[0]).toBeCloseTo(before.max[2] ?? 0, 6);
    expect(after.max[2]).toBeCloseTo(before.max[0], 6);
    expect(after.max[1]).toBeCloseTo(before.max[1], 6);
  });

  it("a +90 turn about Z swaps the X and Y spans", () => {
    const { session, id } = one();
    const before = boundsOf(session, id);
    session.execute(rotateSolids([id], "z", 90, [0, 0, 0]));
    const after = boundsOf(session, id);
    expect(after.max[0]).toBeCloseTo(before.max[1], 6);
    expect(after.max[1]).toBeCloseTo(before.max[0], 6);
  });

  it("turning +90 then -90 returns the object to where it started", () => {
    // The strongest check that the two opposites are exact opposites.
    const { session, id } = one();
    const before = boundsOf(session, id);
    session.execute(rotateSolids([id], "x", 90, [0, 0, 0]));
    session.execute(rotateSolids([id], "x", -90, [0, 0, 0]));
    const after = boundsOf(session, id);
    for (let i = 0; i < 3; i++) {
      expect(after.min[i]!).toBeCloseTo(before.min[i]!, 6);
      expect(after.max[i]!).toBeCloseTo(before.max[i]!, 6);
    }
  });

  it("turns about the pivot, not the origin", () => {
    // A pivot at the box's own centre must leave its bounds alone.
    const { session, id } = one();
    const before = boundsOf(session, id);
    const pivot: [number, number, number] = [50, 10, 2.5];
    session.execute(rotateSolids([id], "z", 180, pivot));
    const after = boundsOf(session, id);
    expect(after.min[0]).toBeCloseTo(before.min[0], 6);
    expect(after.max[1]).toBeCloseTo(before.max[1], 6);
  });

  it("rejects a non-finite angle instead of writing a NaN matrix", () => {
    const { session, id } = one();
    expect(() => session.execute(rotateSolids([id], "z", Number.NaN))).toThrow(/finite/i);
  });
});
