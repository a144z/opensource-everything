/** Small vector/matrix helpers the engine needs. Millimetres; degrees for angles. */

import type { MeshData, Vec3 } from "@apexus/geometry";

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize3(a: Vec3): Vec3 {
  const l = length3(a);
  if (l < 1e-12) throw new RangeError("cannot normalise a zero vector");
  return scale3(a, 1 / l);
}

/** Identity matrix, column-major 4x4 (glTF / Three.js convention). */
export function identity4(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function translation4(v: Vec3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}

export function scale4(s: number | Vec3): number[] {
  const [x, y, z] = typeof s === "number" ? [s, s, s] : s;
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function rotationX4(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function rotationY4(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function rotationZ4(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Rotation of `deg` about an arbitrary unit axis, through `pivot`. */
export function rotationAbout4(axis: Vec3, deg: number, pivot: Vec3 = [0, 0, 0]): number[] {
  const [x, y, z] = normalize3(axis);
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    pivot[0] - (t * x * x + c) * pivot[0] - (t * x * y - s * z) * pivot[1] - (t * x * z + s * y) * pivot[2],
    pivot[1] - (t * x * y + s * z) * pivot[0] - (t * y * y + c) * pivot[1] - (t * y * z - s * x) * pivot[2],
    pivot[2] - (t * x * z - s * y) * pivot[0] - (t * y * z + s * x) * pivot[1] - (t * z * z + c) * pivot[2],
    1,
  ];
}

/** Column-major 4x4 multiply: returns m  n. */
export function multiply4(m: readonly number[], n: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += m[k * 4 + row]! * n[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function applyPoint4(m: readonly number[], p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

/** Apply a column-major 4x4 to every position of a mesh (indices shared). */
export function applyMatrix4(mesh: MeshData, m: readonly number[]): MeshData {
  if (isIdentity4(m)) return mesh;
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!;
    const y = src[i + 1]!;
    const z = src[i + 2]!;
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  return { positions: out, indices: mesh.indices };
}

const IDENTITY = identity4();

export function isIdentity4(m: readonly number[] | undefined): boolean {
  if (!m) return true;
  for (let i = 0; i < 16; i++) if (m[i] !== IDENTITY[i]) return false;
  return true;
}

/** Inverse of an affine column-major 4x4. Returns identity if singular. */
export function invertAffine4(m: readonly number[]): number[] {
  const a = m[0]!,
    b = m[4]!,
    c = m[8]!,
    d = m[12]!;
  const e = m[1]!,
    f = m[5]!,
    g = m[9]!,
    h = m[13]!;
  const i = m[2]!,
    j = m[6]!,
    k = m[10]!,
    l = m[14]!;
  const det = a * (f * k - g * j) - b * (e * k - g * i) + c * (e * j - f * i);
  if (Math.abs(det) < 1e-12) return identity4();
  const inv = 1 / det;
  const r0 = (f * k - g * j) * inv;
  const r1 = (c * j - b * k) * inv;
  const r2 = (b * g - c * f) * inv;
  const r3 = (g * i - e * k) * inv;
  const r4 = (a * k - c * i) * inv;
  const r5 = (c * e - a * g) * inv;
  const r6 = (e * j - f * i) * inv;
  const r7 = (b * i - a * j) * inv;
  const r8 = (a * f - b * e) * inv;
  return [
    r0, r3, r6, 0,
    r1, r4, r7, 0,
    r2, r5, r8, 0,
    -(r0 * d + r1 * h + r2 * l),
    -(r3 * d + r4 * h + r5 * l),
    -(r6 * d + r7 * h + r8 * l),
    1,
  ];
}

export function isFiniteVec(v: readonly number[]): boolean {
  return v.every((n) => Number.isFinite(n));
}

/* ------------------------------------------------------------------- TRS */

/**
 * Translation / rotation / scale split of an affine matrix (task L2-3).
 *
 * A moved, rotated, scaled solid still reports its true size, and tools that
 * only move things do not bake the mesh. Decomposition is general: a negative
 * determinant means mirrored, and the mirror is carried on the X scale.
 */
export interface Trs {
  readonly translation: Vec3;
  /** Column-major 3x3 (basis vectors in columns). */
  readonly rotation: readonly number[];
  readonly scale: Vec3;
}

export const IDENTITY_TRS: Trs = {
  translation: [0, 0, 0],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  scale: [1, 1, 1],
};

function column(m: readonly number[], i: number): Vec3 {
  return [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
}

export function decompose(m: readonly number[] | undefined): Trs {
  if (!m || m.length !== 16) return IDENTITY_TRS;
  const x = column(m, 0);
  const y = column(m, 1);
  const z = column(m, 2);
  const sx = length3(x) || 1;
  const sy = length3(y) || 1;
  const sz = length3(z) || 1;
  const det =
    (x[0] * (y[1] * z[2] - y[2] * z[1]) - y[0] * (x[1] * z[2] - x[2] * z[1]) + z[0] * (x[1] * y[2] - x[2] * y[1])) /
    (sx * sy * sz);
  const flip = det < 0 ? -1 : 1;
  return {
    translation: [m[12]!, m[13]!, m[14]!],
    rotation: [
      x[0] / (sx * flip), x[1] / (sx * flip), x[2] / (sx * flip),
      y[0] / sy, y[1] / sy, y[2] / sy,
      z[0] / sz, z[1] / sz, z[2] / sz,
    ],
    scale: [sx * flip, sy, sz],
  };
}

function mul3(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      out[c * 3 + r] = a[r]! * b[c * 3]! + a[3 + r]! * b[c * 3 + 1]! + a[6 + r]! * b[c * 3 + 2]!;
    }
  }
  return out;
}

export function compose(trs: Trs): number[] {
  const { rotation: r, scale: s, translation: t } = trs;
  return [
    r[0]! * s[0]!, r[1]! * s[0]!, r[2]! * s[0]!, 0,
    r[3]! * s[1]!, r[4]! * s[1]!, r[5]! * s[1]!, 0,
    r[6]! * s[2]!, r[7]! * s[2]!, r[8]! * s[2]!, 0,
    t[0], t[1], t[2], 1,
  ];
}

/** Rotate ase by deg about a world axis through pivot, preserving its TRS split. */
export function withRotation(base: readonly number[], axis: Vec3, deg: number, pivot: Vec3 = [0, 0, 0]): number[] {
  const trs = decompose(base);
  const rot = rotationAbout4(axis, deg).slice(0, 12);
  // rotationAbout4 already puts the pivot term in the translation column; use
  // only its 3x3 block here and rotate the TRS translation about the pivot.
  const basis = [rot[0]!, rot[1]!, rot[2]!, rot[4]!, rot[5]!, rot[6]!, rot[8]!, rot[9]!, rot[10]!];
  const d: Vec3 = [
    trs.translation[0] - pivot[0],
    trs.translation[1] - pivot[1],
    trs.translation[2] - pivot[2],
  ];
  const moved: Vec3 = [
    basis[0]! * d[0] + basis[3]! * d[1] + basis[6]! * d[2] + pivot[0],
    basis[1]! * d[0] + basis[4]! * d[1] + basis[7]! * d[2] + pivot[1],
    basis[2]! * d[0] + basis[5]! * d[1] + basis[8]! * d[2] + pivot[2],
  ];
  return compose({ rotation: mul3(basis, trs.rotation), scale: trs.scale, translation: moved });
}

export function withTranslation(base: readonly number[], delta: Vec3): number[] {
  const trs = decompose(base);
  return compose({
    rotation: trs.rotation,
    scale: trs.scale,
    translation: add3(trs.translation, delta),
  });
}

/** Scale about pivot, keeping rotation; scale factors compose. */
export function withScale(base: readonly number[], factor: number | Vec3, pivot: Vec3 = [0, 0, 0]): number[] {
  const trs = decompose(base);
  const f: Vec3 = typeof factor === "number" ? [factor, factor, factor] : factor;
  return compose({
    rotation: trs.rotation,
    scale: [trs.scale[0] * f[0], trs.scale[1] * f[1], trs.scale[2] * f[2]],
    translation: [
      pivot[0] + (trs.translation[0] - pivot[0]) * f[0],
      pivot[1] + (trs.translation[1] - pivot[1]) * f[1],
      pivot[2] + (trs.translation[2] - pivot[2]) * f[2],
    ],
  });
}
