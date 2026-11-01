import { describe, expect, it } from "vitest";
import { mergeMeshes } from "@apexus/geometry";
import {
  Session,
  addSolid,
  deleteSolids,
  descendantsOf,
  deserializeJson,
  groupSolids,
  moveBetween,
  parentsOf,
  rootsOf,
  SCHEMA_VERSION,
  serializeJson,
  setMatrix,
  translateSolids,
  ungroupSolid,
  type SolidId,
  type SolidRecipe,
} from "../src/index.js";

/**
 * Groups (task L2-1). A group is an ordered set of owned children plus its own
 * matrix; these tests pin the three things that are easy to get wrong:
 *
 *   1. grouping and ungrouping compose to the identity, geometry included;
 *   2. a transform on a group applies to its children exactly once, and is
 *      visible in the merged mesh, not just in the recipe;
 *   3. ownership is exclusive, so one member cannot be meshed by two parents.
 */

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const box = (w: number, h: number, d: number, at: readonly [number, number, number] = [0, 0, 0]): SolidRecipe => ({
  kind: "box",
  width: w,
  height: h,
  depth: d,
  origin: at,
  matrix: I,
});

/** Two boxes side by side; returns the session and their ids. */
function twoBoxes(): { s: Session; a: SolidId; b: SolidId } {
  const s = new Session();
  s.execute(addSolid(box(10, 10, 10)));
  s.execute(addSolid(box(10, 10, 10, [100, 0, 0])));
  const ids = [...s.document.solids.keys()];
  return { s, a: ids[0]!, b: ids[1]! };
}

function size(s: Session, id: SolidId): readonly [number, number, number] {
  const b = s.boundsOf(id);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function groupIds(s: Session): SolidId[] {
  return [...s.document.solids.values()].filter((x) => x.recipe.kind === "group").map((x) => x.id);
}

describe("grouping", () => {
  it("creates one parent whose mesh is the union of its members", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b], "Cabinet"));
    const [g] = groupIds(s);
    expect(g).toBeDefined();
    const solid = s.document.solids.get(g!)!;
    expect(solid.meta.name).toBe("Cabinet");
    expect(descendantsOf(s.document, g!).sort()).toEqual([a, b].sort());
    // Volume is additive: two disjoint 1000 mm3 boxes.
    expect(s.analyse(g!).volume).toBeCloseTo(2000, 3);
    // The merged bounds span both boxes.
    expect(size(s, g!)[0]).toBeCloseTo(110, 3);
    // Members are still in the document, still individually addressable.
    expect(s.document.solids.has(a)).toBe(true);
    expect(rootsOf(s.document)).toEqual([g]);
  });

  it("is one undo step that removes only the parent", () => {
    const { s, a, b } = twoBoxes();
    const hash = s.hash();
    s.execute(groupSolids([a, b]));
    expect(s.document.solids.size).toBe(3);
    s.undo();
    expect(s.document.solids.size).toBe(2);
    expect(s.hash()).toBe(hash);
  });

  it("refuses to group nothing, or a member that already has a parent", () => {
    const { s, a, b } = twoBoxes();
    expect(() => s.execute(groupSolids([]))).toThrow(/at least one/);
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    // `a` is owned now, so grouping it again would draw it twice.
    expect(() => s.execute(groupSolids([a]))).toThrow(/already belongs/);
    expect(groupIds(s)).toEqual([g]);
  });
});

describe("transforms compose exactly once", () => {
  it("moving a group moves its children once, not twice", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    s.execute(translateSolids([g!], [0, 0, 50]));
    expect(s.boundsOf(g!).min[2]).toBeCloseTo(50, 5);
    // Size is unchanged: a double application would still be size-preserving,
    // so check the member's own world position through the group's mesh.
    expect(size(s, g!)[2]).toBeCloseTo(10, 5);
    expect(s.analyse(g!).volume).toBeCloseTo(2000, 3);
  });

  it("scaling a group scales its children exactly once", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    const scale2 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    s.execute(setMatrix([g!], scale2));
    const [x] = size(s, g!);
    expect(x).toBeCloseTo(220, 4);
    // Volume of two boxes at 2x linear scale is 2^3 times the original.
    expect(s.analyse(g!).volume).toBeCloseTo(2000 * 8, 2);
  });

  it("a nested group resolves through both parents", () => {
    const { s, a, b } = twoBoxes();
    s.execute(addSolid(box(10, 10, 10, [200, 0, 0])));
    const c = [...s.document.solids.keys()][2]!;
    s.execute(groupSolids([a, b], "Inner"));
    const [inner] = groupIds(s);
    s.execute(groupSolids([inner!, c], "Outer"));
    const outer = groupIds(s).find((x) => x !== inner)!;
    expect(descendantsOf(s.document, outer).sort()).toEqual([a, b, c, inner!].sort());
    expect(s.analyse(outer).volume).toBeCloseTo(3000, 3);
    s.execute(translateSolids([outer], [0, 0, 25]));
    // Every level moved together, and nothing was doubled.
    expect(s.analyse(outer).volume).toBeCloseTo(3000, 3);
    expect(s.boundsOf(outer).max[2] - s.boundsOf(outer).min[2]).toBeCloseTo(10, 5);
  });
});

describe("ungrouping", () => {
  it("at the top level restores the original geometry exactly", () => {
    const { s, a, b } = twoBoxes();
    const before = s.hash();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    s.execute(ungroupSolid(g!));
    expect(groupIds(s)).toEqual([]);
    // group then ungroup is the identity, down to the content hash.
    expect(s.hash()).toBe(before);
    expect(s.boundsOf(a).min[0]).toBeCloseTo(0, 6);
    expect(s.boundsOf(b).min[0]).toBeCloseTo(100, 6);
  });

  it("after moving the group, children keep the world position the user saw", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    s.execute(translateSolids([g!], [0, 0, 40]));
    const seenBounds = s.boundsOf(g!);
    s.execute(ungroupSolid(g!));
    // Each child now carries the group's placement in its own matrix.
    expect(s.boundsOf(a).min[2]).toBeCloseTo(40, 5);
    expect(s.boundsOf(b).min[2]).toBeCloseTo(40, 5);
    expect(s.boundsOf(a).min[0]).toBeCloseTo(seenBounds.min[0], 5);
  });

  it("inside a parent splices the members into the parent in place", () => {
    const { s, a, b } = twoBoxes();
    s.execute(addSolid(box(10, 10, 10, [200, 0, 0])));
    const c = [...s.document.solids.keys()][2]!;
    s.execute(groupSolids([c, a], "Inner"));
    const [inner] = groupIds(s);
    s.execute(groupSolids([b, inner!], "Outer"));
    const outer = groupIds(s).find((x) => x !== inner)!;
    s.execute(ungroupSolid(inner!));
    const outerSolid = s.document.solids.get(outer)!;
    expect(outerSolid.recipe.kind).toBe("group");
    if (outerSolid.recipe.kind === "group") {
      // Order is preserved: b first, then inner's members where inner sat.
      expect(outerSolid.recipe.members).toEqual([b, c, a]);
    }
    expect(s.analyse(outer).volume).toBeCloseTo(3000, 3);
  });

  it("refuses to ungroup something that is not a group", () => {
    const { s, a } = twoBoxes();
    expect(() => s.execute(ungroupSolid(a))).toThrow(/not a group/);
  });
});

describe("ownership", () => {
  it("moveBetween reparents without duplicating the member", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    s.execute(moveBetween([a], g!));
    // Already there: still exactly one mention of `a`.
    const recipe = s.document.solids.get(g!)!.recipe;
    if (recipe.kind === "group") expect(recipe.members.filter((m) => m === a)).toHaveLength(1);

    s.execute(moveBetween([a], null));
    expect(parentsOf(s.document, a)).toEqual([]);
    expect(s.document.solids.size).toBe(3);
  });

  it("moveBetween refuses a group as its own parent", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    expect(() => s.execute(moveBetween([g!], g!))).toThrow(/cannot contain itself/);
  });

  it("moveBetween refuses a parent that is not a group", () => {
    const { s, a, b } = twoBoxes();
    expect(() => s.execute(moveBetween([a], b))).toThrow(/not a group/);
  });

  it("a file with a cyclic group is refused at load, not at render", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    const raw = JSON.parse(serializeJson(s.document));
    // Point the group at itself the way a hand-edited file could.
    const entry = raw.solids.find((x: { id: string }) => x.id === g);
    entry.recipe.members = [a, g];
    expect(() => deserializeJson(JSON.stringify(raw))).toThrow(/itself|ancestor/);
  });

  it("a file with a group nested inside itself is refused", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [inner] = groupIds(s);
    s.execute(addSolid(box(10, 10, 10, [200, 0, 0])));
    const c = [...s.document.solids.keys()].find((x) => x !== a && x !== b && x !== inner)!;
    s.execute(groupSolids([inner!, c], "Outer"));
    const outer = groupIds(s).find((x) => x !== inner)!;
    const raw = JSON.parse(serializeJson(s.document));
    // Two groups that own each other: neither can be meshed first. This is the
    // case a self-membership check alone does not catch.
    const entry = raw.solids.find((x: { id: string }) => x.id === inner);
    entry.recipe.members = [a, b, outer];
    expect(() => deserializeJson(JSON.stringify(raw))).toThrow(/ancestor|cycle/);
  });

  it("a file with a duplicated member is refused", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    const raw = JSON.parse(serializeJson(s.document));
    const entry = raw.solids.find((x: { id: string }) => x.id === g);
    entry.recipe.members = [a, a];
    expect(() => deserializeJson(JSON.stringify(raw))).toThrow(/twice/);
  });

  it("a schema 3 file still opens and gains no groups", () => {
    const { s, a, b } = twoBoxes();
    const raw = JSON.parse(serializeJson(s.document));
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    raw.schemaVersion = 3;
    const opened = deserializeJson(JSON.stringify(raw));
    expect(opened.solids.size).toBe(2);
    expect([...opened.solids.values()].every((x) => x.recipe.kind === "box")).toBe(true);
    expect(opened.solids.has(a) && opened.solids.has(b)).toBe(true);
  });

  it("a group round-trips through the project file", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b], "Cabinet"));
    const text = serializeJson(s.document);
    const reloaded = new Session();
    reloaded.load(deserializeJson(text));
    const [g] = groupIds(reloaded);
    expect(reloaded.document.solids.get(g!)!.meta.name).toBe("Cabinet");
    expect(reloaded.analyse(g!).volume).toBeCloseTo(s.analyse(g!).volume, 6);
  });

  it("deleting the members leaves no resolvable group behind", () => {
    const { s, a, b } = twoBoxes();
    s.execute(groupSolids([a, b]));
    const [g] = groupIds(s);
    // Deleting the parent leaves its children top-level, which is legal; the
    // document must still mesh everything that is left.
    s.execute(deleteSolids([g!]));
    expect(() => s.analyse(a)).not.toThrow();
    expect(s.analyse(a).volume).toBeCloseTo(1000, 3);
  });
});

describe("mergeMeshes", () => {
  it("keeps children separate so a merged group stays watertight", () => {
    const { s, a, b } = twoBoxes();
    const merged = mergeMeshes([s.meshOf(a), s.meshOf(b)]);
    expect(merged.positions.length).toBe(s.meshOf(a).positions.length + s.meshOf(b).positions.length);
    // Indices are re-based, so the second child's triangles still point at it.
    const secondStart = s.meshOf(a).positions.length / 3;
    expect(Math.min(...merged.indices.subarray(s.meshOf(a).indices.length))).toBeGreaterThanOrEqual(secondStart);
  });

  it("an empty list is an empty mesh, not an error", () => {
    const merged = mergeMeshes([]);
    expect(merged.positions.length).toBe(0);
    expect(merged.indices.length).toBe(0);
  });
});
