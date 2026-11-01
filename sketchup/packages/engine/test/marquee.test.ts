import { describe, expect, it } from "vitest";
import {
  containsBox,
  dragBox,
  dragDirection,
  isDegenerate,
  overlaps,
  selectByDrag,
  type ScreenBox,
} from "@apexus/engine";

const box = (minX: number, minY: number, maxX: number, maxY: number): ScreenBox => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe("drag direction", () => {
  it("left to right is a window, right to left is a crossing", () => {
    expect(dragDirection(100, 300)).toBe("window");
    expect(dragDirection(300, 100)).toBe("crossing");
    expect(dragDirection(200, 200)).toBe("window");
  });
});

describe("drag box", () => {
  it("normalises whichever corner the drag started from", () => {
    const fromTopLeft = dragBox(10, 10, 90, 60);
    const fromBottomRight = dragBox(90, 60, 10, 10);
    expect(fromTopLeft).toEqual(fromBottomRight);
    expect(fromTopLeft).toEqual(box(10, 10, 90, 60));
  });

  it("a click is a degenerate drag and must not select by rectangle", () => {
    expect(isDegenerate(dragBox(50, 50, 51, 50))).toBe(true);
    expect(isDegenerate(dragBox(50, 50, 200, 50))).toBe(false);
  });
});

describe("containment and overlap", () => {
  it("containment needs every edge inside, and allows shared edges", () => {
    expect(containsBox(box(0, 0, 100, 100), box(10, 10, 20, 20))).toBe(true);
    expect(containsBox(box(0, 0, 100, 100), box(0, 0, 100, 100))).toBe(true);
    expect(containsBox(box(0, 0, 100, 100), box(90, 90, 110, 110))).toBe(false);
  });

  it("a box straddling the edge is not contained but does overlap", () => {
    const drag = box(0, 0, 100, 100);
    const solid = box(90, 90, 110, 110);
    expect(containsBox(drag, solid)).toBe(false);
    expect(overlaps(drag, solid)).toBe(true);
  });

  it("boxes that only touch at a corner count as overlapping", () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 10, 20, 20))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(11, 0, 20, 10))).toBe(false);
  });
});

describe("select by drag", () => {
  const solids = new Map<string, ScreenBox>([
    ["inside", box(20, 20, 40, 40)],
    ["straddling", box(80, 80, 140, 140)],
    ["outside", box(300, 300, 400, 400)],
    ["behind", box(0, 0, 0, 0)],
  ]);
  const project = (id: string) => (id === "behind" ? null : solids.get(id) ?? null);
  const ids = ["inside", "straddling", "outside", "behind"];

  it("a window drag takes only what is fully inside", () => {
    expect(selectByDrag(ids, dragBox(0, 0, 100, 100), "window", project)).toEqual(["inside"]);
  });

  it("a crossing drag also takes what it touches", () => {
    expect(selectByDrag(ids, dragBox(0, 0, 100, 100), "crossing", project)).toEqual([
      "inside",
      "straddling",
    ]);
  });

  it("never selects geometry behind the camera", () => {
    const all = selectByDrag(ids, dragBox(-50, -50, 500, 500), "crossing", project);
    expect(all).not.toContain("behind");
  });

  it("keeps the document order so selection is deterministic", () => {
    const hit = selectByDrag(ids, dragBox(-50, -50, 500, 500), "crossing", project);
    expect(hit).toEqual(["inside", "straddling", "outside"]);
  });

  it("an empty drag selects nothing", () => {
    expect(selectByDrag(ids, dragBox(0, 0, 5, 5), "crossing", project)).toEqual([]);
  });
});
