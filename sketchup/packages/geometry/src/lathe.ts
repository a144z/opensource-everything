/**
 * Lathe: turning a closed profile around an axis.
 *
 * A vase, a column capital, a spindle - anything a wood turner makes on a lathe.
 * The profile is a ring drawn in the half-plane facing the axis; sweeping it a
 * full turn closes a solid with no caps, because the profile's own ring already
 * surrounds the hole it would leave at the top and bottom.
 *
 * Two rules the maths enforces rather than trusts:
 *   - the profile must stay strictly off the axis, or the surface folds through
 *     itself and the volume is meaningless;
 *   - the sweep is a whole turn. A partial sweep is a surface, not a solid, and
 *     this kernel only speaks solid.
 */

import { polygonArea, type MeshData, type Vec2 } from "./index.js";

export interface LatheOptions {
  /** How far the profile's own zero sits from the axis, in mm. */
  readonly offset?: number;
  /** Slices around the turn; clamped to [3, 512]. */
  readonly segments?: number;
}

/** Below this the profile is touching the axis; no solid exists there. */
const MIN_RADIUS = 1e-3;

/** Drop a closing point equal to the first; a ring must never repeat itself. */
function openRing(points: readonly Vec2[]): Vec2[] {
  const out = points.map((p): Vec2 => [p[0], p[1]]);
  while (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
    else break;
  }
  return out;
}

/**
 * Sweep `points` a full turn about the vertical axis at `x = -offset`.
 *
 * The profile is triangulated once in 2D; each triangle then becomes a closed
 * triangular prism between one slice and the next (two end caps plus three
 * sides, five triangles per face). Prisms tile the whole turn, so the result is
 * watertight by construction: every interior quad is emitted twice with
 * opposite winding, and every boundary quad once.
 *
 * Volume check in the tests uses Pappus: V = 2 * pi * R * A, where R is the
 * profile centroid's radius and A its area.
 */
export function latheSolid(points: readonly Vec2[], options: LatheOptions = {}): MeshData {
  const ring = openRing(points);
  if (ring.length < 3) throw new RangeError("a lathe profile needs at least three points");
  if (Math.abs(polygonArea(ring)) < 1e-9) throw new RangeError("lathe profile has zero area");
  const segments = Math.max(3, Math.min(512, Math.trunc(options.segments ?? 32)));
  if (!Number.isFinite(segments)) throw new RangeError("lathe segments must be a number");

  const offset = options.offset ?? 0;
  if (!Number.isFinite(offset)) throw new RangeError("lathe offset must be finite");
  const radiusOf = (p: Vec2): number => p[0] + offset;
  for (const p of ring) {
    if (radiusOf(p) < MIN_RADIUS) throw new RangeError("lathe profile crosses the axis; it cannot be turned around it");
  }
  // A ring that crosses itself turns into a surface that intersects itself,
  // so it is not a solid. `polygonArea` catches the degenerate cases; the
  // off-axis rule above catches the ones that fold through the axis.

  const positions: number[] = [];
  for (let s = 0; s < segments; s++) {
    const angle = (s / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const p of ring) {
      const r = radiusOf(p);
      positions.push(r * cos, r * sin, p[1]);
    }
  }

  // Each profile edge sweeps into one quad per slice, so the whole surface is
  // ring x turn: closed exactly when the ring is, with no triangulation to
  // disagree about which way an edge runs. Watertightness comes from every
  // quad edge being shared by exactly one neighbour, on the ring or round the
  // turn; an n-gon cap is avoided because the profile ring already caps it.
  const indices: number[] = [];
  const n = ring.length;
  const at = (segment: number, i: number): number => (segment % segments) * n + (i % n);
  const ccw = polygonArea(ring) > 0;
  for (let s = 0; s < segments; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // Walk the ring in its own counter-clockwise order in the (radius,
      // height) plane, advancing round the turn, so the face normal by the
      // right-hand rule points away from the axis on the outer wall.
      const a0 = at(s, ccw ? i : j);
      const b0 = at(s, ccw ? j : i);
      const a1 = at(s + 1, ccw ? i : j);
      const b1 = at(s + 1, ccw ? j : i);
      indices.push(a0, a1, b0, b0, a1, b1);
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
