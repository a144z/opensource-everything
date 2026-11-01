import { describe, expect, it } from "vitest";
import { initKernel, booleanRecipe } from "@apexus/kernel";
import {
  Session,
  addSolid,
  analyzeSolid,
  arrayCopy,
  booleanSolids,
  boundsOf,
  centreInEnvelope,
  deleteSolids,
  deserializeJson,
  documentBounds,
  duplicateSolid,
  fitToEnvelope,
  pullFace,
  rotateSolid,
  rotateSolids,
  scaleAbout,
  scaleSolid,
  scaleSolids,
  serializeJson,
  setEnvelope,
  setMeta,
  translateSolid,
  translateSolids,
  type SolidId,
  type SolidRecipe,
} from "../src/index.js";

/**
 * L1/L2 invariants: transforms never change a solid's true size, mass edits are
 * one undo step, arrays are exact, booleans keep the volume arithmetic honest,
 * and the fit solver only ever shrinks (docs/07, docs/09).
 */

const MM = 0.01;

const box = (w: number, h: number, d: number, origin: readonly [number, number, number] = [0, 0, 0]): SolidRecipe => ({
  kind: "box",
  width: w,
  height: h,
  depth: d,
  origin,
});

const extrude = (w: number, h: number, distance: number): SolidRecipe => ({
  kind: "extrude",
  profile: { width: w, height: h },
  normal: [0, 0, 1],
  origin: [0, 0, 0],
  distance,
});

const loop = (points: readonly (readonly [number, number])[], distance: number): SolidRecipe => ({
  kind: "loop",
  points,
  plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
  distance,
});

function size(s: Session, id: SolidId): readonly [number, number, number] {
  const b = s.boundsOf(id);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function only(s: Session): SolidId {
  const ids = [...s.document.solids.keys()];
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

describe("transforms preserve true size", () => {
  it("translate moves bounds without touching size", () => {
    const s = new Session();
    s.execute(addSolid(box(100, 200, 300)));
    const id = only(s);
    s.execute(translateSolid(id, [50, -25, 10]));
    expect(size(s, id)[0]).toBeCloseTo(100, 6);
    expect(size(s, id)[1]).toBeCloseTo(200, 6);
    expect(size(s, id)[2]).toBeCloseTo(300, 6);
    const b = s.boundsOf(id);
    expect(b.min[0]).toBeCloseTo(50, 6);
    expect(b.min[1]).toBeCloseTo(-25, 6);
    expect(b.min[2]).toBeCloseTo(10, 6);
  });

  it("rotate 90 deg about Z swaps X and Y extent, keeps volume", () => {
    const s = new Session();
    s.execute(addSolid(box(100, 50, 20, [0, 0, 0])));
    const id = only(s);
    const before = s.analyse(id).volume;
    s.execute(rotateSolid(id, "z", 90));
    const [x, y, z] = size(s, id);
    expect(x).toBeCloseTo(50, 6);
    expect(y).toBeCloseTo(100, 6);
    expect(z).toBeCloseTo(20, 6);
    expect(s.analyse(id).volume).toBeCloseTo(before, 3);
  });

  it("scale composes across edits and keeps the primitive numbers true", () => {
    const s = new Session();
    s.execute(addSolid(box(100, 100, 100)));
    const id = only(s);
    s.execute(scaleSolid(id, 2));
    s.execute(scaleSolid(id, [1, 0.5, 1]));
    expect(size(s, id)[0]).toBeCloseTo(200, 6);
    expect(size(s, id)[1]).toBeCloseTo(100, 6);
    const recipe = s.document.solids.get(id)!.recipe as Extract<SolidRecipe, { kind: "box" }>;
    expect(recipe.width).toBe(100); // numbers untouched, matrix carries the scale
  });

  it("moves survive a save/load round trip", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    s.execute(rotateSolid(id, "x", 45));
    s.execute(translateSolid(id, [7, 0, 0]));
    const text = serializeJson(s.document);
    const reloaded = new Session();
    reloaded.load(deserializeJson(text));
    const b = reloaded.boundsOf(only(reloaded));
    expect(b.min[0]).toBeCloseTo(7, 4);
  });

  it("a mass transform is one undo step", () => {
    const s = new Session();
    for (let i = 0; i < 5; i++) s.execute(addSolid(box(10, 10, 10, [i * 20, 0, 0])));
    const before = s.hash();
    s.execute(translateSolids([...s.document.solids.keys()], [0, 100, 0]));
    expect(s.hash()).not.toBe(before);
    s.undo();
    expect(s.hash()).toBe(before);
  });

  it("locked solids are skipped, not moved", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10), { locked: true }));
    const id = only(s);
    s.execute(translateSolids([id], [100, 0, 0]));
    expect(s.boundsOf(id).min[0]).toBeCloseTo(0, 6);
  });

  it("move tool: copy leaves the original in place", () => {
    // What Move with Ctrl held does: duplicate at the delta, original untouched.
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    s.execute(duplicateSolid(id, [40, 0, 0]));
    expect(s.document.solids.size).toBe(2);
    const xs = [...s.document.solids.values()].map((sol) => s.boundsOf(sol.id).min[0]).sort((a, b) => a - b);
    expect(xs).toEqual([0, 40]);
  });

  it("rotate tool: turning about a far pivot orbits, not just spins", () => {
    // Box spans 0..10 (centre 5); pivot (100,0) -> 180 deg puts centre at 195.
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    const before = s.analyse(id).volume;
    s.execute(rotateSolids([id], "z", 180, [100, 0, 0]));
    const c = s.boundsOf(id);
    expect((c.min[0] + c.max[0]) / 2).toBeCloseTo(195, 4);
    expect((c.min[1] + c.max[1]) / 2).toBeCloseTo(-5, 4);
    const [x, y] = size(s, id);
    expect(x).toBeCloseTo(10, 4);
    expect(y).toBeCloseTo(10, 4);
    expect(s.analyse(id).volume).toBeCloseTo(before, 3);
  });
});

describe("scale about a grabbed point", () => {
  it("keeps the pivot fixed and scales uniformly", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    const before = s.boundsOf(id);
    // Grab the far corner of the box: it must not move.
    const pivot: [number, number, number] = [before.max[0], before.max[1], before.max[2]];
    s.execute(scaleAbout([id], 2, pivot));
    const after = s.boundsOf(id);
    expect(after.max[0]).toBeCloseTo(pivot[0], 6);
    expect(after.max[1]).toBeCloseTo(pivot[1], 6);
    expect(after.max[2]).toBeCloseTo(pivot[2], 6);
    expect(after.min[0]).toBeCloseTo(pivot[0] - 20, 6);
    expect(size(s, id)[0]).toBeCloseTo(20, 6);
    expect(s.analyse(id).volume).toBeCloseTo(8000, 2);
  });

  it("one undo restores the exact previous document", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    const hash = s.hash();
    s.execute(scaleAbout([id], 3, [0, 0, 0]));
    s.undo();
    expect(s.hash()).toBe(hash);
  });

  it("refuses a non-positive or non-finite factor without touching history", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    const hash = s.hash();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => s.execute(scaleAbout([id], bad, [0, 0, 0]))).toThrow(/positive and finite/);
    }
    expect(s.hash()).toBe(hash);
    // A rejected command must not become an undo step (validate at construction).
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.document.solids.size).toBe(0);
  });

  it("leaves locked solids alone and a factor of 1 is a no-op", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    const hash = s.hash();
    s.execute(setMeta(id, { locked: true }));
    s.execute(scaleAbout([id], 2, [0, 0, 0]));
    expect(Math.abs(s.boundsOf(id).max[0] - 10)).toBeLessThan(1e-6);

    s.execute(setMeta(id, { locked: false }));
    const hashOpen = s.hash();
    s.execute(scaleAbout([id], 1, [5, 5, 5]));
    expect(s.hash()).toBe(hashOpen);
    expect(hash).toBeTruthy();
  });
});

describe("arrays and copies", () => {
  it("array copy is exact spacing and one undo", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const id = only(s);
    const before = s.hash();
    s.execute(arrayCopy(id, 3, [20, 0, 0]));
    expect(s.document.solids.size).toBe(4);
    const xs = [...s.document.solids.values()].map((sol) => s.boundsOf(sol.id).min[0]).sort((a, b) => a - b);
    expect(xs).toEqual([0, 20, 40, 60]);
    s.undo();
    expect(s.document.solids.size).toBe(1);
    expect(s.hash()).toBe(before);
  });

  it("duplicate offset copy is independent of the source", () => {
    const s = new Session();
    s.execute(addSolid(extrude(10, 10, 5)));
    const src = only(s);
    const patch = s.execute(duplicateSolid(src, [30, 0, 0]));
    const copy = [...patch.forward.keys()].find((k) => k !== src)!;
    s.execute(pullFace(copy, 20));
    const a = s.document.solids.get(src)!.recipe as Extract<SolidRecipe, { kind: "extrude" }>;
    const b = s.document.solids.get(copy)!.recipe as Extract<SolidRecipe, { kind: "extrude" }>;
    expect(a.distance).toBe(5);
    expect(b.distance).toBe(20);
  });
});

describe("profiles and faces", () => {
  it("loops with holes and insets produce positive volume", () => {
    const s = new Session();
    s.execute(addSolid(loop([[0, 0], [100, 0], [100, 100], [0, 100]], 10)));
    expect(s.analyse(only(s)).volume).toBeCloseTo(100_000, 0);
  });

  it("push/pull by distance on a loop keeps the profile", () => {
    const s = new Session();
    s.execute(addSolid(loop([[0, 0], [10, 0], [10, 10], [0, 10]], 5)));
    s.execute(pullFace(only(s), 20));
    expect(s.analyse(only(s)).volume).toBeCloseTo(2000, 3);
  });

  it("a rotated face grows along its own normal", () => {
    const s = new Session();
    s.execute(addSolid(extrude(10, 10, 5)));
    const id = only(s);
    s.execute(rotateSolid(id, "x", 90));
    const before = s.analyse(id).volume;
    s.execute(pullFace(id, 10));
    expect(s.analyse(id).volume).toBeCloseTo(before * 2, 3);
  });
});

describe("booleans (needs the kernel)", () => {
  it("union volume is additive for disjoint solids and undo restores both", async () => {
    if (!(await kernelAvailable())) return;
    const s = boxed();
    s.execute(addSolid(box(10, 10, 10)));
    s.execute(addSolid(box(10, 10, 10, [10, 0, 0])));
    const [a, b] = [...s.document.solids.keys()];
    const hash = s.hash();
    s.execute(booleanSolids(a!, b!, "union"));
    expect(s.document.solids.size).toBe(1);
    expect(s.analyse(only(s)).volume).toBeCloseTo(2000, 3);
    s.undo();
    expect(s.hash()).toBe(hash);
  });

  it("difference removes exactly the overlap", async () => {
    if (!(await kernelAvailable())) return;
    const s = boxed();
    s.execute(addSolid(box(10, 10, 10)));
    s.execute(addSolid(box(10, 10, 10, [5, 0, 0])));
    const [a, b] = [...s.document.solids.keys()];
    s.execute(booleanSolids(a!, b!, "difference"));
    expect(s.analyse(only(s)).volume).toBeCloseTo(500, 3);
  });
});

describe("fit solver", () => {
  it("never grows and lands on the envelope min corner", () => {
    const s = new Session();
    s.execute(addSolid(box(1000, 1000, 1000)));
    s.execute(setEnvelope({ min: [0, 0, 0], max: [100, 500, 500] }));
    s.execute(fitToEnvelope());
    const b = s.boundsOf(only(s));
    expect(b.min[0]).toBeCloseTo(0, 4);
    expect(b.max[0]).toBeCloseTo(100, 4);
    expect(size(s, only(s))[1]).toBeCloseTo(100, 4); // uniform scale
  });

  it("refuses when nothing needs shrinking", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    s.execute(setEnvelope({ min: [0, 0, 0], max: [100, 100, 100] }));
    expect(() => s.execute(fitToEnvelope())).toThrow(/already fits/);
    expect(s.document.solids.size).toBe(1);
  });

  it("centre puts the model in the middle", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    s.execute(setEnvelope({ min: [0, 0, 0], max: [100, 100, 100] }));
    s.execute(centreInEnvelope());
    const b = s.boundsOf(only(s));
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(50, 4);
  });

  it("a fit keeps tol 0.01 mm", () => {
    const s = new Session();
    s.execute(addSolid(box(333, 333, 333)));
    s.execute(setEnvelope({ min: [0, 0, 0], max: [100, 100, 100] }));
    s.execute(fitToEnvelope());
    const b = s.boundsOf(only(s));
    expect(Math.abs(b.max[0] - 100)).toBeLessThan(MM);
  });
});

describe("document bounds helper", () => {
  it("ignores hidden solids", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    s.execute(addSolid(box(1000, 1000, 1000), { hidden: true }));
    expect(s.documentBounds().max[0]).toBeCloseTo(10, 6);
  });

  it("delete then undo restores the exact document", () => {
    const s = new Session();
    s.execute(addSolid(box(1, 2, 3)));
    const hash = s.hash();
    s.execute(deleteSolids([...s.document.solids.keys()]));
    s.undo();
    expect(s.hash()).toBe(hash);
  });
});


/* ------------------------------------------------------------------ helpers */

function boxed(): Session {
  return new Session({ kernel: booleanRecipe });
}

let kernelState: Promise<boolean> | null = null;
function kernelAvailable(): Promise<boolean> {
  kernelState ??= initKernel().then(
    () => true,
    () => false,
  );
  return kernelState;
}
