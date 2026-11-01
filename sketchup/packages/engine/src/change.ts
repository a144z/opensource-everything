/**
 * Change detection for `Session`.
 *
 * Every commit reports what it did: which solids appeared, which changed, which
 * went away. The app reconciles its scene from that report, so nothing has to
 * guess by comparing whole documents, and a tool never has to remember to sync.
 *
 * `revision` is bumped per solid on change, which is what lets the app skip a
 * solid it has already built while still rebuilding one whose geometry moved.
 */

import type { Solid, SolidId } from "./types.js";

/** What changed between two documents. `SessionChange` adds the cause on top. */export type SolidDiff = {
  /** Ids that now exist and did not before. */
  readonly added: readonly SolidId[];
  /** Ids that existed before and after, with new content or metadata. */
  readonly updated: readonly SolidId[];
  /** Ids that existed before and do not now. */
  readonly removed: readonly SolidId[];
  /** The label of the command that caused the change, for the status line. */
  readonly label: string;
};

export const EMPTY_CHANGE: SolidDiff = { added: [], updated: [], removed: [], label: "" };

export function isEmptyChange(change: SolidDiff): boolean {
  return change.added.length === 0 && change.updated.length === 0 && change.removed.length === 0;
}

/**
 * What differs between two documents, ignoring order.
 *
 * A solid counts as updated when its revision or metadata moved. Recipe content
 * is not deep-compared: a recipe change always arrives with a revision bump, so
 * trusting the counter is both cheaper and never misses an edit.
 */
export function diffSolids(
  before: ReadonlyMap<SolidId, Solid>,
  after: ReadonlyMap<SolidId, Solid>,
  label = "",
): SolidDiff {
  const added: SolidId[] = [];
  const updated: SolidId[] = [];
  const removed: SolidId[] = [];
  for (const [id, solid] of after) {
    const old = before.get(id);
    if (!old) added.push(id);
    else if (old.revision !== solid.revision || !sameMeta(old, solid)) updated.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, updated, removed, label };
}

function sameMeta(a: Solid, b: Solid): boolean {
  return (
    a.meta.name === b.meta.name &&
    a.meta.color === b.meta.color &&
    a.meta.hidden === b.meta.hidden &&
    a.meta.locked === b.meta.locked &&
    a.meta.opacity === b.meta.opacity &&
    a.meta.roughness === b.meta.roughness &&
    a.meta.metallic === b.meta.metallic &&
    a.meta.tag === b.meta.tag
  );
}
