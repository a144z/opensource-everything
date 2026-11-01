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
 * Freehand lasso selection.
 *
 * SketchUp's lasso means the same thing as its rectangle: draw the path one way
 * and only fully-enclosed objects are picked, draw it the other way and anything
 * it crosses is picked. The path is a polygon of screen points; a solid counts as
 * enclosed when all four of its projected corners are inside, and as crossed when
 * its box shares any screen area with the lasso.
 *
 * Self-intersecting loops are accepted (the user drew what they drew): the
 * even-odd rule decides inside, which is what a person expects from a scribble.
 */
export function pointInPolygon(point: readonly [number, number], path: readonly (readonly [number, number])[]): boolean {
  // Even-odd ray cast to +x, the same rule a rectangle drag uses: count the
  // edges the ray crosses and a point is inside when the count is odd.
  //
  // The edge test is half-open on y, `(a.y > y) !== (b.y > y)`, which counts a
  // vertex shared by two edges exactly once and never divides by a zero rise, so
  // a ray through a corner is not ambiguous and needs no nudge: nudging a corner
  // moves the crossing off the ray by less than a round-off and can land the
  // point on the wrong side of its own edge, which is how a lobe reads outside.
  const px = point[0];
  const py = point[1];
  let crossings = 0;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[j]!;
    const b = path[i]!;
    if (a[1] > py !== b[1] > py) {
      const x = ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0];
      if (x > px) crossings++;
    }
  }
  return crossings % 2 === 1;
}



/** Which rule a lasso path means: the same left-to-right convention as the drag. */
export function lassoDirection(path: readonly (readonly [number, number])[]): DragDirection {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return "window";
  return dragDirection(first[0], last[0]);
}

/** True when a path encloses an area worth selecting with: 3+ points and some spread. */
export function isLassoPath(path: readonly { readonly x: number; readonly y: number }[], minPixels = 4): boolean {
  if (path.length < 3) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return maxX - minX >= minPixels || maxY - minY >= minPixels;
}

/** True when every corner of `box` lies inside the lasso path. */
export function boxInsidePath(box: ScreenBox, path: readonly (readonly [number, number])[]): boolean {
  if (path.length < 3) return false;
  const corners: readonly (readonly [number, number])[] = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ];
  return corners.every((c) => pointInPolygon(c, path));
}

/** True when the box shares any screen area with the lasso. */
export function boxTouchesPath(box: ScreenBox, path: readonly (readonly [number, number])[]): boolean {
  if (path.length < 3) return false;
  // A box corner inside the path, or a path vertex inside the box. The second
  // half is what catches a lasso drawn entirely within one large object.
  const corners: readonly (readonly [number, number])[] = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ];
  if (
    corners.some((c) => pointInPolygon(c, path)) ||
    path.some((p) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY)
  ) {
    return true;
  }
  // Any edge of the path crossing any edge of the box.
  const edges: readonly (readonly [readonly number[], readonly number[]])[] = [
    [
      [box.minX, box.minY],
      [box.maxX, box.minY],
    ],
    [
      [box.maxX, box.minY],
      [box.maxX, box.maxY],
    ],
    [
      [box.maxX, box.maxY],
      [box.minX, box.maxY],
    ],
    [
      [box.minX, box.maxY],
      [box.minX, box.minY],
    ],
  ];
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    for (const [c, d] of edges) {
      if (segmentsCross(a, b, c as readonly [number, number], d as readonly [number, number])) return true;
    }
  }
  return false;
}

/** The ids a lasso selects, in the order given. */
export function selectByLasso(
  ids: readonly string[],
  path: readonly (readonly [number, number])[],
  project: (id: string) => ScreenBox | null,
): string[] {
  const mode = lassoDirection(path);
  const picked: string[] = [];
  for (const id of ids) {
    const box = project(id);
    if (!box) continue;
    const hit = mode === "window" ? boxInsidePath(box, path) : boxTouchesPath(box, path);
    if (hit) picked.push(id);
  }
  return picked;
}

function orientation(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const v = (b[1]! - a[1]!) * (c[0]! - b[0]!) - (b[0]! - a[0]!) * (c[1]! - b[1]!);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}

function segmentsCross(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== o2 && o3 !== o4;
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
