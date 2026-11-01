import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  deserialize,
  deserializeJson,
  serializeJson,
  setOpacity,
  SCHEMA_VERSION,
  setSection,
  setTag,
  setTagVisible,
  tagsInUse,
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

/** Everything the app writes after a cycle of edits, written and read back. */
function roundTrip(s: Session): Session {
  const copy = new Session();
  copy.load(deserializeJson(serializeJson(s.document)));
  return copy;
}

describe("schema 2 fields", () => {
  it("a new solid is opaque and untagged, so old behaviour is unchanged", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const solid = [...s.document.solids.values()][0]!;
    expect(solid.meta.opacity).toBe(1);
    expect(solid.meta.tag).toBe("");
    expect(s.document.section).toBeNull();
  });

  it("opacity survives save and load, and is clamped", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = [...s.document.solids.keys()][0]!;
    s.execute(setOpacity([id], 0.35));
    expect(roundTrip(s).document.solids.get(id)!.meta.opacity).toBeCloseTo(0.35, 6);
    s.execute(setOpacity([id], 2));
    // Out of range clamps rather than throwing: a slider that overshoots is not a bug.
    expect(s.document.solids.get(id)!.meta.opacity).toBe(1);
    expect(() => setOpacity([id], Number.NaN)).toThrow();
    // Out-of-range values in a hand-edited file clamp instead of loading garbage.
    const raw = JSON.parse(serializeJson(s.document)) as { solids: { meta: { opacity: number } }[] };
    raw.solids[0]!.meta.opacity = 7;
    expect(deserialize(raw).solids.get(id)!.meta.opacity).toBe(1);
  });

  it("a tag survives save and load; a blank or long tag is refused", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = [...s.document.solids.keys()][0]!;
    s.execute(setTag([id], "  Woodwork "));
    expect(roundTrip(s).document.solids.get(id)!.meta.tag).toBe("Woodwork");
    expect(() => setTag([id], "x".repeat(41))).toThrow(/40 characters/);
    // Blank means "no tag", which is a legitimate command, not an error.
    expect(setTag([id], "   ").label).toBe("Clear tag");
  });

  it("tag counts separate visible from hidden objects", () => {
    const s = new Session();
    s.execute(addSolid(box(0)));
    s.execute(addSolid(box(200)));
    s.execute(addSolid(box(400)));
    const ids = [...s.document.solids.keys()];
    s.execute(setTag([ids[0]!, ids[1]!], "Frame"));
    s.execute(setTag([ids[2]!], "Panel"));
    s.execute(setTagVisible("Frame", false));
    expect(tagsInUse(s.document)).toEqual([
      { tag: "Frame", total: 2, hidden: 2 },
      { tag: "Panel", total: 1, hidden: 0 },
    ]);
    s.execute(setTagVisible("Frame", true));
    expect(tagsInUse(s.document)[0]).toEqual({ tag: "Frame", total: 2, hidden: 0 });
  });

  it("hiding a tag is one undo step for every object on it", () => {
    const s = new Session();
    s.execute(addSolid(box(0)));
    s.execute(addSolid(box(200)));
    const ids = [...s.document.solids.keys()];
    s.execute(setTag(ids, "Frame"));
    const hash = s.hash();
    s.execute(setTagVisible("Frame", false));
    expect([...s.document.solids.values()].every((x) => x.meta.hidden)).toBe(true);
    s.undo();
    expect(s.hash()).toBe(hash);
  });

  it("a section is document state: saved, undoable, and validated", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    s.execute(setSection({ axis: "z", offset: 25, flip: false }));
    expect(roundTrip(s).document.section).toEqual({ axis: "z", offset: 25, flip: false });
    s.undo();
    expect(s.document.section).toBeNull();
    s.redo();
    expect(s.document.section?.axis).toBe("z");
    expect(() => setSection({ axis: "z", offset: Number.NaN, flip: false })).toThrow();
  });

  it("a malformed section in a file is rejected, not silently dropped", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const raw = JSON.parse(serializeJson(s.document)) as Record<string, unknown>;
    raw["section"] = { axis: "w", offset: 0, flip: false };
    expect(() => deserialize(raw)).toThrow(/axis/);
    raw["section"] = { axis: "x", offset: "0", flip: false };
    expect(() => deserialize(raw)).toThrow(/offset/);
  });

  it("a schema 1 file still opens, with schema 2 defaults filled in", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const raw = JSON.parse(serializeJson(s.document)) as Record<string, unknown>;
    raw["schemaVersion"] = 1;
    delete raw["section"];
    const solids = raw["solids"] as { meta: Record<string, unknown> }[];
    delete solids[0]!.meta["opacity"];
    delete solids[0]!.meta["tag"];
    const loaded = deserialize(raw);
    // The reader always returns the current schema; the test's point is that a
    // 1-file walked every step and got the defaults each one introduced.
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.section).toBeNull();
    const solid = [...loaded.solids.values()][0]!;
    expect(solid.meta.opacity).toBe(1);
    expect(solid.meta.tag).toBe("");
    expect(solid.meta.metallic).toBe(0);
  });

  it("refuses a file from a newer schema rather than guessing", () => {
    expect(() => deserialize({ schemaVersion: 99, units: "mm", envelope: null, solids: [] })).toThrow(
      /newer version/,
    );
  });
});
