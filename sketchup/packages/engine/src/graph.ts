/**
 * The reference graph: which solid names which.
 *
 * This lives in its own module because both `session.ts` (resolution, cache
 * invalidation) and `commands.ts` (grouping, reparenting, "is this in use?")
 * need it, and `session.ts` already imports `commands.ts`. Putting it in either
 * would make a cycle between them.
 *
 * One consequence worth knowing: a `group` owns its members the same way an
 * `instance` names its source, so every rule below treats them alike. Nothing
 * else in the codebase is allowed to re-derive this list.
 */

import type { DocumentState, SolidId, SolidRecipe } from "./types.js";

/** The ids a recipe points at, in one place. */
export function refsOf(recipe: SolidRecipe): readonly SolidId[] {
  switch (recipe.kind) {
    case "boolean":
      return [recipe.a, recipe.b];
    case "transform":
      return [recipe.child];
    case "instance":
      return [recipe.source];
    case "group":
      return recipe.members;
    default:
      return [];
  }
}

/** Ids that name `id` anywhere in their recipe (any depth of nesting). */
export function parentsOf(doc: DocumentState, id: SolidId): SolidId[] {
  const out: SolidId[] = [];
  for (const solid of doc.solids.values()) {
    if (refsOf(solid.recipe).includes(id)) out.push(solid.id);
  }
  return out;
}

/** True when no solid in the document points at `id`. */
export function isUnreferenced(doc: DocumentState, id: SolidId): boolean {
  return parentsOf(doc, id).length === 0;
}

/**
 * Every solid reachable from `id`, not counting `id` itself, in depth-first
 * order. Used by the outliner to draw nesting and by tests to prove a group
 * really does own its children.
 */
export function descendantsOf(doc: DocumentState, id: SolidId): SolidId[] {
  const out: SolidId[] = [];
  const seen = new Set<SolidId>([id]);
  const walk = (current: SolidId): void => {
    const solid = doc.solids.get(current);
    if (!solid) return;
    for (const ref of refsOf(solid.recipe)) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push(ref);
      walk(ref);
    }
  };
  walk(id);
  return out;
}

/** The top-level solids: those no other solid points at. */
export function rootsOf(doc: DocumentState): SolidId[] {
  const claimed = new Set<SolidId>();
  for (const solid of doc.solids.values()) {
    for (const ref of refsOf(solid.recipe)) claimed.add(ref);
  }
  return [...doc.solids.keys()].filter((id) => !claimed.has(id));
}

/**
 * Every group ancestor of `id`, nearest first.
 *
 * Display needs this: an edit to a group member changes the parent's merged
 * mesh, so the parent's cached triangles have to be thrown away too. Only
 * groups are walked, because a transform or instance owner is re-meshed by the
 * session's own dependency walk and rebuilding it twice would be wasted work.
 */
export function ancestorsThroughGroups(doc: DocumentState, id: SolidId): SolidId[] {
  const out: SolidId[] = [];
  const seen = new Set<SolidId>([id]);
  let current = id;
  for (;;) {
    const ownerId = parentsOf(doc, current).find(
      (owner) => doc.solids.get(owner)?.recipe.kind === "group",
    );
    if (ownerId === undefined || seen.has(ownerId)) return out;
    seen.add(ownerId);
    out.push(ownerId);
    current = ownerId;
  }
}

/**
 * The solids that draw their own geometry: every root, plus any child that a
 * `transform` or `instance` names, because those reference rather than contain.
 *
 * A `group` child must NOT be drawn on its own: its triangles are already in
 * the parent's merged mesh, so drawing both would paint every grouped object
 * twice and the selection outline would sit on an invisible duplicate. Every
 * consumer that walks the document for display (viewport, fit check, STL
 * export, orbit) must use this rather than `doc.solids.values()`.
 */
export function drawnSolids(doc: DocumentState): SolidId[] {
  const out: SolidId[] = [];
  for (const solid of doc.solids.values()) {
    const owners = parentsOf(doc, solid.id);
    if (owners.length === 0) {
      out.push(solid.id);
      continue;
    }
    // Owned only by groups -> contained, skip. Owned by a transform or an
    // instance -> referenced, still its own object on screen.
    const containedOnly = owners.every((ownerId) => doc.solids.get(ownerId)?.recipe.kind === "group");
    if (!containedOnly) out.push(solid.id);
  }
  return out;
}

/**
 * True when any ancestor group is hidden. Hiding a group must hide what is
 * inside it even though the children's own `hidden` flags are untouched.
 */
export function isHiddenByAncestor(doc: DocumentState, id: SolidId): boolean {
  const seen = new Set<SolidId>([id]);
  const stack: SolidId[] = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const ownerId of parentsOf(doc, current)) {
      if (seen.has(ownerId)) continue;
      seen.add(ownerId);
      const owner = doc.solids.get(ownerId);
      if (!owner) continue;
      if (owner.recipe.kind === "group" && owner.meta.hidden) return true;
      stack.push(ownerId);
    }
  }
  return false;
}
