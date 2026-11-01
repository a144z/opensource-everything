/**
 * Commands (ADR 0003). A command validates, then returns an invertible patch.
 * It never mutates the document.
 *
 * Rule every command obeys: validate by meshing the result, so a command either
 * produces a solid with positive volume and finite bounds, or it throws and the
 * session is untouched. Mass transforms validate one mesh, not N kernel calls.
 */

import type { Aabb, MeshData, Vec3 } from "@apexus/geometry";
import { analyseMesh, isFiniteBounds, withMatrix } from "./analyze.js";
import { patchOf, type Command } from "./command.js";
import {
  identity4,
  isIdentity4,
  multiply4,
  scale4,
  sub3,
  translation4,
  withRotation,
  withScale,
  withTranslation,
} from "./math.js";
import type { BooleanOp, DocumentState, Envelope, SectionPlane, Solid, SolidId, SolidMeta, SolidRecipe } from "./types.js";
import { DEFAULT_COLORS, SCHEMA_VERSION, clampOpacity, clampUnit } from "./types.js";
import { validateRecipe as normaliseRecipe } from "./io.js";

export type Resolve = (recipe: SolidRecipe) => MeshData;

export function emptyDocumentState(): DocumentState {
  return { schemaVersion: SCHEMA_VERSION, units: "mm", envelope: null, solids: new Map(), section: null };
}

export function labelFor(recipe: SolidRecipe): string {
  switch (recipe.kind) {
    case "box":
      return "Box";
    case "extrude":
      return "Face";
    case "loop":
      return "Loop";
    case "boolean":
      return recipe.op === "union" ? "Union" : recipe.op === "difference" ? "Cut" : "Intersect";
    case "transform":
      return "Copy";
    case "instance":
      return "Instance";
    case "mesh":
      return "Mesh";
    case "lathe":
      return "Lathe";
  }
}

function requireSolid(doc: DocumentState, id: SolidId): Solid {
  const solid = doc.solids.get(id);
  if (!solid) throw new Error(`unknown solid ${id}`);
  return solid;
}

/** Validate by actually meshing it; a command must never emit junk geometry. */
export function validateRecipe(recipe: SolidRecipe, resolve: Resolve): void {
  const geo = analyseMesh(resolve(recipe));
  if (!isFiniteBounds(geo.bounds)) throw new RangeError(`${labelFor(recipe)} produced no geometry`);
  if (!(geo.volume > 0)) throw new RangeError(`${labelFor(recipe)} produced a solid with no volume`);
}

export function newMeta(doc: DocumentState, recipe: SolidRecipe, meta?: Partial<SolidMeta>): SolidMeta {
  const count = doc.solids.size;
  return {
    name: meta?.name ?? `${labelFor(recipe)} ${count + 1}`,
    color: meta?.color ?? DEFAULT_COLORS[count % DEFAULT_COLORS.length]!,
    hidden: meta?.hidden ?? false,
    locked: meta?.locked ?? false,
    opacity: clampOpacity(meta?.opacity),
    roughness: clampUnit(meta?.roughness, 0.75),
    metallic: clampUnit(meta?.metallic, 0),
    tag: meta?.tag ?? "",
  };
}

/** Build a solid from a recipe that has no matrix yet. */
export function makeRecipe(recipe: Record<string, unknown>): SolidRecipe {
  return { ...recipe, matrix: (recipe["matrix"] as readonly number[] | undefined) ?? identity4() } as unknown as SolidRecipe;
}

/* --------------------------------------------------------------- shared */

/**
 * Replace the `matrix` of `ids` with `next(oldMatrix)` as one patch.
 *
 * Only the first new matrix is meshed: every solid's own primitive numbers are
 * unchanged (docs/06), so the same matrix that keeps one solid sound keeps all
 * of them sound. Locked solids are skipped. An empty patch is a valid no-op.
 */
function transformPatch(
  doc: DocumentState,
  ids: readonly SolidId[],
  resolve: Resolve,
  next: (m: readonly number[]) => readonly number[],
  label: string,
): import("./history.js").Patch {
  const forward = new Map<SolidId, Solid | null>();
  const backward = new Map<SolidId, Solid | null>();
  let checked = false;
  for (const id of ids) {
    const prev = doc.solids.get(id);
    if (!prev || prev.meta.locked) continue;
    const recipe = { ...prev.recipe, matrix: next(prev.recipe.matrix) };
    if (!checked) {
      validateRecipe(recipe, resolve);
      checked = true;
    }
    forward.set(id, { ...prev, revision: prev.revision + 1, recipe });
    backward.set(id, prev);
  }
  return patchOf(doc, forward, backward, label);
}

function firstId(ids: readonly SolidId[]): SolidId {
  const id = ids[0];
  if (!id) throw new Error("select at least one object");
  return id;
}

/* ------------------------------------------------------------------ add */

export function addSolid(recipe: SolidRecipe, meta?: Partial<SolidMeta>): Command {
  return {
    kind: "addSolid",
    label: `Add ${labelFor(recipe)}`,
    apply(doc, ctx) {
      const normalised = normaliseRecipe(SCHEMA_VERSION, "new solid", recipe);
      validateRecipe(normalised, ctx.resolve);
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
      validateRecipe(recipe, (r) => ctx.resolveWith?.(r, after) ?? ctx.resolve(r));
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), label);
    },
  };
}

/* ---------------------------------------------------------- push/pull */

/**
 * Push/pull (docs/03: the one gesture that matters).
 *
 * Changes the extrusion's own `distance`; the recipe matrix is untouched, so a
 * moved or rotated face still grows along its own normal (task X-3). A box has
 * no `distance`, so its push/pull replaces the whole recipe. Accepts
 * `pullFace(id, recipe)` (tests) and `pullFace(id, distance)` (app, extrusion
 * or loop only).
 */
export function pullFace(id: SolidId, recipeOrDistance: SolidRecipe | number): Command {
  return {
    kind: "pullFace",
    label: "Push/Pull",
    apply(doc, ctx) {
      const prev = requireSolid(doc, id);
      const r = prev.recipe;
      if (r.kind === "boolean" || r.kind === "transform" || r.kind === "instance") {
        throw new Error("push/pull needs a primitive; pull its sources instead");
      }
      let recipe: SolidRecipe;
      if (typeof recipeOrDistance === "number") {
        if (r.kind !== "extrude" && r.kind !== "loop") {
          throw new Error("push/pull by distance needs an extruded face or loop");
        }
        recipe = { ...r, distance: recipeOrDistance };
      } else {
        recipe = recipeOrDistance;
      }
      if (recipe.kind === "extrude" || recipe.kind === "loop") {
        if (!(Number.isFinite(recipe.distance) && recipe.distance > 1e-3)) {
          throw new RangeError("pull distance must be positive");
        }
      }
      validateRecipe(recipe, ctx.resolve);
      const next: Solid = { ...prev, revision: prev.revision + 1, recipe };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), "Push/Pull");
    },
  };
}

/** Change an extrusion's height by a delta (drag math lives in the app). */
export function pullBy(id: SolidId, delta: number): Command {
  return {
    kind: "pullBy",
    label: "Push/Pull",
    apply(doc, ctx) {
      const prev = requireSolid(doc, id);
      const r = prev.recipe;
      if (r.kind !== "extrude" && r.kind !== "loop") throw new Error("push/pull needs an extruded face or loop");
      const distance = r.distance + delta;
      if (!(distance > 1e-3)) throw new RangeError("pull distance must be positive");
      const recipe: SolidRecipe = { ...r, distance };
      validateRecipe(recipe, ctx.resolve);
      const next: Solid = { ...prev, revision: prev.revision + 1, recipe };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), "Push/Pull");
    },
  };
}

/* ------------------------------------------------------------ transforms */

export type Axis = "x" | "y" | "z";

/** Move one or more solids by `delta`. TRS split is preserved; nothing is baked. */
export function translateSolids(ids: readonly SolidId[], delta: Vec3): Command {
  return {
    kind: "translateSolids",
    label: ids.length > 1 ? "Move" : "Move",
    apply(doc, ctx) {
      if (delta.every((d) => Math.abs(d) < 1e-9)) return patchOf(doc, new Map(), new Map(), "No change");
      return transformPatch(doc, ids, ctx.resolve, (m) => withTranslation(m, delta), "Move");
    },
  };
}

export function translateSolid(id: SolidId, delta: Vec3): Command {
  return translateSolids([id], delta);
}

/** Scale one or more solids about `pivot`; scale factors compose across edits. */
export function scaleSolids(ids: readonly SolidId[], factor: number | Vec3, pivot: Vec3 = [0, 0, 0]): Command {
  return {
    kind: "scaleSolids",
    label: "Scale",
    apply(doc, ctx) {
      const f: Vec3 = typeof factor === "number" ? [factor, factor, factor] : factor;
      if (!f.every((n) => Number.isFinite(n) && n > 0)) {
        throw new RangeError("scale factors must be positive and finite");
      }
      if (f.every((n) => Math.abs(n - 1) < 1e-12)) return patchOf(doc, new Map(), new Map(), "No change");
      return transformPatch(doc, ids, ctx.resolve, (m) => withScale(m, f, pivot), "Scale");
    },
  };
}

export function scaleSolid(id: SolidId, factor: number | Vec3, pivot?: Vec3): Command {
  return scaleSolids([id], factor, pivot);
}

/** Rotate one or more solids about a world axis through `pivot`, in degrees. */
export function rotateSolids(ids: readonly SolidId[], axis: Axis, degrees: number, pivot: Vec3 = [0, 0, 0]): Command {
  return {
    kind: "rotateSolids",
    label: `Rotate ${degrees}`,
    apply(doc, ctx) {
      if (!Number.isFinite(degrees)) throw new RangeError("rotation must be a finite angle");
      if (Math.abs(degrees % 360) < 1e-12) return patchOf(doc, new Map(), new Map(), "No change");
      const unit: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
      return transformPatch(doc, ids, ctx.resolve, (m) => withRotation(m, unit, degrees, pivot), `Rotate ${degrees}`);
    },
  };
}

export function rotateSolid(id: SolidId, axis: Axis, degrees: number, pivot: Vec3 = [0, 0, 0]): Command {
  return rotateSolids([id], axis, degrees, pivot);
}

/**
 * Set one absolute matrix on every id (the gizmo reports a world matrix for a
 * single object, so callers pass one id; batch `matrixFor` handles the rest).
 */
export function setMatrix(ids: readonly SolidId[], matrix: readonly number[], label = "Transform"): Command {
  return {
    kind: "setMatrix",
    label,
    apply(doc, ctx) {
      for (const id of ids) validateRecipe({ ...requireSolid(doc, id).recipe, matrix }, ctx.resolve);
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const id of ids) {
        const prev = requireSolid(doc, id);
        forward.set(id, { ...prev, revision: prev.revision + 1, recipe: { ...prev.recipe, matrix } });
        backward.set(id, prev);
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}

/**
 * Pinched copy (`transform` recipe): the child's mesh is baked in at copy time,
 * so later edits to the source do not follow. `delta` moves the copy in world
 * space.
 */
export function duplicateSolid(id: SolidId, delta: Vec3 = [0, 0, 0]): Command {
  return {
    kind: "duplicateSolid",
    label: "Copy",
    apply(doc, ctx) {
      const src = requireSolid(doc, id);
      const newId = ctx.nextId();
      const recipe = { ...src.recipe, matrix: withTranslation(src.recipe.matrix, delta) };
      validateRecipe(recipe, ctx.resolve);
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
 * Live copy (`instance` recipe): the copy resolves the source's mesh every time,
 * so editing the source edits every instance. `delta` offsets the instance from
 * the source in world space.
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
      // A pinned copy is only ever `source + matrix`, so an instance points at
      // the copy's own child and carries both matrices. Pointing at the copy
      // instead would apply the copy's matrix twice.
      const source = src.recipe.kind === "transform" ? requireSolid(doc, src.recipe.child) : src;
      const pinned = src.recipe.kind === "transform";
      // `origin` cancels whatever the source is already carrying (its own move
      // or rotation), and the instance's matrix is the user's world offset. Two
      // instances of the same window can then sit on different walls without
      // either of them stacking the source's matrix on top of its own. A pinned
      // copy's placement is already the offset the user asked for, so it is
      // kept as the instance's own matrix rather than cancelled.
      const at = pinned ? src.recipe.matrix : source.recipe.matrix;
      const recipe: SolidRecipe = {
        kind: "instance",
        source: source.id,
        origin: [...at],
        matrix: multiply4(at, translation4(delta)),
      };
      const copy: Solid = {
        id: newId,
        revision: 1,
        recipe,
        meta: { ...src.meta, name: `${src.meta.name} instance`, hidden: false, locked: false },
      };
      // Validate the graph the patch would leave behind, including this new
      // solid, so a source that (transitively) points back here is refused.
      const after = new Map(doc.solids);
      after.set(newId, copy);
      validateRecipe(recipe, (r) => ctx.resolveWith?.(r, after) ?? ctx.resolve(r));
      return patchOf(doc, new Map([[newId, copy]]), new Map([[newId, null]]), "Make Instance");
    },
  };
}

/** Linear array copy: `count` new copies at `step` intervals (task L2-4). */
export function arrayCopy(id: SolidId, count: number, step: Vec3): Command {
  return {
    kind: "arrayCopy",
    label: `Array ?${count}`,
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
      return patchOf(doc, forward, backward, `Array ?${count}`);
    },
  };
}

/* -------------------------------------------------------------- booleans */

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
      validateRecipe(recipe, () => mesh);
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

/* ------------------------------------------------------------------ misc */

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

export function renameSolid(id: SolidId, name: string): Command {
  // A blank name would leave the outliner with unclickable rows; refuse it here
  // so no caller can produce one, rather than trusting every UI to check first.
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("a solid's name cannot be blank");
  return {
    kind: "renameSolid",
    label: `Rename to ${trimmed}`,
    apply(doc) {
      const prev = requireSolid(doc, id);
      const next: Solid = { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, name: trimmed } };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), `Rename to ${trimmed}`);
    },
  };
}

export function setMeta(id: SolidId, patch: Partial<SolidMeta>, label = "Edit"): Command {
  return {
    kind: "setMeta",
    label,
    apply(doc) {
      const prev = requireSolid(doc, id);
      const next: Solid = { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, ...patch } };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), label);
    },
  };
}

export function setColor(ids: readonly SolidId[], color: string): Command {
  return {    kind: "setColor",
    label: "Colour",
    apply(doc) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const id of ids) {
        const prev = doc.solids.get(id);
        if (!prev) continue;
        forward.set(id, { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, color } });
        backward.set(id, prev);
      }
      return patchOf(doc, forward, backward, "Colour");
    },
  };
}

/* ------------------------------------------------------------------ tags */

/**
 * Surface finish: roughness (0 mirror to 1 rough) and metal (0 to 1). Both are
 * clamped rather than refused, the same policy as opacity, because a slider can
 * overshoot by a rounding error and that must not fail a whole command.
 */
export function setFinish(ids: readonly SolidId[], roughness: number, metallic: number): Command {
  if (typeof roughness !== "number" || !Number.isFinite(roughness)) {
    throw new RangeError("roughness must be a number from 0 to 1");
  }
  if (typeof metallic !== "number" || !Number.isFinite(metallic)) {
    throw new RangeError("metallic must be a number from 0 to 1");
  }
  const rough = clampUnit(roughness, 0.75);
  const metal = clampUnit(metallic, 0);
  const label = metal > 0.5 ? "Finish: metal" : rough > 0.9 ? "Finish: matte" : "Finish";
  return {
    kind: "setFinish",
    label,
    apply(doc) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const id of ids) {
        const prev = doc.solids.get(id);
        if (!prev) continue;
        if (prev.meta.roughness === rough && prev.meta.metallic === metal) continue;
      forward.set(id, {
        ...prev,
        revision: prev.revision + 1,
        meta: { ...prev.meta, roughness: rough, metallic: metal },
      });
        backward.set(id, prev);
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}

/**
 * Put objects on a tag (SketchUp's "layer"). A tag is a name only: it never
 * owns geometry, so this is a meta edit and undo is a plain restore.
 */
export function setTag(ids: readonly SolidId[], tag: string): Command {
  const name = tag.trim();
  if (name.length > 40) throw new RangeError("a tag name is at most 40 characters");
  const label = name === "" ? "Clear tag" : `Tag: ${name}`;
  return {
    kind: "setTag",
    label,
    apply(doc) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const id of ids) {
        const prev = doc.solids.get(id);
        if (!prev) continue;
        forward.set(id, { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, tag: name } });
        backward.set(id, prev);
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}

/**
 * Show or hide a whole tag. Visibility lives in each solid's meta (not in a
 * tag table) so a project file needs no second source of truth: hiding a tag
 * is exactly setting `hidden` on every object wearing it, one undo step.
 */
export function setTagVisible(tag: string, visible: boolean): Command {
  const name = tag.trim();
  const label = `${visible ? "Show" : "Hide"} tag ${name}`;
  return {
    kind: "setTagVisible",
    label,
    apply(doc) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const solid of doc.solids.values()) {
        if (solid.meta.tag !== name || solid.meta.hidden === !visible) continue;
        forward.set(solid.id, { ...solid, revision: solid.revision + 1, meta: { ...solid.meta, hidden: !visible } });
        backward.set(solid.id, solid);
      }
      return patchOf(doc, forward, backward, label);
    },
  };
}

/** Every tag in use, sorted, with how many visible and hidden objects wear it. */
export function tagsInUse(doc: DocumentState): { tag: string; total: number; hidden: number }[] {
  const counts = new Map<string, { total: number; hidden: number }>();
  for (const solid of doc.solids.values()) {
    const tag = solid.meta.tag;
    if (tag === "") continue;
    const row = counts.get(tag) ?? { total: 0, hidden: 0 };
    row.total += 1;
    if (solid.meta.hidden) row.hidden += 1;
    counts.set(tag, row);
  }
  return [...counts.entries()]
    .map(([tag, row]) => ({ tag, ...row }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function setOpacity(ids: readonly SolidId[], opacity: number): Command {
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
    throw new RangeError("opacity must be a number from 0 to 1");
  }
  const value = clampOpacity(opacity);
  return {
    kind: "setOpacity",
    label: value === 1 ? "Make opaque" : `Opacity ${Math.round(value * 100)}%`,
    apply(doc) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const id of ids) {
        const prev = doc.solids.get(id);
        if (!prev) continue;
        forward.set(id, { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, opacity: value } });
        backward.set(id, prev);
      }
      return patchOf(doc, forward, backward, "Opacity");
    },
  };
}

/* --------------------------------------------------------------- sections */

/** A section plane: everything on the +side of `offset` along `axis` is hidden. */
export function setSection(plane: SectionPlane | null): Command {
  // Validate at construction: a NaN offset is a caller's bug, and it must fail
  // where the caller can see it, not halfway through an undo transaction.
  if (plane) {
    if (!Number.isFinite(plane.offset)) throw new RangeError("a section plane needs a finite position");
    if (!["x", "y", "z"].includes(plane.axis)) throw new RangeError("section axis must be x, y or z");
  }
  const label = plane ? `Section ${plane.axis.toUpperCase()} at ${Math.round(plane.offset)} mm` : "Clear section";
  return {
    kind: "setSection",
    label,
    apply(doc) {
      return {
        forward: new Map(),
        backward: new Map(),
        envelopeBefore: doc.envelope,
        envelopeAfter: doc.envelope,
        label,
        sectionBefore: doc.section,
        sectionAfter: plane,
      };
    },
  };
}

/** Set or clear the fit envelope. Setting one is not a geometry change. */
export function setEnvelope(envelope: Envelope | null): Command {
  const label = envelope ? "Set fit envelope" : "Clear fit envelope";
  return {
    kind: "setEnvelope",
    label,
    apply(doc) {
      if (envelope) {
        const ok = [0, 1, 2].every(
          (i) =>
            Number.isFinite(envelope.min[i]) &&
            Number.isFinite(envelope.max[i]) &&
            envelope.max[i]! > envelope.min[i]!,
        );
        if (!ok) throw new RangeError("envelope max must exceed min on every axis");
      }
      return {
        forward: new Map(),
        backward: new Map(),
        envelopeBefore: doc.envelope,
        envelopeAfter: envelope,
        label,
      };
    },
  };
}

/** Union of the counted (visible) solids' bounds, computed through `resolve`. */
function modelBounds(doc: DocumentState, resolve: Resolve): Aabb {
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

/** Move the whole model so its centre lands on the envelope centre. */
export function centreInEnvelope(): Command {
  return {
    kind: "centreInEnvelope",
    label: "Centre in envelope",
    apply(doc, ctx) {
      const envelope = doc.envelope;
      if (!envelope) throw new Error("set an envelope first");
      const b = modelBounds(doc, ctx.resolve);
      if (!isFiniteBounds(b)) throw new Error("nothing to centre");
      const delta: Vec3 = [
        (envelope.min[0] + envelope.max[0]) / 2 - (b.min[0] + b.max[0]) / 2,
        (envelope.min[1] + envelope.max[1]) / 2 - (b.min[1] + b.max[1]) / 2,
        (envelope.min[2] + envelope.max[2]) / 2 - (b.min[2] + b.max[2]) / 2,
      ];
      const ids = [...doc.solids.values()].filter((s) => !s.meta.locked && !s.meta.hidden).map((s) => s.id);
      return transformPatch(doc, ids, ctx.resolve, (m) => withTranslation(m, delta), "Centre in envelope");
    },
  };
}

/**
 * Fit to envelope (docs/07 solver): uniform scale about the model's min corner,
 * then slide that corner onto the envelope min. Locked and hidden solids are
 * left alone; if any of them stick out afterwards the fit throws rather than
 * lying about it.
 */
export function fitToEnvelope(): Command {
  return {
    kind: "fitToEnvelope",
    label: "Fit to envelope",
    apply(doc, ctx) {
      const envelope = doc.envelope;
      if (!envelope) throw new Error("set an envelope first");
      const b = modelBounds(doc, ctx.resolve);
      if (!isFiniteBounds(b)) throw new Error("nothing to fit");
      const size: Vec3 = sub3(b.max, b.min);
      const room: Vec3 = sub3(envelope.max, envelope.min);
      const perAxis = [0, 1, 2].map((i) => (size[i]! > 1e-3 ? room[i]! / size[i]! : 1));
      const s = Math.min(1, ...perAxis);
      if (s >= 1 - 1e-9) throw new Error("already fits");
      const pivot = b.min;
      const anchor: Vec3 = [
        envelope.min[0] - pivot[0] * s,
        envelope.min[1] - pivot[1] * s,
        envelope.min[2] - pivot[2] * s,
      ];
      const m = multiply4(translation4(anchor), scale4(s));
      const ids = [...doc.solids.values()].filter((sol) => !sol.meta.locked && !sol.meta.hidden).map((sol) => sol.id);
      return transformPatch(doc, ids, ctx.resolve, (prev) => multiply4(m, prev), "Fit to envelope");
    },
  };
}

/** Kept for callers that only need the first id of a selection. */
export { firstId };
