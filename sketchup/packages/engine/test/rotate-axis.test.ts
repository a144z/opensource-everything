import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  applyPoint4 as applyMatrix4Point,
  boundsOf,
  planeBasis,
  rotateSolids,
  rotationAbout4,
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
  it("turns the plane's own basis the way the right-hand rule says", () => {
    for (const axis of ["x", "y", "z"] as const) {
      // The +90 turn actually used by the command, not `planeBasis`: the pivot
      // maths inside a rotation is the thing that silently goes the other way.
      const unit: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
      const m = rotationAbout4(unit, 90);
      const { u, v } = planeBasis(axis);
      // A point one unit along u must land one unit along v: that is exactly
      // what "the angle is measured from u towards v" promises the user.
      const landed = applyMatrix4Point(m, u);
      expect(landed[0]).toBeCloseTo(v[0], 9);
      expect(landed[1]).toBeCloseTo(v[1], 9);
      expect(landed[2]).toBeCloseTo(v[2], 9);
    }
  });

  it("a +90 turn about X lifts the in-plane u direction towards v", () => {
    // Measured positively from u towards v. About X the basis is u = +Y, v = +Z,
    // so the corner at (0, 20, 0) must land at (0, 0, 20): +Y rotates into +Z,
    // exactly as `rotationX4` says.
    const { session, id } = one();
    session.execute(rotateSolids([id], "x", 90, [0, 0, 0]));
    const after = boundsOf(session, id);
    expect(after.max[0]).toBeCloseTo(100, 6);
    expect(after.max[1]).toBeCloseTo(0, 6);
    expect(after.max[2]).toBeCloseTo(20, 6);
  });

  it("a +90 turn about Y swings the long axis down toward -Z", () => {
    // +90 about Y takes x to -z (right-hand rule: y x x = -z). The box starts at
    // the origin, so after the turn it lies at negative z, still 100 long.
    const { session, id } = one();
    const before = boundsOf(session, id);
    session.execute(rotateSolids([id], "y", 90, [0, 0, 0]));
    const after = boundsOf(session, id);
    expect(after.min[2]).toBeCloseTo(-before.max[0], 6);
    expect(after.max[0]).toBeCloseTo(before.max[2] ?? 0, 6);
    expect(after.max[1]).toBeCloseTo(before.max[1], 6);
  });

  it("a +90 turn about Z swings the long axis up toward +Y", () => {
    const { session, id } = one();
    session.execute(rotateSolids([id], "z", 90, [0, 0, 0]));
    const after = boundsOf(session, id);
    // +90 about Z takes x to y, so the 100 mm long axis now stands along Y.
    expect(after.max[0]).toBeCloseTo(0, 6);
    expect(after.max[1]).toBeCloseTo(100, 6);
    expect(after.max[2]).toBeCloseTo(5, 6);
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
