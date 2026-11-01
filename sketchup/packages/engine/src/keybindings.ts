/**
 * A user's keymap: the generated defaults, with the user's changes on top.
 *
 * Three rules, each because the alternative quietly breaks something:
 *
 *   1. A change is stored as the *canonical* form (`ctrl+shift+g`), not the
 *      typed form (`Ctrl+Shift+G`). Lookup compares canonical strings, so a
 *      stored spelling that only looks right would never fire.
 *   2. Binding a key already in use is refused, and says who holds it. Two
 *      commands on one shortcut means one of them silently never runs, and it
 *      is not always the one the user just set.
 *   3. Unbinding is `null`, distinct from "never changed" (absent), so a user
 *      who clears `Delete` does not get it back on reload.
 *
 * This module is pure: no DOM, no storage. The app owns where the overrides are
 * kept, so the same rules can serve a file or a test without any of them
 * knowing about `localStorage`.
 */

import { canonicalShortcut } from "./keymap.js";

/** Command id -> specification. `null` means deliberately unbound. */
export type KeyOverrides = Readonly<Record<string, string | null>>;

export type BindResult =
  | { readonly ok: true; readonly overrides: KeyOverrides }
  | { readonly ok: false; readonly reason: "taken" | "reserved" | "empty"; readonly holder?: string };

/**
 * Keys that no single command may claim, because the browser needs them or the
 * editor does while the user is typing. Refusing them up front beats binding
 * `Ctrl+R`, which reloads the page and looks like a crash.
 */
const RESERVED = new Set(["ctrl+r", "ctrl+w", "ctrl+t", "ctrl+n", "ctrl+shift+i", "ctrl+shift+j", "f5", "f11", "f12", "alt+tab"]);

/**
 * The effective table: generated defaults, then overrides applied.
 * An override of `null` removes the shortcut rather than restoring the default.
 */
export function effectiveKeys(defaults: Readonly<Record<string, string>>, overrides: KeyOverrides): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [id, spec] of Object.entries(defaults)) out[id] = canonicalShortcut(spec);
  for (const [id, spec] of Object.entries(overrides)) {
    if (!(id in defaults)) continue; // a command that no longer exists
    out[id] = spec === null ? undefined : canonicalShortcut(spec);
  }
  return out;
}

/** The command currently holding a canonical shortcut, if any. */
export function holderOf(table: Readonly<Record<string, string | undefined>>, shortcut: string, ignore?: string): string | undefined {
  for (const [id, spec] of Object.entries(table)) {
    if (id !== ignore && spec !== undefined && spec === shortcut) return id;
  }
  return undefined;
}

/**
 * Bind `command` to `spec`, refusing a clash instead of creating a dead
 * shortcut. Returns a new overrides object; the old one is untouched, so a
 * refused binding changes nothing anywhere.
 */
export function bindShortcut(
  defaults: Readonly<Record<string, string>>,
  overrides: KeyOverrides,
  command: string,
  spec: string,
): BindResult {
  if (!(command in defaults)) return { ok: false, reason: "empty" };
  const wanted = canonicalShortcut(spec);
  if (wanted.trim() === "") return { ok: false, reason: "empty" };
  if (RESERVED.has(wanted)) return { ok: false, reason: "reserved" };
  const table = effectiveKeys(defaults, overrides);
  const holder = holderOf(table, wanted, command);
  if (holder !== undefined) return { ok: false, reason: "taken", holder };
  return { ok: true, overrides: { ...overrides, [command]: spec } };
}

/** Remove a command's shortcut (and keep it removed across reloads). */
export function unbindShortcut(overrides: KeyOverrides, command: string): KeyOverrides {
  return { ...overrides, [command]: null };
}

/** Back to the generated default for one command. */
export function resetShortcut(overrides: KeyOverrides, command: string): KeyOverrides {
  const next = { ...overrides };
  delete next[command];
  return next;
}

/** Back to every generated default. */
export function resetAll(): KeyOverrides {
  return {};
}

/**
 * Parse overrides from storage. This is the boundary where a hand-edited or
 * stale blob becomes either a usable keymap or nothing: anything unrecognised is
 * dropped per entry rather than discarding the whole file, and a value that is
 * neither a string nor null is ignored.
 */
export function parseOverrides(raw: string | null | undefined): KeyOverrides {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const out: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null) out[id] = null;
    else if (typeof value === "string" && value.trim() !== "") out[id] = value;
  }
  return out;
}

/**
 * The overrides as storage text. Stable key order, so it does not churn.
 *
 * Shortcuts are written in canonical form (`alt+q`), not as typed: storage is
 * read back and compared as text by the editor and by anyone opening the file,
 * so one key must have exactly one spelling on disk.
 */
export function serialiseOverrides(overrides: KeyOverrides): string {
  const sorted: Record<string, string | null> = {};
  for (const id of Object.keys(overrides).sort()) {
    const spec = overrides[id] ?? null;
    sorted[id] = spec === null ? null : canonicalShortcut(spec);
  }
  return JSON.stringify(sorted);
}

/** Every shortcut a command could be bound to, for the editor's list. */
export function conflicts(defaults: Readonly<Record<string, string>>, overrides: KeyOverrides): string[] {
  // A file edited by hand, or two changed at once, can still produce a clash.
  // Reporting it lets the editor mark the rows instead of hiding the problem.
  const table = effectiveKeys(defaults, overrides);
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const [id, spec] of Object.entries(table)) {
    if (spec === undefined) continue;
    const first = seen.get(spec);
    if (first !== undefined) out.push(spec);
    else seen.set(spec, id);
  }
  return out;
}
