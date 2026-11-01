import Module from "manifold-3d";
import type { Aabb, MeshData, Vec3 } from "@apexus/geometry";
import type { BooleanOp, SolidRecipe } from "@apexus/engine";

/**
 * Manifold solid kernel (ADR 0002). Async WASM init; every caller must await
 * `initKernel()` before a boolean. Sealed: no Manifold object escapes this
 * module, and memory is freed deterministically instead of by GC.
 */

export type { BooleanOp } from "@apexus/engine";

export type KernelStatus = "NoError" | "NotManifold" | "NonFiniteVertex" | "Cancelled" | "Unknown";

export interface KernelMesh {
  readonly mesh: MeshData;
  readonly volume: number;
  readonly bounds: Aabb;
  readonly status: KernelStatus;
}

interface RawMesh {
  numProp: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

interface ManifoldLike {
  add(other: ManifoldLike): ManifoldLike;
  subtract(other: ManifoldLike): ManifoldLike;
  intersect(other: ManifoldLike): ManifoldLike;
  volume(): number;
  boundingBox(): { min: Vec3; max: Vec3 };
  status(): string;
  isEmpty(): boolean;
  numTri(): number;
  getMesh(): RawMesh;
  delete(): void;
}

interface ManifoldModule {
  Manifold: { ofMesh(mesh: RawMesh): ManifoldLike };
  setup(): void;
}

let module: ManifoldModule | null = null;
let loading: Promise<void> | null = null;
const live = new Set<ManifoldLike>();

/** Resolves once; safe to call from anywhere, idempotent, retries after failure. */
export function initKernel(): Promise<void> {
  if (module) return Promise.resolve();
  loading ??= (async () => {
    const wasm = (await (Module as unknown as () => Promise<ManifoldModule>)()) as ManifoldModule;
    wasm.setup();
    module = wasm;
  })().catch((err: unknown) => {
    loading = null;
    throw new Error(`solid kernel failed to load: ${(err as Error).message}`);
  });
  return loading;
}

export function kernelReady(): boolean {
  return module !== null;
}

function requireModule(): ManifoldModule {
  if (!module) throw new Error("kernel not initialised: await initKernel() first");
  return module;
}

function track<T extends ManifoldLike>(m: T): T {
  live.add(m);
  return m;
}

function release(m: ManifoldLike | undefined): void {
  if (m && live.delete(m)) {
    try {
      m.delete();
    } catch {
      // Already freed as part of a chained result; nothing to do.
    }
  }
}

/** Free every Manifold still held. Called on unload and in tests. */
export function disposeKernel(): void {
  for (const m of [...live]) release(m);
  live.clear();
}

export function normaliseStatus(status: string): KernelStatus {
  return status === "NoError" || status === "NotManifold" || status === "NonFiniteVertex" || status === "Cancelled"
    ? status
    : "Unknown";
}

function toManifold(mesh: MeshData): ManifoldLike {
  const { Manifold } = requireModule();
  if (mesh.positions.length === 0 || mesh.indices.length === 0) throw new Error("kernel: empty mesh");
  return track(
    Manifold.ofMesh({
      numProp: 3,
      vertProperties: Float32Array.from(mesh.positions),
      triVerts: Uint32Array.from(mesh.indices),
    }),
  );
}

function fromManifold(m: ManifoldLike): KernelMesh {
  const raw = m.getMesh();
  const count = raw.vertProperties.length / raw.numProp;
  // Manifold may carry extra properties per vertex; keep xyz only.
  let positions: Float32Array;
  if (raw.numProp === 3) {
    positions = new Float32Array(raw.vertProperties);
  } else {
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = raw.vertProperties[i * raw.numProp]!;
      positions[i * 3 + 1] = raw.vertProperties[i * raw.numProp + 1]!;
      positions[i * 3 + 2] = raw.vertProperties[i * raw.numProp + 2]!;
    }
  }
  const bb = m.boundingBox();
  return {
    mesh: { positions, indices: new Uint32Array(raw.triVerts) },
    volume: m.volume(),
    bounds: { min: bb.min, max: bb.max },
    status: normaliseStatus(m.status()),
  };
}

/** Boolean of two meshes. Returns a fresh mesh; kernel objects are freed before returning. */
export function booleanMeshes(a: MeshData, b: MeshData, op: BooleanOp): KernelMesh {
  requireModule();
  const ma = toManifold(a);
  const mb = toManifold(b);
  let result: ManifoldLike | undefined;
  try {
    result = op === "union" ? ma.add(mb) : op === "difference" ? ma.subtract(mb) : ma.intersect(mb);
    track(result);
    return fromManifold(result);
  } finally {
    release(ma);
    release(mb);
    release(result);
  }
}

/** Volume, bounds and manifoldness of a mesh, without keeping anything alive. */
export function inspectMesh(mesh: MeshData): KernelMesh {
  const m = toManifold(mesh);
  try {
    return fromManifold(m);
  } finally {
    release(m);
  }
}

export function isManifold(mesh: MeshData): boolean {
  return inspectMesh(mesh).status === "NoError";
}

/** Count of Manifold objects held; a leak check for tests. */
export function kernelStats(): { live: number; ready: boolean } {
  return { live: live.size, ready: module !== null };
}

/**
 * The session's kernel resolver: booleans resolve their children through the
 * engine, then run through Manifold. Throws when the kernel is not loaded, so a
 * boolean command fails loudly instead of writing garbage into the document.
 *
 * `recipeOf` turns a child id into its recipe, because a boolean needs the child
 * solids' meshes, not the child ids. The session supplies `(id) => doc.solids.get(id)!.recipe`.
 */
export function booleanRecipe(
  recipe: Extract<SolidRecipe, { kind: "boolean" }>,
  recipeOf: (id: string) => SolidRecipe,
  resolve: (r: SolidRecipe) => MeshData,
): MeshData {
  if (!module) throw new Error("boolean needs the solid kernel; await initKernel() first");
  const a = resolve(recipeOf(recipe.a));
  const b = resolve(recipeOf(recipe.b));
  const out = booleanMeshes(a, b, recipe.op);
  if (out.status !== "NoError") throw new Error(`kernel rejected the result: ${out.status}`);
  if (!(out.volume > 0)) throw new RangeError("kernel result has no volume");
  return out.mesh;
}
