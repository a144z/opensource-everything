/**
 * Autosave (task L4-4) and crash recovery (L4-3) as one small pair.
 *
 * The rule the app must never break: saving is something the *user* does, and
 * recovery is something the app does *for* them. So a crash draft is written to
 * a separate slot, never the file they chose, and opening a draft is always an
 * explicit "Recover" action.
 *
 * No journal: the document is small (a recipe per solid, no baked meshes), so a
 * full snapshot every interval is simpler than replay and cannot drift. The
 * slot holds one draft, so it can never grow without bound.
 */

/** The narrow slice of storage this module needs; `localStorage` satisfies it. */
export interface SlotStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Draft {
  /** The document as JSON, exactly what "Save" would have written. */
  readonly json: string;
  /** Epoch milliseconds when the draft was taken. */
  readonly at: number;
  /** The file the user last opened or saved under, if any. */
  readonly fileName: string | null;
}

export const DRAFT_KEY = "fitcheck.draft.v1";

/** Parse a stored draft, dropping anything malformed rather than failing to open. */
export function readDraft(store: SlotStore): Draft | null {
  let raw: string | null = null;
  try {
    raw = store.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  try {
    const value = JSON.parse(raw) as Partial<Draft> | null;
    if (!value || typeof value.json !== "string" || value.json === "") return null;
    const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
    const fileName = typeof value.fileName === "string" && value.fileName !== "" ? value.fileName : null;
    return { json: value.json, at, fileName };
  } catch {
    return null;
  }
}

export function writeDraft(store: SlotStore, draft: Draft): boolean {
  try {
    store.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    // A full quota must not interrupt drawing. Losing the draft is acceptable;
    // losing the session is not.
    return false;
  }
}

export function clearDraft(store: SlotStore): void {
  try {
    store.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to clear, or storage is gone; either way the caller carries on */
  }
}

/**
 * Decide whether a draft is worth offering. A draft older than `maxAgeMs` is too
 * stale to be trusted as "what you were doing", and a draft identical to the
 * saved file is noise after a clean close.
 */
export function draftWorthOffering(
  draft: Draft | null,
  savedJson: string | null,
  now: number,
  maxAgeMs = 7 * 24 * 3600_000,
): boolean {
  if (!draft) return false;
  if (savedJson !== null && draft.json === savedJson) return false;
  return now - draft.at <= maxAgeMs;
}

/** How a draft reads in a prompt: `Recover "desk.fcproj" from 14:05`. */
export function describeDraft(draft: Draft): string {
  const when = new Date(draft.at);
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const name = draft.fileName === null ? "unsaved work" : `"${draft.fileName}"`;
  return `Recover ${name} from ${hh}:${mm}`;
}

/** Called by the app after a real save, so the next change is what triggers a draft. */
export interface SaveMark {
  json: string;
}

/**
 * An interval that only fires when the document changed since the last draft or
 * save. It never asks the document to change, so it cannot touch history, and
 * `tick` is public so a test can drive a whole hour of autosaves in a loop.
 */
export class Autosave {
  #timer: ReturnType<typeof setInterval> | null = null;
  #last = "";
  #paused = false;

  constructor(
    private readonly everyMs: number,
    private readonly snapshot: () => { json: string; fileName: string | null } | null,
    private readonly onWrite: (draft: Draft) => void,
  ) {}

  start(now: () => number = Date.now): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.tick(now()), this.everyMs);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Suspend while a modal asks a question or a file is being written. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  /** Called by the app after a real save: the draft is now redundant. */
  markSaved(json: string): void {
    this.#last = json;
  }

  /** One autosave pass. Returns true when a draft was written. */
  tick(now: number): boolean {
    if (this.#paused) return false;
    const snap = this.snapshot();
    if (!snap) return false;
    if (snap.json === this.#last) return false;
    this.#last = snap.json;
    this.onWrite({ json: snap.json, at: now, fileName: snap.fileName });
    return true;
  }
}
