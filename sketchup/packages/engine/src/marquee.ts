/**
 * Window and crossing selection.
 *
 * The two SketchUp gestures, stated precisely:
 *
 *   - **Window** (drag left-to-right): a solid is picked only when it is
 *     *entirely* inside the rectangle. Nothing outside can be caught by accident.
 *   - **Crossing** (drag right-to-left): a solid is picked when its rectangle
 *     *touches* the drag rectangle at all.
 *
 * The geometry here is screen-space only: callers project each solid's corners
 * to pixels and hand over the axis-aligned box. That keeps this file free of
 * Three.js and of the camera, so the rule that decides what a drag selects can
 * be tested without rendering anything.
 */

export interface ScreenBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export type DragDirection = "window" | "crossing";

/** Which rule a drag means, from the direction the pointer travelled. */
export function dragDirection(fromX: number, toX: number): DragDirection {
  return toX >= fromX ? "window" : "crossing";
}

/** Normalise a drag into a box, whichever corner it started from. */
export function dragBox(ax: number, ay: number, bx: number, by: number): ScreenBox {
  return {
    minX: Math.min(ax, bx),
    minY: Math.min(ay, by),
    maxX: Math.max(ax, bx),
    maxY: Math.max(ay, by),
  };
}

/** True when `inner` lies entirely within `outer` (touching edges count as inside). */
export function containsBox(outer: ScreenBox, inner: ScreenBox): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/** True when two boxes share any area, edges included. */
export function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** True when the box has no area, i.e. the user clicked rather than dragged. */
export function isDegenerate(box: ScreenBox, minPixels = 3): boolean {
  return box.maxX - box.minX < minPixels && box.maxY - box.minY < minPixels;
}

/**
 * The ids a drag selects, in the order given.
 *
 * `project` maps a solid id to its screen box, or `null` when the solid is
 * off-screen behind the camera - such a solid is never selected, because the
 * user could not have seen it inside the rectangle.
 */
export function selectByDrag(
  ids: readonly string[],
  box: ScreenBox,
  direction: DragDirection,
  project: (id: string) => ScreenBox | null,
): string[] {
  const picked: string[] = [];
  for (const id of ids) {
    const at = project(id);
    if (!at) continue;
    if (direction === "window" ? containsBox(box, at) : overlaps(box, at)) picked.push(id);
  }
  return picked;
}
