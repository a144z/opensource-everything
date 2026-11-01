/**
 * Offset: the same closed ring, pushed in (inset) or out (outset) by a
 * distance, mitred at the corners like SketchUp's Offset tool.
 *
 * Pure: no DOM, no kernel. The tool only needs to answer "where does the new
 * ring go, or why can't it exist", so the whole thing is one function with an
 * honest refusal instead of a silently bent ring.
 */

import type { Vec2 } from "./index.js";
import { cleanRing, ringIsCcw } from "./polygon.js";
import { signedArea } from "./rings.js";

/**
 * Longest miter spike allowed, as a multiple of |d|. SketchUp caps its miters
 * here; past it a sharp corner would shoot a needle tens of units into the
 * drawing, so the joint becomes a bevel instead.
 */
export const MAX_MITER = 10;

/** Result of offsetting a closed ring: the new ring, or why it cannot be made. */
export type OffsetResult =
  | { readonly ok: true; readonly points: Vec2[] }
  | { readonly ok: false; readonly reason: "collapsed" | "self-intersect" | "too-short" };

/** Two-dimensional cross product: positive when `b` is left of `a`. */
function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * Half-open even-odd containment: an edge owns its lower-y endpoint and its
 * left-x edge, so a point on a vertex or wall is counted once, not twice.
 * Offsetting parks many points exactly on old edge lines, so a nudge-based
 * test would flip its answer there. Crossing is decided by signed areas, not
 * by dividing y-intercepts, which keeps exact points exact.
 */
function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const up = a[1] <= p[1] && p[1] < b[1];
    const down = b[1] <= p[1] && p[1] < a[1];
    if (!up && !down) continue;
    // a -> b passes right of p iff p is left of a -> b (CCW ring).
    const left = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (up ? left > 0 : left < 0) inside = !inside;
  }
  return inside;
}

interface Seg {
  readonly a: Vec2;
  readonly b: Vec2;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return cross2(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
}

/** The points of `s` and `t` coincide, so a crossing there is a shared vertex, not an overlap. */
function sharesEndpoint(s: Seg, t: Seg): boolean {
  const same = (p: Vec2, q: Vec2): boolean =>
    Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  return (
    same(s.a, t.a) || same(s.a, t.b) || same(s.b, t.a) || same(s.b, t.b)
  );
}

/**
 * Proper segment crossing: each segment's endpoints straddle the other's
 * line, and the crossing falls strictly inside both segments, not merely
 * somewhere on the supporting line. Continuations of one another (a vertex
 * corner whose two rays leave and never meet again) therefore do not count.
 */
function crosses(s: Seg, t: Seg): boolean {
  if (sharesEndpoint(s, t)) return false;
  const d1 = orient(t.a, t.b, s.a);
  const d2 = orient(t.a, t.b, s.b);
  const d3 = orient(s.a, s.b, t.a);
  const d4 = orient(s.a, s.b, t.b);
  if (!((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12))) return false;
  if (!((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))) return false;
  // Parametric position of t.a along s and s.a along t, both in (0, 1).
  const sLen2 = (s.b[0] - s.a[0]) ** 2 + (s.b[1] - s.a[1]) ** 2;
  const tLen2 = (t.b[0] - t.a[0]) ** 2 + (t.b[1] - t.a[1]) ** 2;
  const u = ((t.a[0] - s.a[0]) * (s.b[0] - s.a[0]) + (t.a[1] - s.a[1]) * (s.b[1] - s.a[1])) / sLen2;
  const v = ((s.a[0] - t.a[0]) * (t.b[0] - t.a[0]) + (s.a[1] - t.a[1]) * (t.b[1] - t.a[1])) / tLen2;
  return u > 1e-9 && u < 1 - 1e-9 && v > 1e-9 && v < 1 - 1e-9;
}

/** Every non-adjacent pair of edges of a ring crosses properly. */
function hasSelfIntersection(ring: readonly Vec2[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const s: Seg = { a: ring[i]!, b: ring[(i + 1) % n]! };
    for (let j = i + 1; j < n; j++) {
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const t: Seg = { a: ring[j]!, b: ring[(j + 1) % n]! };
      if (crosses(s, t)) return true;
    }
  }
  return false;
}

/** Total edge length of a closed ring. */
function perimeter(ring: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    total += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return total;
}

/** Kill float dust below 1e-9 mm so exact inputs give exact square corners. */
function snap(p: Vec2): Vec2 {
  const tidy = (v: number): number => {
    const r = Math.round(v * 1e9) / 1e9;
    return Math.abs(v - r) < 1e-9 ? r : v;
  };
  return [tidy(p[0]), tidy(p[1])];
}

/**
 * One joint of the offset ring: where the two offset edges meet. A mitred
 * corner is a single point; a bevelled one is the two offset edge ends, so the
 * `points` array may be longer than the input ring.
 */
function joint(
  prev: Vec2,
  corner: Vec2,
  next: Vec2,
  normalIn: Vec2,
  normalOut: Vec2,
  d: number,
): Vec2[] {
  // Offset copies of the incoming and outgoing edges.
  const p0: Vec2 = [prev[0] + normalIn[0] * d, prev[1] + normalIn[1] * d];
  const c0: Vec2 = [corner[0] + normalIn[0] * d, corner[1] + normalIn[1] * d];
  const c1: Vec2 = [corner[0] + normalOut[0] * d, corner[1] + normalOut[1] * d];
  const p2: Vec2 = [next[0] + normalOut[0] * d, next[1] + normalOut[1] * d];

  // Directions back along the incoming edge and on along the outgoing one,
  // from the corner's own offset points. A ray run all the way to the far end
  // of its edge would let one spike throw every miter on the shape outside
  // 10 x |d|, so the explicit miter test below replaces it.
  const cap = MAX_MITER * Math.abs(d);
  const uLen = Math.hypot(p0[0] - c0[0], p0[1] - c0[1]);
  const vLen = Math.hypot(p2[0] - c1[0], p2[1] - c1[1]);
  const ux = (p0[0] - c0[0]) / uLen;
  const uy = (p0[1] - c0[1]) / uLen;
  const vx = (p2[0] - c1[0]) / vLen;
  const vy = (p2[1] - c1[1]) / vLen;
  const denom = cross2(ux, uy, vx, vy);
  const straight = Math.abs(denom) < 1e-9;

  const shift = Math.hypot(c0[0] - corner[0], c0[1] - corner[1]);
  // Miter length along the bisector is |d| / sin(theta/2), where theta is the
  // angle between the two offset edges. With unit edge directions u and v,
  // |u x v| = |sin theta| and |u + v| = 2 cos(theta/2), so
  // |d| / sin(theta/2) = |d| * |u + v| / |u x v| exactly.
  // A straight joint has no spike: its offset edges already meet at c0.
  const miter = straight
    ? 0
    : (shift * Math.hypot(vx + ux, vy + uy)) / Math.abs(denom);
  // SketchUp caps its miters at MAX_MITER * |d| from the corner; past that the
  // needle would shoot visibly into the drawing, so the joint becomes a bevel.
  const bevelled = shift > 0 && miter > MAX_MITER * shift * (1 + 1e-9);

  if (bevelled) {
    // Cut each offset edge back to where it reaches 10 x |d| from the corner:
    // a flat chamfer across the apex. Each offset point sits `shift` from the
    // corner perpendicular to its own edge, so the chord along the edge is
    // sqrt(cap^2 - shift^2), and clamping to the edge length keeps a tiny
    // edge from being cut past its far end.
    const chord = Math.sqrt(Math.max(0, cap * cap - shift * shift));
    const uCut = Math.min(uLen, chord);
    const vCut = Math.min(vLen, chord);
    return [
      snap([c0[0] + ux * uCut, c0[1] + uy * uCut]),
      snap([c1[0] + vx * vCut, c1[1] + vy * vCut]),
    ];
  }

  // Intersect the two offset lines (p0 + t*u with c1 + s*v).
  const t = cross2(c1[0] - p0[0], c1[1] - p0[1], vx, vy) / denom;
  const hit: Vec2 = [p0[0] + ux * t, p0[1] + uy * t];
  // Square corners land on whole numbers in d*0/d*1; keep them exact rather
  // than leaving -1e-14 and 110.00000000000001 in the model.
  return [snap(hit)];
}

/** Offset a ring known to be counter-clockwise. `d < 0` insets. */
function offsetCcw(ring: readonly Vec2[], d: number): Vec2[] {
  const n = ring.length;
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    // Left normal points into a CCW ring; scaling by d hands outwards for d<0.
    normals.push(len < 1e-12 ? [0, 0] : [ey / len, -ex / len]);
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prevN = normals[(i + n - 1) % n]!;
    const curN = normals[i]!;
    // A vertex with a zero-length neighbour edge has no normal; reuse the other side.
    const nIn: Vec2 = prevN[0] === 0 && prevN[1] === 0 ? curN : prevN;
    const nOut: Vec2 = curN[0] === 0 && curN[1] === 0 ? nIn : curN;
    out.push(...joint(ring[(i + n - 1) % n]!, ring[i]!, ring[(i + 1) % n]!, nIn, nOut, d));
  }
  return out;
}

/**
 * Inset (d < 0) or outset (d > 0) of a closed 2D ring by `d` millimetres,
 * mitred at the corners, as SketchUp's Offset tool does.
 *
 * `points` is a closed ring without a repeated closing point; the output keeps
 * the input's winding, so callers can chain offsets and still extrude the way
 * they expected.
 */
export function offsetRing(points: readonly Vec2[], d: number): OffsetResult {
  const ring = cleanRing(points);
  if (ring.length < 3) return { ok: false, reason: "too-short" };
  const areaIn = signedArea(ring);
  // A ring with no area has no inside to offset toward.
  if (!Number.isFinite(areaIn) || Math.abs(areaIn) < 1e-9) {
    return { ok: false, reason: "collapsed" };
  }
  // Zero distance is the ring itself; handing back the cleaned copy keeps the
  // caller free to compare without worrying about the closing point.
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return { ok: true, points: ring };

  const ccw = ringIsCcw(ring);
  const work = ccw ? ring : [...ring].reverse();
  const raw = offsetCcw(work, d);
  const out = cleanRing(ccw ? raw : [...raw].reverse());

  if (out.length < 3) return { ok: false, reason: "collapsed" };

  // Collapse is decided geometrically: every inset vertex must stay |d| from
  // the walls it faces, then area and winding must survive the move.
  if (d < 0 && pastOwnWalls(work, out, d)) return { ok: false, reason: "collapsed" };

  const areaOut = signedArea(out);
  if (Math.abs(areaOut) < 1e-6) return { ok: false, reason: "collapsed" };
  if (Math.sign(areaOut) !== Math.sign(areaIn)) return { ok: false, reason: "collapsed" };

  if (hasSelfIntersection(out)) return { ok: false, reason: "self-intersect" };
  return { ok: true, points: out };
}

/**
 * Every inset vertex must sit at least |d| from both of its original walls.
 * An inset keeps every wall at exactly |d| from the new edge, so a vertex
 * closer than that has been pushed past a wall: the walls have crossed and
 * the ring has folded through itself. This is exact for any corner angle —
 * obtuse corners travel far along their bisector and are still legal — and it
 * is what refuses both a too-deep inset and a spike whose bevel closed up.
 */
function pastOwnWalls(ring: readonly Vec2[], out: readonly Vec2[], d: number): boolean {
  const n = ring.length;
  const near = Math.abs(d) - 1e-6 * Math.max(1, Math.abs(d));
  // Offset edges lie exactly on the wall lines, so each output point must be
  // at least |d| from every non-adjacent wall; testing all walls is simpler
  // than matching bevel points back to their joint and is never wrong.
  for (const p of out) {
    for (let k = 0; k < n; k++) {
      const a = ring[k]!;
      const b = ring[(k + 1) % n]!;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-12) continue;
      // Perpendicular distance to the wall's line, plus the "past its end"
      // part: a vertex beyond a wall's end has crossed that wall's corner.
      const off = Math.abs(cross2(ex, ey, p[0] - a[0], p[1] - a[1])) / len;
      const along = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (len * len);
      if (along < -1e-9 || along > 1 + 1e-9) continue;
      if (off < near) return true;
    }
  }
  return false;
}

