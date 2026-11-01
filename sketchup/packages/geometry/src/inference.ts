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

export type InferenceKind = "vertex" | "midpoint" | "centre" | "axis" | "on-face" | "grid" | "none";

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
  axis: { kind: "axis", glyph: "", label: "On axis" },
  "on-face": { kind: "on-face", glyph: "", label: "On face" },
  grid: { kind: "grid", glyph: "", label: "On grid" },
  none: { kind: "none", glyph: "", label: "" },
};

export interface SnapCandidate {
  readonly kind: InferenceKind;
  readonly point: Vec3;
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
      return { point: best.point, glyph: GLYPHS[best.kind], snapped: true };
    }
    return { point: withAxisLabel(projected, lock), glyph: GLYPHS.axis, snapped: true };
  }

  if (best) return { point: best.point, glyph: GLYPHS[best.kind], snapped: true };

  const step = input.gridStep ?? 0;
  if (step > 0) {
    const g = snapVec(cursor, step);
    return { point: [g[0], g[1], cursor[2]], glyph: GLYPHS.grid, snapped: true };
  }
  return { point: cursor, glyph: GLYPHS.none, snapped: false };
}

function rank(kind: InferenceKind): number {
  return kind === "vertex" ? 3 : kind === "midpoint" ? 2 : kind === "centre" ? 1 : 0;
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
