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

import type { Solid, SolidId, SolidMeta } from "./types.js";

/**
 * What changed between two documents. Exists so `SessionChange` (session.ts)
 * can add its cause (`kind`, `touched`) on top of one shared shape, and so a
 * listener can be typed without importing the whole `Session` module.
 */
export type SolidDiff = {
  /** Ids that now exist and did not before. */
  readonly added: readonly SolidId[];
  /** Ids that existed before and after, with new content or metadata. */
  readonly updated: readonly SolidId[];
  /** Ids that existed before and do not now. */
  readonly removed: readonly SolidId[];
  /** The label of the command that caused the change, for the status line. */
  readonly label: string;
};

/**
 * What differs between two documents, ignoring order.
 *
 * A solid counts as updated when its revision or metadata moved. Recipe content
 * is not deep-compared: a recipe change always arrives with a revision bump, so
 * trusting the counter is both cheaper and never misses an edit. Metadata is
 * still compared because a label-only edit (rename, tag) is cheap to see and a
 * renderer only needs to repaint it — the revision check alone would report it
 * as updated anyway, this makes the two cases distinguishable.
 *
 * The only consumer is `Session` (execute / batch / undo / redo / load), which
 * turns the result into a `SessionChange` and emits it.
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
    else if (old.revision !== solid.revision || !sameMeta(old.meta, solid.meta)) updated.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, updated, removed, label };
}

/**
 * Field-by-field equality of the two metadata records. Compares every field
 * (rather than the object identity) because a command rebuilds `meta` from a
 * spread even when it writes back the same value; comparing references would
 * turn those no-ops into "updated" reports.
 */
function sameMeta(a: SolidMeta, b: SolidMeta): boolean {
  return (
    a.name === b.name &&
    a.color === b.color &&
    a.hidden === b.hidden &&
    a.locked === b.locked &&
    a.opacity === b.opacity &&
    a.roughness === b.roughness &&
    a.metallic === b.metallic &&
    a.tag === b.tag
  );
}
