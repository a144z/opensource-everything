import type { Vec3 } from "@apexus/geometry";
import { edgeMidpoints, infer, vertices, type InferenceInput, type SnapCandidate } from "@apexus/geometry";
import type { Session } from "@apexus/engine";

/**
 * Screen-space snapping for every tool (L1-6).
 *
 * One place decides what "under the cursor" means, so the line, tape, rectangle
 * and move tools all snap identically. Candidates come from the scene meshes that
 * are already uploaded; rebuilding them per hover would be wasteful, so they are
 * cached against the session revision.
 */

export interface SnapSettings {
  /** Axis lock, when the user is holding Shift along an existing edge. */
  readonly axisLock?: Vec3 | null;
  /** Where a locked axis starts. */
  readonly lockOrigin?: Vec3;
  /** Ground grid step in mm; 0 disables. */
  readonly gridStep?: number;
}

interface CandidateCache {
  doc: unknown;
  points: readonly SnapCandidate[];
}

export class Snapper {
  #session: Session;
  #cache: CandidateCache = { doc: null, points: [] };

  constructor(session: Session) {
    this.#session = session;
  }

  /** Every vertex and edge midpoint in the document, rebuilt when it changes. */
  candidates(): readonly SnapCandidate[] {
    const doc = this.#session.document;
    // The document object is replaced by every patch, so identity is the revision.
    if (this.#cache.doc === doc) return this.#cache.points;
    const points: SnapCandidate[] = [];
    for (const id of doc.solids.keys()) {
      let mesh;
      try {
        mesh = this.#session.meshOf(id);
      } catch {
        continue;
      }
      points.push(...vertices(mesh.positions), ...edgeMidpoints(mesh.positions));
    }
    for (const solid of doc.solids.values()) {
      if (solid.meta.hidden) continue;
      // The pivot of each solid, so objects can be aligned to each other.
      const m = solid.recipe.matrix;
      if (m.length === 16) points.push({ kind: "centre", point: [m[12]!, m[13]!, m[14]!] });
    }
    this.#cache = { doc, points };
    return points;
  }

  /** Resolve a raw cursor point into a snapped point plus its glyph. */
  snap(cursor: Vec3, mmPerPixel: number, settings: SnapSettings = {}) {
    const input: InferenceInput = {
      cursor,
      candidates: this.candidates(),
      mmPerPixel,
      axisLock: settings.axisLock ?? null,
      ...(settings.lockOrigin ? { lockOrigin: settings.lockOrigin } : {}),
      gridStep: settings.gridStep ?? 0,
    };
    return infer(input);
  }
}
