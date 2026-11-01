/**
 * Live measurements — the number that follows the cursor.
 *
 * This is what separates a drawing tool from a painting tool: while a rectangle
 * is being dragged, the user is told the dimensions *as they will be committed*,
 * in the unit they chose, and typing those digits turns what they see into what
 * they get.
 *
 * **Phases, not just values.** Reading the same colour for "you propose 600" and
 * "you committed 600" is what makes a drawing app feel unreliable, so the phase
 * is explicit: a *proposed* value is the cursor's current aim, a *committed* one
 * is what the last click wrote, a *typed* one overrides both until the cursor
 * moves again.
 *
 * The module is pure and takes no DOM: the caller owns where the text appears.
 */

import { formatLengthIn, formatSizeIn, type Unit } from "./display.js";

export type MeasurePhase = "proposed" | "committed" | "typed";

export interface MeasureValue {
  readonly phase: MeasurePhase;
  /** The label in front: `Length`, `Width × Depth`, `Angle`. */
  readonly label: string;
  /** Formatted already, so one unit decision produces one string. */
  readonly text: string;
  /** The prompt after it: what a click or a key will do next. */
  readonly prompt: string;
}

export const NO_MEASURE: MeasureValue = { phase: "proposed", label: "", text: "", prompt: "" };

/**
 * Angle between two ground points, in degrees from +X toward +Y, always 0..360.
 * A line drawn upward reports 90, one drawn to the left 180: SketchUp's sense.
 */
export function angleOnGround(from: readonly [number, number], to: readonly [number, number]): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return 0;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** `90°`, not `90.0°`; one decimal is enough to aim with. */
export function formatAngle(deg: number): string {
  const rounded = Math.round(deg * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}°`;
}

/**
 * A length reading. The unit always comes from the display setting, so the
 * number the user types and the number they read never disagree.
 */
export function lengthValue(
  label: string,
  mm: number,
  unit: Unit,
  prompt = "",
  phase: MeasurePhase = "proposed",
): MeasureValue {
  return { phase, label, text: formatLengthIn(unit, mm), prompt };
}

export function sizeValue(
  label: string,
  mm: readonly number[],
  unit: Unit,
  prompt = "",
  phase: MeasurePhase = "proposed",
): MeasureValue {
  return { phase, label, text: formatSizeIn(unit, mm), prompt };
}

export function angleValue(deg: number, prompt = "", phase: MeasurePhase = "proposed"): MeasureValue {
  return { phase, label: "Angle", text: formatAngle(deg), prompt };
}

/** Typed text wins over the cursor's proposal until the next mouse move. */
export function typedValue(text: string, prompt: string): MeasureValue {
  return { phase: "typed", label: "", text, prompt };
}

/**
 * The status line: the measurement first because the eye tracks it, then the
 * prompt. Empty parts are dropped, so a tool with nothing to say leaves no
 * stray separators behind.
 */
export function statusLine(measure: MeasureValue): string {
  return [measure.text, measure.label, measure.prompt].filter((s) => s !== "").join("   ·   ");
}

/** A rectangle dragged from `a` to `b`: its two edge lengths, to 0.01 mm. */
export function rectangleSize(a: readonly [number, number], b: readonly [number, number]): readonly [number, number] {
  return [round2(Math.abs(b[0] - a[0])), round2(Math.abs(b[1] - a[1]))];
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A typed rectangle size: `600,400` sets both edges. One number is refused
 * rather than guessed at, because "which edge did they mean?" has no answer the
 * app is entitled to invent.
 */
export function typedRectangleSize(text: string): readonly [number, number] | null {
  const parts = text
    .split(/[x,;\s]+/)
    .filter((p) => p !== "")
    .map(Number);
  if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n) && n > 0)) return null;
  return [parts[0]!, parts[1]!];
}
