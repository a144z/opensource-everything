import { describe, expect, it } from "vitest";
import {
  ALL_ANNOTATIONKIND,
  ANNOTATIONKIND,
  Annotation,
  AnnotationStore,
  DIMENSIONAXIS,
  Session,
  addSolid,
  axisVector,
  checkDocumentFit,
  dimensionLength,
  guessAxis,
  isAnnotationKind,
  isDimensionAxis,
  makeAnnotation,
  matchDimensionCheck,
  measureDimension,
  setEnvelope,
  type SolidRecipe,
} from "../src/index.js";

/**
 * Annotations are reference geometry. The one thing that must never break is
 * that a dimension line hanging off a part cannot make the part "not fit" --
 * otherwise the app's core promise (every push/pull is checked against your
 * envelope) turns into noise the moment a user measures anything.
 */

// The import block above is written out explicitly so `Annotation` is a value.
// (Kept alphabetical; vitest sorts nothing.)

const box: SolidRecipe = { kind: "box", width: 100, height: 50, depth: 20, origin: [0, 0, 0] };

describe("measureDimension", () => {
  it("measures extent along an axis, not the diagonal", () => {
    const m = measureDimension([0, 0, 0], [30, 40, 0], DIMENSIONAXIS.x);
    expect(m.length).toBe(30);
    expect(m.end).toEqual([30, 40, 0]);
  });

  it("is signed, so the caller knows which end moved", () => {
    expect(measureDimension([30, 0, 0], [0, 0, 0], DIMENSIONAXIS.x).length).toBe(-30);
  });

  it("measures true distance for a free dimension", () => {
    expect(measureDimension([0, 0, 0], [3, 4, 12], DIMENSIONAXIS.free).length).toBeCloseTo(13, 10);
  });

  it("agrees with dimensionLength for every axis", () => {
    const a = [1, 2, 3] as const;
    const b = [7, -4, 9] as const;
    for (const axis of [DIMENSIONAXIS.x, DIMENSIONAXIS.y, DIMENSIONAXIS.z, DIMENSIONAXIS.free]) {
      expect(measureDimension(a, b, axis).length).toBeCloseTo(dimensionLength(a, b, axis), 10);
    }
  });
});

describe("annotations never touch the model", () => {
  it("does not change bounds, fit or the document", () => {
    const session = new Session();
    session.execute(addSolid(box));
    session.execute(setEnvelope({ min: [0, 0, 0], max: [100, 50, 20] }));
    const before = session.document;
    const fitBefore = checkDocumentFit(before);

    const store = new AnnotationStore();
    store.add(makeAnnotation({ a: [0, 0, 0], b: [500, 0, 0], axis: DIMENSIONAXIS.x }));

    expect(store.size).toBe(1);
    // The dimension reaches 400 mm past the envelope wall; the model still fits.
    expect(session.document).toBe(before);
    expect(checkDocumentFit(session.document)).toEqual(fitBefore);
    expect(fitBefore.pass).toBe(true);
    expect(fitBefore.offenders).toEqual([]);
  });
});

describe("AnnotationStore", () => {
  it("refuses a duplicate id so two notes cannot shadow each other", () => {
    const store = new AnnotationStore();
    const note = makeAnnotation({ a: [0, 0, 0], b: [1, 0, 0] });
    store.add(note);
    expect(() => store.add(note)).toThrow(/duplicate/);
  });

  it("replace returns the previous value, so a caller can undo", () => {
    const store = new AnnotationStore();
    const note = store.add(makeAnnotation({ a: [0, 0, 0], b: [1, 0, 0] }));
    const longer = { ...note, b: [10, 0, 0] as const };
    const previous = store.replace(longer);
    expect(previous.b).toEqual([1, 0, 0]);
    expect(store.get(note.id)?.b).toEqual([10, 0, 0]);
  });

  it("keeps insertion order and filters by kind", () => {
    const store = new AnnotationStore();
    store.add(makeAnnotation({ a: [0, 0, 0], b: [1, 0, 0] }));
    store.add(makeAnnotation({ a: [0, 0, 1], b: [0, 0, 2], kind: ANNOTATIONKIND.label }));
    expect(store.all().map((n) => n.kind)).toEqual([ANNOTATIONKIND.dimension, ANNOTATIONKIND.label]);
    expect(store.byKind(ANNOTATIONKIND.dimension)).toHaveLength(1);
  });

  it("survives a JSON round trip", () => {
    const store = new AnnotationStore();
    store.add(makeAnnotation({ a: [1, 2, 3], b: [4, 5, 6] }));
    const restored = new AnnotationStore();
    for (const note of JSON.parse(JSON.stringify(store.toJSON()))) restored.add(note);
    expect(restored.all()).toEqual(store.all());
  });
});

describe("generated annotation model", () => {
  it("guards every value the spec declared", () => {
    expect(isAnnotationKind("dimension")).toBe(true);
    expect(isAnnotationKind("sketch")).toBe(false);
    expect(isDimensionAxis("free")).toBe(true);
    expect(isDimensionAxis("w")).toBe(false);
    expect(ALL_ANNOTATIONKIND).toEqual(["dimension", "label", "leader"]);
  });

  it("rejects an unknown dimension payload key", () => {
    expect(matchDimensionCheck({ axis: "x", offset: 5 })).toEqual({ axis: "x", offset: 5 });
    expect(() => matchDimensionCheck({ sneaky: 1 })).toThrow(/unknown/);
  });

  it("gives free dimensions no axis vector", () => {
    expect(axisVector(DIMENSIONAXIS.z)).toEqual([0, 0, 1]);
    expect(axisVector(DIMENSIONAXIS.free)).toEqual([0, 0, 0]);
  });

  it("guesses the dominant axis of a span", () => {
    expect(guessAxis([0, 0, 0], [1, 9, 2])).toBe("y");
    expect(guessAxis([0, 0, 0], [0, 0, 0])).toBe("free");
  });
});
