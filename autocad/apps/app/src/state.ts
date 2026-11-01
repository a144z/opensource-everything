import type { DocumentState } from "@apexus/cad";
import { CadSession, compositeCommand } from "@apexus/cad";

/**
 * The one mutable holder of app state, and the one place that knows when
 * something changed.
 *
 * Every mutation goes through `edit()`, which runs an engine `Command` on the
 * session, keeps the selection honest after undo (an erased entity cannot stay
 * selected) and tells the shell to redraw. A presenter that changes the
 * document any other way would leave the canvas stale, so there is no other way.
 */
export interface Settings {
  osnap: boolean;
  ortho: boolean;
  gridSnap: boolean;
  polar: boolean;
  showGrid: boolean;
  layerColors: boolean;
}

export class AppState {
  readonly session = new CadSession();
  /** Snap and view toggles; the shell owns the buttons, tools read them. */
  settings: Settings = { osnap: true, ortho: false, gridSnap: true, polar: false, showGrid: true, layerColors: true };
  /** Bumped on every change; presenters compare, nobody polls. */
  version = 0;
  /** Monotonic id for generate-new-ids gestures (explode, join, trim). */
  #gen = 0;
  readonly listeners = new Set<() => void>();

  get doc(): DocumentState {
    return this.session.doc;
  }

  nextGen = (): string => {
    this.#gen += 1;
    return `g${this.#gen}_`;
  };

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run one command; returns the engine's verdict so the caller can report it. */
  edit(command: Parameters<CadSession["run"]>[0]): { ok: boolean; error?: string } {
    const r = this.session.run(command);
    if (!r.ok) return { ok: false, error: r.error };
    this.#settle();
    return { ok: true };
  }

  /** Several edits from one gesture (trim several lines) as one undo step. */
  editMany(commands: readonly Parameters<CadSession["run"]>[0][], label: string): { ok: boolean; error?: string; ran: number } {
    const wrap = compositeCommand(label, commands);
    const r = this.session.run(wrap);
    if (!r.ok) return { ok: false, ...(r.error !== undefined ? { error: r.error } : {}), ran: 0 };
    this.#settle();
    return { ok: true, ran: commands.length };
  }

  undo(): boolean {
    const ok = this.session.undo();
    if (ok) this.#settle();
    return ok;
  }

  redo(): boolean {
    const ok = this.session.redo();
    if (ok) this.#settle();
    return ok;
  }

  load(doc: DocumentState): void {
    this.session.load(doc);
    this.#settle();
  }

  select(ids: readonly string[]): void {
    this.session.selection = [...new Set(ids)];
    this.touch();
  }

  set hover(id: string | null) {
    if (this.session.hover === id) return;
    this.session.hover = id;
    this.touch();
  }

  touch(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  /** After a command: drop ids the document no longer has out of the selection. */
  #settle(): void {
    const kept = this.session.selection.filter((id) => this.session.doc.entities.has(id));
    if (kept.length !== this.session.selection.length) this.session.selection = kept;
    this.touch();
  }
}
