/**
 * Recipe -> mesh. Standalone kinds are pure; transform/boolean/mesh kinds need
 * the document (their children, or the kernel) and are resolved by the session.
 */

import {
  aabbFromPoints,
  createBox,
  extrudeLoop,
  extrudeRect,
  faceMesh,
  hashMesh,
  isClosedMesh,
  latheSolid,
  meshVolume,
  type Aabb,
  type MeshData,
  type Vec3,
} from "@apexus/geometry";
import { applyMatrix4, identity4, multiply4 } from "./math.js";
import type { SolidId, SolidRecipe } from "./types.js";

export const EMPTY_BOUNDS: Aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

export function isFiniteBounds(b: Aabb): boolean {
  return Number.isFinite(b.min[0]) && Number.isFinite(b.max[0]);
}

/** True for recipes that can be meshed with no other solid and no kernel. */
export function isStandaloneRecipe(recipe: SolidRecipe): boolean {
  return (
    recipe.kind === "box" ||
    recipe.kind === "extrude" ||
    recipe.kind === "loop" ||
    recipe.kind === "face" ||
    recipe.kind === "mesh" ||
    recipe.kind === "lathe"
  );
}

/** The mesh before the recipe's own matrix is applied. */
export function baseMesh(recipe: SolidRecipe): MeshData {
  switch (recipe.kind) {
    case "box":
      return createBox({
        width: recipe.width,
        height: recipe.height,
        depth: recipe.depth,
        origin: recipe.origin,
      });
    case "extrude":
      return extrudeRect(
        recipe.profile.width,
        recipe.profile.height,
        recipe.normal,
        recipe.origin,
        recipe.distance,
      );
    case "loop":
      return extrudeLoop(recipe.points, recipe.plane, recipe.distance);
    case "face":
      return faceMesh(recipe);
    case "mesh":
      return { positions: Float32Array.from(recipe.positions), indices: Uint32Array.from(recipe.indices) };
    case "lathe":
      return latheSolid(recipe.points, { offset: recipe.offset, segments: recipe.segments });
    case "boolean":
    case "transform":
    case "instance":
    case "group":
      throw new Error(`recipe "${recipe.kind}" needs the document; resolve it through the session`);
  }
}

/** Pure resolution for standalone recipes (includes the recipe matrix). */
export function recipeMesh(recipe: SolidRecipe): MeshData {
  return applyMatrix4(baseMesh(recipe), recipe.matrix ?? identity4());
}

export interface SolidGeometry {
  readonly mesh: MeshData;
  readonly bounds: Aabb;
  readonly volume: number;
  readonly closed: boolean;
  readonly hash: string;
}

export function analyseMesh(mesh: MeshData): SolidGeometry {
  const pts: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    pts.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  }
  return {
    mesh,
    bounds: aabbFromPoints(pts),
    volume: meshVolume(mesh),
    closed: isClosedMesh(mesh),
    hash: hashMesh(mesh),
  };
}

export function boundsOf(mesh: MeshData): Aabb;
export function boundsOf(session: { boundsOf(id: SolidId): Aabb }, id: SolidId): Aabb;
/**
 * A solid's world-space bounds.
 *
 * Two call shapes because two audiences ask the same question: the analysis
 * helpers have a mesh in hand, and every tool and test has a session and an id.
 * Answering the second one here (rather than making each caller reach through
 * `session.boundsOf(id)` into a mesh) keeps one definition of "the bounds of a
 * solid", and it reads a missing mesh as empty bounds instead of throwing.
 */
export function boundsOf(subject: MeshData | { boundsOf(id: SolidId): Aabb }, id?: SolidId): Aabb {
  if (id !== undefined) return (subject as { boundsOf(id: SolidId): Aabb }).boundsOf(id);
  const mesh = subject as MeshData;
  const pts: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    pts.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  }
  return aabbFromPoints(pts);
}

/** Pre-multiply a recipe's matrix, keeping every primitive number intact. */
export function withMatrix(recipe: SolidRecipe, m: readonly number[]): SolidRecipe {
  return { ...recipe, matrix: multiply4(m, recipe.matrix ?? identity4()) };
}
