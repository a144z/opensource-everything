import { patchOf, type Command } from "./command.js";
import { parentsOf } from "./graph.js";
import { identity4, multiply4 } from "./math.js";
import { assertFaceRecipe, assertSolidRecipe, newMeta, requireSolid } from "./seams.js";
import type { DocumentState, Solid, SolidId, SolidRecipe } from "./types.js";

/**
 * Groups: the owned-child relationship (L2-1) and the reparenting primitive.
 *
 * A group is the only recipe kind that *owns* its members: it holds an ordered
 * child list plus its own matrix, applied to the merged children, so a transform
 * moves the contents exactly once. An `instance` by contrast stays a single
 * reference to a source it does not own.
 *
 * Deleting, history and interaction belong to other modules; this one is only
 * about who belongs to whom.
 */

/**
 * Group the given solids under one new parent (task L2-1).
 *
 * The members stay in the document, so their names, colours, tags and recipes are
 * all still theirs; only a new `group` parent arrives, and it meshes to the
 * members merged. Making a group is therefore one undo step that adds one object,
 * and ungrouping is one undo step that removes it.
 */
export function groupSolids(ids: readonly SolidId[], name?: string): Command {
  const label = "Group";
  return {
    kind: "groupSolids",
    label,
    apply(doc, ctx) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) throw new Error("select at least one object to group");
      for (const id of unique) requireSolid(doc, id);
      // A member that is already owned by another parent would be meshed by both
      // parents: one object in two groups. SketchUp's own rule is that grouping
      // is a reparenting operation, so reuse `moveBetween`'s check here.
      const shared = unique.filter((id) => parentsOf(doc, id).length > 0);
      if (shared.length > 0) {
        throw new Error(`${shared.join(", ")} already belongs to another group or instance; ungroup it first`);
      }
      const newId = ctx.nextId();
      if (doc.solids.has(newId)) throw new Error(`group id ${newId} is already used`);
      const recipe: Extract<SolidRecipe, { kind: "group" }> = { kind: "group", members: unique, matrix: identity4() };
      const group: Solid = {
        id: newId,
        revision: 1,
        recipe,
        meta: newMeta(doc, recipe, name === undefined ? {} : { name }),
      };
      assertSolidRecipe(group.recipe, ctx.resolve);
      return patchOf(doc, new Map([[newId, group]]), new Map([[newId, null]]), label);
    },
  };
}

/**
 * Ungroup (task L2-1): drop the wrapper and relink its members.
 *
 * The members keep their own matrices, so ungrouping inside a group is
 * geometrically a no-op: the children simply become their parent's children.
 * Ungrouping at the top level makes the children top-level objects in their own
 * right, which is what the user asked for by ungrouping.
 */
export function ungroupSolid(id: SolidId): Command {
  const label = "Ungroup";
  return {
    kind: "ungroupSolid",
    label,
    apply(doc, ctx) {
      const group = requireSolid(doc, id);
      if (group.recipe.kind !== "group") throw new Error(`${group.meta.name} is not a group`);
      const parents = parentsOf(doc, id);
      if (parents.length > 1) throw new Error(`${group.meta.name} is referenced by more than one parent`);
      const parent = parents[0];
      const members = group.recipe.members;
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();

      if (parent) {
        const parentSolid = requireSolid(doc, parent);
        if (parentSolid.recipe.kind === "group") {
          // Splice the members in where the group sat, keeping the parent's own
          // ordering, so nested ungrouping never reshuffles the outliner.
          const nextMembers = parentSolid.recipe.members.flatMap((m) => (m === id ? members : [m]));
          forward.set(parent, {
            ...parentSolid,
            revision: parentSolid.revision + 1,
            recipe: { ...parentSolid.recipe, members: nextMembers },
          });
          backward.set(parent, parentSolid);
        } else {
          // An instance of this group already carries its own copy of the mesh,
          // so removing the wrapper changes nothing visible; it is still safe.
          throw new Error(`cannot ungroup ${group.meta.name}: it is instanced by ${parentSolid.meta.name}`);
        }
      } else {
        // Top level: the group's own placement has to become each child's, or a
        // moved group would jump back to where its children were born.
        for (const member of members) {
          const prev = requireSolid(doc, member);
          forward.set(member, {
            ...prev,
            revision: prev.revision + 1,
            recipe: { ...prev.recipe, matrix: multiply4(group.recipe.matrix, prev.recipe.matrix) },
          });
          backward.set(member, prev);
        }
      }
      forward.set(id, null);
      backward.set(id, group);

      // Validate the document the patch would leave behind, not the one being
      // read: a member whose only parent just disappeared is caught here.
      const after = new Map<SolidId, Solid>(doc.solids);
      for (const [changedId, solid] of forward) {
        if (solid) after.set(changedId, solid);
        else after.delete(changedId);
      }
      for (const [changedId, solid] of forward) {
        if (!solid) continue;
        // A freed face is still a legal object: it has surface but no volume,
        // so it is checked by the surface rule rather than the solid one.
        const check = (r: SolidRecipe) => ctx.resolveWith?.(r, after) ?? ctx.resolve(r);
        if (solid.recipe.kind === "face") assertFaceRecipe(solid.recipe, check);
        else assertSolidRecipe(solid.recipe, check);
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}

/**
 * Move objects into a group, or back out to the top level (`parentId = null`).
 *
 * This is the one primitive both `groupSolids` and the outliner's drag-and-drop
 * use, so "which parent owns this object" has exactly one implementation.
 */
export function moveBetween(ids: readonly SolidId[], parentId: SolidId | null): Command {
  const label = parentId === null ? "Move to model" : "Move into group";
  return {
    kind: "moveBetween",
    label,
    apply(doc) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) throw new Error("select at least one object to move");
      const parent = parentId === null ? null : requireSolid(doc, parentId);
      if (parent && parent.recipe.kind !== "group") {
        throw new Error(`${parent.meta.name} is not a group, so it cannot hold objects`);
      }
      const parentGroup = parent && parent.recipe.kind === "group" ? { solid: parent, recipe: parent.recipe } : null;
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      // Remove from every current parent first, then add to the new one.
      for (const id of unique) {
        requireSolid(doc, id);
        if (id === parentId) throw new Error("a group cannot contain itself");
        for (const ownerId of parentsOf(doc, id)) {
          // Already home: leave it where it is. Stripping and re-adding would
          // depend on the two steps landing in the same patch, which they do not
          // when the group is checked first.
          if (ownerId === parentId) continue;
          const owner = requireSolid(doc, ownerId);
          if (owner.recipe.kind !== "group") {
            throw new Error(`${requireSolid(doc, id).meta.name} is used by ${owner.meta.name}, which is not a group`);
          }
          forward.set(ownerId, {
            ...owner,
            revision: owner.revision + 1,
            recipe: { ...owner.recipe, members: owner.recipe.members.filter((m) => m !== id) },
          });
          if (!backward.has(ownerId)) backward.set(ownerId, owner);
        }
      }
      if (parentGroup) {
        // Only ids that are not already members. Appending blindly let a member
        // be listed twice, which the loader refuses but the live document would
        // have meshed twice: same object, double volume.
        const existing = new Set(parentGroup.recipe.members);
        const additions = unique.filter((id) => !existing.has(id));
        if (additions.length > 0) {
          forward.set(parentGroup.solid.id, {
            ...parentGroup.solid,
            revision: parentGroup.solid.revision + 1,
            recipe: { ...parentGroup.recipe, members: [...parentGroup.recipe.members, ...additions] },
          });
          if (!backward.has(parentGroup.solid.id)) backward.set(parentGroup.solid.id, parentGroup.solid);
        }
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}

/** Every group in the document, in document order. Used by the outliner and panels. */
export function groupsOf(doc: DocumentState): readonly Solid[] {
  return [...doc.solids.values()].filter((s) => s.recipe.kind === "group");
}

/**
 * The innermost groups among `ids`, i.e. the ones whose groups `explode` removes.
 *
 * Explode is ungroup applied one level deep to the groups *inside* the selection,
 * not to the selection itself. Computing it here keeps "one level" a single rule
 * instead of a filter repeated in every caller.
 */
export function innerGroups(doc: DocumentState, ids: readonly SolidId[]): readonly SolidId[] {
  return ids.flatMap((id) => {
    const recipe = doc.solids.get(id)?.recipe;
    return recipe?.kind === "group"
      ? recipe.members.filter((m) => doc.solids.get(m)?.recipe.kind === "group")
      : [];
  });
}

