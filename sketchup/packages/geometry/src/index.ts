/**
 * Pure geometry layer. No DOM, no renderer, no engine imports.
 * Units are millimetres everywhere unless a name says otherwise.
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export const EPSILON = 1e-9;

/* ------------------------------------------------------------------ vec3 */

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < EPSILON) throw new Error("cannot normalize a zero-length vector");
  return scale(a, 1 / l);
}

/* ------------------------------------------------------------------ vec2 */

export function polygonArea(pts: readonly Vec2[]): number {
  let a2 = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const p = pts[i]!;
    const q = pts[j]!;
    a2 += (q[0] + p[0]) * (q[1] - p[1]);
  }
  return Math.abs(a2) / 2;
}

/* ------------------------------------------------------------------ aabb */

export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

export const EMPTY_AABB: Aabb = {
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
};

export function aabbFromPoints(points: Iterable<Vec3>): Aabb {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] > maxZ) maxZ = p[2];
  }
  if (minX === Infinity) return EMPTY_AABB;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  if (a.min[0] === Infinity) return b;
  if (b.min[0] === Infinity) return a;
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

/** Overhang of `a` past the walls of `box`, per axis, in mm. Negative = room to spare. */
export function overshoot(a: Aabb, box: Aabb): Vec3 {
  const over: Vec3 = [
    Math.max(a.max[0] - box.max[0], box.min[0] - a.min[0]),
    Math.max(a.max[1] - box.max[1], box.min[1] - a.min[1]),
    Math.max(a.max[2] - box.max[2], box.min[2] - a.min[2]),
  ];
  return [Math.max(0, over[0]), Math.max(0, over[1]), Math.max(0, over[2])];
}

export function fitsIn(a: Aabb, box: Aabb): boolean {
  const o = overshoot(a, box);
  return o[0] <= EPSILON && o[1] <= EPSILON && o[2] <= EPSILON;
}

/* ------------------------------------------------------------- primitives */

export interface MeshData {
  /** Flat xyz triples, counter-clockwise from outside. */
  readonly positions: Float32Array;
  /** Triangle vertex indices. */
  readonly indices: Uint32Array;
}

export interface CreateBoxOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly origin?: Vec3;
}

/** Axis-aligned closed box. Origin is the min corner. */
export function createBox(opts: CreateBoxOptions): MeshData {
  const { width, height, depth, origin = [0, 0, 0] } = opts;
  if (!(width > 0) || !(height > 0) || !(depth > 0)) {
    throw new RangeError("box dimensions must be positive");
  }
  const [ox, oy, oz] = origin;
  const x0 = ox;
  const x1 = ox + width;
  const y0 = oy;
  const y1 = oy + height;
  const z0 = oz;
  const z1 = oz + depth;
  const positions: number[] = [];
  const v = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const a = v(x0, y0, z0);
  const b = v(x1, y0, z0);
  const c = v(x1, y1, z0);
  const d = v(x0, y1, z0);
  const e = v(x0, y0, z1);
  const f = v(x1, y0, z1);
  const g = v(x1, y1, z1);
  const h = v(x0, y1, z1);
  const indices = new Uint32Array([
    a, c, b, a, d, c, // -z
    e, f, g, e, g, h, // +z
    a, b, f, a, f, e, // -y
    d, h, g, d, g, c, // +y
    a, e, h, a, h, d, // -x
    b, c, g, b, g, f, // +x
  ]);
  return { positions: new Float32Array(positions), indices };
}

/**
 * Closed solid: a `width` x `height` profile in the plane of `normal`, extruded
 * `depth` along `normal` from `origin`.
 *
 * Canonical winding (outward):
 *   - `x`: box rotated -90deg about X  (depth -> -y)
 *   - `y`: box rotated +90deg about Z  (depth -> +x)
 *   - `z`: box as-is                   (depth -> +z)
 * `extrudeRect(w, h, cross(X, Y), o, d)` reproduces that box exactly.
 */
export function extrudeRect(
  width: number,
  height: number,
  normal: Vec3,
  origin: Vec3 = [0, 0, 0],
  depth = 1,
): MeshData {
  const n = normalize(normal);
  const axis = dominantAxis(n);
  const base = createBox({ width, height, depth, origin: [0, 0, 0] });
  const rot =
    axis === "z"
      ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
      : axis === "y"
        ? rotateZ(90)
        : rotateX(-90);
  return offset(applyMatrix(base, rot), origin);
}

export function dominantAxis(n: Vec3): "x" | "y" | "z" {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return "z";
  if (ay >= ax) return "y";
  return "x";
}

export function rotateX(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotateZ(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function rotateY(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Row-major 3x3 applied to every position. */
export function applyMatrix(mesh: MeshData, m: readonly number[]): MeshData {
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!;
    const y = src[i + 1]!;
    const z = src[i + 2]!;
    out[i] = m[0]! * x + m[1]! * y + m[2]! * z;
    out[i + 1] = m[3]! * x + m[4]! * y + m[5]! * z;
    out[i + 2] = m[6]! * x + m[7]! * y + m[8]! * z;
  }
  return { positions: out, indices: mesh.indices };
}

export function offset(mesh: MeshData, d: Vec3): MeshData {
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]! + d[0];
    out[i + 1] = src[i + 1]! + d[1];
    out[i + 2] = src[i + 2]! + d[2];
  }
  return { positions: out, indices: mesh.indices };
}

export function meshBounds(mesh: MeshData): Aabb {
  const pts: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    pts.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  }
  return aabbFromPoints(pts);
}

/** Signed volume via the divergence theorem. Positive when winding is outward. */
export function meshVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 3;
    const i1 = idx[t + 1]! * 3;
    const i2 = idx[t + 2]! * 3;
    const ax = p[i0]!;
    const ay = p[i0 + 1]!;
    const az = p[i0 + 2]!;
    const bx = p[i1]!;
    const by = p[i1 + 1]!;
    const bz = p[i1 + 2]!;
    const cx = p[i2]!;
    const cy = p[i2 + 1]!;
    const cz = p[i2 + 2]!;
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

/**
 * Topological watertightness: every undirected edge must be used by exactly two
 * triangles. Catches CSG bugs the surface area check would miss.
 */
export function isClosedMesh(mesh: MeshData, precision = 5): boolean {
  const p = mesh.positions;
  const keyAt = (i: number): string =>
    `${p[i * 3]!.toFixed(precision)},${p[i * 3 + 1]!.toFixed(precision)},${p[i * 3 + 2]!.toFixed(precision)}`;
  const ids = new Map<string, number>();
  const idOf = (i: number): number => {
    const k = keyAt(i);
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    return id;
  };
  const edgeCount = new Map<string, number>();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idOf(idx[t]!);
    const b = idOf(idx[t + 1]!);
    const c = idOf(idx[t + 2]!);
    for (const [u, w] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = u < w ? `${u}:${w}` : `${w}:${u}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  for (const n of edgeCount.values()) if (n !== 2) return false;
  return true;
}

/* ------------------------------------------------------------------ stl */

export function toStlAscii(mesh: MeshData, name = "solid"): string {
  const p = mesh.positions;
  const idx = mesh.indices;
  const out: string[] = [`solid ${name}`];
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 3;
    const i1 = idx[t + 1]! * 3;
    const i2 = idx[t + 2]! * 3;
    const a: Vec3 = [p[i0]!, p[i0 + 1]!, p[i0 + 2]!];
    const b: Vec3 = [p[i1]!, p[i1 + 1]!, p[i1 + 2]!];
    const c: Vec3 = [p[i2]!, p[i2 + 1]!, p[i2 + 2]!];
    const n = normalize(cross(sub(b, a), sub(c, a)));
    out.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`);
    out.push("    outer loop");
    for (const v of [a, b, c]) out.push(`      vertex ${v[0]} ${v[1]} ${v[2]}`);
    out.push("    endloop");
    out.push("  endfacet");
  }
  out.push(`endsolid ${name}`);
  return out.join("\n");
}

/* ------------------------------------------------------------ stable hash */

/** FNV-1a over typed arrays; used to prove undo round-trips. */
export function hashMesh(mesh: MeshData): string {
  let h = 0x811c9dc5;
  const feed = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  feed(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.toString(16).padStart(8, "0");
}


/* Named submodules: polygon meshing, interchange, units, inference. */
export * from "./polygon.js";
export * from "./io.js";
export * from "./units.js";
export * from "./inference.js";
export * from "./rings.js";
