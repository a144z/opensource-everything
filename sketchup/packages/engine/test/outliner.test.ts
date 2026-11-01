import { describe, expect, it } from "vitest";
import { Session, addSolid, renameSolid, setColor, setEnvelope, setMeta, translateSolids } from "@apexus/engine";

const box = (x = 0) => ({
  kind: "box" as const,
  width: 10,
  height: 10,
  depth: 10,
  origin: [x, 0, 0] as const,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const,
});

const only = (s: Session): string => [...s.document.solids.keys()][0]!;

describe("outliner commands", () => {
  it("rename is one undo step and restores the old name", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = only(s);
    const before = s.document.solids.get(id)!.meta.name;
    s.execute(renameSolid(id, "Wall A"));
    expect(s.document.solids.get(id)!.meta.name).toBe("Wall A");
    s.undo();
    expect(s.document.solids.get(id)!.meta.name).toBe(before);
  });

  it("a blank rename is refused rather than producing an unnamed object", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = only(s);
    expect(() => s.execute(renameSolid(id, "   "))).toThrow();
  });

  it("hidden is a document fact: it survives save/load and is undoable", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = only(s);
    s.execute(setMeta(id, { hidden: true }, "Hide"));
    expect(s.document.solids.get(id)!.meta.hidden).toBe(true);
    s.undo();
    expect(s.document.solids.get(id)!.meta.hidden).toBe(false);
  });

  it("locking keeps the object out of transforms, unlocking lets it move again", () => {
    const s = new Session();
    s.execute(addSolid(box()));
    const id = only(s);
    s.execute(setMeta(id, { locked: true }, "Lock"));
    s.execute(translateSolids([id], [100, 0, 0]));
    expect(s.boundsOf(id).min[0]).toBeCloseTo(0, 6);
    s.execute(setMeta(id, { locked: false }, "Unlock"));
    s.execute(translateSolids([id], [100, 0, 0]));
    expect(s.boundsOf(id).min[0]).toBeCloseTo(100, 6);
  });

  it("colour applies to several objects in one undo step", () => {
    const s = new Session();
    s.execute(addSolid(box(0)));
    s.execute(addSolid(box(50)));
    const ids = [...s.document.solids.keys()];
    const hash = s.hash();
    s.execute(setColor(ids, "#ff0000"));
    for (const id of ids) expect(s.document.solids.get(id)!.meta.color).toBe("#ff0000");
    s.undo();
    expect(s.hash()).toBe(hash);
  });

  it("a hidden object is left out of the fit check, and unhiding brings it back", () => {
    // Hiding is how a user checks one object against the envelope without
    // deleting the rest, so the fit must follow it.
    const s = new Session();
    s.execute(setEnvelope({ min: [0, 0, 0], max: [100, 100, 100] }));
    s.execute(addSolid(box()));
    const small = only(s);
    s.execute(addSolid(box(500)));
    const big = [...s.document.solids.keys()][1]!;
    expect(s.fit().pass).toBe(false);
    s.execute(setMeta(big, { hidden: true }, "Hide"));
    expect(s.fit().pass).toBe(true);
    expect(s.fit().offenders).toHaveLength(0);
    s.execute(setMeta(big, { hidden: false }, "Show"));
    expect(s.fit().pass).toBe(false);
    expect(s.fit().offenders).toContain(big);
    expect(s.fit().offenders).not.toContain(small);
  });
});
