/**
 * Annotations: reference geometry attached to model points.
 *
 * An annotation is a note, not a solid. It never contributes to bounds, never
 * joins a boolean, and never fails the fit check -- otherwise a dimension line
 * hanging off the edge of a part would read as the part being too big. That is
 * the one rule this whole module exists to keep.
 *
 * `annotations.model.ts` is the generated half (records, enums, predicates);
 * this file holds the behaviour: axis maths, storage, and the formatting rules.
 */

import type { Vec3 } from "@apexus/geometry";
import { ANNOTATIONKIND, Annotation } from "./annotations.model.js";
import type { AnnotationInit, AnnotationKind, DimensionAxis } from "./annotations.model.js";

export {
  ANNOTATIONKIND,
  ALL_ANNOTATIONKIND,
  DIMENSIONAXIS,
  ALL_DIMENSIONAXIS,
  Annotation,
  isAnnotationKind,
  isDimensionAxis,
  measureDimension,
  annotationDefaults,
  DIMENSIONCHECK_KEYS,
  matchDimensionCheck,
} from "./annotations.model.js";
export type {
  AnnotationInit,
  AnnotationKind,
  DimensionAxis,
  DimensionMeasurement,
} from "./annotations.model.js";

/** Axis vector for a measured dimension. `free` has no single axis. */
export function axisVector(axis: DimensionAxis): Vec3 {
  switch (axis) {
    case "x":
      return [1, 0, 0];
    case "y":
      return [0, 1, 0];
    case "z":
      return [0, 0, 1];
    case "free":
      return [0, 0, 0];
  }
}

/**
 * Length a dimension reports.
 *
 * Along an axis it reports the extent on that axis only, which is what a
 * cabinetmaker means by "width": two points on a diagonal still give the width.
 * `free` reports true point-to-point distance. Signed, so the caller can orient
 * the witness lines without re-deriving which end moved.
 */
export function dimensionLength(a: Vec3, b: Vec3, axis: DimensionAxis): number {
  if (axis === "free") {
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const i = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  return b[i] - a[i];
}

/** The axis that best explains the span between two points. */
export function guessAxis(a: Vec3, b: Vec3): DimensionAxis {
  const d: Vec3 = [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])];
  const longest = Math.max(d[0], d[1], d[2]);
  if (longest <= 1e-9) return "free";
  if (d[0] === longest) return "x";
  if (d[1] === longest) return "y";
  return "z";
}

let counter = 0;

/** Create an annotation. Text may be left empty; the app formats the length. */
export function makeAnnotation(init: Partial<AnnotationInit> & { a: Vec3; b: Vec3 }): Annotation {
  counter += 1;
  const axis = init.axis ?? guessAxis(init.a, init.b);
  return new Annotation({
    id: init.id ?? `ann${counter}`,
    kind: init.kind ?? ANNOTATIONKIND.dimension,
    a: init.a,
    b: init.b,
    axis,
    offset: init.offset ?? 12,
    text: init.text ?? "",
  });
}

/**
 * Annotations keyed by id, replaceable as one unit.
 *
 * Deliberately not a `Solid`: no history patch, no mesh. Moving a dimension is
 * cheap and never invalidates the fit cache, which is the point of keeping the
 * two model apart. `toJSON` keeps the project file honest.
 */
export class AnnotationStore {
  #notes = new Map<string, Annotation>();

  get size(): number {
    return this.#notes.size;
  }

  /** Insertion order, so the view draws them in the order the user made them. */
  all(): readonly Annotation[] {
    return [...this.#notes.values()];
  }

  get(id: string): Annotation | undefined {
    return this.#notes.get(id);
  }

  add(annotation: Annotation): Annotation {
    if (this.#notes.has(annotation.id)) throw new Error(`duplicate annotation ${annotation.id}`);
    this.#notes.set(annotation.id, annotation);
    return annotation;
  }

  /** Replace by id; returns the previous value so a caller can undo. */
  replace(annotation: Annotation): Annotation {
    const previous = this.#notes.get(annotation.id);
    if (!previous) throw new Error(`unknown annotation ${annotation.id}`);
    this.#notes.set(annotation.id, annotation);
    return previous;
  }

  remove(id: string): Annotation | undefined {
    const previous = this.#notes.get(id);
    this.#notes.delete(id);
    return previous;
  }

  /** Annotations attached to no point in particular (labels pinned in space). */
  byKind(kind: AnnotationKind): readonly Annotation[] {
    return this.all().filter((note) => note.kind === kind);
  }

  toJSON(): readonly Annotation[] {
    return this.all();
  }
}
