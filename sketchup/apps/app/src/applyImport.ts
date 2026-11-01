/**
 * Route a decoded file into the document (tasks L3-1/L3-2/L3-3).
 *
 * `importers.ts` decides what a file *means*: its unit, its name, its triangles.
 * This module is the only place that turns that decision into document changes,
 * so the rules are not re-typed inside an event handler. It takes the `Session`
 * rather than a view, and it returns ids, so a test can drive it with no canvas.
 *
 * Nothing here chooses a unit or renames anything: `readImport` already did both.
 */

import { addFace, addSolid, type Session, type SolidId, type Vec3 } from "@apexus/engine";
import { counterClockwise } from "@apexus/geometry";
import type { ImportOutcome } from "./importers.js";

export interface AppliedImport {
  readonly ids: readonly SolidId[];
  /** What the user is told, in one sentence. */
  readonly message: string;
}

/** Every imported DXF outline is placed on the ground, facing up. */
const GROUND_PLANE = { origin: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };

/**
 * Apply an import. An error outcome is thrown as a real error, because a caller
 * that asked to apply something the reader refused has a bug or a user to tell;
 * either way it must not look like success.
 */
export function applyImport(session: Session, outcome: ImportOutcome): AppliedImport {
  if (outcome.kind === "error") throw new Error(outcome.reason);

  if (outcome.kind === "mesh") {
    const patch = session.execute(addSolid(outcome.recipe, { name: outcome.name }));
    const ids = [...patch.forward.keys()];
    if (ids.length === 0) throw new Error(`${outcome.name}: the solid did not survive its own check.`);
    return { ids, message: `${outcome.name} imported. ${outcome.note}` };
  }

  // An outline is a flat profile, not a solid: each ring becomes a face, which
  // the user may then push/pull into one. A face rather than a zero-thickness
  // loop, because that is what an outline is — a surface with area and no
  // volume — and the engine refuses a loop whose distance is not positive.
  // Rings are wound consistently, so two imports of the same drawing do not
  // differ by which side faces out.
  const ids: SolidId[] = [];
  for (const ring of outcome.loops) {
    const patch = session.execute(addFace(counterClockwise(ring), GROUND_PLANE, { name: `${outcome.name} outline` }));
    ids.push(...patch.forward.keys());
  }
  if (ids.length === 0) {
    throw new Error(`${outcome.name}: no outline had three usable points, so nothing was added.`);
  }
  return {
    ids,
    message: `${outcome.name} imported. ${outcome.note} Push/pull an outline to make it solid.`,
  };
}
