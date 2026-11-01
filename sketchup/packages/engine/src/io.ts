/**
 * `.fcproj` persistence (ADR 0004). Versioned JSON, forward-only migrations,
 * validation at the boundary.
 *
 * The file stores recipes, never vertices (except imported meshes), so a project
 * is small and every future feature can re-mesh it.
 */

import type { DocumentState, Envelope, SectionPlane, Solid, SolidId, SolidMeta, SolidRecipe } from "./types.js";
import { SCHEMA_VERSION, clampOpacity } from "./types.js";
import { emptyDocumentState } from "./commands.js";

export interface SerializedSolid {
  readonly id: SolidId;
  readonly revision: number;
  readonly recipe: SolidRecipe;
  readonly meta: SolidMeta;
}

export interface SerializedDocument {
  readonly schemaVersion: number;
  readonly units: "mm";
  readonly envelope: Envelope | null;
  readonly solids: readonly SerializedSolid[];
  readonly section: SectionPlane | null;
}

export function serialize(doc: DocumentState): SerializedDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    units: "mm",
    envelope: doc.envelope,
    solids: [...doc.solids.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    section: doc.section,
  };
}

export function serializeJson(doc: DocumentState): string {
  return JSON.stringify(serialize(doc), null, 2) + "\n";
}

type Raw = Record<string, unknown>;
type Upgrader = (raw: Raw) => Raw;

/**
 * Migration chain. 1 is the first shipped schema (recipes carry no matrix;
 * `matrix` was added after 1 shipped, so a 1-file simply defaults to identity).
 * Add an entry here and raise SCHEMA_VERSION when the format next changes.
 *
 * 1 -> 2: added `meta.opacity`, `meta.tag` and top-level `section`. Every new
 * field is optional on read with a default that reproduces 1-file behaviour
 * (opaque, untagged, no cut), so the step only marks the file as understood.
 */
const MIGRATIONS: Record<number, Upgrader> = {
  1: (raw) => ({ ...raw, schemaVersion: 2 }),
};

export function deserialize(raw: unknown): DocumentState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("project must be a JSON object");
  }
  let data = raw as Raw;
  let version = typeof data["schemaVersion"] === "number" ? (data["schemaVersion"] as number) : 0;
  if (version < 1) throw new Error("project has no schemaVersion");
  if (version > SCHEMA_VERSION) {
    throw new Error(`project was written by a newer version (schema ${version} > ${SCHEMA_VERSION})`);
  }
  while (version < SCHEMA_VERSION) {
    const upgrade = MIGRATIONS[version];
    if (!upgrade) throw new Error(`no migration path from schema ${version}`);
    data = upgrade(data);
    version += 1;
  }
  const doc = emptyDocumentState();
  const solids = new Map<SolidId, Solid>();
  const list = Array.isArray(data["solids"]) ? (data["solids"] as SerializedSolid[]) : [];
  for (const s of list) {
    if (!s || typeof s.id !== "string") throw new Error("solid entry is missing an id");
    if (!s.recipe || typeof s.recipe !== "object") throw new Error(`solid ${s.id} is missing a recipe`);
    const recipe = validateRecipe(version, s.id, s.recipe);
    solids.set(s.id, {
      id: s.id,
      revision: typeof s.revision === "number" ? s.revision : 1,
      recipe,
      meta: {
        name: typeof s.meta?.name === "string" ? s.meta.name : s.id,
        color: typeof s.meta?.color === "string" ? s.meta.color : "#e8b04b",
        hidden: s.meta?.hidden === true,
        locked: s.meta?.locked === true,
        opacity: clampOpacity(s.meta?.opacity),
        tag: typeof s.meta?.tag === "string" ? s.meta.tag : "",
      },
    });
  }
  // Booleans/transforms must point at solids that exist, and never at themselves.
  for (const solid of solids.values()) {
    const r = solid.recipe;
    const refs = r.kind === "boolean" ? [r.a, r.b] : r.kind === "transform" ? [r.child] : [];
    for (const ref of refs) {
      if (!solids.has(ref)) throw new Error(`solid ${solid.id} references missing solid ${ref}`);
      if (ref === solid.id) throw new Error(`solid ${solid.id} references itself`);
    }
  }
  const envelope = (data["envelope"] as Envelope | null) ?? null;
  if (envelope) {
    const ok = [0, 1, 2].every(
      (i) => Number.isFinite(envelope.min?.[i]) && Number.isFinite(envelope.max?.[i]) && envelope.max[i]! > envelope.min[i]!,
    );
    if (!ok) throw new Error("envelope has invalid bounds");
  }
  const section = readSection(data["section"]);
  return { ...doc, envelope, solids, section };
}

/** A section saved by another build may be absent (old file) or junk (never). */
function readSection(raw: unknown): SectionPlane | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new Error("section must be an object or null");
  const s = raw as Record<string, unknown>;
  const axis = s["axis"];
  if (axis !== "x" && axis !== "y" && axis !== "z") throw new Error("section axis must be x, y or z");
  const offset = s["offset"];
  if (typeof offset !== "number" || !Number.isFinite(offset)) throw new Error("section offset must be a finite number");
  return { axis, offset, flip: s["flip"] === true };
}

export function deserializeJson(text: string): DocumentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON: ${(err as Error).message}`);
  }
  return deserialize(parsed);
}

const KINDS = new Set<SolidRecipe["kind"]>(["box", "extrude", "loop", "boolean", "transform", "mesh"]);

function nums(v: unknown, n: number, label: string): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`recipe field "${label}" must be ${n} finite numbers`);
  }
  return v as number[];
}

function pos(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`recipe field "${label}" must be positive`);
  return v;
}

export const IDENTITY4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Structural validation of one recipe, so a corrupt file cannot inject junk. */
export function validateRecipe(_schema: number, id: string, raw: SolidRecipe): SolidRecipe {
  return normaliseRecipe(id, raw);
}

/** Shared by the file reader and the session, so both police the same rules. */
export function normaliseRecipe(id: string, raw: SolidRecipe): SolidRecipe {
  if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") throw new Error(`solid ${id} is missing a recipe`);
  const kind = raw.kind as SolidRecipe["kind"];
  if (!KINDS.has(kind)) throw new Error(`solid ${id} has unknown recipe kind "${String(raw.kind)}"`);
  const matrix = raw.matrix === undefined ? IDENTITY4.slice() : nums(raw.matrix, 16, "matrix");
  switch (raw.kind) {
    case "box":
      return { kind: "box", width: pos(raw.width, "width"), height: pos(raw.height, "height"), depth: pos(raw.depth, "depth"), origin: nums(raw.origin, 3, "origin") as [number, number, number], matrix };
    case "extrude":
      if (!raw.profile) throw new Error(`solid ${id} has no profile`);
      return {
        kind: "extrude",
        profile: { width: pos(raw.profile.width, "profile.width"), height: pos(raw.profile.height, "profile.height") },
        normal: nums(raw.normal, 3, "normal") as [number, number, number],
        origin: nums(raw.origin, 3, "origin") as [number, number, number],
        distance: pos(raw.distance, "distance"),
        matrix,
      };
    case "loop": {
      if (!Array.isArray(raw.points) || raw.points.length < 3) throw new Error(`solid ${id} loop needs 3+ points`);
      const points = raw.points.map((p, i) => nums(p, 2, `points[${i}]`) as [number, number]);
      if (!raw.plane) throw new Error(`solid ${id} loop has no plane`);
      return {
        kind: "loop",
        points,
        plane: { origin: nums(raw.plane.origin, 3, "plane.origin") as [number, number, number], normal: nums(raw.plane.normal, 3, "plane.normal") as [number, number, number] },
        distance: pos(raw.distance, "distance"),
        matrix,
      };
    }
    case "boolean":
      if (raw.op !== "union" && raw.op !== "difference" && raw.op !== "intersection") throw new Error(`solid ${id} has unknown boolean op`);
      if (typeof raw.a !== "string" || typeof raw.b !== "string") throw new Error(`solid ${id} boolean needs a and b`);
      return { kind: "boolean", op: raw.op, a: raw.a, b: raw.b, matrix };
    case "transform":
      if (typeof raw.child !== "string") throw new Error(`solid ${id} transform needs a child`);
      return { kind: "transform", child: raw.child, matrix };
    case "mesh": {
      if (!Array.isArray(raw.positions) || !Array.isArray(raw.indices)) throw new Error(`solid ${id} mesh is incomplete`);
      if (raw.positions.length % 9 !== 0 || raw.indices.length % 3 !== 0) throw new Error(`solid ${id} mesh is not whole triangles`);
      if (![...raw.positions, ...raw.indices].every((n) => typeof n === "number" && Number.isFinite(n))) {
        throw new Error(`solid ${id} mesh has non-finite numbers`);
      }
      return { kind: "mesh", positions: raw.positions, indices: raw.indices, matrix };
    }
  }
  // Unreachable while KINDS and this switch agree; keeps the return type honest.
  throw new Error(`solid ${id} has unsupported recipe kind "${String(kind)}"`);
}
