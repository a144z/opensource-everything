/**
 * Units and numeric entry (task L3-9 / L1-12).
 *
 * Everything in the document is millimetres. Display converts. Numeric entry
 * accepts a bare number (in the current display unit), or an explicit suffix:
 * `250`, `25cm`, `2.5m`, `1'`, `12"`, `1200mm`.
 */

export type Unit = "mm" | "cm" | "m" | "in";

export interface UnitSpec {
  readonly id: Unit;
  readonly label: string;
  /** Millimetres per unit. */
  readonly mm: number;
  readonly digits: number;
}

export const UNITS: Readonly<Record<Unit, UnitSpec>> = {
  mm: { id: "mm", label: "mm", mm: 1, digits: 1 },
  cm: { id: "cm", label: "cm", mm: 10, digits: 2 },
  m: { id: "m", label: "m", mm: 1000, digits: 3 },
  in: { id: "in", label: "in", mm: 25.4, digits: 2 },
};

export const UNIT_ORDER: readonly Unit[] = ["mm", "cm", "m", "in"];

export function toDisplay(mm: number, unit: Unit): number {
  return mm / UNITS[unit].mm;
}

export function formatLength(mm: number, unit: Unit = "mm"): string {
  if (!Number.isFinite(mm)) return "";
  const spec = UNITS[unit];
  return `${(mm / spec.mm).toFixed(spec.digits)} ${spec.label}`;
}

/** Format a size triple like `600  400  300 mm`. */
export function formatSize(mm: readonly number[], unit: Unit = "mm"): string {
  return `${mm.map((n) => toDisplay(n, unit).toFixed(UNITS[unit].digits)).join("  ")} ${UNITS[unit].label}`;
}

export interface ParsedLength {
  readonly mm: number;
  readonly unit: Unit;
}

const SUFFIXES: readonly { readonly re: RegExp; readonly mm: number; readonly unit: Unit }[] = [
  { re: /^(.*?)\s*mm$/i, mm: 1, unit: "mm" },
  { re: /^(.*?)\s*cm$/i, mm: 10, unit: "cm" },
  { re: /^(.*?)\s*m$/i, mm: 1000, unit: "m" },
  { re: /^(.*?)\s*in$/i, mm: 25.4, unit: "in" },
  { re: /^(.*?)\s*(?:"|in(?:ch(?:es)?)?)$/i, mm: 25.4, unit: "in" },
  { re: /^(.*?)\s*'$/, mm: 304.8, unit: "in" },
];

/**
 * Parse a typed length. Returns null when it is not a number at all.
 * `defaultUnit` applies to a bare number; an explicit suffix always wins,
 * because someone typing `25mm` while in inches means 25 mm.
 */
export function parseLength(text: string, defaultUnit: Unit = "mm"): ParsedLength | null {
  const raw = text.trim();
  if (raw === "") return null;
  for (const s of SUFFIXES) {
    const m = s.re.exec(raw);
    if (!m) continue;
    const value = parseNumber(m[1]!);
    if (value === null) return null;
    return { mm: value * s.mm, unit: s.unit };
  }
  const value = parseNumber(raw);
  if (value === null) return null;
  return { mm: value * UNITS[defaultUnit].mm, unit: defaultUnit };
}

/** Accept `1,5` (decimal comma), `1e3`, leading `+`, trailing junk-free numbers. */
function parseNumber(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse `600x400x300` (any of x, , *, spaces) into mm sizes. */
export function parseSize(text: string, defaultUnit: Unit = "mm"): number[] | null {
  const parts = text
    .trim()
    .split(/\s*[x*,\s]\s*/i)
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const part of parts) {
    const parsed = parseLength(part, defaultUnit);
    if (!parsed) return null;
    out.push(parsed.mm);
  }
  return out;
}

/** Snapping helpers shared by every tool. */
export function snap(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

export function snapVec(v: readonly number[], step: number): [number, number, number] {
  return [snap(v[0]!, step), snap(v[1]!, step), snap(v[2]!, step)];
}
