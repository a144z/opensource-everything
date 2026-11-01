/**
 * Edges: a run of points in a plane, drawn as segments.
 *
 * The line tool's unclosed chain is real geometry in SketchUp, not a thrown-away
 * sketch, and it is what every later click snaps to. It has no volume and no
 * area, so it cannot be a `loop` (an extrusion) or a `face` (a surface): it is
 * its own kind, with a mesh of degenerate pairs so picking, bounds and snapping
 * all work on it unchanged.
 *
 * Lives beside face.ts and depends the same way: edges.ts -> index.ts and
 * edges.ts -> polygon.ts, never back.
 */

import { normalize, type MeshData, type Vec2, type Vec3 } from "./index.js";
import { planeAxes } from "./polygon.js";

/** Points in a plane's own (u, v) axes, one segment per consecutive pair. */
export interface EdgePath {
  readonly points: readonly Vec2[];
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3 };
}

/**
 * The vertices of an edge path, in world space.
 *
 * A point collapses on its neighbour (a zero-length segment) is dropped: the
 * user clicked twice without moving, and an edge with no length would sit in the
 * pick list forever. Fewer than two left is not an edge and throws.
 */
export function edgePositions(path: EdgePath): Vec3[] {
  const n = normalize(path.plane.normal);
  const { u, v } = planeAxes(path.points, n);
  const out: Vec3[] = [];
  for (const p of path.points) {
    const world: Vec3 = [
      path.plane.origin[0] + u[0] * p[0] + v[0] * p[1],
      path.plane.origin[1] + u[1] * p[0] + v[1] * p[1],
      path.plane.origin[2] + u[2] * p[0] + v[2] * p[1],
    ];
    const last = out[out.length - 1];
    if (last && Math.hypot(world[0] - last[0], world[1] - last[1], world[2] - last[2]) < 1e-6) continue;
    out.push(world);
  }
  if (out.length < 2) throw new RangeError("an edge needs two distinct points");
  return out;
}

/**
 * Mesh an edge path for picking and bounds.
 *
 * One degenerate triangle per segment, wound the same way twice, so every edge
 * reaches the renderer's line pass and nothing reaches the volume rules: an
 * edge has no surface, and a nonzero `volume` would let a BOQ count it.
 */
export function edgesMesh(path: EdgePath): MeshData {
  const pts = edgePositions(path);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const p of pts) positions.push(p[0], p[1], p[2]);
  for (let i = 0; i + 1 < pts.length; i++) indices.push(i, i + 1, i);
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) };
}
