/**
 * Inference and snapping (task L1-6). Pure functions over candidate points, so
 * they are unit-testable without a renderer.
 *
 * The inference engine answers three questions for a cursor position:
 *   - which named points are near enough to snap to (vertex, midpoint, centre),
 *   - whether an axis lock is active,
 *   - what the snapped point is, plus the glyph to show next to the cursor.
 */

import type { Vec3 } from "./index.js";
import { distance, sub } from "./index.js";
import { snapVec } from "./units.js";

export type InferenceKind =
  | "vertex"
  | "midpoint"
  | "centre"
  | "quadrant"
  | "perpendicular"
  | "axis"
  | "on-face"
  | "on-edge"
  | "grid"
  | "none";

export interface InferenceGlyph {
  readonly kind: InferenceKind;
  /** Single character shown in the on-screen badge, SketchUp style. */
  readonly glyph: string;
  readonly label: string;
}

export const GLYPHS: Readonly<Record<InferenceKind, InferenceGlyph>> = {
  vertex: { kind: "vertex", glyph: "", label: "Endpoint" },
  midpoint: { kind: "midpoint", glyph: "", label: "Midpoint" },
  centre: { kind: "centre", glyph: "", label: "Centre" },
  quadrant: { kind: "quadrant", glyph: "", label: "Quadrant" },
  perpendicular: { kind: "perpendicular", glyph: "", label: "Perpendicular" },
  axis: { kind: "axis", glyph: "", label: "On axis" },
  "on-face": { kind: "on-face", glyph: "", label: "On face" },
  "on-edge": { kind: "on-edge", glyph: "", label: "On edge" },
  grid: { kind: "grid", glyph: "", label: "On grid" },
  none: { kind: "none", glyph: "", label: "" },
};

export interface SnapCandidate {
  readonly kind: InferenceKind;
  readonly point: Vec3;
  /** Unit normal of the face or edge the point lies on; absent for vertices. */
  readonly normal?: Vec3;
}

export interface InferenceInput {
  /** Unsnapeed cursor position on the active plane. */
  readonly cursor: Vec3;
  /** Points worth snapping to (edges' endpoints, face centres, origin). */
  readonly candidates: readonly SnapCandidate[];
  /** Modelscreen scale: mm per pixel, so the tolerance is constant on screen. */
  readonly mmPerPixel: number;
  /** Axis locked by Shift (or by a strong prior); null for free movement. */
  readonly axisLock?: Vec3 | null;
  /** Origin of a locked axis constraint through the last placed point. */
  readonly lockOrigin?: Vec3;
  /** Grid step for the ground plane; 0 disables grid snapping. */
  readonly gridStep?: number;
}

export interface InferenceResult {
  readonly point: Vec3;
  readonly glyph: InferenceGlyph;
  readonly snapped: boolean;
  /** Unit normal of the surface snapped to, when the hit came from a face. */
  readonly normal?: Vec3;
}

/** Screen-space snap radius in pixels, converted to mm by the caller. */
export const SNAP_PIXELS = 10;

export function infer(input: InferenceInput): InferenceResult {
  const { cursor, candidates, mmPerPixel } = input;
  const tolerance = Math.max(mmPerPixel * SNAP_PIXELS, 1e-4);

  let best: SnapCandidate | null = null;
  let bestD = tolerance;
  for (const c of candidates) {
    const d = distance(cursor, c.point);
    if (d <= bestD) {
      // Vertices beat midpoints beat centres at equal distance.
      if (best && rank(c.kind) >= rank(best.kind) && d > bestD * 0.999) continue;
      best = c;
      bestD = d;
    }
  }

  const lock = input.axisLock ?? null;
  const origin = input.lockOrigin ?? [0, 0, 0];

  if (lock) {
    const projected = projectOnAxis(cursor, origin, lock);
    if (best && distance(projected, best.point) <= tolerance) {
      return withNormal(best, { point: best.point, glyph: GLYPHS[best.kind], snapped: true });
    }
    return { point: withAxisLabel(projected, lock), glyph: GLYPHS.axis, snapped: true };
  }

  if (best) return withNormal(best, { point: best.point, glyph: GLYPHS[best.kind], snapped: true });

  const step = input.gridStep ?? 0;
  if (step > 0) {
    const g = snapVec(cursor, step);
    return { point: [g[0], g[1], cursor[2]], glyph: GLYPHS.grid, snapped: true };
  }
  return { point: cursor, glyph: GLYPHS.none, snapped: false };
}

function rank(kind: InferenceKind): number {
  // A named point beats an inferred one, and among named points the more
  // specific wins: an endpoint is a corner the user can see, a midpoint is
  // computed from it. Quadrants are the points of an arc or circle where a
  // dimension is easiest to read, so they beat a plain centre.
  return kind === "vertex"
    ? 4
    : kind === "midpoint" || kind === "perpendicular"
      ? 3
      : kind === "quadrant"
        ? 2
        : kind === "centre"
          ? 1
          : 0;
}

/** Foot of the perpendicular from `p` onto the ray `origin + taxis`. */
export function projectOnAxis(p: Vec3, origin: Vec3, axis: Vec3): Vec3 {
  const d = sub(p, origin);
  const len2 = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
  if (len2 < 1e-12) return p;
  const t = (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / len2;
  return [origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t];
}

/** Deterministic jitter-free rounding so a projected point compares cleanly. */
function withAxisLabel(p: Vec3, _axis: Vec3): Vec3 {
  const r = (n: number): number => Math.round(n * 1e6) / 1e6;
  return [r(p[0]), r(p[1]), r(p[2])];
}

/** Carry the snapped surface's normal through to the caller, when it has one. */
function withNormal(candidate: SnapCandidate, result: InferenceResult): InferenceResult {
  return candidate.normal ? { ...result, normal: candidate.normal } : result;
}

/**
 * Pick the axis for a Shift lock: the world axis closest to the movement vector.
 * Ties favour the earlier axis, so a diagonal keeps its first direction.
 */
export function bestAxis(from: Vec3, to: Vec3): Vec3 {
  const d = sub(to, from);
  const ax = Math.abs(d[0]);
  const ay = Math.abs(d[1]);
  const az = Math.abs(d[2]);
  if (az >= ax && az >= ay) return [0, 0, d[2] < 0 ? -1 : 1];
  if (ay >= ax) return [0, d[1] < 0 ? -1 : 1, 0];
  return [d[0] < 0 ? -1 : 1, 0, 0];
}

/** Midpoints of every edge of a flat triangle list; feeds `candidates`. */
export function edgeMidpoints(positions: Float32Array): readonly SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a: Vec3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!];
    const b: Vec3 = [positions[i + 3]!, positions[i + 4]!, positions[i + 5]!];
    const c: Vec3 = [positions[i + 6]!, positions[i + 7]!, positions[i + 8]!];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = `${p.join(",")}|${q.join(",")}`;
      const rkey = `${q.join(",")}|${p.join(",")}`;
      if (seen.has(key) || seen.has(rkey)) continue;
      seen.add(key);
      out.push({ kind: "midpoint", point: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] });
    }
  }
  return out;
}

/** Unique vertices of a flat triangle list; feeds `candidates`. */
export function vertices(positions: Float32Array): readonly SnapCandidate[] {
  const seen = new Set<string>();
  const out: SnapCandidate[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const key = `${positions[i]!.toFixed(4)},${positions[i + 1]!.toFixed(4)},${positions[i + 2]!.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "vertex", point: [positions[i]!, positions[i + 1]!, positions[i + 2]!] });
  }
  return out;
}

/**
 * Centres of every flat face in a flat triangle list, one per distinct plane.
 *
 * A box has six faces and a triangulated face has two triangles; both must yield
 * one centre, or the cursor would find two "Centre" points a few millimetres
 * apart and snap to whichever came first. Faces are keyed by their plane
 * (normal + offset), which is exact for the boxes and extrusions this app makes.
 */
export function faceCentres(positions: Float32Array): readonly SnapCandidate[] {
  interface Face {
    normal: Vec3;
    offset: number;
    sum: [number, number, number];
    count: number;
  }
  const faces = new Map<string, Face>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a: Vec3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!];
    const b: Vec3 = [positions[i + 3]!, positions[i + 4]!, positions[i + 5]!];
    const c: Vec3 = [positions[i + 6]!, positions[i + 7]!, positions[i + 8]!];
    const n = unit(triangleNormal(a, b, c));
    if (!n) continue;
    const offset = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    const key = `${n.map((v) => v.toFixed(3)).join(",")}|${offset.toFixed(3)}`;
    const face = faces.get(key);
    if (face) {
      face.count += 3;
      face.sum[0] += a[0] + b[0] + c[0];
      face.sum[1] += a[1] + b[1] + c[1];
      face.sum[2] += a[2] + b[2] + c[2];
    } else {
      faces.set(key, {
        normal: n,
        offset,
        sum: [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]],
        count: 3,
      });
    }
  }
  return [...faces.values()].map((f) => ({
    kind: "centre" as const,
    point: [f.sum[0] / f.count, f.sum[1] / f.count, f.sum[2] / f.count] as Vec3,
    normal: f.normal,
  }));
}

/**
 * Quadrant points of the model's bounding box: the four corners of the
 * footprint at the top and bottom, plus the mid-edge points of each side.
 *
 * These stand in for the quadrant points of arcs and circles, which this app
 * does not keep as entities: after a circle is drawn it is a mesh, and the only
 * meaningful "quadrant" left is the extreme of its bounds. That is exactly what
 * SketchUp uses a quadrant for, reading off a width or height.
 */
export function boundsQuadrants(min: Vec3, max: Vec3): readonly SnapCandidate[] {
  const xs = [min[0], (min[0] + max[0]) / 2, max[0]];
  const ys = [min[1], (min[1] + max[1]) / 2, max[1]];
  const zs = [min[2], max[2]];
  const out: SnapCandidate[] = [];
  for (const z of zs) {
    for (const [xi, yi] of [
      [0, 1],
      [2, 1],
      [1, 0],
      [1, 2],
    ] as const) {
      out.push({ kind: "quadrant", point: [xs[xi]!, ys[yi]!, z] });
    }
  }
  return out;
}

/**
 * The foot of the perpendicular from `from` to the nearest edge of a mesh.
 *
 * "Perpendicular" in SketchUp means: while drawing or moving from a point, the
 * cursor snaps to the place on an edge that makes a right angle with the line
 * you are drawing. Given the segments of the target mesh, this returns the
 * closest such foot within `tolerance`, or null.
 */
export function perpendicularFeet(
  from: Vec3,
  positions: Float32Array,
  tolerance: number,
): readonly SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const tri: readonly Vec3[] = [
      [positions[i]!, positions[i + 1]!, positions[i + 2]!],
      [positions[i + 3]!, positions[i + 4]!, positions[i + 5]!],
      [positions[i + 6]!, positions[i + 7]!, positions[i + 8]!],
    ];
    for (let e = 0; e < 3; e++) {
      const p = tri[e]!;
      const q = tri[(e + 1) % 3]!;
      const foot = footOnSegment(from, p, q);
      if (distance(foot, from) > tolerance) continue;
      const key = `${foot.map((v) => v.toFixed(3)).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "perpendicular", point: foot });
    }
  }
  return out;
}

/** Closest point to `from` on segment `p`-`q`, clamped to the segment. */
export function footOnSegment(from: Vec3, p: Vec3, q: Vec3): Vec3 {
  const d = sub(q, p);
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (len2 < 1e-12) return p;
  const t = ((from[0] - p[0]) * d[0] + (from[1] - p[1]) * d[1] + (from[2] - p[2]) * d[2]) / len2;
  const clamped = Math.max(0, Math.min(1, t));
  return [p[0] + d[0] * clamped, p[1] + d[1] * clamped, p[2] + d[2] * clamped];
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}
