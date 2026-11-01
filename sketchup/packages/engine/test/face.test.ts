import { describe, expect, it } from "vitest";
import { initKernel } from "@apexus/kernel";
import type { Vec2, Vec3 } from "@apexus/geometry";
import {
  SCHEMA_VERSION,
  Session,
  addFace,
  deserialize,
  deserializeJson,
  pullBy,
  pullFace,
  serializeJson,
  type SolidId,
  type SolidRecipe,
} from "../src/index.js";

/**
 * The zero-thickness face as a document object (schema 6).
 *
 * A face is a ring and a plane with area and no volume, and these groups pin the
 * four promises that make it a real object rather than a slab in disguise:
 *   - validation: a face that cannot be a surface is refused with RangeError at
 *     the seam a solid is, so a command never emits junk geometry;
 *   - storage: it is stored as `kind: "face"` with the ring and plane it was
 *     given, and it stays zero height through analysis;
 *   - push/pull: `pullFace` / `pullBy` turn it into a loop of the same profile,
 *     and a non-positive distance is refused before history grows;
 *   - persistence: undo restores it exactly, a save/load keeps it a face, and a
 *     schema-5 file opens as 6 while a 6-file with an impossible face is
 *     rejected rather than silently repaired.
 *
 * Every case here is pure geometry: a face is triangulated without the kernel,
 * so none of them needs WASM. The bootstrap below mirrors `transforms.test.ts`
 * so that if a face ever starts routing through the kernel, its absence stays a
 * skip rather than a failed suite.
 */

const PLANE: { readonly origin: Vec3; readonly normal: Vec3 } = { origin: [0, 0, 0], normal: [0, 0, 1] };

/** 100 x 50 in the plane's own (u, v) axes, counter-clockwise. */
const RING: readonly Vec2[] = [
  [0, 0],
  [100, 0],
  [100, 50],
  [0, 50],
];

const faceRecipe = (points: readonly Vec2[], plane = PLANE): SolidRecipe => ({ kind: "face", points, plane, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });

function only(s: Session): SolidId {
  const ids = [...s.document.solids.keys()];
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

/** The stored recipe, narrowed so a wrong kind fails loudly in the test. */
function faceOf(s: Session, id: SolidId): Extract<SolidRecipe, { kind: "face" }> {
  const recipe = s.document.solids.get(id)!.recipe;
  if (recipe.kind !== "face") throw new Error(`expected a face, got ${recipe.kind}`);
  return recipe;
}

/** The session with a face in it, already returned to the state before the pull. */
function withFace(): { s: Session; id: SolidId } {
  const s = new Session();
  s.execute(addFace(RING, PLANE));
  const id = only(s);
  return { s, id };
}

/** A schema 5 file: it can hold no faces, only a 10 mm extrusion, and must open. */
function schema5File(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    units: "mm",
    envelope: null,
    section: null,
    solids: [
      {
        id: "s1",
        revision: 1,
        meta: { name: "Slab", color: "#e8b04b", hidden: false, locked: false, opacity: 1, roughness: 0.75, metallic: 0, tag: "" },
        recipe: { kind: "loop", points: RING, plane: PLANE, distance: 10, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      },
    ],
  };
}

/** The same file declaring schema 6 and holding one face from `recipe`. */
function schema6File(recipe: SolidRecipe): Record<string, unknown> {
  const raw = schema5File();
  raw["schemaVersion"] = 6;
  const solids = raw["solids"] as Record<string, unknown>[];
  solids[0]!["recipe"] = recipe;
  solids[0]!["meta"] = { name: "Face", color: "#e8b04b", hidden: false, locked: false, opacity: 1, roughness: 0.75, metallic: 0, tag: "" };
  return raw;
}

describe("a face is validated as a surface, not a solid", () => {
  it("refuses fewer than three points", () => {
    const s = new Session();
    expect(() => s.execute(addFace([[0, 0], [10, 0]], PLANE))).toThrow(RangeError);
    expect(s.document.solids.size).toBe(0);
    expect(s.canUndo).toBe(false);
  });

  it("refuses a ring with zero area", () => {
    const s = new Session();
    expect(() => s.execute(addFace([[0, 0], [10, 0], [20, 0]], PLANE))).toThrow(RangeError);
    expect(s.document.solids.size).toBe(0);
  });

  it("refuses a zero-length plane normal", () => {
    const s = new Session();
    expect(() => s.execute(addFace(RING, { origin: [0, 0, 0], normal: [0, 0, 0] }))).toThrow(RangeError);
    expect(s.document.solids.size).toBe(0);
  });

  it("stores kind face with the ring and plane it was given", () => {
    const { s, id } = withFace();
    const recipe = faceOf(s, id);
    expect(recipe.kind).toBe("face");
    expect(recipe.points).toEqual(RING);
    expect(recipe.plane).toEqual(PLANE);
    // Nothing invents a distance: that absence is what keeps it a surface.
    expect("distance" in recipe).toBe(false);
  });

  it("is zero height, 100 x 50 wide and has no volume", () => {
    const { s, id } = withFace();
    const b = s.boundsOf(id);
    expect(b.max[0] - b.min[0]).toBeCloseTo(100, 6);
    expect(b.max[1] - b.min[1]).toBeCloseTo(50, 6);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0, 6);
    expect(s.analyse(id).volume).toBeCloseTo(0, 9);
    // A surface is open by definition; a closed volume here would be a slab.
    expect(s.analyse(id).closed).toBe(false);
  });
});

describe("push/pull from a face", () => {
  it("pullFace makes a loop of the same points, plane and distance", () => {
    const { s, id } = withFace();
    s.execute(pullFace(id, 300));
    const recipe = s.document.solids.get(id)!.recipe;
    if (recipe.kind !== "loop") throw new Error(`expected a loop, got ${recipe.kind}`);
    expect(recipe.points).toEqual(RING);
    expect(recipe.plane).toEqual(PLANE);
    expect(recipe.distance).toBe(300);
    expect(s.analyse(id).volume).toBeCloseTo(100 * 50 * 300, 0);
  });

  it("pullFace refuses a distance <= 0 and leaves history untouched", () => {
    const { s, id } = withFace();
    const hash = s.hash();
    const depth = s.historyDepth;
    for (const bad of [0, -50, Number.NaN]) {
      expect(() => s.execute(pullFace(id, bad))).toThrow(RangeError);
    }
    expect(s.hash()).toBe(hash);
    expect(s.historyDepth).toBe(depth);
    expect(faceOf(s, id).kind).toBe("face");
  });

  it("pullBy on a face treats the delta as the whole height", () => {
    const { s, id } = withFace();
    s.execute(pullBy(id, 300));
    const recipe = s.document.solids.get(id)!.recipe;
    if (recipe.kind !== "loop") throw new Error(`expected a loop, got ${recipe.kind}`);
    expect(recipe.distance).toBe(300);
    expect(s.analyse(id).volume).toBeCloseTo(100 * 50 * 300, 0);
  });

  it("one undo restores the face exactly", () => {
    const { s, id } = withFace();
    const hash = s.hash();
    s.execute(pullFace(id, 300));
    expect(s.hash()).not.toBe(hash);
    s.undo();
    expect(s.hash()).toBe(hash);
    expect(faceOf(s, id).kind).toBe("face");
  });
});

describe("faces persist", () => {
  it("survives a save/load round trip and keeps zero volume", () => {
    const { s, id } = withFace();
    const reopened = new Session();
    reopened.load(deserializeJson(serializeJson(s.document)));
    const reloaded = only(reopened);
    expect(faceOf(reopened, reloaded).points).toEqual(RING);
    expect(reopened.analyse(reloaded).volume).toBeCloseTo(0, 9);
    expect(reopened.boundsOf(reloaded).max[1]).toBeCloseTo(50, 6);
    expect(reopened.hash()).toBe(s.hash());
  });

  it("a schema 5 file still loads and upgrades to the current version", () => {
    const doc = deserialize(schema5File());
    // The file carries no face and no edge, so every later step is a version
    // bump with nothing to rewrite.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    const solid = [...doc.solids.values()][0]!;
    expect(solid.recipe.kind).toBe("loop");
    const s = new Session();
    s.load(doc);
    expect(s.analyse("s1").volume).toBeCloseTo(100 * 50 * 10, 0);
  });

  it("rejects a schema 6 face with two points", () => {
    const raw = schema6File(faceRecipe([[0, 0], [100, 0]]));
    expect(() => deserialize(raw)).toThrow(/face needs 3\+ points/);
  });
});

/* ------------------------------------------------------------------ helpers */

let kernelState: Promise<boolean> | null = null;
function kernelAvailable(): Promise<boolean> {
  kernelState ??= initKernel().then(
    () => true,
    () => false,
  );
  return kernelState;
}

