/** Mesh resolution contract between the engine and whichever kernel is plugged in. */

import type { MeshData } from "@apexus/geometry";
import type { BooleanOp, SolidRecipe } from "./types.js";

export type BooleanMeshes = (a: MeshData, b: MeshData, op: BooleanOp) => MeshData;

/** Recipe kinds that need other solids (or the kernel) to become a mesh. */
export function dependsOnOthers(recipe: SolidRecipe): boolean {
  return recipe.kind === "boolean" || recipe.kind === "transform" || recipe.kind === "instance";
}
