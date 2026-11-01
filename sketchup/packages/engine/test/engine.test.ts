import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  analyzeSolid,
  deleteSolids,
  deserializeJson,
  emptyDocument,
  pullFace,
  renameSolid,
  serializeJson,
  setEnvelope,
  type SolidRecipe,
} from "../src/index.js";

const boxRecipe = (w: number, h: number, d: number, origin = [0, 0, 0] as const): SolidRecipe => ({
  kind: "box",
  width: w,
  height: h,
  depth: d,
  origin,
});

describe("document", () => {
  it("starts empty", () => {
    const doc = emptyDocument();
    expect(doc.solids.size).toBe(0);
    expect(doc.envelope).toBeNull();
    expect(doc.schemaVersion).toBe(1);
  });
});

describe("session history", () => {
  it("undo/redo of a single add round-trips", () => {
    const s = new Session();
    s.execute(addSolid(boxRecipe(1, 1, 1)));
    const after = s.hash();
    expect(s.document.solids.size).toBe(1);
    expect(s.undo()).toBe(true);
    expect(s.document.solids.size).toBe(0);
    expect(s.redo()).toBe(true);
    expect(s.hash()).toBe(after);
  });

  it("100 random ops, undone fully, returns to the start hash", () => {
    const s = new Session({ idPrefix: "r" });
    const start = s.hash();
    const hashes: string[] = [];
    // Deterministic PRNG so failures reproduce.
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 100; i++) {
      const r = rnd();
      const ids = [...s.document.solids.keys()];
      if (r < 0.55 || ids.length === 0) {
        s.execute(addSolid(boxRecipe(1 + i, 2 + i, 3), { name: `b${i}` }));
      } else if (r < 0.8) {
        const id = ids[Math.floor(rnd() * ids.length)]!;
        const prev = s.document.solids.get(id)!;
        const depth = ((prev.recipe as Extract<SolidRecipe, { kind: "box" }>).depth ?? 1) + 1;
        s.execute(pullFace(id, { ...(prev.recipe as Extract<SolidRecipe, { kind: "box" }>), depth }));
      } else if (r < 0.9) {
        const id = ids[Math.floor(rnd() * ids.length)]!;
        s.execute(renameSolid(id, `renamed${i}`));
      } else {
        const id = ids[Math.floor(rnd() * ids.length)]!;
        s.execute(deleteSolids([id]));
      }
      hashes.push(s.hash());
    }
    expect(new Set(hashes).size).toBeGreaterThan(50); // the ops actually did something
    let undone = 0;
    while (s.undo()) undone++;
    expect(undone).toBe(100);
    expect(s.document.solids.size).toBe(0);
    expect(s.hash()).toBe(start);
    expect(s.canUndo).toBe(false);
  });

  it("a new command clears the redo stack", () => {
    const s = new Session();
    s.execute(addSolid(boxRecipe(1, 1, 1)));
    s.undo();
    expect(s.canRedo).toBe(true);
    s.execute(addSolid(boxRecipe(2, 2, 2)));
    expect(s.canRedo).toBe(false);
  });

  it("undoing a push/pull restores the previous volume", () => {
    const s = new Session();
    s.execute(addSolid(boxRecipe(2, 3, 4)));
    const [id] = [...s.document.solids.keys()];
    const before = analyzeSolid(s.document.solids.get(id!)!).volume;
    s.execute(pullFace(id!, boxRecipe(2, 3, 10)));
    const after = analyzeSolid(s.document.solids.get(id!)!).volume;
    expect(after).toBeCloseTo(before * 2.5, 6);
    s.undo();
    expect(analyzeSolid(s.document.solids.get(id!)!).volume).toBeCloseTo(before, 6);
  });
});

describe("fit check", () => {
  it("passes with no envelope", () => {
    const s = new Session();
    s.execute(addSolid(boxRecipe(500, 500, 500)));
    expect(s.fit().pass).toBe(true);
    expect(s.fit().envelope).toBeNull();
  });

  it("passes an object that fits, failing one that does not", () => {
    const s = new Session();
    s.execute(setEnvelope({ min: [0, 0, 0], max: [600, 600, 600] }));
    s.execute(addSolid(boxRecipe(600, 600, 600)));
    expect(s.fit().pass).toBe(true);

    const [id] = [...s.document.solids.keys()];
    s.execute(pullFace(id!, boxRecipe(600, 600, 650)));
    const fit = s.fit();
    expect(fit.pass).toBe(false);
    expect(fit.worst).toEqual({ axis: "z", mm: 50 });
    expect(fit.overshoot).toEqual({ x: 0, y: 0, z: 50 });
  });

  it("rejects an inverted envelope", () => {
    const s = new Session();
    expect(() => s.execute(setEnvelope({ min: [10, 0, 0], max: [0, 10, 10] }))).toThrow(RangeError);
  });

  it("envelope changes are undoable", () => {
    const s = new Session();
    s.execute(setEnvelope({ min: [0, 0, 0], max: [10, 10, 10] }));
    s.undo();
    expect(s.document.envelope).toBeNull();
  });
});

describe("project file", () => {
  it("round-trips a document byte-for-byte", () => {
    const s = new Session();
    s.execute(setEnvelope({ min: [0, 0, 0], max: [1000, 1000, 500] }));
    s.execute(addSolid(boxRecipe(10, 20, 30, [1, 2, 3]), { name: "cabinet", color: "#123456" }));
    s.execute(addSolid({ kind: "extrude", profile: { width: 4, height: 5 }, normal: [0, 0, 1], origin: [0, 0, 0], distance: 6 }));

    const json = serializeJson(s.document);
    const back = deserializeJson(json);
    expect(serializeJson(back)).toBe(json);

    const s2 = new Session();
    for (const solid of back.solids.values()) {
      s2.execute(addSolid(solid.recipe, solid.meta));
    }
    expect(s2.document.solids.size).toBe(2);
    expect(s2.fit().pass).toBe(true);
  });

  it("refuses a file from a newer schema", () => {
    expect(() => deserializeJson(JSON.stringify({ schemaVersion: 99, solids: [] }))).toThrow(/newer version/);
  });

  it("refuses a solid with no recipe", () => {
    expect(() =>
      deserializeJson(JSON.stringify({ schemaVersion: 1, solids: [{ id: "a" }] })),
    ).toThrow(/missing a recipe/);
  });

  it("fills in missing metadata rather than crashing", () => {
    const doc = deserializeJson(
      JSON.stringify({ schemaVersion: 1, solids: [{ id: "a", recipe: boxRecipe(1, 1, 1) }] }),
    );
    const solid = doc.solids.get("a")!;
    expect(solid.revision).toBe(1);
    expect(solid.meta.name).toBe("a");
  });
});

describe("derived geometry", () => {
  it("marked closed and positive volume for generated solids", () => {
    const s = new Session();
    s.execute(addSolid(boxRecipe(10, 10, 10)));
    const [id] = [...s.document.solids.keys()];
    const geo = analyzeSolid(s.document.solids.get(id!)!);
    expect(geo.closed).toBe(true);
    expect(geo.volume).toBeCloseTo(1000, 6);
  });
});
