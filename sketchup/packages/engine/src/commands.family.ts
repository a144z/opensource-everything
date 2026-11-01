import type { Vec3 } from "@apexus/geometry";
import { patchOf, type Command, type CommandContext } from "./command.js";
import { multiply4, translation4, withTranslation } from "./math.js";
import { assertSolidRecipe, requireSolid } from "./seams.js";
import type { DocumentState, Solid, SolidId, SolidRecipe } from "./types.js";

/**
 * Copy commands: the three relationship kinds a repeated object can have.
 *
 * They are easy to confuse, so they are defined next to each other:
 *
 *   - a *pinned copy* (`transform` recipe) bakes the source mesh in at copy
 *     time; later edits to the source do not follow it;
 *   - a *live copy* (`instance` recipe) resolves the source every time, so
 *     editing the source edits every copy;
 *   - a *component* is a live copy that also carries a `definition` name, which
 *     is what lets the outliner group the copies and rename them together. The
 *     commands that create and rename components are in `commands.components.ts`;
 *     the recipe it needs is built here, by `liveCopyRecipe`, so a component and
 *     a plain instance can never disagree about how a copy is placed.
 */

/**
 * Pinned copy: the child's mesh is baked in at copy time, so later edits to the
 * source do not follow. `delta` moves the copy in world space.
 */
export function duplicateSolid(id: SolidId, delta: Vec3 = [0, 0, 0]): Command {
  return {
    kind: "duplicateSolid",
    label: "Copy",
    apply(doc, ctx) {
      const src = requireSolid(doc, id);
      const newId = ctx.nextId();
      const recipe = { ...src.recipe, matrix: withTranslation(src.recipe.matrix, delta) };
      assertSolidRecipe(recipe, ctx.resolve);
      const copy: Solid = {
        id: newId,
        revision: 1,
        recipe,
        meta: { ...src.meta, name: `${src.meta.name} copy`, hidden: false, locked: false },
      };
      return patchOf(doc, new Map([[newId, copy]]), new Map([[newId, null]]), "Copy");
    },
  };
}

/**
 * Live copy: the copy resolves the source's mesh every time, so editing the
 * source edits every instance. `delta` offsets the instance from the source in
 * world space.
 *
 * A source that is itself a pinned copy is flattened first: an instance of a
 * copy whose only difference was its matrix would otherwise apply that matrix
 * twice and land in the wrong place.
 */
export function instanceCopy(id: SolidId, delta: Vec3 = [0, 0, 0]): Command {
  return {
    kind: "instanceCopy",
    label: "Make Instance",
    apply(doc, ctx) {
      const src = requireSolid(doc, id);
      if (delta.every((d) => d === 0)) throw new Error("an instance must be placed away from its source");
      const newId = ctx.nextId();
      const { recipe } = liveCopyRecipe(doc, src, delta);
      const copy: Solid = {
        id: newId,
        revision: 1,
        recipe,
        meta: { ...src.meta, name: `${src.meta.name} instance`, hidden: false, locked: false },
      };
      assertResolvable(doc, ctx, newId, copy, recipe);
      return patchOf(doc, new Map([[newId, copy]]), new Map([[newId, null]]), "Make Instance");
    },
  };
}

/**
 * The placement half of any live copy, shared by `instanceCopy` and
 * `makeComponent` so the two can never disagree about how a copy is placed.
 *
 * A pinned copy is only ever `source + matrix`, so an instance points at the
 * copy's own child and carries both matrices; pointing at the copy would apply
 * the copy's matrix twice.
 *
 * `origin` cancels whatever the source is already carrying (its own move or
 * rotation) and the instance's matrix is the user's world offset. Two instances
 * of the same window can then sit on different walls without either of them
 * stacking the source's matrix on top of its own. A pinned copy's placement is
 * already the offset the user asked for, so it is kept as the instance's own
 * matrix rather than cancelled.
 */
export function liveCopyRecipe(
  doc: DocumentState,
  src: Solid,
  delta: Vec3,
): { recipe: Extract<SolidRecipe, { kind: "instance" }>; source: Solid } {
  const pinned = src.recipe.kind === "transform";
  const source = pinned ? requireSolid(doc, src.recipe.child) : src;
  const at = pinned ? src.recipe.matrix : source.recipe.matrix;
  return {
    source,
    recipe: {
      kind: "instance",
      source: source.id,
      origin: [...at],
      matrix: multiply4(at, translation4(delta)),
    },
  };
}

/**
 * Mesh a recipe against the document the patch would leave behind, including
 * `newId`. Validating against the live document instead would miss a source
 * that (transitively) points back at the new object: a cycle.
 */
export function assertResolvable(
  doc: DocumentState,
  ctx: CommandContext,
  newId: SolidId,
  solid: Solid,
  recipe: SolidRecipe,
): void {
  const after = new Map(doc.solids);
  after.set(newId, solid);
  assertSolidRecipe(recipe, (r) => ctx.resolveWith?.(r, after) ?? ctx.resolve(r));
}

/**
 * Linear array copy: `count` new copies at `step` intervals (task L2-4).
 *
 * Copying does not re-mesh the source, so it cannot produce a new invalid
 * solid; what it can do is collide an id or overflow a count, and both are
 * refused before a single entry is written.
 */
export function arrayCopy(id: SolidId, count: number, step: Vec3): Command {
  return {
    kind: "arrayCopy",
    label: `Array ×${count}`,
    apply(doc) {
      const src = requireSolid(doc, id);
      if (!Number.isInteger(count) || count < 1 || count > 500) {
        throw new RangeError("array count must be an integer between 1 and 500");
      }
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (let i = 1; i <= count; i++) {
        const newId = `${id}~a${i}`;
        if (doc.solids.has(newId) || forward.has(newId)) throw new Error("array copy id collision");
        const offset: Vec3 = [step[0] * i, step[1] * i, step[2] * i];
        // The step is already a world vector, but it was being added through
        // the solid's own matrix, so a rotated source arrayed off its own axis.
        // Translate in world first, then let the model matrix do its thing.
        const matrix = multiply4(src.recipe.matrix, translation4(offset));
        forward.set(newId, {
          id: newId,
          revision: 1,
          recipe: { ...src.recipe, matrix },
          meta: { ...src.meta, name: `${src.meta.name} ${i + 1}`, hidden: false, locked: false },
        });
        backward.set(newId, null);
      }
      return patchOf(doc, forward, backward, `Array ×${count}`);
    },
  };
}
