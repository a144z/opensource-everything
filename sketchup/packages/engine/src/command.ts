/**
 * Command model (ADR 0003). A command validates, then returns an invertible patch.
 * It must never mutate the document.
 */

import type { MeshData } from "@apexus/geometry";
import type { DocumentState, Envelope, Solid, SolidId, SolidRecipe } from "./types.js";
import type { Patch } from "./history.js";

export interface CommandContext {
  readonly nextId: () => SolidId;
  readonly resolve: (recipe: SolidRecipe) => MeshData;
  /**
   * Resolve as if `solids` were already in the document. Validation needs this:
   * a new instance references a solid the document does not contain yet, and a
   * rewritten recipe is only tested against the graph it will leave behind.
   */
  readonly resolveWith?: (recipe: SolidRecipe, solids: ReadonlyMap<SolidId, Solid>) => MeshData;
}

export interface Command {
  readonly kind: string;
  readonly label: string;
  apply(doc: DocumentState, ctx: CommandContext): Patch;
}

/**
 * Assemble a patch. `removed` is derived here rather than hand-written in each
 * command: any solid that exists before and is null afterwards is gone as far
 * as the forward direction is concerned.
 */
export function patchOf(
  doc: DocumentState,
  forward: ReadonlyMap<SolidId, Solid | null>,
  backward: ReadonlyMap<SolidId, Solid | null>,
  label: string,
  envelopeAfter: Envelope | null = doc.envelope,
  section?: { before: DocumentState["section"] | undefined; after: DocumentState["section"] | undefined },
): Patch {
  const removed: SolidId[] = [];
  for (const [id, solid] of forward) if (solid === null) removed.push(id);
  const base: Patch = {
    forward,
    backward,
    envelopeBefore: doc.envelope,
    envelopeAfter,
    label,
    removed,
  };
  // Optional fields are only present when a command actually moved them; with
  // `exactOptionalPropertyTypes` an explicit `undefined` is not the same thing.
  if (!section) return base;
  return { ...base, sectionBefore: section.before ?? null, sectionAfter: section.after ?? null };
}
