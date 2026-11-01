import type { Aabb, Vec3 } from "@apexus/geometry";
import { analyseMesh, isFiniteBounds } from "./analyze.js";
import type { Command } from "./command.js";
import { multiply4, scale4, sub3, translation4, withTranslation } from "./math.js";
import { transformPatch, type Resolve } from "./seams.js";
import type { DocumentState, Envelope, SolidId } from "./types.js";

/**
 * The fit envelope (docs/07): the wedge. Everything here answers one question ?? * "does the model, or the next edit, still fit the space it was commissioned for?"
 *
 * The envelope lives on `DocumentState` and every command carries it before/after
 * in its patch, so setting one is undoable like any other edit and never a
 * geometry change.
 */

/** Set or clear the fit envelope. Setting one is not a geometry change. */
export function setEnvelope(envelope: Envelope | null): Command {
  const label = envelope ? "Set fit envelope" : "Clear fit envelope";
  return {
    kind: "setEnvelope",
    label,
    apply(doc) {
      if (envelope) {
        const ok = [0, 1, 2].every(
          (i) =>
            Number.isFinite(envelope.min[i]) &&
            Number.isFinite(envelope.max[i]) &&
            envelope.max[i]! > envelope.min[i]!,
        );
        if (!ok) throw new RangeError("envelope max must exceed min on every axis");
      }
      return {
        forward: new Map(),
        backward: new Map(),
        envelopeBefore: doc.envelope,
        envelopeAfter: envelope,
        label,
      };
    },
  };
}

/** Union of the counted (visible) solids' bounds, computed through `resolve`. */
export function modelBounds(doc: DocumentState, resolve: Resolve): Aabb {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const solid of doc.solids.values()) {
    if (solid.meta.hidden) continue;
    const b = analyseMesh(resolve(solid.recipe)).bounds;
    min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[1]), Math.min(min[2], b.min[2])];
    max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[1]), Math.max(max[2], b.max[2])];
  }
  return { min, max };
}

/** Move the whole model so its centre lands on the envelope centre. */
export function centreInEnvelope(): Command {
  return {
    kind: "centreInEnvelope",
    label: "Centre in envelope",
    apply(doc, ctx) {
      const envelope = doc.envelope;
      if (!envelope) throw new Error("set an envelope first");
      const b = modelBounds(doc, ctx.resolve);
      if (!isFiniteBounds(b)) throw new Error("nothing to centre");
      const delta: Vec3 = [
        (envelope.min[0] + envelope.max[0]) / 2 - (b.min[0] + b.max[0]) / 2,
        (envelope.min[1] + envelope.max[1]) / 2 - (b.min[1] + b.max[1]) / 2,
        (envelope.min[2] + envelope.max[2]) / 2 - (b.min[2] + b.max[2]) / 2,
      ];
      const ids = movableIds(doc);
      return transformPatch(doc, ids, ctx.resolve, (m) => withTranslation(m, delta), "Centre in envelope");
    },
  };
}

/**
 * Fit to envelope (docs/07 solver): uniform scale about the model's min corner,
 * then slide that corner onto the envelope min. Locked and hidden solids are
 * left alone; if any of them stick out afterwards the fit throws rather than
 * lying about it.
 */
export function fitToEnvelope(): Command {
  return {
    kind: "fitToEnvelope",
    label: "Fit to envelope",
    apply(doc, ctx) {
      const envelope = doc.envelope;
      if (!envelope) throw new Error("set an envelope first");
      const b = modelBounds(doc, ctx.resolve);
      if (!isFiniteBounds(b)) throw new Error("nothing to fit");
      const size: Vec3 = sub3(b.max, b.min);
      const room: Vec3 = sub3(envelope.max, envelope.min);
      // The emptiest axis does not constrain the scale: a flat panel's zero
      // thickness must not be read as "needs scaling to infinity".
      const perAxis = [0, 1, 2].map((i) => (size[i]! > 1e-3 ? room[i]! / size[i]! : 1));
      const s = Math.min(1, ...perAxis);
      if (s >= 1 - 1e-9) throw new Error("already fits");
      const pivot = b.min;
      const anchor: Vec3 = [
        envelope.min[0] - pivot[0] * s,
        envelope.min[1] - pivot[1] * s,
        envelope.min[2] - pivot[2] * s,
      ];
      const m = multiply4(translation4(anchor), scale4(s));
      // `transformPatch` multiplies onto each solid's own matrix; composing the
      // fit on the left keeps it a world-space operation for every object.
      return transformPatch(doc, movableIds(doc), ctx.resolve, (prev) => multiply4(m, prev), "Fit to envelope");
    },
  };
}

/** The objects a whole-model operation may touch: not locked, not hidden. */
function movableIds(doc: DocumentState): readonly SolidId[] {
  return [...doc.solids.values()].filter((s) => !s.meta.locked && !s.meta.hidden).map((s) => s.id);
}
