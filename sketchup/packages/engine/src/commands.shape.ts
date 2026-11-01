import type { Vec2, Vec3 } from "@apexus/geometry";
import { patchOf, type Command } from "./command.js";
import { identity4, withRotation, withScale, withTranslation } from "./math.js";
import { assertEdgeRecipe, assertFaceRecipe, assertSolidRecipe, newMeta, requireSolid, transformPatch } from "./seams.js";
import type { Solid, SolidId, SolidMeta, SolidRecipe } from "./types.js";

/**
 * Shape edits: push/pull and the rigid transforms.
 *
 * These are the gestures a modeller makes continuously, so they are the ones
 * whose maths must never drift. Nothing here bakes geometry: a transform only
 * rewrites a solid's matrix, and push/pull only rewrites an extrusion's own
 * `distance`, so a moved or rotated face still grows along its own normal.
 */

/* ------------------------------------------------------------ faces */

/**
 * Add a zero-thickness face: the rectangle tool's result, and the base every
 * push/pull starts from.
 *
 * It is a document object like any other (picked, selected, renamed), so it
 * goes through `newMeta` and gets a name and colour; only the validity rule
 * differs, because a face has area and no volume.
 */
export function addFace(
  points: readonly Vec2[],
  plane: { readonly origin: Vec3; readonly normal: Vec3 },
  meta?: Partial<SolidMeta>,
): Command {
  const recipe: Extract<SolidRecipe, { kind: "face" }> = { kind: "face", points, plane, matrix: identity4() };
  return {
    kind: "addFace",
    label: "Add Face",
    apply(doc, ctx) {
      assertFaceRecipe(recipe, ctx.resolve);
      const id = ctx.nextId();
      const solid: Solid = { id, revision: 1, recipe, meta: newMeta(doc, recipe, meta) };
      return patchOf(doc, new Map([[id, solid]]), new Map([[id, null]]), `Add ${solid.meta.name}`);
    },
  };
}

/**
 * Add an open run of edges: the line tool's chain, left unclosed.
 *
 * One object for the whole chain, not one per segment, so a scribbled outline is
 * a single row in the outliner and a single undo step. It is not a surface: no
 * area, no volume, so push/pull and the BOQ ignore it, but it is picked,
 * selected and snapped to like anything else.
 */
export function addEdges(
  points: readonly Vec2[],
  plane: { readonly origin: Vec3; readonly normal: Vec3 },
  meta?: Partial<SolidMeta>,
): Command {
  const recipe: Extract<SolidRecipe, { kind: "edge" }> = { kind: "edge", points, plane, matrix: identity4() };
  return {
    kind: "addEdges",
    label: "Add Edges",
    apply(doc, ctx) {
      assertEdgeRecipe(recipe, ctx.resolve);
      const id = ctx.nextId();
      const solid: Solid = { id, revision: 1, recipe, meta: newMeta(doc, recipe, meta) };
      return patchOf(doc, new Map([[id, solid]]), new Map([[id, null]]), `Add ${solid.meta.name}`);
    },
  };
}

/**
 * A face becomes a solid by adding a `distance` to the same ring and plane, so
 * the extrusion is the face's own profile grown along its own normal. The ring
 * is not re-aimed: the user drew it once, and what push/pull changes is only how
 * far it goes.
 */
function extrudeFace(recipe: Extract<SolidRecipe, { kind: "face" }>, distance: number): SolidRecipe {
  return {
    kind: "loop",
    points: recipe.points,
    plane: recipe.plane,
    distance,
    matrix: recipe.matrix,
  };
}

/* ---------------------------------------------------------- push/pull */

/**
 * Push/pull (docs/03: the one gesture that matters).
 *
 * Changes the extrusion's own `distance`; the recipe matrix is untouched, so a
 * moved or rotated face still grows along its own normal (task X-3). A box has
 * no `distance`, so its push/pull replaces the whole recipe. A zero-thickness
 * face is the base case: it converts to an extrusion of the same points and
 * plane, because growing a face *is* what makes a solid. Accepts
 * `pullFace(id, recipe)` (tests) and `pullFace(id, distance)` (app, extrusion,
 * loop or face).
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
        if (r.kind === "face") {
          if (!(Number.isFinite(recipeOrDistance) && recipeOrDistance > 1e-3)) {
            throw new RangeError("pull distance must be positive");
          }
          recipe = extrudeFace(r, recipeOrDistance);
        } else if (r.kind === "extrude" || r.kind === "loop") {
          recipe = { ...r, distance: recipeOrDistance };
        } else {
          throw new Error("push/pull by distance needs a face, extruded face or loop");
        }
      } else {
        recipe = recipeOrDistance;
      }
      if (recipe.kind === "extrude" || recipe.kind === "loop") {
        if (!(Number.isFinite(recipe.distance) && recipe.distance > 1e-3)) {
          throw new RangeError("pull distance must be positive");
        }
      }
      assertSolidRecipe(recipe, ctx.resolve);
      const next: Solid = { ...prev, revision: prev.revision + 1, recipe };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), "Push/Pull");
    },
  };
}

/**
 * Change an extrusion's height by a delta (drag math lives in the app).
 *
 * On a face the delta is the whole distance: the face has none yet, so a drag of
 * 300 mm makes a 300 mm solid rather than a 300 mm adjustment to nothing.
 */
export function pullBy(id: SolidId, delta: number): Command {
  return {
    kind: "pullBy",
    label: "Push/Pull",
    apply(doc, ctx) {
      const prev = requireSolid(doc, id);
      const r = prev.recipe;
      if (r.kind !== "extrude" && r.kind !== "loop" && r.kind !== "face") {
        throw new Error("push/pull needs a face, extruded face or loop");
      }
      const distance = r.kind === "face" ? delta : r.distance + delta;
      // Validate first, so a push past zero is refused before history grows.
      if (!(distance > 1e-3)) throw new RangeError("pull distance must be positive");
      const recipe: SolidRecipe = r.kind === "face" ? extrudeFace(r, distance) : { ...r, distance };
      assertSolidRecipe(recipe, ctx.resolve);
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
    label: "Move",
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

/**
 * Uniform scale about a grabbed point, so the point under the cursor stays put.
 *
 * `factor` is already the ratio the user's drag produced; this clamps it once
 * rather than per object (scaling 0.001 to death), refuses non-finite values,
 * and skips locked solids like every other transform. Unlike `scaleSolids`,
 * the pivot is mandatory: a scale tool always scales about something the user
 * pointed at, and defaulting it to the world origin would be a silent surprise.
 */
export function scaleAbout(ids: readonly SolidId[], factor: number, pivot: Vec3): Command {
  return {
    kind: "scaleAbout",
    label: "Scale",
    apply(doc, ctx) {
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new RangeError("scale factor must be positive and finite");
      }
      if (!pivot.every(Number.isFinite)) throw new RangeError("scale pivot must be finite");
      // 1e-6 .. 1e6 keeps every dimension inside double range for any model.
      const f = Math.min(Math.max(factor, 1e-6), 1e6);
      if (Math.abs(f - 1) < 1e-9) return patchOf(doc, new Map(), new Map(), "No change");
      return transformPatch(doc, ids, ctx.resolve, (m) => withScale(m, [f, f, f], pivot), "Scale");
    },
  };
}

/** The two in-plane directions a turn about `axis` is measured between. */
export function planeBasis(axis: Axis): { u: Vec3; v: Vec3 } {
  // A right-handed pair around the axis, so a positive angle is the same
  // direction the right-hand rule (and `withRotation` below) gives. Getting this
  // backwards turns the object the other way while the hint says otherwise.
  if (axis === "x") return { u: [0, 1, 0], v: [0, 0, 1] };
  if (axis === "y") return { u: [0, 0, 1], v: [1, 0, 0] };
  return { u: [1, 0, 0], v: [0, 1, 0] };
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
      for (const id of ids) assertSolidRecipe({ ...requireSolid(doc, id).recipe, matrix }, ctx.resolve);
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
