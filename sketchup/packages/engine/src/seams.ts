import { triangulateRing, type MeshData } from "@apexus/geometry";
import { analyseMesh, isFiniteBounds } from "./analyze.js";
import { patchOf } from "./command.js";
import type { Patch } from "./history.js";
import { DEFAULT_COLORS, clampOpacity, clampUnit } from "./types.js";
import type { DocumentState, Solid, SolidId, SolidMeta, SolidRecipe } from "./types.js";

/**
 * The rules every command obeys, in one place.
 *
 * These are the invariants a command suite has in common: a solid must exist, a
 * recipe must mesh to a positive volume, a new solid gets a default name and
 * colour, and a transform is applied by rewriting the recipe's matrix. They used
 * to live at the top of `commands.ts`, which meant every command module imported
 * the module that imported them. Separating them makes the dependency direction
 * honest: command modules depend on the rules, never the other way round.
 */

export type Resolve = (recipe: SolidRecipe) => MeshData;

/** The one "is this id real" rule. A stale id is a bug, never a silent no-op. */
export function requireSolid(doc: DocumentState, id: SolidId): Solid {
  const solid = doc.solids.get(id);
  if (!solid) throw new Error(`unknown solid ${id}`);
  return solid;
}

/** The first id of a selection, or a throw. Kept here because many commands need it. */
export function firstId(ids: readonly SolidId[]): SolidId {
  const id = ids[0];
  if (!id) throw new Error("select at least one object");
  return id;
}

/** A human label for a recipe, used for default names and error messages. */
export function labelFor(recipe: SolidRecipe): string {
  switch (recipe.kind) {
    case "box":
      return "Box";
    case "extrude":
      return "Face";
    case "loop":
      return "Loop";
    case "face":
      return "Face";
    case "edge":
      return "Edge";
    case "boolean":
      return recipe.op === "union" ? "Union" : recipe.op === "difference" ? "Cut" : "Intersect";
    case "transform":
      return "Copy";
    case "instance":
      return "Instance";
    case "group":
      return "Group";
    case "mesh":
      return "Mesh";
    case "lathe":
      return "Lathe";
  }
}

/** Validate by actually meshing it; a command must never emit junk geometry. */
export function assertSolidRecipe(recipe: SolidRecipe, resolve: Resolve): void {
  const geo = analyseMesh(resolve(recipe));
  if (!isFiniteBounds(geo.bounds)) throw new RangeError(`${labelFor(recipe)} produced no geometry`);
  if (!(geo.volume > 0)) throw new RangeError(`${labelFor(recipe)} produced a solid with no volume`);
}

/**
 * Validate a face, the one object with no volume to check.
 *
 * `assertSolidRecipe` asks "does this enclose something", which a face by
 * definition does not, so a face gets the surface-shaped version of the same
 * question: a real ring, some area in it, and a triangulation that exists. The
 * mesh is resolved as well, because that is what the renderer and the picker
 * will use; a ring that cannot be triangulated must be refused here rather than
 * becoming an invisible object nobody can select.
 */
export function assertFaceRecipe(
  recipe: Extract<SolidRecipe, { kind: "face" }>,
  resolve: Resolve,
): void {
  if (recipe.points.length < 3) throw new RangeError("a face needs at least three points");
  let area2 = 0;
  for (let i = 0, j = recipe.points.length - 1; i < recipe.points.length; j = i++) {
    const p = recipe.points[i]!;
    const q = recipe.points[j]!;
    area2 += q[0] * p[1] - p[0] * q[1];
  }
  if (Math.abs(area2) / 2 < 1e-9) throw new RangeError("face has zero area");
  // `faceMesh` normalises the plane, so a degenerate normal must be refused here
  // with the RangeError callers of this validator expect.
  if (recipe.plane.normal[0] === 0 && recipe.plane.normal[1] === 0 && recipe.plane.normal[2] === 0) {
    throw new RangeError("face has a zero-length plane normal");
  }
  if (triangulateRing(recipe.points).length < 3) {
    throw new RangeError("face could not be triangulated (self-intersecting?)");
  }
  const geo = analyseMesh(resolve(recipe));
  if (!isFiniteBounds(geo.bounds)) throw new RangeError("Face produced no geometry");
  if (geo.mesh.indices.length === 0) throw new RangeError("face could not be triangulated (self-intersecting?)");
}

/**
 * An edge path, validated by meshing it.
 *
 * An edge has no volume, so the volume rule in `assertSolidRecipe` would refuse
 * every one; the honest checks are that two distinct points survive and that the
 * result is finite. Segment collapses are dropped by the mesher, so a chain that
 * doubles back on itself is legal as long as it has length.
 */
export function assertEdgeRecipe(recipe: Extract<SolidRecipe, { kind: "edge" }>, resolve: Resolve): void {
  if (recipe.points.length < 2) throw new RangeError("an edge needs at least two points");
  if (recipe.plane.normal[0] === 0 && recipe.plane.normal[1] === 0 && recipe.plane.normal[2] === 0) {
    throw new RangeError("edge has a zero-length plane normal");
  }
  const geo = analyseMesh(resolve(recipe));
  if (!isFiniteBounds(geo.bounds)) throw new RangeError("Edge produced no geometry");
  if (geo.mesh.indices.length === 0) throw new RangeError("an edge needs two distinct points");
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

/**
 * Replace the `matrix` of `ids` with `next(oldMatrix)` as one patch.
 *
 * Only the first new matrix is meshed: every solid's own primitive numbers are
 * unchanged (docs/06), so the same matrix that keeps one solid sound keeps all
 * of them sound. Locked solids are skipped. An empty patch is a valid no-op.
 *
 * A stale id is a bug, not a no-op: silently moving "nothing" hides the bug and
 * reports success. A locked solid is the opposite case, deliberate and visible in
 * the outliner, so it is skipped on purpose.
 */
export function transformPatch(
  doc: DocumentState,
  ids: readonly SolidId[],
  resolve: Resolve,
  next: (m: readonly number[]) => readonly number[],
  label: string,
): Patch {
  const forward = new Map<SolidId, Solid | null>();
  const backward = new Map<SolidId, Solid | null>();
  let checked = false;
  for (const id of ids) {
    const prev = requireSolid(doc, id);
    if (prev.meta.locked) continue;
    const recipe = { ...prev.recipe, matrix: next(prev.recipe.matrix) };
    if (!checked) {
      assertSolidRecipe(recipe, resolve);
      checked = true;
    }
    forward.set(id, { ...prev, revision: prev.revision + 1, recipe });
    backward.set(id, prev);
  }
  return patchOf(doc, forward, backward, label);
}

/**
 * A command that only changes metadata, applied to every id in one patch.
 *
 * Colour, opacity, finish, tag and lock are all "write these fields on these
 * objects": one helper keeps them one undo step and one label, and stops a
 * objects": one helper keeps them one undo step and one label, and stops a
 * sixth copy of the same six-line loop appearing when the next field arrives.
 */
export function metaPatch(
  doc: DocumentState,
  ids: readonly SolidId[],
  next: (meta: SolidMeta, solid: Solid) => SolidMeta | null,
  label: string,
): Patch {
  const forward = new Map<SolidId, Solid | null>();
  const backward = new Map<SolidId, Solid | null>();
  for (const id of ids) {
    const prev = doc.solids.get(id);
    if (!prev) continue;
    const meta = next(prev.meta, prev);
    if (meta === null) continue;
    forward.set(id, { ...prev, revision: prev.revision + 1, meta });
    backward.set(id, prev);
  }
  return patchOf(doc, forward, backward, label);
}
