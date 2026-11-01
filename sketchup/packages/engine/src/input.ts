/**
 * Typed numeric input: the text a user types while a tool is active, turned
 * into numbers the engine can act on.
 *
 * This lives in the engine, not in the app, because the rules are about meaning,
 * not about drawing: what `500`, `,500` and `500;0` mean must not depend on
 * which widget received the keystrokes. SketchUp uses `;` as its axis separator
 * and accepts `@`/`<` for angle in rotated input; the comma is the one every
 * keyboard has, so it is the one this reader accepts, and `;` with it.
 */

import type { Unit, Vec3 } from "@apexus/geometry";
import { parseLength } from "@apexus/geometry";

const SEPARATORS = /[;,]/;

/**
 * A typed move offset: `500`, `500,0`, `,500,0`, `500;-250`.
 *
 * Missing trailing axes are zero. A blank between separators means "zero on
 * this axis", which is how a pure Y move is typed: `,500`. Returns null on
 * anything unreadable, rather than guessing a direction: a move in the wrong
 * direction is worse than a refusal.
 */
export function deltaFromText(text: string, unit: Unit): Vec3 | null {
  const parts = text.split(SEPARATORS);
  if (parts.length > 3) return null;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!.trim();
    if (raw === "") continue;
    const parsed = parseLength(raw, unit);
    if (!parsed || !Number.isFinite(parsed.mm)) return null;
    out[i] = parsed.mm;
  }
  return out;
}

/**
 * A typed angle in degrees: `45`, `-30`, `45.5`. Returns null when the text is
 * not a finite number, so the caller can say so instead of turning by NaN.
 */
export function angleFromText(text: string): number | null {
  const t = text.trim().replace(/\u00b0$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
