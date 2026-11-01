import { patchOf, type Command } from "./command.js";
import { identity4 } from "./math.js";
import { assertSolidRecipe, newMeta, requireSolid } from "./seams.js";
import type { BooleanOp, Solid, SolidId, SolidRecipe } from "./types.js";

/**
 * Structural edits: combining solids through the kernel, and removing them.
 *
 * Both are the commands that can make the model *smaller*, so both are where a
 * dangling reference would hide. They validate the graph they leave behind, and
 * `deleteSolids` refuses to orphan a child rather than letting the mesh list
 * reference an id nobody can resolve.
 */

/**
 * Combine two solids through the kernel (task L1-3). The result is checked, then
 * both inputs are removed, so undo is a single exact restore.
 */
export function booleanSolids(a: SolidId, b: SolidId, op: BooleanOp): Command {
  const label = op === "union" ? "Union" : op === "difference" ? "Subtract" : "Intersect";
  return {
    kind: "booleanSolids",
    label,
    apply(doc, ctx) {
      const sa = requireSolid(doc, a);
      const sb = requireSolid(doc, b);
      if (a === b) throw new Error("cannot combine a solid with itself");
      const recipe: SolidRecipe = { kind: "boolean", op, a, b, matrix: identity4() };
      // Mesh both operands before anything is deleted. Afterwards the result is a
      // plain mesh: it no longer references its inputs, so undo is a single
      // exact restore rather than a dangling id chain.
      const mesh = ctx.resolve(recipe);
      assertSolidRecipe(recipe, () => mesh);
      const id = ctx.nextId();
      const solid: Solid = {
        id,
        revision: 1,
        recipe: { kind: "mesh", positions: [...mesh.positions], indices: [...mesh.indices], matrix: identity4() },
        meta: { ...newMeta(doc, sa.recipe), name: `${sa.meta.name} ${op === "difference" ? "cut" : op}` },
      };
      return patchOf(
        doc,
        new Map<SolidId, Solid | null>([
          [id, solid],
          [a, null],
          [b, null],
        ]),
        new Map<SolidId, Solid | null>([
          [id, null],
          [a, sa],
          [b, sb],
        ]),
        solid.meta.name,
      );
    },
  };
}

/**
 * Delete objects.
 *
 * A stale id is skipped rather than thrown on: delete arrives from a selection
 * that may already have been pruned, and refusing the whole delete because one
 * entry in a list of thirty was gone would be worse than the skip. References
 * from elsewhere are *not* checked here; the session prunes the patch's removed
 * ids before applying it, so a dangling link cannot survive a delete.
 */
export function deleteSolids(ids: readonly SolidId[]): Command {
  const label = ids.length > 1 ? `Delete ${ids.length} objects` : "Delete";
  return {
    kind: "deleteSolids",
    label,
    apply(doc) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const id of ids) {
        const prev = doc.solids.get(id);
        if (!prev) continue;
        forward.set(id, null);
        backward.set(id, prev);
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}
