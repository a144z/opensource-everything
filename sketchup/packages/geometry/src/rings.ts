/**
 * Closed paths on the ground plane, in millimetres.
 *
 * Circle and arc both end up as a ring that the `loop` recipe extrudes, so this
 * is the one place where "a curve" becomes a polyline. Pure functions: no DOM,
 * no renderer, no kernel, so they are cheap to test.
 */

import type { Vec2, Vec3 } from "./index.js";

/** Segments in a full circle. 64 reads as round at any normal zoom. */
export const CIRCLE_SEGMENTS = 64;

/**
 * A full circle, counter-clockwise, starting where `towards` points. The start
 * direction matters: it is what the user sees under the cursor on the first
 * frame, so the drag never appears to jump.
 */
export function circlePoints(
  centre: Vec3,
  towards: Vec3,
  radius: number,
  segments = CIRCLE_SEGMENTS,
): Vec2[] {
  if (!(radius > 0)) throw new RangeError("circle radius must be positive");
  const start = Math.atan2(towards[1] - centre[1], towards[0] - centre[0]);
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = start + (i / segments) * Math.PI * 2;
    out.push([centre[0] + Math.cos(a) * radius, centre[1] + Math.sin(a) * radius]);
  }
  return out;
}

/**
 * A regular polygon on the ground plane, counter-clockwise, with one vertex
 * where `towards` points.
 *
 * A polygon is a circle with a small, exact number of segments, which is why it
 * shares the start-angle rule: the vertex under the cursor stays under the
 * cursor. Sides are clamped to 3..96: two sides cannot enclose an area, and past
 * about a hundred a "polygon" is a circle and should be drawn as one.
 */
export function polygonPoints(
  centre: Vec3,
  towards: Vec3,
  radius: number,
  sides: number,
): Vec2[] {
  if (!(radius > 0)) throw new RangeError("polygon radius must be positive");
  if (!Number.isFinite(sides)) throw new RangeError("polygon needs a whole number of sides");
  const n = Math.min(96, Math.max(3, Math.round(sides)));
  const start = Math.atan2(towards[1] - centre[1], towards[0] - centre[0]);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * Math.PI * 2;
    out.push([centre[0] + Math.cos(a) * radius, centre[1] + Math.sin(a) * radius]);
  }
  return out;
}

/**
 * Three-point arc on the ground plane: `points[0]` is the start, `points[1]`
 * (or `through`, once both are known) lies on the arc, and the end is the last
 * known point.
 *
 * With fewer than three distinct points this degrades to a straight chord,
 * which is exactly what the preview should show while the user is still
 * choosing.
 *
 * `z` is deliberately discarded: the result is a ring that the `loop` recipe
 * extrudes along +Z, so an arc lives on the ground plane and Push/Pull gives it
 * height. Callers holding raised points get `flatArc`'s loud refusal instead of
 * a silently collapsed arc.
 */
export function arcPoints(points: readonly Vec3[], through: Vec3 | null = null): Vec2[] {
  const all = through ? [...points, through] : [...points];
  for (const q of all) {
    if (q[2] !== 0) {
      throw new RangeError(
        `arcPoints draws on the ground plane, but a point has z=${q[2]} mm; level it or use a raised profile`,
      );
    }
  }
  const flat = all.map((q): Vec2 => [q[0], q[1]]);
  if (flat.length === 0) return [];
  if (flat.length < 3) return [flat[0]!, flat[flat.length - 1]!];

  const a = flat[0]!;
  const b = flat[1]!;
  const c = flat[flat.length - 1]!;
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  // Collinear: no circumcircle, so the honest answer is the chord.
  if (Math.abs(d) < 1e-9) return [a, c];

  const sa = a[0] * a[0] + a[1] * a[1];
  const sb = b[0] * b[0] + b[1] * b[1];
  const sc = c[0] * c[0] + c[1] * c[1];
  const cx = (sa * (b[1] - c[1]) + sb * (c[1] - a[1]) + sc * (a[1] - b[1])) / d;
  const cy = (sa * (c[0] - b[0]) + sb * (a[0] - c[0]) + sc * (b[0] - a[0])) / d;
  const radius = Math.hypot(a[0] - cx, a[1] - cy);

  const TAU = Math.PI * 2;
  const norm = (v: number): number => ((v % TAU) + TAU) % TAU;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const a1 = Math.atan2(b[1] - cy, b[0] - cx);
  const a2 = Math.atan2(c[1] - cy, c[0] - cx);

  // Sweep counter-clockwise if the middle point sits inside that sweep,
  // otherwise the arc must run the other way.
  const ccw = norm(a2 - a0);
  const ccwThrough = norm(a1 - a0);
  const [from, sweep, flip] = ccwThrough <= ccw ? [a0, ccw, false] : [a2, TAU - ccw, true];

  const segments = Math.max(2, Math.ceil((sweep / TAU) * CIRCLE_SEGMENTS));
  const out: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = from + (sweep * i) / segments;
    out.push([cx + Math.cos(t) * radius, cy + Math.sin(t) * radius]);
  }
  // Pin the endpoints so the arc meets other geometry without a rounding gap.
  // Walking the long way round generates the ring end-first, so reverse it:
  // a ring always reads start -> through -> end.
  out[0] = flip ? c : a;
  out[out.length - 1] = flip ? a : c;
  return flip ? out.reverse() : out;
}

/** Close an open arc back along its chord so it can be extruded. */
export function closedArc(ring: readonly Vec2[]): Vec2[] {
  if (ring.length === 0) return [];
  return [...ring, ring[0]!];
}

/**
 * Signed shoelace area. Positive means counter-clockwise.
 */
export function signedArea(ring: readonly Vec2[]): number {
  let a2 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[i]!;
    const q = ring[j]!;
    a2 += q[0] * p[1] - p[0] * q[1];
  }
  return a2 / 2;
}

/**
 * The same ring, counter-clockwise. Extrusion depends on winding: a clockwise
 * ring produces a solid with negative volume, which the engine rejects. Every
 * ring handed to the `loop` recipe goes through here first.
 */
export function counterClockwise(ring: readonly Vec2[]): Vec2[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
}

export function polylineLength(ring: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i - 1]!;
    const q = ring[i]!;
    total += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return total;
}
