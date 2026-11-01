import { describe, expect, it } from "vitest";
import {
  createBox,
  cross,
  extrudeRect,
  hashMesh,
  isClosedMesh,
  meshVolume,
  aabbFromPoints,
  fitsIn,
  overshoot,
  toStlAscii,
  polygonArea,
} from "../src/index.js";

const X = [1, 0, 0] as const;
const Y = [0, 1, 0] as const;

describe("box primitive", () => {
  it("is closed with outward winding", () => {
    const box = createBox({ width: 10, height: 20, depth: 30 });
    expect(isClosedMesh(box)).toBe(true);
    expect(meshVolume(box)).toBeCloseTo(6000, 9);
  });

  it("places the origin at the min corner", () => {
    const bounds = aabbFromPoints(toVec3(createBox({ width: 2, height: 3, depth: 4, origin: [5, 6, 7] })));
    expect(bounds.min).toEqual([5, 6, 7]);
    expect(bounds.max).toEqual([7, 9, 11]);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => createBox({ width: 0, height: 1, depth: 1 })).toThrow(RangeError);
  });
});

describe("push/pull (extrude face)", () => {
  it("volume equals profile area x pull distance, for all three axes", () => {
    const combos = [
      { normal: [0, 0, 1], origin: [0, 0, 0] },
      { normal: [1, 0, 0], origin: [0, 0, 0] },
      { normal: [0, 1, 0], origin: [0, 0, 4] },
      { normal: [-1, 0, 0], origin: [4, 0, 0] },
    ] as const;
    for (const c of combos) {
      const solid = extrudeRect(3, 5, c.normal, c.origin, 2);
      expect(meshVolume(solid)).toBeCloseTo(30, 9);
      expect(isClosedMesh(solid)).toBe(true);
    }
  });

  it("a zero pull is a degenerate solid, never a silent no-op solid", () => {
    expect(() => extrudeRect(3, 5, [0, 0, 1], [0, 0, 0], 0)).toThrow(RangeError);
  });

  it("refuses NaN and negative pull distances", () => {
    expect(() => extrudeRect(3, 5, [0, 0, 1], [0, 0, 0], Number.NaN)).toThrow(RangeError);
    expect(() => extrudeRect(3, 5, [0, 0, 1], [0, 0, 0], -2)).toThrow(RangeError);
    expect(() => createBox({ width: Number.NaN, height: 1, depth: 1 })).toThrow(RangeError);
  });

  it("cross(profile X, profile Y) reproduces the face normal", () => {
    for (const n of [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ] as const) {
      const solid = extrudeRect(1, 1, n, [0, 0, 0], 2);
      expect(meshVolume(solid)).toBeCloseTo(2, 6);
    }
    expect(cross(X, Y)).toEqual([0, 0, 1]);
  });
});

describe("fit check", () => {
  const envelope = { min: [0, 0, 0] as const, max: [100, 100, 100] as const };

  it("accepts an object exactly on the envelope walls", () => {
    const box = createBox({ width: 100, height: 100, depth: 100 });
    const b = aabbFromPoints(toVec3(box));
    expect(fitsIn(b, envelope)).toBe(true);
    expect(overshoot(b, envelope)).toEqual([0, 0, 0]);
  });

  it("reports the overshoot per axis in mm", () => {
    const box = createBox({ width: 130, height: 100, depth: 80, origin: [0, -5, 0] });
    const b = aabbFromPoints(toVec3(box));
    expect(fitsIn(b, envelope)).toBe(false);
    expect(overshoot(b, envelope)).toEqual([30, 5, 0]);
  });
});

describe("stl export", () => {
  it("writes 12 facets and a normal per facet for a box", () => {
    const stl = toStlAscii(createBox({ width: 1, height: 1, depth: 1 }));
    expect(stl.match(/facet normal/g)).toHaveLength(12);
    expect(stl.startsWith("solid")).toBe(true);
    expect(stl.trimEnd().endsWith("endsolid solid")).toBe(true);
  });
});

describe("polygon helpers", () => {
  it("computes area independent of winding", () => {
    const cw = [
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
    ] as const;
    const ccw = [...cw].reverse() as unknown as readonly (readonly [number, number])[];
    expect(polygonArea(cw)).toBeCloseTo(6, 12);
    expect(polygonArea(ccw)).toBeCloseTo(6, 12);
  });
});

describe("mesh hash", () => {
  it("is stable across rebuilds and changes when geometry changes", () => {
    const a = hashMesh(createBox({ width: 1, height: 2, depth: 3 }));
    const b = hashMesh(createBox({ width: 1, height: 2, depth: 3 }));
    const c = hashMesh(createBox({ width: 1, height: 2, depth: 3.0001 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

function* toVec3(mesh: { positions: Float32Array }) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    yield [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!] as const;
  }
}
