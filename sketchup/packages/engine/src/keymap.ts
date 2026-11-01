/**
 * Keyboard shortcuts, reduced to one canonical form.
 *
 * The generated table writes human shortcuts (`Ctrl+Shift+Z`, ` `, `Delete`)
 * and the browser reports keys in its own shape (`e.key`, `e.ctrlKey`). Both
 * go through `bindKey` so a mismatch can never be a matter of spelling. The
 * rules are deliberately small and total:
 *
 *   - modifiers come first, in the fixed order Ctrl, Meta, Alt, Shift;
 *   - the key is lower-cased, so `R` and `r` are one shortcut;
 *   - `meta` is folded into `ctrl`, so a Mac and a PC share the table.
 */

export type Bindable = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

/** `"Ctrl+Shift+Z"` -> `"ctrl+shift+z"`; `" "` -> `" "`. */
export function normaliseShortcut(spec: string): string {
  // Split on separators that are actually followed by something, so a literal
  // "+" held down with Ctrl ("Ctrl++") keeps its plus as the key.
  // A shortcut of a single space (Select) must keep that space; trimming is for
  // the modifiers and for stray padding in the table, not for the key itself.
  const raw = spec.split(/\+(?=.)/);
  const key = raw.pop() ?? "";
  const mods = new Set(
    raw.map((p) => p.trim().toLowerCase()).map((p) => (p === "meta" || p === "cmd" ? "ctrl" : p)),
  );
  const order = ["ctrl", "alt", "shift"].filter((m) => mods.has(m));
  return [...order, key.toLowerCase()].join("+");
}

/**
 * The canonical form of a real key event.
 *
 * Letters, digits and space are case-insensitive because Shift only changes
 * their case. Punctuation is not: Shift turns `/` into `?`, and a user who
 * types `?` means the `?` key, not `Shift+/`.
 */
export function bindKey(e: Bindable): string {
  // Shift on a single printable key is already "in" the character the event
  // reports (`?` arrived as `?`, `R` as `R`). Counting Shift as a modifier as
  // well would make the shortcut `shift+?`, which nothing could ever type; and
  // KeyZ already carries `z` with shiftKey set, so Ctrl+Shift+Z still works.
  const printable = /^[\x20-\x7e]$/.test(e.key);
  const key = printable ? e.key.toLowerCase() : e.key;
  const mods = [
    e.ctrlKey || e.metaKey ? "ctrl" : "",
    e.altKey ? "alt" : "",
    e.shiftKey && !printable ? "shift" : "",
  ].filter((m) => m !== "");
  return [...mods, key].join("+");
}

/** The command a key event names, or null. Ties favour the first entry. */
export function commandForEvent(
  table: Readonly<Record<string, string | undefined>>,
  e: Bindable,
): string | null {
  const pressed = bindKey(e);
  for (const [id, spec] of Object.entries(table)) {
    if (spec !== undefined && normaliseShortcut(spec) === pressed) return id;
  }
  return null;
}
