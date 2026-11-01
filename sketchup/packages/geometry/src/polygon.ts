/**
 * Polygon handling: 2D rings -> triangles, and closed-loop extrusion in an
 * arbitrary plane. Pure; no kernel needed.
 *
 * shortcut: concavity is handled by ear clipping (O(n^2) on the ring). Rings are
 * user-drawn loops of tens of points, so upgrade only if a profile ever has
 * thousands of points.
 */

import { cross, dot, normalize, polygonArea, type MeshData, type Vec2, type Vec3 } from "./index.js";

export interface Plane {
  readonly origin: Vec3;
  readonly normal: Vec3;
}

/** Signed area sign of a ring; positive = counter-clockwise in (u, v). */
export function ringIsCcw(points: readonly Vec2[]): boolean {
  let a2 = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const p = points[i]!;
    const q = points[j]!;
    a2 += (q[0] + p[0]) * (q[1] - p[1]);
  }
  return a2 < 0;
}

/** Drop consecutive duplicates and a closing point equal to the first. */
export function cleanRing(points: readonly Vec2[], eps = 1e-6): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < eps && Math.abs(last[1] - p[1]) < eps) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(first[0] - last[0]) < eps && Math.abs(first[1] - last[1]) < eps) out.pop();
    else break;
  }
  return out;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple ring. Returns index triples wound
 * counter-clockwise in the ring's own 2D frame.
 */
export function triangulateRing(points: readonly Vec2[]): number[] {
  const ring = cleanRing(points);
  const n = ring.length;
  if (n < 3) return [];
  const idx = [...ring.keys()];
  if (!ringIsCcw(ring)) idx.reverse();
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n * 2) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length]!;
      const i1 = idx[i]!;
      const i2 = idx[(i + 1) % idx.length]!;
      const a = ring[i0]!;
      const b = ring[i1]!;
      const c = ring[i2]!;
      const convex = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
      if (!convex) continue;
      let contains = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(ring[j]!, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // self-intersecting ring: emit what we have, caller checks volume
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

/** Orthonormal in-plane axes: u along the first ring edge, v = n x u. */
export function planeAxes(points: readonly Vec2[], normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal);
  let u: Vec3 = [1, 0, 0];
  for (let i = 0; i < points.length && points.length > 1; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], 0];
    if (Math.hypot(d[0], d[1]) > 1e-9) {
      u = normalize(d);
      break;
    }
  }
  if (Math.abs(dot(u, n)) > 0.999) u = normalize(cross(n, [0, 1, 0]));
  const v = normalize(cross(n, u));
  return { u, v };
}

/**
 * Closed watertight solid from a ring in a plane, extruded `distance` along the
 * plane normal (positive along normal). Caps are ear-clipped; sides are quads.
 */
export function extrudeLoop(points: readonly Vec2[], plane: Plane, distance: number): MeshData {
  if (!(Number.isFinite(distance) && distance > 0)) throw new RangeError("extrusion distance must be positive");
  const ring = cleanRing(points);
  if (ring.length < 3) throw new RangeError("a loop needs at least three distinct points");
  if (polygonArea(ring) < 1e-9) throw new RangeError("loop has zero area");
  const tris = triangulateRing(ring);
  if (tris.length < 3) throw new RangeError("loop could not be triangulated (self-intersecting?)");

  const n = normalize(plane.normal);
  const { u, v } = planeAxes(ring, n);
  const toWorld = (p: Vec2, h: number): Vec3 => [
    plane.origin[0] + u[0] * p[0] + v[0] * p[1] + n[0] * h,
    plane.origin[1] + u[1] * p[0] + v[1] * p[1] + n[1] * h,
    plane.origin[2] + u[2] * p[0] + v[2] * p[1] + n[2] * h,
  ];

  const positions: number[] = [];
  const bottom: number[] = [];
  const top: number[] = [];
  for (const p of ring) {
    const w = toWorld(p, 0);
    positions.push(w[0], w[1], w[2]);
    bottom.push(positions.length / 3 - 1);
  }
  for (const p of ring) {
    const w = toWorld(p, distance);
    positions.push(w[0], w[1], w[2]);
    top.push(positions.length / 3 - 1);
  }

  const indices: number[] = [];
  // Bottom cap: triangles of the ring, wound clockwise when seen from +normal.
  for (let i = 0; i < tris.length; i += 3) {
    indices.push(bottom[tris[i]!]!, bottom[tris[i + 2]!]!, bottom[tris[i + 1]!]!);
  }
  // Top cap: same triangles, wound outward along +normal.
  for (let i = 0; i < tris.length; i += 3) {
    indices.push(top[tris[i]!]!, top[tris[i + 1]!]!, top[tris[i + 2]!]!);
  }
  // Sides.
  const count = ring.length;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const b0 = bottom[i]!;
    const b1 = bottom[j]!;
    const t0 = top[i]!;
    const t1 = top[j]!;
    indices.push(b0, b1, t1, b0, t1, t0);
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Planar polygon area in mm^2 for display. */
export function loopArea(points: readonly Vec2[]): number {
  return polygonArea(cleanRing(points));
}
