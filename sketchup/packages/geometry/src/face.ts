/**
 * Flat faces: a closed ring in a plane, triangulated into a single-sided
 * surface. Pure; no kernel needed.
 *
 * Lives outside index.ts so the dependency runs one way only:
 * face.ts -> index.ts and face.ts -> polygon.ts, never back. It used to sit in
 * index.ts, which made polygon.ts and index.ts a value cycle.
 */

import { normalize, polygonArea, type MeshData, type Vec2, type Vec3 } from "./index.js";
import { cleanRing, planeAxes, triangulateRing } from "./polygon.js";

/**
 * A flat face: a closed ring triangulated in its own plane.
 *
 * A face is a first-class thing in this app — the rectangle tool makes one and
 * push/pull turns it into a solid — but for one cycle it was not in the document
 * model, so a face had to be a 10 mm-thick `loop` extrusion wearing a "Face" name.
 * That made every face a hidden solid: a BOQ counted it, the fit solver measured
 * it, and a DXF import came back as a forest of slabs. This type is the honest
 * one: zero volume, a real surface, still resolvable to a mesh for picking.
 */
export interface Face2D {
  /** Closed ring, counter-clockwise in the plane's own (u, v) axes. */
  readonly points: readonly Vec2[];
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3 };
}

/**
 * Triangulate a face into a single-sided surface in world space.
 *
 * Index contract: `indices` index the returned `positions`, which is
 * `face.points` after `cleanRing` dropped duplicates and any closing point. A
 * ring already clean therefore maps one to one.
 *
 * Winding: `triangulateRing` returns triangles counter-clockwise in the (u, v)
 * frame and `planeAxes` builds that frame with `v = n x u`, so the triplets are
 * already counter-clockwise seen from `+normal`. No reversal here: a ring passed
 * clockwise is flipped inside `triangulateRing`, so every face ends up lit from
 * its `+normal` side.
 */
export function faceMesh(face: Face2D): MeshData {
  const ring = cleanRing(face.points);
  if (ring.length < 3) throw new RangeError("a face needs at least three distinct points");
  if (polygonArea(ring) < 1e-9) throw new RangeError("face has zero area");
  const tris = triangulateRing(ring);
  if (tris.length < 3) throw new RangeError("face could not be triangulated (self-intersecting?)");

  const n = normalize(face.plane.normal);
  const { u, v } = planeAxes(ring, n);
  const positions: number[] = [];
  for (const p of ring) {
    positions.push(
      face.plane.origin[0] + u[0] * p[0] + v[0] * p[1],
      face.plane.origin[1] + u[1] * p[0] + v[1] * p[1],
      face.plane.origin[2] + u[2] * p[0] + v[2] * p[1],
    );
  }

  // triangulateRing indexes into ring, which is the list those positions were
  // emitted from, so its indices address this mesh as-is. The check is a guard
  // against a future change to triangulateRing, not a fix-up.
  const vertexCount = positions.length / 3;
  for (const i of tris) {
    if (!Number.isInteger(i) || i < 0 || i >= vertexCount) {
      throw new RangeError("face triangulation returned an out-of-range index");
    }
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(tris) };
}
