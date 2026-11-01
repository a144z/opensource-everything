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
}

export interface Command {
  readonly kind: string;
  readonly label: string;
  apply(doc: DocumentState, ctx: CommandContext): Patch;
}

export function patchOf(
  doc: DocumentState,
  forward: ReadonlyMap<SolidId, Solid | null>,
  backward: ReadonlyMap<SolidId, Solid | null>,
  label: string,
  envelopeAfter: Envelope | null = doc.envelope,
): Patch {
  return { forward, backward, envelopeBefore: doc.envelope, envelopeAfter, label };
}
