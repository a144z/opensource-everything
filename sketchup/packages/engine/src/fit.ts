/** Fit check (docs/07-fit-check-spec.md). Pure, cached by the session. */

import { fitsIn, overshoot, unionAabb, type Aabb, type Vec3 } from "@apexus/geometry";
import { analyseMesh, recipeMesh } from "./analyze.js";
import type { DocumentState, Envelope, Solid, SolidId, SolidMeta, SolidRecipe } from "./types.js";
import { FIT_TOLERANCE } from "./types.js";
import { EMPTY_BOUNDS, isFiniteBounds } from "./analyze.js";

export type FitAxis = "x" | "y" | "z";

export interface FitResult {
  readonly pass: boolean;
  readonly envelope: Envelope | null;
  readonly bounds: Aabb;
  /** Per-axis overshoot in mm; 0 when inside. */
  readonly overshoot: Readonly<Record<FitAxis, number>>;
  readonly worst: { readonly axis: FitAxis; readonly mm: number } | null;
  /** Solids that stick out of the envelope. Empty when there is no envelope. */
  readonly offenders: readonly string[];
}

const AXES: readonly FitAxis[] = ["x", "y", "z"];

export function emptyFit(): FitResult {
  return {
    pass: true,
    envelope: null,
    bounds: EMPTY_BOUNDS,
    overshoot: { x: 0, y: 0, z: 0 },
    worst: null,
    offenders: [],
  };
}

/** Union of the bounds of every counted solid (per-id map, hidden ones excluded). */
export function unionBounds(boundsById: ReadonlyMap<string, Aabb>): Aabb {
  let box = EMPTY_BOUNDS;
  for (const b of boundsById.values()) box = unionAabb(box, b);
  return box;
}

export function checkFit(
  input: ReadonlyMap<string, Aabb> | DocumentState,
  envelopeOrResolve: Envelope | null | ((recipe: SolidRecipe) => import("@apexus/geometry").MeshData),
): FitResult {
  // Two call forms: cached-fit style (map of bounds), and document style
  // `checkFit(doc)` / `checkFit(doc, resolve)` for tests and the report paths.
  let boundsById: ReadonlyMap<string, Aabb>;
  let envelope: Envelope | null;
  if (input instanceof Map || !("solids" in input)) {
    boundsById = input as ReadonlyMap<string, Aabb>;
    envelope = (envelopeOrResolve as Envelope | null) ?? null;
  } else {
    const doc = input;
    const resolve = (typeof envelopeOrResolve === "function" ? envelopeOrResolve : recipeMesh);
    const map = new Map<string, Aabb>();
    for (const solid of doc.solids.values()) {
      if (solid.meta.hidden) continue;
      map.set(solid.id, analyseMesh(resolve(solid.recipe)).bounds);
    }
    boundsById = map;
    envelope = doc.envelope;
  }
  const bounds = unionBounds(boundsById);
  if (!envelope) return { ...emptyFit(), bounds };
  const box: Aabb = { min: envelope.min, max: envelope.max };
  const over = overshoot(bounds, box);
  const pass = fitsIn(bounds, box);
  const offenders: string[] = [];
  for (const [id, b] of boundsById) if (!fitsIn(b, box)) offenders.push(id);
  let worst: FitResult["worst"] = null;
  if (!pass) {
    let idx = 0;
    if (over[1] > over[idx]!) idx = 1;
    if (over[2] > over[idx]!) idx = 2;
    worst = { axis: AXES[idx]!, mm: Number(over[idx]!.toFixed(3)) };
  }
  return {
    pass,
    envelope,
    bounds,
    overshoot: {
      x: Number(over[0].toFixed(3)),
      y: Number(over[1].toFixed(3)),
      z: Number(over[2].toFixed(3)),
    },
    worst,
    offenders,
  };
}

export interface ScaleSuggestion {
  /** Factors <= 1 for each axis; 1 means already inside on that axis. */
  readonly factors: Vec3;
  /** Uniform factor, the smallest of the three. */
  readonly uniform: number;
  readonly needed: boolean;
}

/** Smallest scale that brings `bounds` inside `envelope`, anchored at the min corner. */
export function suggestScale(bounds: Aabb, envelope: Envelope | null): ScaleSuggestion {
  if (!envelope || !isFiniteBounds(bounds)) return { factors: [1, 1, 1], uniform: 1, needed: false };
  const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const room = [
    envelope.max[0] - envelope.min[0],
    envelope.max[1] - envelope.min[1],
    envelope.max[2] - envelope.min[2],
  ];
  const axis = (i: number): number => {
    const s = size[i]!;
    if (s <= FIT_TOLERANCE) return 1;
    return Math.min(1, room[i]! / s);
  };
  const factors: Vec3 = [axis(0), axis(1), axis(2)];
  const uniform = Math.min(factors[0], factors[1], factors[2]);
  return { factors, uniform, needed: uniform < 1 - 1e-6 };
}

/**
 * Clearance between two boxes: the smallest separating distance along any axis.
 * Negative means they overlap by that much.
 */
export function clearance(a: Aabb, b: Aabb): number {
  const gaps = [
    Math.max(b.min[0] - a.max[0], a.min[0] - b.max[0]),
    Math.max(b.min[1] - a.max[1], a.min[1] - b.max[1]),
    Math.max(b.min[2] - a.max[2], a.min[2] - b.max[2]),
  ];
  return Math.max(...gaps);
}

export function collides(a: Aabb, b: Aabb): boolean {
  return clearance(a, b) < -FIT_TOLERANCE;
}
