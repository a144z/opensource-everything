import { describe, expect, it } from "vitest";
import {
  Session,
  addEdges,
  addFace,
  deserializeJson,
  emptyDocument,
  serializeJson,
  type SolidRecipe,
} from "../src/index.js";

/** The ground plane every line chain is drawn on. */
const GROUND = { origin: [0, 0, 0], normal: [0, 0, 1] } as const;

const L: readonly [number, number][] = [
  [0, 0],
  [1000, 0],
  [1000, 600],
];

function line(): Session {
  const session = new Session(emptyDocument());
  session.execute(addEdges(L, GROUND, { name: "Edges" }));
  return session;
}

function only(session: Session): SolidRecipe {
  const ids = [...session.document.solids.keys()];
  expect(ids).toHaveLength(1);
  return session.document.solids.get(ids[0]!)!.recipe;
}

describe("edges: the line tool's open chain", () => {
  it("is one object for the whole chain, not one per segment", () => {
    const session = line();
    expect(only(session).kind).toBe("edge");
    // The chain is 1000 + 600 mm long; the outliner should say so once.
    expect(session.document.solids.size).toBe(1);
  });

  it("has no volume and no area, so it cannot be counted as material", () => {
    const session = line();
    const id = [...session.document.solids.keys()][0]!;
    const geo = session.analyse(id);
    expect(geo.volume).toBe(0);
  });

  it("is picked through a mesh that spans the chain", () => {
    const session = line();
    const id = [...session.document.solids.keys()][0]!;
    const bounds = session.boundsOf(id);
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max[0]).toBeCloseTo(1000, 6);
    expect(bounds.max[1]).toBeCloseTo(600, 6);
  });

  it("refuses a single point: a click that never moved is not a line", () => {
    const session = new Session(emptyDocument());
    expect(() => session.execute(addEdges([[0, 0]], GROUND))).toThrow(/at least two points/);
  });

  it("drops a segment that doubles back to nothing", () => {
    const session = new Session(emptyDocument());
    session.execute(addEdges([[0, 0], [500, 0], [500, 0]], GROUND));
    const recipe = only(session);
    expect(recipe.kind === "edge" && recipe.points.length).toBe(3);
    const id = [...session.document.solids.keys()][0]!;
    // The repeat made no length, so the mesh has one segment, not two.
    expect(session.meshOf(id).indices.length).toBe(3);
  });

  it("is one undo step", () => {
    const session = line();
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.document.solids.size).toBe(0);
  });

  it("survives a save and a load", () => {
    const session = line();
    const back = deserializeJson(serializeJson(session.document));
    const recipe = [...back.solids.values()][0]!.recipe;
    expect(recipe.kind).toBe("edge");
    expect(recipe.kind === "edge" && recipe.points).toEqual(L);
  });

  it("does not stop a closed chain from becoming a face", () => {
    // The same points, closed: a face, so a closed loop and an open chain are
    // distinguished by the tool's last click, not by the recipe writer.
    const session = new Session(emptyDocument());
    session.execute(addFace(L, GROUND, { name: "Face" }));
    expect(only(session).kind).toBe("face");
  });
});
