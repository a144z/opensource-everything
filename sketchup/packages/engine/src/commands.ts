/**
 * The command suite's public face.
 *
 * Every command is a small value that validates, then returns an invertible
 * patch (ADR 0003); none of them mutates the document. The implementations are
 * split by *what they operate on*, not by line count, so each module can be read
 * on its own:
 *
 *   - `seams.ts`               the rules every command shares
 *   - `commands.ts` (this file) documents: add a solid, replace a recipe
 *   - `commands.shape.ts`      push/pull and the rigid transforms
 *   - `commands.groups.ts`     ownership: group, ungroup, reparent
 *   - `commands.family.ts`     copies: pinned, live, array
 *   - `commands.components.ts` named definitions and their instances
 *   - `commands.structure.ts`  booleans and delete
 *   - `commands.appearance.ts` rename, colour, finish, tags, section
 *   - `commands.envelope.ts`   the fit envelope and its solver
 *
 * This file is the only place that knows the whole set, so anything importing
 * `@apexus/engine` keeps working with no path changes after a split.
 */

import { patchOf, type Command } from "./command.js";
import { identity4 } from "./math.js";
import { assertSolidRecipe, labelFor, newMeta, requireSolid } from "./seams.js";
import { SCHEMA_VERSION } from "./types.js";
import { validateRecipe as normaliseRecipe } from "./io.js";
import type { DocumentState, Solid, SolidId, SolidMeta, SolidRecipe } from "./types.js";

/* ------------------------------------------------------------ documents */

/** An empty document with nothing in it: the state a new project starts in. */
export function emptyDocumentState(): DocumentState {
  return { schemaVersion: SCHEMA_VERSION, units: "mm", envelope: null, solids: new Map(), section: null };
}

/** Build a solid from a recipe that has no matrix yet. */
export function makeRecipe(recipe: Record<string, unknown>): SolidRecipe {
  return { ...recipe, matrix: (recipe["matrix"] as readonly number[] | undefined) ?? identity4() } as unknown as SolidRecipe;
}

/* ------------------------------------------------------------------ add */

export function addSolid(recipe: SolidRecipe, meta?: Partial<SolidMeta>): Command {
  return {
    kind: "addSolid",
    label: `Add ${labelFor(recipe)}`,
    apply(doc, ctx) {
      const normalised = normaliseRecipe(SCHEMA_VERSION, "new solid", recipe);
      assertSolidRecipe(normalised, ctx.resolve);
      const id = ctx.nextId();
      const solid: Solid = { id, revision: 1, recipe: normalised, meta: newMeta(doc, normalised, meta) };
      return patchOf(doc, new Map([[id, solid]]), new Map([[id, null]]), `Add ${solid.meta.name}`);
    },
  };
}

/** Replace a recipe wholesale: transform, repair, conversion. */
export function setRecipe(id: SolidId, recipe: SolidRecipe, label = "Edit"): Command {
  return {
    kind: "setRecipe",
    label,
    apply(doc, ctx) {
      const prev = requireSolid(doc, id);
      const next: Solid = { ...prev, revision: prev.revision + 1, recipe };
      // Validate against the document the patch would leave behind, or a cycle
      // (this solid becoming an ancestor of itself) would go unnoticed.
      const after = new Map(doc.solids);
      after.set(id, next);
      assertSolidRecipe(recipe, (r) => ctx.resolveWith?.(r, after) ?? ctx.resolve(r));
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), label);
    },
  };
}

/* -------------------------------------------------------------- re-export */

export { assertSolidRecipe, labelFor, requireSolid, newMeta } from "./seams.js";
/**
 * The seam checker, under its own name.
 *
 * `validateRecipe` is the public name of the *load-time* normaliser in `io.ts`
 * (schema version + id + raw recipe). Naming the in-memory checker — mesh it,
 * require positive volume — `assertSolidRecipe` keeps the two from being one
 * name that resolves to whichever re-export runs last.
 */

export * from "./commands.shape.js";
export * from "./commands.groups.js";
export * from "./commands.family.js";
export * from "./commands.components.js";
export * from "./commands.structure.js";
export * from "./commands.appearance.js";
export * from "./commands.envelope.js";

/** Kept for callers that only need the first id of a selection. */
export { firstId } from "./seams.js";
