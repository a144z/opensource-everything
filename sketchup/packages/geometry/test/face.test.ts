import { describe, expect, it } from "vitest";
import {
  cross,
  dot,
  faceMesh,
  meshBounds,
  meshVolume,
  normalize,
  sub,
  type MeshData,
  type Vec2,
  type Vec3,
} from "../src/index.js";

/**
 * `faceMesh`: the pure triangulation every zero-thickness face resolves through.
 *
 * The contract the rest of the app depends on:
 *   - a simple ring triangulates into a fan's worth of triangles (n - 2) with no
 *     invented vertices, so an index into the mesh is an index into the ring;
 *   - world bounds are the ring's own footprint with zero height along the normal;
 *   - every triangle is wound counter-clockwise seen from `+plane.normal`, which
 *     is what makes a face lit, and pickable, from the side it faces;
 *   - a ring in any plane works, not just XY;
 *   - a ring that cannot be a surface (too few points, collinear, bow-tie) is a
 *     RangeError rather than an invisible object nobody can select.
 */

const SQUARE: readonly Vec2[] = [
  [0, 0],
  [100, 0],
  [100, 50],
  [0, 50],
];

const XY: { readonly origin: Vec3; readonly normal: Vec3 } = { origin: [0, 0, 0], normal: [0, 0, 1] };

function vertex(mesh: MeshData, i: number): Vec3 {
  return [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
}

/** The unit normal of triangle `t`, wound as the indices say. */
function triangleNormal(mesh: MeshData, t: number): Vec3 {
  const a = vertex(mesh, mesh.indices[t * 3]!);
  const b = vertex(mesh, mesh.indices[t * 3 + 1]!);
  const c = vertex(mesh, mesh.indices[t * 3 + 2]!);
  return normalize(cross(sub(b, a), sub(c, a)));
}

describe("faceMesh: a 100 x 50 square in the XY plane", () => {
  it("gives two triangles over the four ring points, with no extra vertex", () => {
    const mesh = faceMesh({ points: SQUARE, plane: XY });
    expect(mesh.indices).toHaveLength(6);
    expect(mesh.positions).toHaveLength(12);
    // Every index addresses a real vertex of the ring, so picking maps one to one.
    for (const i of mesh.indices) expect(i).toBeLessThan(4);
  });

  it("bounds are 100 x 50 with zero height", () => {
    const b = meshBounds(faceMesh({ points: SQUARE, plane: XY }));
    expect(b.max[0] - b.min[0]).toBeCloseTo(100, 5);
    expect(b.max[1] - b.min[1]).toBeCloseTo(50, 5);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0, 6);
  });

  it("encloses nothing", () => {
    expect(meshVolume(faceMesh({ points: SQUARE, plane: XY }))).toBeCloseTo(0, 9);
  });

  it("winds every triangle along +plane.normal", () => {
    const mesh = faceMesh({ points: SQUARE, plane: XY });
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const n = triangleNormal(mesh, t);
      expect(dot(n, [0, 0, 1])).toBeCloseTo(1, 5);
    }
  });

  it("is lit from +normal even when the ring is handed in clockwise", () => {
    // The same square drawn the other way round must not flip the face's side.
    const clockwise = [...SQUARE].reverse();
    const mesh = faceMesh({ points: clockwise, plane: XY });
    expect(mesh.indices).toHaveLength(6);
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      expect(dot(triangleNormal(mesh, t), [0, 0, 1])).toBeCloseTo(1, 5);
    }
  });
});

describe("faceMesh: a ring in another plane", () => {
  it("builds the face in the XZ plane facing -Y", () => {
    // Ring in (u, v) with u = X and v = +Z: a 100 x 50 face standing upright.
    const plane = { origin: [0, 0, 0] as Vec3, normal: [0, -1, 0] as Vec3 };
    const mesh = faceMesh({ points: SQUARE, plane });
    expect(mesh.indices).toHaveLength(6);
    expect(mesh.positions).toHaveLength(12);

    const b = meshBounds(mesh);
    expect(b.max[0] - b.min[0]).toBeCloseTo(100, 5);
    expect(b.max[2] - b.min[2]).toBeCloseTo(50, 5);
    expect(b.max[1] - b.min[1]).toBeCloseTo(0, 6);

    for (let t = 0; t < mesh.indices.length / 3; t++) {
      expect(dot(triangleNormal(mesh, t), [0, -1, 0])).toBeCloseTo(1, 5);
    }
    expect(meshVolume(mesh)).toBeCloseTo(0, 9);
  });

  it("places the ring relative to the plane origin", () => {
    const plane = { origin: [10, 20, 30] as Vec3, normal: [0, 0, 1] as Vec3 };
    const b = meshBounds(faceMesh({ points: SQUARE, plane }));
    expect(b.min[0]).toBeCloseTo(10, 4);
    expect(b.min[1]).toBeCloseTo(20, 4);
    expect(b.min[2]).toBeCloseTo(30, 6);
    expect(b.max[0]).toBeCloseTo(110, 4);
    expect(b.max[1]).toBeCloseTo(70, 4);
  });
});

describe("faceMesh refuses a ring that cannot be a surface", () => {
  it("fewer than three distinct points", () => {
    expect(() => faceMesh({ points: [[0, 0], [100, 0]], plane: XY })).toThrow(RangeError);
    // Three entries that are really two points: a duplicate collapses to two.
    expect(() => faceMesh({ points: [[0, 0], [100, 0], [0, 0]], plane: XY })).toThrow(RangeError);
  });

  it("a collinear ring", () => {
    expect(() =>
      faceMesh({
        points: [
          [0, 0],
          [50, 0],
          [100, 0],
        ],
        plane: XY,
      }),
    ).toThrow(RangeError);
  });

  it("a bow-tie", () => {
    // The second lobe winds the opposite way, so the two triangles cancel and the
    // ring encloses nothing: it has area, but no surface.
    const bowTie: readonly Vec2[] = [
      [0, 0],
      [100, 100],
      [100, 0],
      [0, 100],
    ];
    expect(() => faceMesh({ points: bowTie, plane: XY })).toThrow(RangeError);
  });
});
