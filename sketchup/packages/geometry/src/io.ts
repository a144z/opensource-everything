/** Mesh interchange: glTF (binary), STL in/out, DXF outlines. Pure JS. */

import type { MeshData, Vec2 } from "./index.js";
import { normalize, cross, sub } from "./index.js";

/* ----------------------------------------------------------- STL import */

export function fromStlAscii(text: string): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    positions.push(Number(m[1]), Number(m[2]), Number(m[3]));
    indices.push(positions.length / 3 - 1);
  }
  if (indices.length % 3 !== 0) throw new Error("STL is not a whole number of triangles");
  return weld({ positions: new Float32Array(positions), indices: new Uint32Array(indices) }, 1e-5);
}

/** Merge coincident vertices so STL soups become closed meshes. */
export function weld(mesh: MeshData, precision = 1e-5): MeshData {
  const map = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(mesh.positions.length / 3);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!;
    const y = mesh.positions[i + 1]!;
    const z = mesh.positions[i + 2]!;
    const key = `${Math.round(x / precision)},${Math.round(y / precision)},${Math.round(z / precision)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(x, y, z);
      map.set(key, id);
    }
    remap[i / 3] = id;
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(mesh.indices, (i) => remap[i]!) };
}

/* ----------------------------------------------------------- glTF export */

const GLTF_HEADER = 12;
const CHUNK_HEADER = 8;

/** Minimal binary glTF: one mesh, one primitive, positions + indices, mm units (scale 1). */
export function toGltfBinary(meshes: readonly { name: string; mesh: MeshData }[]): ArrayBuffer {
  const bufferParts: ArrayBuffer[] = [];
  const accessors: unknown[] = [];
  const meshesJson: unknown[] = [];
  const nodes: unknown[] = [];
  let byteOffset = 0;

  const push = (typed: Float32Array | Uint32Array): number => {
    const pad = (4 - (byteOffset % 4)) % 4;
    if (pad) {
      bufferParts.push(new Uint8Array(pad).buffer as ArrayBuffer);
      byteOffset += pad;
    }
    const start = byteOffset;
    const bytes = typed.buffer.slice(typed.byteOffset, typed.byteOffset + typed.byteLength) as ArrayBuffer;
    bufferParts.push(bytes);
    byteOffset += bytes.byteLength;
    return start;
  };

  for (const { name, mesh } of meshes) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const val = mesh.positions[i + a]!;
        if (val < min[a]!) min[a] = val;
        if (val > max[a]!) max[a] = val;
      }
    }
    const posOffset = push(mesh.positions);
    const idxOffset = push(mesh.indices);
    const posAccessor = accessors.push({
      bufferView: accessors.length,
      componentType: 5126,
      count: mesh.positions.length / 3,
      type: "VEC3",
      min,
      max,
    });
    accessors.push({ bufferView: accessors.length, componentType: 5125, count: mesh.indices.length, type: "SCALAR" });
    void posOffset;
    void idxOffset;
    meshesJson.push({ name, primitives: [{ attributes: { POSITION: posAccessor - 1 }, indices: posAccessor }] });
    nodes.push({ mesh: meshesJson.length - 1, name });
  }

  const total = byteOffset;
  const binBuffer = new ArrayBuffer(total);
  const view = new Uint8Array(binBuffer);
  let cursor = 0;
  for (const part of bufferParts) {
    view.set(new Uint8Array(part), cursor);
    cursor += part.byteLength;
  }

  const json = {
    asset: { version: "2.0", generator: "FitCheck" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: meshesJson,
    accessors,
    bufferViews: buildBufferViews(bufferParts, total),
    buffers: [{ byteLength: total }],
  };
  const jsonText = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (binBuffer.byteLength % 4)) % 4;
  const totalLength = GLTF_HEADER + CHUNK_HEADER + jsonBytes.length + jsonPad + CHUNK_HEADER + binBuffer.byteLength + binPad;
  const out = new ArrayBuffer(totalLength);
  const dv = new DataView(out);
  const bytes = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLength, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  bytes.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) bytes[20 + jsonBytes.length + i] = 0x20;
  const binStart = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(binStart, binBuffer.byteLength + binPad, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // BIN
  bytes.set(new Uint8Array(binBuffer), binStart + 8);
  return out;
}

function buildBufferViews(parts: readonly ArrayBuffer[], _total: number): unknown[] {
  const views: unknown[] = [];
  let offset = 0;
  for (const part of parts) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: part.byteLength });
    offset += part.byteLength;
  }
  return views;
}

/* ------------------------------------------------------------- STL export */

export function toStlAsciiNamed(meshes: readonly { name: string; mesh: MeshData }[]): string {
  const chunks: string[] = [];
  for (const { name, mesh } of meshes) chunks.push(stlChunk(name, mesh));
  return chunks.join("\n");
}

function stlChunk(name: string, mesh: MeshData): string {
  const p = mesh.positions;
  const idx = mesh.indices;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const out: string[] = [`solid ${safe}`];
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 3;
    const i1 = idx[t + 1]! * 3;
    const i2 = idx[t + 2]! * 3;
    const a = [p[i0]!, p[i0 + 1]!, p[i0 + 2]!] as const;
    const b = [p[i1]!, p[i1 + 1]!, p[i1 + 2]!] as const;
    const c = [p[i2]!, p[i2 + 1]!, p[i2 + 2]!] as const;
    const n = normalize(cross(sub(b, a), sub(c, a)));
    out.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`);
    out.push("    outer loop");
    out.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`);
    out.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`);
    out.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`);
    out.push("    endloop");
    out.push("  endfacet");
  }
  out.push(`endsolid ${safe}`);
  return out.join("\n");
}

/* ---------------------------------------------------------------- DXF */

/** R12 ASCII DXF of closed 2D polylines on layer 0, in mm. */
export function toDxf(polylines: readonly { name: string; points: readonly Vec2[] }[]): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number): void => {
    out.push(String(code), String(value));
  };
  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$INSUNITS");
  pair(70, 4); // millimetres
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  for (const { name, points } of polylines) {
    for (const p of points) {
      pair(0, "POINT");
      pair(8, "0");
      pair(10, p[0]);
      pair(20, p[1]);
      pair(30, 0);
      void name;
    }
    pair(0, "POLYLINE");
    pair(8, "0");
    pair(66, 1);
    pair(70, 1); // closed
    for (const p of points) {
      pair(0, "VERTEX");
      pair(8, "0");
      pair(10, p[0]);
      pair(20, p[1]);
      pair(30, 0);
    }
    pair(0, "SEQEND");
    pair(8, "0");
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\n") + "\n";
}

/**
 * VERTEX `70` bit 16: a spline or curve-fit frame control point rather than a
 * real corner. Keeping one would put a Bezier handle in the ring as if the user
 * had drawn a kink there.
 */
const VERTEX_SPLINE_FRAME = 16;

/**
 * Parse LWPOLYLINE and POLYLINE entities into closed rings.
 *
 * Only *closed* polylines are returned, and the `70` group code is what says so.
 * An open polyline is a fence or a wall run, not a face: closing it would turn a
 * drawing the user made into a face they never asked for, so it is skipped and
 * `readImport` reports how many were skipped rather than pretending they arrived.
 *
 * The two spellings of "polyline" are kept apart on purpose. An LWPOLYLINE carries
 * its vertices inline; a POLYLINE is a run of separate VERTEX entities ended by
 * SEQEND, so its points are collected across several entities and the run is only
 * finished when SEQEND arrives (or the file ends). R12 writers use POLYLINE for
 * everything, so reading only the inline form silently imports nothing from them.
 */
export function fromDxf(text: string): Vec2[][] {
  const lines = text.split(/\r?\n/);
  const rings: Vec2[][] = [];
  /**
   * The ring being filled, whether its entity said it is closed, and whether the
   * VERTEX currently being read is a spline frame point to drop.
   */
  let current: { points: Vec2[]; closed: boolean; splineVertex: boolean } | null = null;
  /** True while inside a POLYLINE/VERTEX run, where vertices are their own entities. */
  let inPolyline = false;
  /** True while the entity being read is a VERTEX of that run. */
  let inVertex = false;
  let inEntities = false;
  let pendingX: number | null = null;
  const finish = (): void => {
    if (current && current.closed && current.points.length >= 3) rings.push(current.points);
    current = null;
    inPolyline = false;
    inVertex = false;
    pendingX = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim();
    const value = lines[i + 1]!.trim();
    if (code === "2" && value === "ENTITIES") inEntities = true;
    else if (code === "0" && value === "ENDSEC") inEntities = false;
    if (!inEntities) continue;
    if (code === "0") {
      pendingX = null;
      if (inPolyline && value === "VERTEX") {
        inVertex = true;
        current = current ?? { points: [], closed: false, splineVertex: false };
        current.splineVertex = false;
        continue;
      }
      inVertex = false;
      if (inPolyline && value === "SEQEND") {
        finish();
        continue;
      }
      // Any other entity ends whatever ring was open.
      finish();
      if (value === "LWPOLYLINE") {
        current = { points: [], closed: false, splineVertex: false };
      } else if (value === "POLYLINE") {
        current = { points: [], closed: false, splineVertex: false };
        inPolyline = true;
      }
      continue;
    }
    if (!current) continue;
    // Inside a run, `70` after a VERTEX entity is the vertex's own flags. The
    // POLYLINE's `70` arrives before its first VERTEX, so `inVertex` is what
    // separates the two; treating both as a VERTEX flag dropped every corner.
    if (inVertex && code === "70") {
      current.splineVertex = (Number.parseInt(value, 10) & VERTEX_SPLINE_FRAME) !== 0;
    } else if (code === "70") {
      // Bit 1 is the closed flag; the other bits (spline-fit, 3D) do not matter
      // because only the plan view is read.
      current.closed = (Number.parseInt(value, 10) & 1) === 1;
    } else if (code === "10") {
      pendingX = Number(value);
    } else if (code === "20" && pendingX !== null) {
      if (!current.splineVertex) current.points.push([pendingX, Number(value)]);
      pendingX = null;
    }
  }
  finish();
  return rings;
}
