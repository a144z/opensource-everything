/**
 * Presenting the document to callers: derived views and small converters that
 * the tests and the app both use. Nothing here mutates.
 */

import { fitsIn, type Aabb, type MeshData } from "@apexus/geometry";
import { analyseMesh, recipeMesh, type SolidGeometry } from "./analyze.js";
import { checkFit, type FitResult } from "./fit.js";
import type { DocumentState, Solid, SolidRecipe } from "./types.js";

export function analyzeSolid(
  solid: Solid,
  resolve: (recipe: SolidRecipe) => MeshData = recipeMesh,
): SolidGeometry {
  return analyseMesh(resolve(solid.recipe));
}

/** The document's own fit verdict, recomputed from scratch (no cache). */
export function checkDocumentFit(doc: DocumentState, resolve: (recipe: SolidRecipe) => MeshData = recipeMesh): FitResult {
  const bounds = new Map<string, Aabb>();
  for (const solid of doc.solids.values()) {
    if (solid.meta.hidden) continue;
    bounds.set(solid.id, analyseMesh(resolve(solid.recipe)).bounds);
  }
  return checkFit(bounds, doc.envelope);
}

/** Union of the visible solids' bounds, for the outliner and gizmo. */
export function documentBounds(
  doc: DocumentState,
  resolve: (recipe: SolidRecipe) => import("@apexus/geometry").MeshData,
): import("@apexus/geometry").Aabb {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const solid of doc.solids.values()) {
    if (solid.meta.hidden) continue;
    const b = analyseMesh(resolve(solid.recipe)).bounds;
    min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[1]), Math.min(min[2], b.min[2])];
    max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[1]), Math.max(max[2], b.max[2])];
  }
  return { min, max };
}

/** Solid ids sticking out of the envelope. Empty when there is no envelope. */
export function failures(
  doc: DocumentState,
  resolve: (recipe: SolidRecipe) => import("@apexus/geometry").MeshData,
): Set<string> {
  const out = new Set<string>();
  if (!doc.envelope) return out;
  const box = { min: doc.envelope.min, max: doc.envelope.max };
  for (const solid of doc.solids.values()) {
    if (solid.meta.hidden) continue;
    if (!fitsIn(analyseMesh(resolve(solid.recipe)).bounds, box)) out.add(solid.id);
  }
  return out;
}
