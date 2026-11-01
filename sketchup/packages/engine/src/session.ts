/**
 * Session: owns the document, history, mesh cache and fit cache. The only
 * sanctioned mutation path is `execute(command)` (ADR 0003).
 *
 * Standalone recipes are meshed by the engine. Transform recipes are meshed
 * here too (their child is in the document). Boolean and mesh recipes go through
 * the injected resolver, which is where the kernel lives.
 */

import { aabbFromPoints, type Aabb, type MeshData, type Vec3 } from "@apexus/geometry";
import { analyseMesh, baseMesh, isStandaloneRecipe, recipeMesh, type SolidGeometry } from "./analyze.js";
import { emptyDocumentState } from "./commands.js";
import type { Command, CommandContext } from "./command.js";
import { checkFit, type FitResult } from "./fit.js";
import { History, applyPatch, type Patch } from "./history.js";
import { applyMatrix4, isIdentity4 } from "./math.js";
import { validateRecipe as normaliseRecipe } from "./io.js";
import type { DocumentState, Solid, SolidId, SolidRecipe } from "./types.js";

export type KernelResolver = (
  recipe: Extract<SolidRecipe, { kind: "boolean" }>,
  recipeOf: (id: SolidId) => SolidRecipe,
  resolve: (r: SolidRecipe) => MeshData,
) => MeshData;

export interface SessionOptions {
  /** Handles boolean recipes. Without one, boolean commands throw. */
  readonly kernel?: KernelResolver;
  readonly idPrefix?: string;
  readonly historyLimit?: number;
  readonly cacheLimit?: number;
}

export type ChangeKind = "add" | "remove" | "update" | "envelope" | "undo" | "redo" | "load";

export interface SessionChange {
  readonly kind: ChangeKind;
  /** Ids whose content changed (additions, edits, deletions). A hint, not a full list. */
  readonly touched: readonly SolidId[];
  readonly label: string;
}

function classifyCommand(kind: string): ChangeKind {
  switch (kind) {
    case "addSolid":
    case "duplicateSolid":
    case "arrayCopy":
    case "booleanSolids":
      return "add";
    case "deleteSolids":
      return "remove";
    case "setEnvelope":
      return "envelope";
    default:
      return "update";
  }
}

interface CachedAnalysis {
  revision: number;
  geometry: SolidGeometry;
}

export class Session {
  #doc: DocumentState;
  #history: History;
  #counter = 0;
  #prefix: string;
  #cache = new Map<SolidId, CachedAnalysis>();
  #cacheLimit: number;
  #kernel: SessionOptions["kernel"] | null;
  #fit: FitResult | null = null;
  #changeListeners = new Set<(change: SessionChange) => void>();

  constructor(options: SessionOptions = {}) {
    this.#doc = emptyDocumentState();
    this.#history = new History(options.historyLimit ?? 500);
    this.#prefix = options.idPrefix ?? "s";
    this.#cacheLimit = options.cacheLimit ?? 4000;
    this.#kernel = options.kernel ?? null;
  }

  /* ------------------------------------------------------------- changes */

  /**
   * Subscribe to committed changes; returns the unsubscribe function. The app
   * reconciles its scene from this, so no tool needs to remember to call sync().
   */
  onChange(listener: (change: SessionChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  #emit(change: SessionChange): void {
    for (const listener of this.#changeListeners) listener(change);
  }

  /* ------------------------------------------------------------ accessors */

  get document(): DocumentState {
    return this.#doc;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  get historyLabels(): readonly string[] {
    return this.#history.labels;
  }

  get historyDepth(): number {
    return this.#history.depth;
  }

  get hasKernel(): boolean {
    return this.#kernel !== null;
  }

  /** Resolve a recipe to a world-space mesh. */
  resolve = (recipe: SolidRecipe): MeshData => {
    if (isStandaloneRecipe(recipe)) return recipeMesh(recipe);
    const m = recipe.matrix;
    if (recipe.kind === "transform") {
      const child = this.#doc.solids.get(recipe.child);
      if (!child) throw new Error(`transform references missing solid ${recipe.child}`);
      return applyMatrix4(this.resolve(child.recipe), m);
    }
    if (recipe.kind === "boolean") return this.#booleanMesh(this.#patchBase ?? this.#doc, recipe, this.resolve);
    // Exhaustive; keeps the compiler honest if a recipe kind is added.
    const mesh = baseMesh(recipe);
    return isIdentity4(m) ? mesh : applyMatrix4(mesh, m);
  };

  /** Resolve a boolean by id against a given document. Kernel hook point. */
  #booleanMesh(doc: DocumentState, recipe: Extract<SolidRecipe, { kind: "boolean" }>, resolve: (r: SolidRecipe) => MeshData): MeshData {
    if (!this.#kernel) throw new Error("boolean needs the solid kernel, which is not ready yet");
    const recipeOf = (id: SolidId): SolidRecipe => {
      const solid = doc.solids.get(id);
      if (!solid) throw new Error(`boolean references missing solid ${id}`);
      return solid.recipe;
    };
    return this.#kernel(recipe, recipeOf, resolve);
  }

  /**
   * A command may delete a solid and reference it in the same patch (a boolean
   * consumes its two operands). While that command is being applied, operand
   * lookups fall back to the document as it was before the patch.
   */
  #patchBase: DocumentState | null = null;

  /** Run one command under the patch base so intra-patch references work. */
  #apply(command: Command, doc: DocumentState): Patch {
    return this.#applyWith(command, doc, this.#ctx());
  }

  #applyWith(command: Command, doc: DocumentState, ctx: CommandContext): Patch {
    const outer = this.#patchBase;
    this.#patchBase = doc;
    try {
      return command.apply(doc, ctx);
    } finally {
      this.#patchBase = outer;
    }
  }

  /* ------------------------------------------------------------ mutations */

  execute(command: Command): Patch {
    const patch = this.#apply(command, this.#doc);
    this.#doc = applyPatch(this.#doc, patch, "forward");
    this.#history.push({ label: patch.label, patch });
    this.#invalidate(patch);
    this.#emit({ kind: classifyCommand(command.kind), touched: [...patch.forward.keys(), ...patch.backward.keys()], label: patch.label });
    return patch;
  }

  /**
   * Execute several commands as one undo step. All or nothing: if any command
   * throws, the document, the id counter and the history are untouched.
   */
  batch(commands: readonly Command[]): Patch {
    if (commands.length === 0) {
      return { forward: new Map(), backward: new Map(), envelopeBefore: this.#doc.envelope, envelopeAfter: this.#doc.envelope, label: "No change" };
    }
    const envelopeBefore = this.#doc.envelope;
    let working = this.#doc;
    let label = "";
    let counter = this.#counter;
    for (const command of commands) {
      const ctx: CommandContext = {
        nextId: () => `${this.#prefix}${++counter}`,
        resolve: (recipe) => this.#resolveAgainst(working, recipe),
      };
      working = applyPatch(working, this.#applyWith(command, working, ctx), "forward");
      label = label ? `${label} + ${command.label}` : command.label;
    }
    // One patch from the original document to the final one: undo restores every
    // id the batch touched, including ids it created and then deleted.
    const forward = new Map<SolidId, Solid | null>();
    const backward = new Map<SolidId, Solid | null>();
    const ids = new Set([...this.#doc.solids.keys(), ...working.solids.keys()]);
    for (const id of ids) {
      const before = this.#doc.solids.get(id) ?? null;
      const after = working.solids.get(id) ?? null;
      if (before === after) continue;
      forward.set(id, after);
      backward.set(id, before);
    }
    const patch: Patch = {
      forward,
      backward,
      envelopeBefore,
      envelopeAfter: working.envelope,
      label,
      sectionBefore: this.#doc.section,
      sectionAfter: working.section,
    };
    this.#counter = counter;
    this.#doc = working;
    this.#history.push({ label, patch });
    this.#invalidate(patch);
    this.#emit({ kind: "update", touched: [...forward.keys()], label });
    return patch;
  }

  undo(): boolean {
    const entry = this.#history.takeUndo();
    if (!entry) return false;
    this.#doc = applyPatch(this.#doc, entry.patch, "backward");
    this.#invalidate(entry.patch);
    this.#emit({ kind: "undo", touched: [], label: entry.label });
    return true;
  }

  redo(): boolean {
    const entry = this.#history.takeRedo();
    if (!entry) return false;
    this.#doc = applyPatch(this.#doc, entry.patch, "forward");
    this.#invalidate(entry.patch);
    this.#emit({ kind: "redo", touched: [], label: entry.label });
    return true;
  }

  /** Replace the whole document (open a file). Clears history and caches. */
  load(doc: DocumentState): void {
    this.#doc = doc;
    this.#history.clear();
    this.#cache.clear();
    this.#fit = null;
    // Keep the id counter past anything already in the file.
    const used = [...doc.solids.keys()].map((id) => {
      const m = /(\d+)$/.exec(id);
      return m ? Number(m[1]) : 0;
    });
    this.#counter = Math.max(this.#counter, ...used, 0);
    for (const solid of doc.solids.values()) this.#analyse(solid.id);
    this.#emit({ kind: "load", touched: [...doc.solids.keys()], label: "Open" });
  }

  /* ------------------------------------------------------------- analysis */

  analyse(id: SolidId): SolidGeometry {
    return this.#analyse(id);
  }

  boundsOf(id: SolidId): Aabb {
    this.#analyse(id);
    return this.#cache.get(id)?.geometry.bounds ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  }

  meshOf(id: SolidId): MeshData {
    return this.#analyse(id).mesh;
  }

  /** Union of the visible solids' bounds (empty model gives infinities). */
  documentBounds(): Aabb {
    let min: [number, number, number] = [Infinity, Infinity, Infinity];
    let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const solid of this.#doc.solids.values()) {
      if (solid.meta.hidden) continue;
      const b = this.boundsOf(solid.id);
      min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[1]), Math.min(min[2], b.min[2])];
      max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[1]), Math.max(max[2], b.max[2])];
    }
    return { min, max };
  }

  /** Ids sticking out of the envelope; empty when there is no envelope. */
  failures(): Set<SolidId> {
    const out = new Set<SolidId>();
    const env = this.#doc.envelope;
    if (!env) return out;
    for (const solid of this.#doc.solids.values()) {
      if (solid.meta.hidden) continue;
      const b = this.boundsOf(solid.id);
      if (
        b.min[0] < env.min[0] || b.min[1] < env.min[1] || b.min[2] < env.min[2] ||
        b.max[0] > env.max[0] || b.max[1] > env.max[1] || b.max[2] > env.max[2]
      ) {
        out.add(solid.id);
      }
    }
    return out;
  }

  /** Cached fit verdict; recomputed after any change. */
  fit(): FitResult {
    if (this.#fit) return this.#fit;
    const counted = new Map<SolidId, Aabb>();
    for (const solid of this.#doc.solids.values()) {
      if (solid.meta.hidden) continue;
      counted.set(solid.id, this.boundsOf(solid.id));
    }
    this.#fit = checkFit(counted, this.#doc.envelope);
    return this.#fit;
  }

  /** Deterministic content hash: proves undo and file round-trips. */
  hash(): string {
    const parts: string[] = [];
    for (const id of [...this.#doc.solids.keys()].sort()) {
      const geo = this.#analyse(id);
      parts.push(`${id}:${geo.hash}:${geo.volume.toFixed(6)}:${geo.closed ? 1 : 0}`);
    }
    parts.push(`env:${JSON.stringify(this.#doc.envelope)}`);
    let h = 0x811c9dc5;
    for (const ch of parts.join("|")) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  /** Total triangle count across visible solids; the perf harness reads this. */
  triangleCount(): number {
    let n = 0;
    for (const solid of this.#doc.solids.values()) {
      if (solid.meta.hidden) continue;
      n += this.#analyse(solid.id).mesh.indices.length / 3;
    }
    return n;
  }

  /* -------------------------------------------------------------- private */

  #ctx(): CommandContext {
    return {
      nextId: () => `${this.#prefix}${++this.#counter}`,
      resolve: this.resolve,
    };
  }

  /** Resolve a recipe against an arbitrary document (used by `batch`). */
  #resolveAgainst(doc: DocumentState, recipe: SolidRecipe): MeshData {
    if (doc === this.#doc) return this.resolve(recipe);
    if (isStandaloneRecipe(recipe)) return recipeMesh(recipe);
    if (recipe.kind === "transform") {
      const child = doc.solids.get(recipe.child);
      if (!child) throw new Error(`transform references missing solid ${recipe.child}`);
      return applyMatrix4(this.#resolveAgainst(doc, child.recipe), recipe.matrix);
    }
    if (recipe.kind === "boolean") return this.#booleanMesh(doc, recipe, (r) => this.#resolveAgainst(doc, r));
    return applyMatrix4(baseMesh(recipe), recipe.matrix);
  }

  #analyse(id: SolidId): SolidGeometry {
    const solid = this.#doc.solids.get(id);
    if (!solid) throw new Error(`unknown solid ${id}`);
    const cached = this.#cache.get(id);
    if (cached && cached.revision === solid.revision) return cached.geometry;
    const geometry = analyseMesh(this.resolve(solid.recipe));
    this.#cache.set(id, { revision: solid.revision, geometry });
    if (this.#cache.size > this.#cacheLimit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined && oldest !== id) this.#cache.delete(oldest);
    }
    return geometry;
  }

  /** Drop caches for the solids a patch touched, then re-mesh what is still needed. */
  #invalidate(patch: Patch): void {
    const touched = new Set([...patch.forward.keys(), ...patch.backward.keys()]);
    for (const id of touched) this.#cache.delete(id);
    // Dependents (booleans/transforms referring to a touched solid) may be stale too.
    const doc = this.#doc;
    for (const solid of doc.solids.values()) {
      const r = solid.recipe;
      if (r.kind === "boolean" && (touched.has(r.a) || touched.has(r.b))) this.#cache.delete(solid.id);
      if (r.kind === "transform" && touched.has(r.child)) this.#cache.delete(solid.id);
    }
    this.#fit = null;
    for (const id of doc.solids.keys()) {
      try {
        this.#analyse(id);
      } catch {
        // A broken recipe still shows in the outliner; it must not crash the session.
        this.#cache.delete(id);
      }
    }
  }
}

/** Column-major 4x4 applied to a mesh (copies positions, shares indices). */
export function applyMatrix(mesh: MeshData, m: readonly number[]): MeshData {
  return applyMatrix4(mesh, m);
}

export { aabbFromPoints };
export type { Vec3 };
