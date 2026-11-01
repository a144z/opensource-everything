import type { MeshData, Vec3 } from "@apexus/geometry";
import {
  boundsQuadrants,
  edgeMidpoints,
  faceCentres,
  infer,
  perpendicularFeet,
  vertices,
  type InferenceInput,
  type SnapCandidate,
} from "@apexus/geometry";
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

interface MeshCache {
  doc: unknown;
  entries: readonly (readonly [string, MeshData])[];
}

export class Snapper {
  #session: Session;
  #cache: CandidateCache = { doc: null, points: [] };
  #meshCache: MeshCache = { doc: null, entries: [] };

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
      points.push(...vertices(mesh.positions), ...edgeMidpoints(mesh.positions), ...faceCentres(mesh));
      // Quadrants of each object, so a dimension can be read across an object
      // without hunting for a corner.
      const b = this.#session.boundsOf(id);
      points.push(...boundsQuadrants(b.min, b.max));
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
    const mmPerPx = Number.isFinite(mmPerPixel) && mmPerPixel > 0 ? mmPerPixel : 1;
    const extra: SnapCandidate[] = [];
    // A tool that has a start point (line, tape, move) gets perpendicular and
    // tangent feet relative to it: "drop onto this edge at a right angle" is
    // how SketchUp lets a user place a point exactly above a wall.
    const from = settings.lockOrigin;
    if (from) {
      const reach = Math.max(mmPerPx * 10 * 6, 1);
      for (const [id, mesh] of this.#meshes()) {
        extra.push(...perpendicularFeet(from, mesh, reach));
      }
    }
    const input: InferenceInput = {
      cursor,
      candidates: extra.length ? [...this.candidates(), ...extra] : this.candidates(),
      mmPerPixel: mmPerPx,
      axisLock: settings.axisLock ?? null,
      ...(from ? { lockOrigin: from } : {}),
      gridStep: settings.gridStep ?? 0,
    };
    return infer(input);
  }

  /** Meshes of every solid, cached against the document revision. */
  #meshes(): readonly (readonly [string, MeshData])[] {
    const doc = this.#session.document;
    if (this.#meshCache.doc === doc) return this.#meshCache.entries;
    const entries: [string, MeshData][] = [];
    for (const id of doc.solids.keys()) {
      try {
        entries.push([id, this.#session.meshOf(id)]);
      } catch {
        // A solid that cannot be meshed contributes no snaps.
      }
    }
    this.#meshCache = { doc, entries };
    return entries;
  }
}
