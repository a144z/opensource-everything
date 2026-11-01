/** History: invertible patches and the undo/redo stacks (ADR 0003). */

import type { DocumentState, Envelope, Solid, SolidId } from "./types.js";

export interface Patch {
  readonly forward: ReadonlyMap<SolidId, Solid | null>;
  readonly backward: ReadonlyMap<SolidId, Solid | null>;
  readonly envelopeBefore: Envelope | null;
  readonly envelopeAfter: Envelope | null;
  readonly label: string;
}

export function applyPatch(
  doc: DocumentState,
  patch: Patch,
  direction: "forward" | "backward",
): DocumentState {
  const map = direction === "forward" ? patch.forward : patch.backward;
  const envelope = direction === "forward" ? patch.envelopeAfter : patch.envelopeBefore;
  if (map.size === 0 && envelope === doc.envelope) return doc;
  const solids = new Map(doc.solids);
  for (const [id, solid] of map) {
    if (solid === null) solids.delete(id);
    else solids.set(id, solid);
  }
  return { schemaVersion: doc.schemaVersion, units: doc.units, envelope, solids };
}

export interface HistoryEntry {
  readonly label: string;
  readonly patch: Patch;
}

export class History {
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #limit: number;

  constructor(limit = 500) {
    this.#limit = Math.max(1, limit);
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get labels(): readonly string[] {
    return this.#undo.map((e) => e.label);
  }

  get depth(): number {
    return this.#undo.length;
  }

  push(entry: HistoryEntry): void {
    this.#undo.push(entry);
    if (this.#undo.length > this.#limit) this.#undo.shift();
    this.#redo = [];
  }

  takeUndo(): HistoryEntry | null {
    const entry = this.#undo.pop() ?? null;
    if (entry) this.#redo.push(entry);
    return entry;
  }

  takeRedo(): HistoryEntry | null {
    const entry = this.#redo.pop() ?? null;
    if (entry) this.#undo.push(entry);
    return entry;
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }
}
