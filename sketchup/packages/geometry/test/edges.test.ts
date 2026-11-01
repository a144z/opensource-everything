import { describe, expect, it } from "vitest";
import { edgesMesh, edgePositions } from "../src/edges.js";

const GROUND = { origin: [0, 0, 0], normal: [0, 0, 1] } as const;

describe("edge meshing", () => {
  it("maps plane points to world along the plane's own axes", () => {
    const pts = edgePositions({ points: [[0, 0], [10, 0]], plane: GROUND });
    expect(pts).toEqual([
      [0, 0, 0],
      [10, 0, 0],
    ]);
  });

  it("offsets from the plane origin", () => {
    const pts = edgePositions({ points: [[0, 0], [10, 0]], plane: { origin: [5, 5, 5], normal: [0, 0, 1] } });
    expect(pts[0]).toEqual([5, 5, 5]);
  });

  it("gives one degenerate triangle per segment", () => {
    const mesh = edgesMesh({ points: [[0, 0], [10, 0], [10, 20]], plane: GROUND });
    expect(mesh.positions.length).toBe(9);
    expect(mesh.indices.length).toBe(6);
  });

  it("refuses a path that collapses to a point", () => {
    expect(() => edgesMesh({ points: [[0, 0], [0, 0]], plane: GROUND })).toThrow(/two distinct points/);
  });
});
