// Generated file. Do not edit by hand; regenerate from its source of record. Source: annotations.

import type { Vec3 } from '@apexus/geometry';
/** What a sticky note in the model is for. Each kind draws differently. */
export const ANNOTATIONKIND = {
  dimension: 'dimension',
  label: 'label',
  leader: 'leader',
} as const;

export type AnnotationKind = (typeof ANNOTATIONKIND)[keyof typeof ANNOTATIONKIND];

/** All values, in declaration order. */
export const ALL_ANNOTATIONKIND: readonly AnnotationKind[] = ['dimension', 'label', 'leader'];

export function isAnnotationKind(value: unknown): value is AnnotationKind {
  return typeof value === 'string' && (ALL_ANNOTATIONKIND as readonly string[]).includes(value);
}

/** Axis a dimension measures along. `free` measures the true point-to-point distance. */
export const DIMENSIONAXIS = {
  x: 'x',
  y: 'y',
  z: 'z',
  free: 'free',
} as const;

export type DimensionAxis = (typeof DIMENSIONAXIS)[keyof typeof DIMENSIONAXIS];

/** All values, in declaration order. */
export const ALL_DIMENSIONAXIS: readonly DimensionAxis[] = ['x', 'y', 'z', 'free'];

export function isDimensionAxis(value: unknown): value is DimensionAxis {
  return typeof value === 'string' && (ALL_DIMENSIONAXIS as readonly string[]).includes(value);
}

/** A note attached to model coordinates. Annotations are reference geometry: they never take part in the fit check and never contribute to bounds. */
export interface AnnotationInit {
  /** Stable id, unique within the document. */
  id: string;
  /** Dimension, label or leader. */
  kind: AnnotationKind;
  /** First point, world space, millimetres. */
  a: Vec3;
  /** Second point, world space, millimetres. */
  b: Vec3;
  /** Axis measured along. */
  axis: DimensionAxis;
  /** Distance the line sits off the span, mm. */
  offset: number;
  /** User override; empty means format the length. */
  text: string;
}

/** A note attached to model coordinates. Annotations are reference geometry: they never take part in the fit check and never contribute to bounds. */
export class Annotation {
  /** Stable id, unique within the document. */
  id: string;
  /** Dimension, label or leader. */
  kind: AnnotationKind;
  /** First point, world space, millimetres. */
  a: Vec3;
  /** Second point, world space, millimetres. */
  b: Vec3;
  /** Axis measured along. */
  axis: DimensionAxis;
  /** Distance the line sits off the span, mm. */
  offset: number;
  /** User override; empty means format the length. */
  text: string;
  constructor(init: AnnotationInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.a = init.a;
    this.b = init.b;
    this.axis = init.axis;
    this.offset = init.offset;
    this.text = init.text;
  }
}

/** A note attached to model coordinates. Annotations are reference geometry: they never take part in the fit check and never contribute to bounds. Every field null until filled; handy for forms and for tests. */
export const annotationDefaults = () => ({
  id: null as string | null,
  kind: null as AnnotationKind | null,
  a: null as Vec3 | null,
  b: null as Vec3 | null,
  axis: null as DimensionAxis | null,
  offset: null as number | null,
  text: null as string | null,
});

/** Signed length of a dimension along its axis, plus the two points it spans. Pure: no document access, so it is cheap to call every frame while dragging. */
export interface DimensionMeasurement {
  /** Point the line starts at (world). */
  readonly start: Vec3;
  /** Point the line ends at (world). */
  readonly end: Vec3;
  /** Signed length in mm. Negative when `b` sits before `a` on the axis. */
  readonly length: number;
  /** Axis the length was measured along. */
  readonly axis: DimensionAxis;
}

export function measureDimension(a: Vec3, b: Vec3, axis: DimensionAxis): DimensionMeasurement {
const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const length =
    axis === 'free'
      ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      : b[i]! - a[i]!;
  return { start: a, end: b, length, axis };
}

/** Constraint for dimension check: reject unknown keys, keep known ones. */
export const DIMENSIONCHECK_KEYS = ['a', 'b', 'axis', 'offset', 'text'] as const;
export type DimensionCheckKey = (typeof DIMENSIONCHECK_KEYS)[number];

/** Constraint for dimension check. */
export function matchDimensionCheck(payload: Record<string, unknown>): Partial<Record<DimensionCheckKey, unknown>> {
  const out: Partial<Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(payload)) {
    switch (key) {
    case 'a':
      out[key] = value;
      break;
    case 'b':
      out[key] = value;
      break;
    case 'axis':
      out[key] = value;
      break;
    case 'offset':
      out[key] = value;
      break;
    case 'text':
      out[key] = value;
      break;
      default:
        throw new Error(`unknown dimension check key ${key}`);
    }
  }
  return out as Partial<Record<DimensionCheckKey, unknown>>;
}
