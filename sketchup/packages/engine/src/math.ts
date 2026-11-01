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

/** A pure translation, column-major: the vector lives in the last column. */
export function translation4(v: Vec3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}

export function scale4(s: number | Vec3): number[] {
  const [x, y, z] = typeof s === "number" ? [s, s, s] : s;
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function rotationX4(deg: number): number[] {
  return rotationAbout4([1, 0, 0], deg);
}

export function rotationY4(deg: number): number[] {
  return rotationAbout4([0, 1, 0], deg);
}

export function rotationZ4(deg: number): number[] {
  return rotationAbout4([0, 0, 1], deg);
}

/**
 * Rotation of `deg` about an arbitrary unit axis, through `pivot`.
 *
 * Column-major, active rotation: with column vectors, entry `[c, r]` is
 * `m[c * 4 + r]`, so this is Rodrigues' matrix written column by column. A +90
 * turn about x takes y to z (column 1 becomes `(0, 0, 1)`), matching
 * `rotationX4`; a +90 turn about z takes x to y, matching `rotationZ4`.
 */
export function rotationAbout4(axis: Vec3, deg: number, pivot: Vec3 = [0, 0, 0]): number[] {
  const [x, y, z] = normalize3(axis);
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const t = 1 - c;
  // Columns of the 3x3 block, in the row order x, y, z.
  const c0: Vec3 = [t * x * x + c, t * x * y + s * z, t * x * z - s * y];
  const c1: Vec3 = [t * x * y - s * z, t * y * y + c, t * y * z + s * x];
  const c2: Vec3 = [t * x * z + s * y, t * y * z - s * x, t * z * z + c];
  // Rotation first, then pivot: t = p - R p, so a point on the pivot does not move.
  const p0: Vec3 = [
    pivot[0] - (c0[0] * pivot[0] + c1[0] * pivot[1] + c2[0] * pivot[2]),
    pivot[1] - (c0[1] * pivot[0] + c1[1] * pivot[1] + c2[1] * pivot[2]),
    pivot[2] - (c0[2] * pivot[0] + c1[2] * pivot[1] + c2[2] * pivot[2]),
  ];
  return [c0[0], c0[1], c0[2], 0, c1[0], c1[1], c1[2], 0, c2[0], c2[1], c2[2], 0, p0[0], p0[1], p0[2], 1];
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

/**
 * A matrix maps column vectors (`applyMatrix4` reads `m[4]` for y), so a
 * rotation must be built one way round to match; see `rotationAbout4`.
 */
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
/** Rotate `base` by `deg` about a world axis through `pivot`, preserving its TRS split. */
export function withRotation(base: readonly number[], axis: Vec3, deg: number, pivot: Vec3 = [0, 0, 0]): number[] {
  const trs = decompose(base);
  const { rotation: m } = decompose(rotationAbout4(axis, deg));
  // Apply the turn in world space: `world * base`, both pure rotations, so a
  // turn about the origin of an object whose own rotation is R leaves R·M, which
  // is what SketchUp reports and what a second turn composes with.
  const rotated = mul3(m, trs.rotation);
  const d: Vec3 = [
    trs.translation[0] - pivot[0],
    trs.translation[1] - pivot[1],
    trs.translation[2] - pivot[2],
  ];
  const spun: Vec3 = [
    m[0]! * d[0] + m[3]! * d[1] + m[6]! * d[2],
    m[1]! * d[0] + m[4]! * d[1] + m[7]! * d[2],
    m[2]! * d[0] + m[5]! * d[1] + m[8]! * d[2],
  ];
  return compose({
    rotation: rotated,
    scale: trs.scale,
    translation: [pivot[0] + spun[0], pivot[1] + spun[1], pivot[2] + spun[2]],
  });
}

export function withTranslation(base: readonly number[], delta: Vec3): number[] {
  const trs = decompose(base);
  return compose({
    rotation: trs.rotation,
    scale: trs.scale,
    translation: add3(trs.translation, delta),
  });
}

/**
 * The matrix to keep after a scale handle is released.
 *
 * A TransformControls scale handle scales about the object's centre, so letting
 * its matrix through would also *move* the object by (centre − origin) × (s − 1)
 * on every drag. SketchUp grows a face from the opposite face, leaving the object
 * where the user put it: the scale factors are taken from the gizmo and the
 * translation is restored exactly. The rotation is never taken from the gizmo,
 * because a scale handle has none to offer and reading one back lets float error
 * creep a placed object off its angle one drag at a time.
 *
 * A non-finite or zero factor keeps the base axis: a collapse is not a scale the
 * document can hold, and refusing it here is safer than a NaN matrix later.
 */
export function withScaleFromDragged(base: readonly number[], dragged: readonly number[]): number[] {
  const start = decompose(base);
  const now = decompose(dragged);
  // The dragged matrix is the base rotation times the new factor, so the factor
  // is the dragged column length over the base one (1 for an unrotated object,
  // which is why plain objects behave unchanged).
  const axis = (i: 0 | 1 | 2): number => {
    const factor = now.scale[i];
    const wanted = start.scale[i] !== 0 ? factor / start.scale[i] : factor;
    return Number.isFinite(wanted) && wanted !== 0 ? wanted : start.scale[i];
  };
  return compose({
    rotation: start.rotation,
    scale: [axis(0), axis(1), axis(2)],
    translation: start.translation,
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
