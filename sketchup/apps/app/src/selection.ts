import { ancestorsThroughGroups, descendantsOf, type DocumentState, type SolidId } from "@apexus/engine";

/**
 * Selection and the group context (task L2-1, L2-2).
 *
 * Both are *app* state, not document state: neither enters the undo stack nor the
 * project file. They live here rather than in the composition root because they
 * are the only two pieces of state a click, a drag, a keyboard shortcut and the
 * outliner all read, and three modules reading one `let` is how they drift.
 *
 * This module is pure: it takes a document as an argument and never imports the
 * session, so it is testable without a DOM or a kernel.
 */

/** A selection is an unordered set of object ids, held in click order for the UI. */
export type Selection = ReadonlySet<SolidId>;

export const EMPTY_SELECTION: Selection = new Set();

/**
 * Apply one pick to the selection, SketchUp's way.
 *
 * A plain click *replaces*. Shift toggles the single object, because that is how
 * a user builds a set one at a time. A drag or a lasso *replaces too* and uses
 * its own additive rule, which is a different rule and lives with the gesture:
 * toggling a set of twelve at once is never what a drag meant.
 */
export function applyPick(current: Selection, id: SolidId, additive: boolean): Selection {
  if (!additive) return new Set([id]);
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Drop ids that no longer name a live solid.
 *
 * Undo can remove an object the user has selected (group, then undo). A selection
 * that names nothing is worse than an empty one: the next Delete silently does
 * nothing and the panel renders a row that cannot be clicked.
 */
export function pruneSelection(doc: DocumentState, selection: Selection): Selection {
  let changed = false;
  const next = new Set<SolidId>();
  for (const id of selection) {
    if (doc.solids.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selection;
}

/** The only object a transform gizmo can attach to, or null. */
export function soleSelection(selection: Selection): SolidId | null {
  if (selection.size !== 1) return null;
  return [...selection][0] ?? null;
}

/* ------------------------------------------------------------ group context */

/**
 * The group the user is inside, or null at the model's top level.
 *
 * Entering a group changes what a click *means*, not what the model *is*, so it
 * must never enter the undo stack or the file. It exists so a click can reach a
 * member instead of being swallowed by the group that owns it.
 */
export type Context = SolidId | null;

/**
 * Is this group something a user can step into?
 *
 * An empty group has nothing inside to edit, so double-clicking it would move the
 * context to a place where every click misses. It is reported as not enterable so
 * the caller can leave the context alone rather than pretend.
 */
export function canEnter(doc: DocumentState, id: SolidId): boolean {
  const solid = doc.solids.get(id);
  if (!solid || solid.recipe.kind !== "group") return false;
  return solid.recipe.members.length > 0;
}

/**
 * Step one level out. Returns the parent group's id, or null at the top level.
 *
 * `ancestorsThroughGroups` is ordered nearest-first, so `[0]` is the group that
 * directly owns the current context.
 */
export function contextAfterExit(doc: DocumentState, context: Context): Context {
  if (context === null) return null;
  return ancestorsThroughGroups(doc, context)[0] ?? null;
}

/**
 * A context that no longer names a live group is dropped.
 *
 * Called after every change rather than trusted to every command: a context can
 * be undone away (delete, ungroup, then Ctrl+Z), and routing a click into nothing
 * is the one failure a user cannot diagnose from the screen.
 */
export function sanitiseContext(doc: DocumentState, context: Context): Context {
  if (context === null) return null;
  const solid = doc.solids.get(context);
  if (!solid || solid.recipe.kind !== "group") return null;
  return context;
}

/** Inclusive containment with a hair of slack for float noise at a face. */
export function boundsContain(
  b: { min: readonly number[]; max: readonly number[] },
  p: readonly number[],
): boolean {
  const slack = 1e-6;
  for (let i = 0; i < 3; i++) {
    if (p[i]! < b.min[i]! - slack || p[i]! > b.max[i]! + slack) return false;
  }
  return true;
}

/**
 * Map a hit on a drawn mesh onto the object the current context points at.
 *
 * Meshes exist only for drawn solids, so a click always lands on a root or a
 * referenced child. Inside a group the user means the member under the cursor, so
 * walk the group's members and keep the innermost one whose bounds contain the hit
 * point. The point is the ray's impact on the group's surface, so a member the
 * user can see is a member that contains it; the innermost wins when a child sits
 * inside its parent's box, which is the one on top.
 *
 * `boundsOf` is injected rather than a session: this is pure lookup over a graph.
 */
export function resolveHit(
  doc: DocumentState,
  context: Context,
  hitId: SolidId,
  point: readonly number[],
  boundsOf: (id: SolidId) => { min: readonly number[]; max: readonly number[] },
): SolidId {
  if (context === null) return hitId;
  let current = doc.solids.get(hitId);
  if (!current || current.recipe.kind !== "group") return hitId;
  let best: SolidId | null = null;
  // Descend while the object under the point is still a group. Each level
  // prefers the member that owns the context, so following the user into a
  // nested group keeps landing on the objects they are working with.
  for (;;) {
    const recipe = current.recipe;
    if (recipe.kind !== "group") break;
    const under = recipe.members.filter((m) => boundsContain(boundsOf(m), point));
    if (under.length === 0) break;
    const next = under.find((m) => m === context || descendantsOf(doc, m).includes(context)) ?? under[0]!;
    best = next;
    const child = doc.solids.get(next);
    if (!child) break;
    current = child;
  }
  return best ?? hitId;
}
