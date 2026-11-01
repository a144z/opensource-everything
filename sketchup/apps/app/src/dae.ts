/**
 * COLLADA (`.dae`) import — the format SketchUp's own free tier exports, so it
 * is the file a FitCheck user will most often be handed.
 *
 * A browser has a real XML parser, so this module uses `DOMParser` and reads the
 * tree by element name (not tag name, because a file may declare a namespace
 * prefix and `getElementsByTagName("mesh")` would then find nothing).
 *
 * Two deliberate limits keep it small:
 *
 *   1. **Geometry becomes one solid.** COLLADA is a node tree with transforms;
 *      FitCheck groups a bag of solids that move together, so the honest import
 *      is one solid whose recipe is a `mesh` of every triangle in world space.
 *   2. **Triangles and quads only.** COLLADA allows a `<polygons>` n-gon, and a
 *      naive fan triangulation of a concave one is silently wrong. A named
 *      refusal beats a quietly mangled model.
 *
 * Y-up to Z-up: COLLADA says Y is up, FitCheck says Z is up, so
 * `(x, y, z) -> (x, -z, y)`. That is a rotation, so triangle winding (and
 * therefore which side faces out) survives untouched.
 */

export interface DaeMesh {
  /** Flat xyz triples in the file's own units, already in world space. */
  readonly positions: number[];
  /** Triangle indices, counter-clockwise seen from outside. */
  readonly indices: number[];
  /** The asset `<title>`, or "Imported". */
  readonly name: string;
  /** `<unit meter="...">`, so the caller can scale the file to millimetres. */
  readonly unitMetres: number;
}

export class DaeError extends Error {
  constructor(
    message: string,
    readonly where: string,
  ) {
    super(`${where}: ${message}`);
    this.name = "DaeError";
  }
}

type Mat4 = readonly number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Parse COLLADA text. Throws `DaeError` naming the element it failed on. */
export function parseDae(text: string): DaeMesh {
  const dom = new DOMParser().parseFromString(text, "application/xml");
  const failure = dom.querySelector("parsererror");
  if (failure) throw new DaeError(failure.textContent?.trim() || "not well-formed XML", "document");

  const root = dom.documentElement;
  if (root.localName !== "COLLADA") {
    throw new DaeError(`root element is <${root.localName}>, expected <COLLADA>`, "document");
  }
  if (dom.getElementsByTagNameNS("*", "polygons").length > 0) {
    throw new DaeError("`<polygons>` is not supported; export triangles instead", "mesh");
  }

  const geometries = byName(root, "geometry");
  if (geometries.length === 0) throw new DaeError("no <geometry> element", "library_geometries");

  const title = byName(root, "title")[0]?.textContent?.trim();
  const positions: number[] = [];
  const indices: number[] = [];

  for (const geometry of geometries) {
    const id = geometry.getAttribute("id") ?? "";
    const meshes = byName(geometry, "mesh");
    if (meshes.length === 0) {
      throw new DaeError(`geometry "${id}" is not a <mesh> (splines and skins are not imported)`, id || "geometry");
    }
    // Each geometry is stamped out once per node that instances it, so the same
    // part drawn in four places arrives four times, in each place.
    const placements = worldMatrices(root, `#${id}`);
    for (const mesh of meshes) {
      const triangles = readMesh(mesh, id || "geometry");
      for (const matrix of placements) appendTransformed(triangles, matrix, positions, indices);
    }
  }

  if (indices.length === 0) throw new DaeError("no triangles found", "geometry");
  return {
    positions,
    indices,
    name: title !== undefined && title !== "" ? title : "Imported",
    unitMetres: readUnit(root),
  };
}

/** `<unit meter="0.01"/>`; COLLADA's default when absent is 1 metre. */
function readUnit(root: Element): number {
  const raw = byName(root, "unit")[0]?.getAttribute("meter");
  if (raw === null || raw === undefined || raw === "") return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

interface Triangles {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

/**
 * Read one `<mesh>`. The vertex source is resolved through `<vertices>`, so a
 * file that lists normals or UVs first among its inputs still finds positions.
 */
function readMesh(mesh: Element, where: string): Triangles {
  const sources = new Map<string, number[]>();
  for (const source of byName(mesh, "source")) {
    const id = source.getAttribute("id");
    const array = byName(source, "float_array")[0];
    if (id && array) sources.set(`#${id}`, splitFloats(array.textContent ?? ""));
  }

  const positionSource = (primitive: Element): number[] => {
    const inputs = byName(primitive, "input");
    const vertex = inputs.find((i) => i.getAttribute("semantic") === "VERTEX");
    if (!vertex) throw new DaeError("primitive has no VERTEX input", where);
    const ref = vertex.getAttribute("source") ?? "";
    const direct = sources.get(ref);
    if (direct) return direct;
    const vertices = byName(mesh, "vertices").find((v) => `#${v.getAttribute("id")}` === ref);
    const position = vertices ? byName(vertices, "input").find((i) => i.getAttribute("semantic") === "POSITION") : undefined;
    const inner = position ? sources.get(position.getAttribute("source") ?? "") : undefined;
    if (!inner) throw new DaeError(`VERTEX source "${ref}" does not resolve to POSITION data`, where);
    return inner;
  };

  /**
   * `<p>` interleaves every input the primitive declares, so the vertex index
   * is at `offset` and repeats every `stride` numbers.
   */
  const layout = (primitive: Element): { stride: number; offset: number } => {
    const inputs = byName(primitive, "input");
    const vertex = inputs.find((i) => i.getAttribute("semantic") === "VERTEX");
    if (!vertex) throw new DaeError("primitive has no VERTEX input", where);
    const offsets = inputs.map((i) => Number(i.getAttribute("offset") ?? "0"));
    return { stride: Math.max(0, ...offsets) + 1, offset: Number(vertex.getAttribute("offset") ?? "0") };
  };

  const out: number[] = [];
  const idx: number[] = [];

  for (const primitive of byName(mesh, "triangles")) {
    out.push(...positionSource(primitive));
    const { stride, offset } = layout(primitive);
    const base = out.length / 3 - positionSource(primitive).length / 3;
    const p = splitInts(byName(primitive, "p")[0]?.textContent ?? "");
    for (let i = offset; i < p.length; i += stride) idx.push(base + p[i]!);
  }

  for (const primitive of byName(mesh, "polylist")) {
    out.push(...positionSource(primitive));
    const { stride, offset } = layout(primitive);
    const base = out.length / 3 - positionSource(primitive).length / 3;
    const p = splitInts(byName(primitive, "p")[0]?.textContent ?? "");
    const counts = splitInts(byName(primitive, "vcount")[0]?.textContent ?? "");
    let cursor = 0;
    for (const count of counts) {
      const start = cursor;
      cursor += count;
      if (count < 3) continue;
      const corner = (k: number): number => p[start + k * stride + offset]!;
      // A fan is only used for count 3 and 4, where it is exact for convex and
      // non-convex alike (a quad has no diagonal ambiguity a fan gets wrong).
      const first = corner(0);
      for (let k = 1; k + 1 < count; k++) idx.push(base + first, base + corner(k), base + corner(k + 1));
    }
  }

  return { positions: out, indices: idx };
}

/**
 * Every world matrix that places `<geometry id="...">`: one per
 * `<instance_geometry url="#...">`, each the product of its own `<matrix>` and
 * every `<node>` above it in the scene graph.
 */
function worldMatrices(root: Element, url: string): Mat4[] {
  const out: Mat4[] = [];
  for (const instance of byName(root, "instance_geometry")) {
    if (instance.getAttribute("url") !== url) continue;
    let matrix: Mat4 = IDENTITY;
    for (let el: Element | null = instance.parentElement; el; el = el.parentElement) {
      if (el.localName !== "node") continue;
      const own = byName(el, "matrix")[0];
      if (own) matrix = compose(splitFloats(own.textContent ?? ""), matrix);
    }
    out.push(matrix);
  }
  // A geometry nothing instances is still imported, at the origin.
  return out.length === 0 ? [IDENTITY] : out;
}

/** Column-major 4x4, `after * before`: COLLADA's `matrix` is applied to the vertex last. */
function compose(after: Mat4, before: Mat4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (after[k * 4 + row] ?? 0) * (before[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Append one mesh transformed into the output, converting Y-up to Z-up. */
function appendTransformed(t: Triangles, m: Mat4, positions: number[], indices: number[]): void {
  const base = positions.length / 3;
  for (let i = 0; i < t.positions.length; i += 3) {
    const x = t.positions[i]!;
    const y = t.positions[i + 1]!;
    const z = t.positions[i + 2]!;
    const wx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
    const wy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
    const wz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
    positions.push(wx, -wz, wy);
  }
  // The swap is a rotation, so the winding is still outward; only the base moves.
  for (const i of t.indices) indices.push(base + i);
}

/** Elements whose local name is `name`, from anywhere under `scope`. */
function byName(scope: ParentNode, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS("*", name));
}

function splitFloats(text: string): number[] {
  return (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

function splitInts(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number);
}
