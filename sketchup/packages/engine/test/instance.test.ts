import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  deserialize,
  deserializeJson,
  duplicateSolid,
  instanceCopy,
  pullFace,
  serializeJson,
  setRecipe,
  translateSolid,
  type SolidRecipe,
} from "@apexus/engine";

const box = (x = 0): SolidRecipe => ({
  kind: "box",
  width: 100,
  height: 50,
  depth: 20,
  origin: [x, 0, 0],
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});

const box2 = (x = 0, w = 100): SolidRecipe => ({ ...box(x), width: w });

function only(s: Session): string {
  const ids = [...s.document.solids.keys()];
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

describe("instances versus pinned copies", () => {
  it("an instance follows later edits to its source", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(instanceCopy(src, [200, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src)!;
    expect(s.document.solids.get(inst)!.recipe.kind).toBe("instance");

    const before = s.boundsOf(inst).max[0];
    s.execute(setRecipe(src, box2(0, 300)));
    const after = s.boundsOf(inst);
    expect(after.max[0] - after.min[0]).toBeCloseTo(300, 6);
    expect(after.max[0]).toBeGreaterThan(before);
    // The instance still sits 200 mm to the right of the source.
    expect(after.min[0]).toBeCloseTo(200, 6);
  });

  it("a pinned copy does not follow", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(duplicateSolid(src, [200, 0, 0]));
    const copy = [...s.document.solids.keys()].find((id) => id !== src)!;
    expect(s.document.solids.get(copy)!.recipe.kind).toBe("box");

    s.execute(setRecipe(src, box2(0, 300)));
    expect(s.boundsOf(copy).max[0] - s.boundsOf(copy).min[0]).toBeCloseTo(100, 6);
  });

  it("moving the source carries every instance with it", () => {
    // An instance is a live view of its source: it stores the source's
    // placement at copy time in `origin`, and the source's *later* motion is
    // whatever the instance sees. That is the difference from a pinned copy.
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(instanceCopy(src, [200, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src)!;
    s.execute(translateSolid(src, [0, 10, 0]));
    expect(s.boundsOf(src).min[1]).toBeCloseTo(10, 6);
    expect(s.boundsOf(inst).min[1]).toBeCloseTo(10, 6);
    expect(s.boundsOf(inst).min[0]).toBeCloseTo(200, 6);
  });

  it("an instance of a pinned copy lands at the copy's place plus its offset", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(duplicateSolid(src, [200, 0, 0]));
    const copy = [...s.document.solids.keys()].find((id) => id !== src)!;
    s.execute(instanceCopy(copy, [100, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src && id !== copy)!;
    // Copy sits at 200, dropped 100 further out: 300, not 200 + 200 + 100.
    expect(s.boundsOf(inst).min[0]).toBeCloseTo(300, 6);
  });

  it("refuses to place an instance in the same spot", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    expect(() => s.execute(instanceCopy(src, [0, 0, 0]))).toThrow();
  });

  it("refuses to make an instance of itself through a corrupt file", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = only(s);
    const raw = JSON.parse(serializeJson(s.document)) as { solids: { id: string; recipe: unknown }[] };
    raw.solids[0]!.recipe = { kind: "instance", source: id, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    expect(() => deserialize(raw)).toThrow(/itself/);
  });

  it("a reference cycle is caught at load, never hung", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    s.execute(addSolid(box(200)));
    const ids = [...s.document.solids.keys()];
    const [a, b] = [ids[0]!, ids[1]!];
    // Hand-build the cycle a bad file could create, written and read back so
    // the reader's own cycle refusal is part of what is tested.
    const raw = JSON.parse(serializeJson(s.document)) as {
      solids: { id: string; recipe: unknown }[];
    };
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    raw.solids.find((x) => x.id === a)!.recipe = { kind: "instance", source: b, matrix: I };
    raw.solids.find((x) => x.id === b)!.recipe = { kind: "instance", source: a, matrix: I };
    // Two-node rings pass the "not its own source" check, so the loader has to
    // walk the whole chain to notice.
    expect(() => deserialize(raw)).toThrow(/ancestor|cycle/i);
  });

  it("a cycle built through the session is refused at construction", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    // Rewriting the source as an instance of its own instance is the shape a
    // future "make this follow that" feature could produce.
    s.execute(instanceCopy(src, [200, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src)!;
    const cyclic = { ...s.document.solids.get(src)!.recipe, kind: "instance", source: inst } as SolidRecipe;
    expect(() => s.execute(setRecipe(src, cyclic))).toThrow(/ancestor/);
    expect(s.document.solids.get(src)!.recipe.kind).toBe("box");
  });

  it("an instance follows a source two levels away, once the chain is live", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    // Instance -> instance -> box: editing the box must reach both, at any depth.
    s.execute(instanceCopy(src, [200, 0, 0]));
    const first = [...s.document.solids.keys()].find((id) => id !== src)!;
    s.execute(instanceCopy(first, [200, 0, 0]));
    const second = [...s.document.solids.keys()].find((id) => id !== src && id !== first)!;
    expect(s.document.solids.get(second)!.recipe.kind).toBe("instance");

    // Placed before the edit, so both carry the 100 mm box's origin; the
    // resize reaches both, and each stays at its own drop point.
    s.execute(setRecipe(src, box2(0, 400)));
    for (const id of [first, second]) {
      const b = s.boundsOf(id);
      expect(b.max[0] - b.min[0]).toBeCloseTo(400, 6);
    }
    expect(s.boundsOf(first).min[0]).toBeCloseTo(200, 6);
    expect(s.boundsOf(second).min[0]).toBeCloseTo(400, 6);
  });

  it("an instance of a pinned copy inherits that copy's frozen size, not new edits", () => {
    // Pinning is the whole point of `transform`: the copy is history, so an
    // instance of it follows the copy, which no longer follows the source.
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(duplicateSolid(src, [200, 0, 0]));
    const copy = [...s.document.solids.keys()].find((id) => id !== src)!;
    s.execute(instanceCopy(copy, [100, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src && id !== copy)!;

    s.execute(setRecipe(src, box2(0, 400)));
    expect(s.boundsOf(inst).max[0] - s.boundsOf(inst).min[0]).toBeCloseTo(100, 6);
    expect(s.boundsOf(inst).min[0]).toBeCloseTo(300, 6);
  });


  it("an instance survives save and load", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(instanceCopy(src, [200, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src)!;

    const reopened = new Session();
    reopened.load(deserializeJson(serializeJson(s.document)));
    // Exactly what was written, `origin` included: a reload that silently
    // dropped the recorded placement would move every instance of a moved source.
    expect(reopened.document.solids.get(inst)!.recipe).toEqual(s.document.solids.get(inst)!.recipe);
    expect(reopened.analyse(inst).closed).toBe(true);
    expect(reopened.hash()).toBe(s.hash());
  });

  it("deleting a source leaves a readable document, not a crash", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(instanceCopy(src, [200, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src)!;
    s.execute({
      kind: "deleteSolids",
      label: "delete",
      apply: (doc) => ({
        forward: new Map([[src, null]]),
        backward: new Map([[src, doc.solids.get(src)!]]),
        envelopeBefore: doc.envelope,
        envelopeAfter: doc.envelope,
        label: "delete",
      }),
    });
    // The instance is still listed; asking for its mesh says why it is gone.
    expect(s.document.solids.has(inst)).toBe(true);
    expect(() => s.meshOf(inst)).toThrow(/missing solid/);
  });
});

describe("schema 3 migration", () => {
  it("a schema 2 file loads with default finish and no new kinds", () => {
    const doc = deserialize({
      schemaVersion: 2,
      units: "mm",
      envelope: null,
      section: null,
      solids: [
        {
          id: "s1",
          revision: 1,
          recipe: { kind: "extrude", profile: { width: 10, height: 10 }, normal: [0, 0, 1], origin: [0, 0, 0], distance: 5, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
          meta: { name: "Wall", color: "#fff", hidden: false, locked: false, opacity: 1, tag: "Walls" },
        },
      ],
    });
    const solid = doc.solids.get("s1")!;
    expect(doc.schemaVersion).toBe(3);
    expect(solid.meta.roughness).toBeCloseTo(0.75, 6);
    expect(solid.meta.metallic).toBe(0);
    expect(solid.meta.tag).toBe("Walls");
  });

  it("a schema 1 file still walks both steps", () => {
    const doc = deserialize({
      schemaVersion: 1,
      units: "mm",
      envelope: null,
      solids: [
        { id: "s1", revision: 1, recipe: { kind: "box", width: 1, height: 1, depth: 1, origin: [0, 0, 0] }, meta: { name: "B", color: "#fff", hidden: false, locked: false } },
      ],
    });
    expect(doc.solids.get("s1")!.meta.opacity).toBe(1);
    expect(doc.solids.get("s1")!.meta.roughness).toBeCloseTo(0.75, 6);
  });

  it("finish is clamped on write and on read", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = only(s);
    s.execute(setRecipe(id, { ...box(), matrix: box().matrix }));
    expect(s.document.solids.get(id)!.meta.metallic).toBe(0);
    const raw = JSON.parse(serializeJson(s.document)) as { solids: { meta: { roughness: number; metallic: number } }[] };
    raw.solids[0]!.meta.roughness = -3;
    raw.solids[0]!.meta.metallic = 9;
    const back = deserialize(raw).solids.get(id)!;
    expect(back.meta.roughness).toBe(0);
    expect(back.meta.metallic).toBe(1);
  });
});

describe("a lathe stays a solid through push/pull refusals", () => {
  it("push/pull rejects an instance by name", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const src = only(s);
    s.execute(instanceCopy(src, [200, 0, 0]));
    const inst = [...s.document.solids.keys()].find((id) => id !== src)!;
    expect(() => s.execute(pullFace(inst, 10))).toThrow(/primitive/);
    expect(s.analyse(inst).closed).toBe(true);
    expect(s.analyse(src).closed).toBe(true);
  });
});
