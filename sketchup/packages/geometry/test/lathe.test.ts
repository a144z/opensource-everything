import { describe, expect, it } from "vitest";
import {
  isClosedMesh,
  latheSolid,
  meshBounds,
  meshVolume,
  type Vec2,
} from "@apexus/geometry";
import {
  Session,
  addSolid,
  analyseMesh,
  baseMesh,
  isStandaloneRecipe,
  setMatrix,
  translation4,
  type SolidRecipe,
} from "@apexus/engine";

/** A 20 x 100 rectangle standing in the half-plane: a pipe wall. */
const pipeProfile: Vec2[] = [
  [0, 0],
  [20, 0],
  [20, 100],
  [0, 100],
];

/** The same ring moved 50 mm off the axis, so it can be turned with no offset. */
const liftedProfile: Vec2[] = pipeProfile.map(([x, y]) => [x + 50, y] as Vec2);

/** Area of the profile, by the shoelace rule, so the Pappus check is independent. */
const profileArea = 20 * 100;
/** Centroid of the profile band, 10 mm from its inner edge. */
const centroidX = 10;

describe("latheSolid", () => {
  it("is watertight and outward-wound", () => {
    const mesh = latheSolid(pipeProfile, { offset: 50, segments: 48 });
    expect(isClosedMesh(mesh)).toBe(true);
    expect(meshVolume(mesh)).toBeGreaterThan(0);
  });

  it("matches Pappus: V = 2*pi*R*A", () => {
    const offset = 50;
    const mesh = latheSolid(pipeProfile, { offset, segments: 1440 });
    const pappus = 2 * Math.PI * (offset + centroidX) * profileArea;
    // A 1440-gon inscribes its circle, so the mesh is a hair (~0.002%) under the
    // smooth Pappus value: close relative, not absolute, to a half-microlitre.
    expect(meshVolume(mesh) / pappus).toBeCloseTo(1, 4);
    expect(meshVolume(mesh) / pappus).toBeGreaterThan(0.99);
  });

  it("a coarse sweep is still closed, just chunkier", () => {
    const coarse = latheSolid(pipeProfile, { offset: 50, segments: 3 });
    expect(isClosedMesh(coarse)).toBe(true);
    expect(meshVolume(coarse)).toBeGreaterThan(0);
  });

  it("reads a zero offset as: the profile's own x is the radius", () => {
    // The ring sits 50..70 mm from the axis in its own coordinates, so with no
    // offset the sweep must produce the same tube as `offset: 50` does.
    const b = meshBounds(latheSolid(liftedProfile, { segments: 32 }));
    expect(b.min[0]).toBeCloseTo(-70, 3);
    expect(b.max[0]).toBeCloseTo(70, 3);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(100, 6);
  });  it("refuses a profile that crosses the axis", () => {
    const crossing: Vec2[] = [
      [-10, 0],
      [20, 0],
      [20, 100],
    ];
    expect(() => latheSolid(crossing, { offset: 0 })).toThrow(/axis/);
  });

  it("refuses junk profiles", () => {
    expect(() =>
      latheSolid(
        [
          [5, 0],
          [9, 9],
        ],
        {},
      ),
    ).toThrow(/three points/);
    expect(() =>
      latheSolid(
        [
          [10, 0],
          [20, 0],
          [30, 0],
        ],
        {},
      ),
    ).toThrow(/zero area/);
  });

  it("clamps the segment count instead of refusing it", () => {
    expect(() => latheSolid(pipeProfile, { offset: 50, segments: 1 })).not.toThrow();
    expect(() => latheSolid(pipeProfile, { offset: 50, segments: 100000 })).not.toThrow();
  });
});

describe("lathe recipe", () => {
  const recipe: SolidRecipe = { kind: "lathe", points: pipeProfile, offset: 50, segments: 32 };

  it("meshes standalone, through the engine", () => {
    expect(isStandaloneRecipe(recipe)).toBe(true);
    const geo = analyseMesh(baseMesh(recipe));
    expect(geo.closed).toBe(true);
    expect(geo.volume).toBeGreaterThan(0);
  });

  it("goes into a session and follows its matrix", () => {
    const s = new Session();
    s.execute(addSolid(recipe));
    const id = [...s.document.solids.keys()][0]!;
    expect(s.boundsOf(id).min[1]).toBeCloseTo(-70, 3);
    expect(s.boundsOf(id).max[1]).toBeCloseTo(70, 3);

    s.execute(setMatrix([id], translation4([0, 0, 5])));
    expect(s.boundsOf(id).min[2]).toBeCloseTo(5, 6);
    expect(s.analyse(id).closed).toBe(true);
  });
});
