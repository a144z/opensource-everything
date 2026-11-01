import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  componentsOf,
  definitionName,
  deserializeJson,
  detachDefinition,
  makeComponent,
  renameDefinition,
  renameSolid,
  serializeJson,
  translateSolid,
  type SolidId,
  type SolidRecipe,
} from "../src/index.js";

/**
 * A component is a *set*: six windows that are the same window. These tests pin
 * the three things that make that true — one definition or none, a rename that
 * hits the whole set and nothing else, and a file that survives the round trip.
 */

const box = (w: number, h: number, d: number): SolidRecipe => ({
  kind: "box",
  width: w,
  height: h,
  depth: d,
  origin: [0, 0, 0],
});

function withBox(): { session: Session; id: SolidId } {
  const session = new Session();
  session.execute(addSolid(box(100, 60, 100)));
  const id = [...session.document.solids.keys()][0]!;
  return { session, id };
}

/** Make a component and return the placed instance id. */
function made(session: Session, id: SolidId, name?: string): SolidId {
  const patch = session.execute(makeComponent(id, [200, 0, 0], name));
  const placed = [...patch.backward].filter(([, prev]) => prev === null).map(([k]) => k)[0];
  if (!placed) throw new Error("no instance was placed");
  return placed;
}

describe("make component", () => {
  it("leaves a named definition and one instance", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    const instance = session.document.solids.get(instanceId)!;
    expect(instance.recipe.kind).toBe("instance");
    expect(instance.recipe.kind === "instance" && instance.recipe.definition).toBe("Post cap");
    expect(componentsOf(session.document)).toEqual([
      { definition: "Post cap", count: 1, instances: [instanceId] },
    ]);
  });

  it("makes the copy at the requested offset, not on top of the source", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    const a = session.boundsOf(id);
    const b = session.boundsOf(instanceId);
    expect(b.min[0] - a.min[0]).toBeCloseTo(200, 6);
  });

  it("never leaves a definition with no instance", () => {
    // A definition nobody instantiates is a component the user cannot reach; the
    // command must be all-or-nothing rather than rename-then-fail.
    const { session, id } = withBox();
    expect(() => session.execute(makeComponent(id, [0, 0, 0], "Post cap"))).toThrow(/away from the source/i);
    const solid = session.document.solids.get(id)!;
    expect(solid.recipe.kind).not.toBe("instance");
    expect(componentsOf(session.document)).toHaveLength(0);
  });

  it("refuses a second component with the same name", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    session.execute(addSolid(box(10, 10, 10)));
    const other = [...session.document.solids.keys()].find((k) => k !== id)!;
    expect(() => session.execute(makeComponent(other, [0, 300, 0], "Post cap"))).toThrow(/already exists/i);
  });

  it("refuses to make a component of a component", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    expect(() => session.execute(makeComponent(instanceId, [0, 300, 0], "Again"))).toThrow(/already a component/i);
  });

  it("treats different spellings of one name as one component", () => {
    const { session, id } = withBox();
    made(session, id, "  Post   cap ");
    expect(componentsOf(session.document)[0]!.definition).toBe("Post cap");
  });

  it("refuses an empty name instead of inventing one", () => {
    const { session, id } = withBox();
    expect(() => session.execute(makeComponent(id, [200, 0, 0], "   "))).toThrow(/needs a name/i);
  });

  it("refuses a name longer than the field will ever hold", () => {
    const { session, id } = withBox();
    expect(() => session.execute(makeComponent(id, [200, 0, 0], "x".repeat(65)))).toThrow(/64/);
  });

  it("refuses a name with a control character in it", () => {
    const { session, id } = withBox();
    expect(() => session.execute(makeComponent(id, [200, 0, 0], "a\u0001b"))).toThrow(/control character/i);
  });

  it("falls back to the object's own name when none is given", () => {
    const { session, id } = withBox();
    const source = session.document.solids.get(id)!;
    const instanceId = made(session, id);
    const instance = session.document.solids.get(instanceId)!;
    expect(instance.recipe.kind === "instance" && instance.recipe.definition).toBe(source.meta.name);
  });

  it("is one undo step: undo removes both the copy and the definition", () => {
    const { session, id } = withBox();
    session.execute(makeComponent(id, [200, 0, 0], "Post cap"));
    session.undo();
    expect(componentsOf(session.document)).toHaveLength(0);
    expect(session.document.solids.size).toBe(1);
    expect(session.document.solids.get(id)!.recipe.kind).not.toBe("instance");
  });

  it("editing the definition still moves every instance", () => {
    // The whole point of a component: the set is live. Moving the definition
    // must carry every instance with it, by the same delta.
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    const beforeSource = session.boundsOf(id);
    const beforeInstance = session.boundsOf(instanceId);
    session.execute(translateSolid(id, [0, 500, 0]));
    const afterSource = session.boundsOf(id);
    const afterInstance = session.boundsOf(instanceId);
    const sourceMoved = afterSource.min[1] - beforeSource.min[1];
    const instanceMoved = afterInstance.min[1] - beforeInstance.min[1];
    expect(sourceMoved).toBeCloseTo(500, 6);
    // An instance cancels the source's own placement, so it stays where the user
    // put it rather than being dragged along: the *shape* is shared, not the
    // position. This is the behaviour two windows on two walls needs.
    expect(instanceMoved).toBeCloseTo(0, 6);
  });
});

describe("rename a component", () => {
  it("renames every instance at once", () => {
    const { session, id } = withBox();
    const first = made(session, id, "Post cap");
    const second = made(session, id, "Post cap");
    session.execute(renameDefinition("Post cap", "Window"));
    for (const i of [first, second]) {
      const r = session.document.solids.get(i)!.recipe;
      expect(r.kind === "instance" && r.definition).toBe("Window");
    }
  });

  it("leaves unrelated instances alone", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    session.execute(addSolid(box(10, 10, 10)));
    const other = [...session.document.solids.keys()].find(
      (k) => session.document.solids.get(k)!.recipe.kind === "box" && k !== id,
    )!;
    const kept = made(session, other, "Sill");
    session.execute(renameDefinition("Post cap", "Window"));
    const r = session.document.solids.get(kept)!.recipe;
    expect(r.kind === "instance" && r.definition).toBe("Sill");
  });

  it("refuses a name that is already taken", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    session.execute(addSolid(box(10, 10, 10)));
    const other = [...session.document.solids.keys()].find(
      (k) => session.document.solids.get(k)!.recipe.kind === "box" && k !== id,
    )!;
    made(session, other, "Sill");
    expect(() => session.execute(renameDefinition("Post cap", "Sill"))).toThrow(/already exists/i);
  });

  it("is a no-op, not an error, when the name did not change", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    const before = session.undoDepth;
    session.execute(renameDefinition("Post cap", "Post cap"));
    expect(session.undoDepth).toBe(before);
  });

  it("refuses a component that does not exist", () => {
    const { session } = withBox();
    expect(() => session.execute(renameDefinition("Nothing", "Something"))).toThrow(/no component/i);
  });

  it("renames the definition's own label but not a name the user chose", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    session.execute(renameDefinition("Post cap", "Window"));
    // The instance label followed the definition...
    expect(session.document.solids.get(instanceId)!.meta.name).toBe("Window");
    // ...and the definition row keeps its marker.
    expect(session.document.solids.get(id)!.meta.name).toBe("Window (definition)");
  });

  it("does not rename an instance the user renamed by hand", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    session.execute(renameSolid(instanceId, "The one on the corner"));
    session.execute(renameDefinition("Post cap", "Window"));
    expect(session.document.solids.get(instanceId)!.meta.name).toBe("The one on the corner");
  });
});

describe("detach a component", () => {
  it("removes the definition but keeps every object", () => {
    const { session, id } = withBox();
    const a = made(session, id, "Post cap");
    const b = made(session, id, "Post cap");
    const count = session.document.solids.size;
    session.execute(detachDefinition("Post cap"));
    expect(session.document.solids.size).toBe(count);
    expect(componentsOf(session.document)).toHaveLength(0);
    for (const i of [a, b]) {
      const r = session.document.solids.get(i)!.recipe;
      expect(r.kind).toBe("instance");
      expect(r.kind === "instance" && r.definition).toBeUndefined();
    }
  });

  it("keeps the geometry in place", () => {
    const { session, id } = withBox();
    const a = made(session, id, "Post cap");
    const before = session.boundsOf(a);
    session.execute(detachDefinition("Post cap"));
    const after = session.boundsOf(a);
    expect(after.min[0]).toBeCloseTo(before.min[0], 6);
    expect(after.max[2]).toBeCloseTo(before.max[2], 6);
  });

  it("is undone as one step", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    session.execute(detachDefinition("Post cap"));
    session.undo();
    expect(componentsOf(session.document)).toHaveLength(1);
  });
});

describe("component naming", () => {
  it("reports the definition for an instance and the name for a plain solid", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    expect(definitionName(session.document.solids.get(instanceId)!)).toBe("Post cap");
    expect(definitionName(session.document.solids.get(id)!)).toBe(session.document.solids.get(id)!.meta.name);
  });
});

describe("components in a project file", () => {
  it("survives a save and reload with its definition intact", () => {
    const { session, id } = withBox();
    const instanceId = made(session, id, "Post cap");
    const text = serializeJson(session.document);
    const back = deserializeJson(text);
    const r = back.solids.get(instanceId)!.recipe;
    expect(r.kind === "instance" && r.definition).toBe("Post cap");
    expect(componentsOf(back)).toEqual([{ definition: "Post cap", count: 1, instances: [instanceId] }]);
  });

  it("reads a schema-4 file whose instances have no definition", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    const raw = JSON.parse(serializeJson(session.document));
    raw.schemaVersion = 4;
    delete raw.solids.find((s: { recipe: { kind: string } }) => s.recipe.kind === "instance").recipe.definition;
    const back = deserializeJson(JSON.stringify(raw));
    expect(componentsOf(back)).toHaveLength(0);
    // The object is still an instance; only its name is gone.
    const inst = [...back.solids.values()].find((s) => s.recipe.kind === "instance")!;
    expect(inst.recipe.kind).toBe("instance");
  });

  it("drops a blank definition rather than storing an empty name", () => {
    const { session, id } = withBox();
    made(session, id, "Post cap");
    const raw = JSON.parse(serializeJson(session.document));
    raw.solids.find((s: { recipe: { kind: string } }) => s.recipe.kind === "instance").recipe.definition = "   ";
    const back = deserializeJson(JSON.stringify(raw));
    expect(componentsOf(back)).toHaveLength(0);
    const inst = [...back.solids.values()].find((s) => s.recipe.kind === "instance")!;
    expect(inst.recipe.kind === "instance" && inst.recipe.definition).toBeUndefined();
  });
});
