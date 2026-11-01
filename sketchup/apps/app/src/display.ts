/**
 * Units of display. The document is always millimetres; this module is the only
 * place that decides how a number becomes text, because a length means nothing
 * without its unit.
 *
 * This is a view concern, not a document one: the chosen unit never enters
 * `.fcproj` and never grows the undo stack. `parseLength`/`UNITS` in
 * `@apexus/geometry` stay the single parser, so typing `2'` in a tool keeps
 * meaning the same thing whatever the display is set to.
 */

import { UNITS as UNIT_SPECS, parseLength, type Unit } from "@apexus/geometry";

export type { Unit };

/** One line per unit: the id used in storage and the words shown in the menu. */
export const UNIT_MENU: readonly { readonly id: Unit; readonly label: string }[] = [
  { id: "mm", label: "Millimetres" },
  { id: "cm", label: "Centimetres" },
  { id: "m", label: "Metres" },
  { id: "in", label: "Inches" },
];

/** `UNITS` is keyed in mm/cm/m/in order; the menu follows the same order. */
export const UNIT_IDS: readonly Unit[] = UNIT_MENU.map((u) => u.id);

export function isUnit(value: string): value is Unit {
  return value in UNIT_SPECS;
}

/**
 * Architectural inches, the way a tape measure reads: `1.20 m` is metric, but
 * `3' 4 1/2"` is what Inches means. Sixteenths are the smallest division
 * because that is the finest mark on a ruler, not because of a float limit.
 */
export function formatFeetInches(mm: number): string {
  if (!Number.isFinite(mm)) return "";
  const sign = mm < 0 ? "-" : "";
  const sixteenths = Math.round((Math.abs(mm) / 25.4) * 16);
  const feet = Math.floor(sixteenths / 192);
  const rest = sixteenths - feet * 192;
  const inches = Math.floor(rest / 16);
  const fraction = reduce(rest - inches * 16, 16);

  const inchText = `${inches}${fraction === "" ? "" : ` ${fraction}`}\"`;
  const footText = feet === 0 ? "" : `${feet}'`;
  return sign + [footText, inchText].filter((s) => s !== "").join(" ");
}

/** `12`/`16` -> `3/4`; a zero numerator gives the empty string. */
function reduce(numerator: number, denominator: number): string {
  if (numerator === 0) return "";
  let a = numerator;
  let b = denominator;
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return `${numerator / a}/${denominator / a}`;
}

/**
 * A length in the given unit, with its symbol. Inches gets the architectural
 * form; everything else is `<number><symbol>` with the unit's own precision,
 * so `12 mm` and `1.20 cm` are not both written `12.00`.
 */
export function formatLengthIn(unit: Unit, mm: number): string {
  if (!Number.isFinite(mm)) return "";
  if (unit === "in") return formatFeetInches(mm);
  const spec = UNIT_SPECS[unit];
  return `${(mm / spec.mm).toFixed(spec.digits)}${spec.label}`;
}

/** `600 × 400 × 300 mm`, in the current unit, keeping the unit's precision. */
export function formatSizeIn(unit: Unit, mm: readonly number[]): string {
  if (unit === "in") return mm.map(formatFeetInches).join(" × ");
  const spec = UNIT_SPECS[unit];
  return `${mm.map((n) => (n / spec.mm).toFixed(spec.digits)).join(" × ")}${spec.label}`;
}

/**
 * Turn typed text into millimetres in the current display unit. An explicit
 * suffix always wins, so `25mm` typed while in inches is still 25 mm.
 */
export function parseIn(unit: Unit, text: string): number | null {
  return parseLength(text, unit)?.mm ?? null;
}
