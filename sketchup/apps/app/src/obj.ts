/**
 * Wavefront OBJ import (`.obj`), the other interchange file a furniture or
 * component library will hand over. Text, no XML, no textures.
 *
 * What is read: `v` vertices, `f` faces (triangles, quads and n-gons, with the
 * `v`, `v/vt`, `v//vn` and `v/vt/vn` spellings), `o`/`g` names, and `mtllib` /
 * `usemtl` only so far as to name the solid after the material when the object
 * has no name of its own.
 *
 * What is refused, loudly: OBJ has no unit at all. A file that gives no hint is
 * read as millimetres and the caller is told, because guessing metres for a
 * chair would import a 600 mm seat as 600 m. `# units: cm` (or `in`, `m`, `mm`)
 * in a comment is honoured, which is what exporters that care already write.
 *
 * N-gons are fan-triangulated. Unlike COLLADA's `<polygons>`, an OBJ face is
 * almost always planar and convex (exporters emit triangles and quads), and
 * refusing every n-gon would reject most real files; a fan is exact for convex
 * faces and visible-but-repairable for concave ones.
 *
 * `indices` is always a whole number of triangles, and every index names a
 * vertex that exists: the engine refuses a mesh recipe whose index count is not
 * a multiple of three, so a file that repeats a corner (`f 1 2 2 3`, or a
 * polygon closed by naming its first corner again) must not reach it. A
 * repeated corner carries no area, so dropping it loses nothing.
 */

/** One mesh in the shape the engine's `mesh` recipe takes: flat, whole triangles. */
export interface ObjMesh {
  /** Flat xyz triples, in millimetres after the caller scales them. */
  readonly positions: number[];
  /** Triangle indices into `positions / 3`; length is a multiple of three. */
  readonly indices: number[];
  readonly name: string;
  /** The unit the file declared, or null when it declared none. */
  readonly declaredUnit: string | null;
}

/** Millimetres per unit name, for the optional `# units:` comment. */
const UNIT_MM: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
  ft: 304.8,
};

export class ObjError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "ObjError";
  }
}

/**
 * Parse OBJ text into one mesh. `negativeIndexBase` exists because OBJ indices
 * are 1-based, but `-1` means "the last vertex so far", so a face can only be
 * resolved while reading, forward in the file.
 */
export function parseObj(text: string): ObjMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  let name = "";
  let material = "";
  let declaredUnit: string | null = null;

  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      const units = /^#\s*units?\s*[:=]\s*([a-z"]+)/i.exec(line);
      if (units) declaredUnit = units[1]!.replace(/"/g, "").toLowerCase();
      continue;
    }
    const space = line.indexOf(" ");
    const keyword = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? "" : line.slice(space + 1).trim();

    switch (keyword) {
      case "v": {
        const n = rest.split(/\s+/).map(Number);
        if (n.length < 3 || !n.slice(0, 3).every(Number.isFinite)) {
          throw new ObjError("a vertex needs three finite numbers", i + 1);
        }
        positions.push(n[0]!, n[1]!, n[2]!);
        break;
      }
      case "o":
      case "g":
        // The first name wins: a file with both `o chair` and `g chair_mesh`
        // is one object to a user.
        if (name === "" && rest !== "") name = rest;
        break;
      case "usemtl":
        if (rest !== "") material = rest;
        break;
      case "f": {
        const corners = rest.split(/\s+/).filter((t) => t !== "");
        if (corners.length < 3) throw new ObjError("a face needs at least three corners", i + 1);
        const resolved = corners.map((token) => resolveIndex(token.split("/")[0] ?? "", positions.length / 3, i + 1));
        // Fan from the first corner. A fan triangle whose corner repeats another
        // is a degenerate edge of the polygon (or a doubled corner in the file),
        // not a face: it is skipped so `indices` stays a whole run of triangles.
        for (let k = 1; k + 1 < resolved.length; k++) {
          const a = resolved[0]!;
          const b = resolved[k]!;
          const c = resolved[k + 1]!;
          if (a === b || b === c || a === c) continue;
          indices.push(a, b, c);
        }
        break;
      }
      default:
        // `vt`, `vn`, `mtllib`, `s`, `l`, `p` and vendor extensions are skipped:
        // none of them change the shape.
        break;
    }
  }

  if (indices.length === 0) throw new ObjError("no faces found", 1);
  return {
    positions,
    indices,
    name: name !== "" ? name : material !== "" ? material : "Imported",
    declaredUnit,
  };
}

/** OBJ index -> 0-based vertex index. `token` is the text before the first `/`. */
function resolveIndex(token: string, count: number, line: number): number {
  const n = Number.parseInt(token, 10);
  if (!Number.isFinite(n) || n === 0) throw new ObjError(`"${token}" is not a vertex index`, line);
  const index = n > 0 ? n - 1 : count + n;
  if (index < 0 || index >= count) {
    throw new ObjError(`vertex ${n} is out of range (${count} vertices so far)`, line);
  }
  return index;
}

/** `null` when the file declared no unit; the caller then decides and says so. */
export function objUnitMm(declared: string | null): number | null {
  if (declared === null) return null;
  const key = declared.replace(/[^a-z]/g, "");
  return UNIT_MM[key] ?? null;
}
