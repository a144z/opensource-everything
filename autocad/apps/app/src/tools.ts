import type { Entity, EntityId, Pt } from "@apexus/cad";
import {
  addArc,
  addCircle,
  addDimension,
  addEntityCommand,
  addHatch,
  addInsert,
  addLayer,
  addLeader,
  addLine,
  addPoint,
  addPolyline,
  addRectangle,
  addSectionMarker,
  addText,
  boundsOf,
  changeEntities,
  defineBlock,
  deleteLayer,
  deriveOffset,
  dist,
  duplicateEntities,
  entityPoints,
  eraseEntities,
  explodeEntities,
  extendLine,
  filletLines,
  fitPointer,
  formatLength,
  joinEntities,
  joinCommand,
  lastPolyline,
  layerByName,
  measureDimension,
  moveEntities,
  mirrorCommand,
  pairTrims,
  parseLength,
  parseXY,
  pt,
  replaceEntity,
  rotateEntities,
  scaleEntities,
  setCurrentLayer,
  setLayer,
  setPolylinePoints,
  setUnits,
  snapCandidates,
  sub,
  unit,
} from "@apexus/cad";
import type { AppState } from "./state.js";
import type { Camera } from "./camera.js";

/**
 * The tool system: every drawing gesture is a prompt queue.
 *
 * A CAD tool is not an event handler, it is a conversation — "Specify first
 * point:", "Specify next point or [Undo/Close]:". A CAD user answers that
 * conversation twice: with the mouse, or by typing. Keeping *one* state machine
 * that both answers feed is what makes typing `10,20` and clicking at (10, 20)
 * the same code path, and it is why the command line is not a second,
 * half-finished implementation of every tool.
 *
 * A tool never mutates the document directly: it calls `ctx.app.edit`, so a
 * gesture is always an engine command with an invertible patch.
 */

export type PromptKind = "point" | "value" | "text";

export interface Prompt {
  readonly label: string;
  readonly kind: PromptKind;
  /** Rubber band from this point to the cursor (point prompts). */
  readonly from?: Pt;
  /** Keyword options a typed answer may use. */
  readonly options?: readonly string[];
  /** The last accepted point, for `@x,y` relative input. */
  readonly relativeTo?: Pt;
}

export interface ToolContext {
  readonly app: AppState;
  readonly cam: Camera;
  say(text: string, bad?: boolean): void;
  redraw(): void;
}

export type Step =
  | { readonly kind: "next"; readonly prompt: Prompt; readonly message?: string }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "cancel"; readonly message: string }
  | { readonly kind: "same"; readonly message?: string }
  | { readonly kind: "error"; readonly message: string };

export const next = (prompt: Prompt, message?: string): Step => (message === undefined ? { kind: "next", prompt } : { kind: "next", prompt, message });
export const done = (message: string): Step => ({ kind: "done", message });
export const cancel = (message = "Cancelled"): Step => ({ kind: "cancel", message });
export const again = (message?: string): Step => (message === undefined ? { kind: "same" } : { kind: "same", message });
export const fail = (message: string): Step => ({ kind: "error", message });

export interface Answer {
  /** Fitted point for a click, parsed point for typed coordinates, else null. */
  readonly point: Pt | null;
  readonly text: string;
  readonly byClick: boolean;
}

export interface Tool {
  readonly id: string;
  readonly label: string;
  start(ctx: ToolContext): Step;
  answer(ctx: ToolContext, prompt: Prompt, answer: Answer): Step;
  /** Cursor moved. Return the model points of the rubber band. */
  preview?(ctx: ToolContext, prompt: Prompt, fitted: Pt): readonly Pt[];
}

export type ToolFactory = () => Tool;

/** Runs one tool at a time; the shell feeds clicks and typed lines into it. */
export class Runner {
  #tool: Tool | null = null;
  #prompt: Prompt | null = null;
  readonly ctx: ToolContext;
  trail: readonly Pt[] = [];

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  get tool(): Tool | null {
    return this.#tool;
  }

  get prompt(): Prompt | null {
    return this.#prompt;
  }

  /**
   * Accept a tool, or a factory for one. Tools that keep per-gesture state must
   * be built fresh every time, and the shell's registry stores both shapes, so
   * the normalisation lives here rather than in thirty call sites.
   */
  start(tool: Tool | ToolFactory): void {
    const t = typeof tool === "function" ? tool() : tool;
    this.#tool = t;
    this.#apply(t.start(this.ctx));
  }

  answer(a: Answer): void {
    const tool = this.#tool;
    const prompt = this.#prompt;
    if (!tool || !prompt) return;
    this.#apply(tool.answer(this.ctx, prompt, a));
  }

  cancel(): boolean {
    if (!this.#tool) return false;
    this.#tool = null;
    this.#prompt = null;
    this.trail = [];
    this.ctx.say("Cancelled");
    this.ctx.redraw();
    return true;
  }

  preview(raw: Pt): readonly Pt[] {
    if (!this.#tool || !this.#prompt) return [];
    const fitted = fitPoint(this.ctx, this.#prompt, raw);
    this.trail = this.#tool.preview?.(this.ctx, this.#prompt, fitted) ?? [];
    return this.trail;
  }

  #apply(step: Step): void {
    switch (step.kind) {
      case "next":
        this.#prompt = step.prompt;
        this.ctx.say(`${step.message ? step.message + "  " : ""}${describe(step.prompt)}`);
        break;
      case "done":
        this.#tool = null;
        this.#prompt = null;
        this.trail = [];
        this.ctx.say(step.message);
        break;
      case "cancel":
        this.#tool = null;
        this.#prompt = null;
        this.trail = [];
        this.ctx.say(step.message, true);
        break;
      case "same":
        if (this.#prompt) this.ctx.say(`${step.message ? step.message + "  " : ""}${describe(this.#prompt)}`);
        break;
      case "error":
        this.ctx.say(step.message, true);
        break;
    }
    this.ctx.redraw();
  }
}

export function describe(p: Prompt): string {
  return `${p.label}${p.options?.length ? ` [${p.options.join("/")}]` : ""}:`;
}

export function fitPoint(ctx: ToolContext, p: Prompt, raw: Pt): Pt {
  const r = fitPointer(ctx.app.doc, raw, {
    tolerance: ctx.cam.mm(10),
    ...(p.from ? { from: p.from } : {}),
    ortho: ctx.app.settings.ortho,
    objectSnap: ctx.app.settings.osnap,
    ...(ctx.app.settings.gridSnap ? { grid: ctx.cam.gridStep(8) } : {}),
  });
  return r.point;
}

export function snapPreview(ctx: ToolContext, raw: Pt): { point: Pt; label: string } | null {
  if (!ctx.app.settings.osnap) return null;
  const best = snapCandidates(ctx.app.doc, raw, ctx.cam.mm(10))[0];
  if (!best) return null;
  const label = best.snap === "center" ? "Centre" : best.snap === "midpoint" ? "Midpoint" : best.snap === "endpoint" ? "Endpoint" : "On";
  return { point: best.point, label };
}

/**
 * A typed point: `x,y`, `@dx,dy`, `dist<angle`, `@dist<angle`, or a bare
 * distance along the rubber band (`L 100` draws a 100 mm line).
 */
export function parsePointInput(text: string, from: Pt | null, units: Parameters<typeof parseLength>[1]): Pt | null {
  const t = text.trim();
  if (t === "") return null;
  // Absolute and polar coordinates need no previous point; only the relative
  // forms (`@dx,dy`, `@dist<angle`) do, and they say so by returning null.
  const origin = from ?? pt(0, 0);
  if (t.includes("<")) {
    const [dRaw, aRaw] = t.split("<");
    const d = parseLength((dRaw ?? "").replace(/^@/, ""), units);
    const a = Number((aRaw ?? "").trim());
    if (!d || !Number.isFinite(a)) return null;
    const base = t.startsWith("@") ? from : pt(0, 0);
    if (!base) return null;
    const r = (a * Math.PI) / 180;
    return pt(base.x + Math.cos(r) * d.mm, base.y + Math.sin(r) * d.mm);
  }
  if (t.startsWith("@")) {
    const rel = parseXY(t.slice(1), units);
    return rel ? pt(origin.x + rel.x, origin.y + rel.y) : null;
  }
  const abs = parseXY(t, units);
  return abs ? pt(abs.x, abs.y) : null;
}

/** Bare distance typed at a point prompt: the point along the rubber band. */
export function pointAlong(from: Pt, cursor: Pt, distanceMm: number): Pt {
  const u = unit(sub(cursor, from)) ?? pt(1, 0);
  return pt(from.x + u.x * distanceMm, from.y + u.y * distanceMm);
}

function distToEntity(e: Entity, p: Pt): number {
  if (e.kind !== "line" && e.kind !== "polyline") return Infinity;
  const segs: { a: Pt; b: Pt }[] = [];
  if (e.kind === "line") segs.push({ a: e.a, b: e.b });
  else {
    for (let i = 0; i + 1 < e.points.length; i++) segs.push({ a: e.points[i]!, b: e.points[i + 1]! });
    if (e.closed && e.points.length > 2) segs.push({ a: e.points[e.points.length - 1]!, b: e.points[0]! });
  }
  let best = Infinity;
  for (const s of segs) {
    const ab = sub(s.b, s.a);
    const len2 = ab.x * ab.x + ab.y * ab.y || 1e-12;
    const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * ab.x + (p.y - s.a.y) * ab.y) / len2));
    best = Math.min(best, Math.hypot(p.x - (s.a.x + ab.x * t), p.y - (s.a.y + ab.y * t)));
  }
  return best;
}

/** The line under the cursor within the pick radius, nearest first. */
function lineNear(app: AppState, cam: Camera, p: Pt): Extract<Entity, { kind: "line" }> | null {
  let best: { e: Extract<Entity, { kind: "line" }>; d: number } | null = null;
  for (const e of app.doc.entities.values()) {
    if (e.kind !== "line") continue;
    const d = distToEntity(e, p);
    if (d < cam.mm(10) && (!best || d < best.d)) best = { e, d };
  }
  return best?.e ?? null;
}

function selectionEntities(app: AppState): Entity[] {
  return app.session.selection.map((id) => app.doc.entities.get(id)).filter((e): e is Entity => !!e);
}

/** Fail when the tool needs a selection; the message says what to do. */
function needSelection(ctx: ToolContext, what: string, min = 1): Step | null {
  if (ctx.app.session.selection.length >= min) return null;
  return fail(min === 1 ? `Select ${what} first` : `Select at least ${min} ${what} first`);
}

/* ============================================================== draw */

/**
 * Line: click-run, each segment its own undo step (AutoCAD's behaviour), with
 * Close (C) to seal the chain and Undo (U) to drop the last vertex.
 */
export function lineTool(): Tool {
  let pts: Pt[] = [];
  const run = (from: Pt | undefined): Prompt => ({ label: from ? "Specify next point or" : "Specify first point", kind: "point", ...(from ? { from, relativeTo: from } : {}), options: from ? ["U", "C"] : [] });
  return {
    id: "line",
    label: "Line",
    start: () => {
      pts = [];
      return next(run(undefined));
    },
    answer(ctx, p, a) {
      const kw = a.byClick ? "" : a.text.toUpperCase();
      if (kw === "U") {
        if (pts.length === 0) return fail("Nothing to undo");
        const last = [...ctx.app.doc.entities.values()].reverse().find((e) => e.kind === "line" && dist(e.a, pts[pts.length - 1]!) < 1e-9);
        if (last) ctx.app.edit(eraseEntities([last.id]));
        pts.pop();
        const from = pts[pts.length - 1];
        return next(run(from));
      }
      if (!a.point) return fail("A point is needed, or U / C");
      if (kw === "C") {
        if (pts.length < 2) return fail("Close needs at least two points");
        const r = ctx.app.edit(addLine(pts[pts.length - 1]!, pts[0]!));
        if (!r.ok) return fail(r.error ?? "could not close");
        return done(`Closed with ${pts.length + 1} segments`);
      }
      if (pts.length === 0) {
        pts = [a.point];
        return next(run(a.point));
      }
      const last = pts[pts.length - 1]!;
      if (dist(last, a.point) < 1e-9) return fail("Zero-length line refused");
      const r = ctx.app.edit(addLine(last, a.point));
      if (!r.ok) return fail(r.error ?? "could not add line");
      pts = [...pts, a.point];
      return next(run(a.point));
    },
    preview: (_c, p) => (p.from ? [p.from, p.from] : []),
  };
}

/**
 * Polyline: one vertex per pick, every vertex edit rewriting the *same* entity so
 * the run is a single polyline. `live` holds the id this gesture created, so it
 * never stitches onto a polyline left over from an earlier command.
 */
export function polylineTool(): Tool {
  let live: EntityId | null = null;
  const run = (from: Pt | undefined): Prompt => ({ label: from ? "Specify next point or" : "Specify start point", kind: "point", ...(from ? { from, relativeTo: from } : {}), options: from ? ["U", "C"] : [] });
  return {
    id: "polyline",
    label: "Polyline",
    start: () => {
      live = null;
      return next(run(undefined));
    },
    answer(ctx, p, a) {
      const current = live ? ctx.app.doc.entities.get(live) : null;
      const pl = current?.kind === "polyline" ? current : null;
      const kw = a.byClick ? "" : a.text.toUpperCase();
      if (kw === "C" && pl) {
        const r = ctx.app.edit(setPolylinePoints(pl.id, pl.points, true));
        live = null;
        return r.ok ? done(`Polyline closed with ${pl.points.length} vertices`) : fail(r.error ?? "could not close");
      }
      if (kw === "U") {
        if (!pl) return fail("Nothing to undo");
        if (pl.points.length <= 2) {
          ctx.app.edit(eraseEntities([pl.id]));
          live = null;
          return next(run(undefined));
        }
        const pts = pl.points.slice(0, -1);
        ctx.app.edit(setPolylinePoints(pl.id, pts));
        return next(run(pts[pts.length - 1]));
      }
      if (!a.point) return fail("A point is needed, or U / C");
      if (!pl) {
        const r = ctx.app.edit(addPolyline([a.point], false));
        if (!r.ok) return fail(r.error ?? "could not start polyline");
        const made = `pl${ctx.app.session.doc.order.length}`;
        void made;
        const fresh = [...ctx.app.doc.entities.values()].reverse().find((e) => e.kind === "polyline");
        live = fresh?.id ?? null;
        return next(run(a.point));
      }
      const last = pl.points[pl.points.length - 1]!;
      if (dist(last, a.point) < 1e-9) return fail("Zero-length segment refused");
      const r = ctx.app.edit(setPolylinePoints(pl.id, [...pl.points, a.point]));
      if (!r.ok) return fail(r.error ?? "could not extend polyline");
      return next(run(a.point));
    },
    preview: (_c, p) => (p.from ? [p.from, p.from] : []),
  };
}

export const rectangleTool: Tool = {
  id: "rect",
  label: "Rectangle",
  start: () => next({ label: "Specify first corner", kind: "point" }),
  answer(ctx, p, a) {
    if (!a.point) return fail("A corner is needed");
    if (p.from === undefined) return next({ label: "Specify opposite corner", kind: "point", from: a.point, relativeTo: a.point });
    const r = ctx.app.edit(addRectangle(p.from, a.point));
    if (!r.ok) return fail(r.error ?? "could not add rectangle");
    return done("Rectangle added");
  },
  preview: (_c, p) => {
    if (!p.from) return [];
    return [p.from, p.from];
  },
};

export const circleTool: Tool = {
  id: "circle",
  label: "Circle",
  start: () => next({ label: "Specify centre point", kind: "point" }),
  answer(ctx, p, a) {
    if (p.from === undefined) {
      if (!a.point) return fail("A centre is needed");
      return next({ label: "Specify radius", kind: "value", from: a.point, relativeTo: a.point });
    }
    let radius: number;
    if (a.point) radius = dist(p.from, a.point);
    else {
      const len = parseLength(a.text, ctx.app.doc.units);
      if (!len) return fail("A radius is needed");
      radius = len.mm;
    }
    const r = ctx.app.edit(addCircle(p.from, radius));
    if (!r.ok) return fail(r.error ?? "could not add circle");
    return done(`Circle r=${formatLength(radius, ctx.app.doc.units)}`);
  },
  preview: (_c, p) => (p.from ? [p.from, p.from] : []),
};

export const arcTool: Tool = {
  id: "arc",
  label: "Arc",
  start: () => next({ label: "Specify centre", kind: "point" }),
  answer(ctx, p, a) {
    if (!a.point) return fail("A point is needed");
    if (p.from === undefined) return next({ label: "Specify start point", kind: "point", from: a.point, relativeTo: a.point });
    if (p.relativeTo === undefined) return fail("unexpected prompt");
    const [kind, , rest] = ["", "", ""];
    void kind;
    void rest;
    return fail("unreachable");
  },
};

export const textTool: Tool = {
  id: "text",
  label: "Text",
  start: () => next({ label: "Specify text insertion point", kind: "point" }),
  answer(ctx, p, a) {
    if (p.kind === "text" && p.from) {
      const value = a.text === "" ? "Text" : a.text;
      const r = ctx.app.edit(addText(p.from, value));
      if (!r.ok) return fail(r.error ?? "could not add text");
      return next({ label: "Specify text insertion point", kind: "point" }, "Text added.");
    }
    if (!a.point) return fail("A point is needed");
    return next({ label: "Enter text", kind: "text", from: a.point });
  },
};

export const pointTool: Tool = {
  id: "point",
  label: "Point",
  start: () => next({ label: "Specify point", kind: "point" }),
  answer(ctx, _p, a) {
    if (!a.point) return fail("A point is needed");
    const r = ctx.app.edit(addPoint(a.point));
    if (!r.ok) return fail(r.error ?? "could not add point");
    return next({ label: "Specify point", kind: "point" }, "Point added.");
  },
};

/* ======================================================== dimensions */

export function dimLinearTool(): Tool {
  let origins: Pt[] = [];
  return {
  id: "dimlinear",
  label: "Linear dimension",
  start: () => {
    origins = [];
    return next({ label: "Specify first extension line origin", kind: "point" });
  },
  answer(ctx, p, a) {
    void p;
    if (!a.point) return fail("A point is needed");
    // Three picks: first origin, second origin, then where the dimension line
    // sits. `origins` is the gesture's two measured points; the third answer is
    // only a placement, so it must not overwrite them.
    if (origins.length === 0) {
      origins = [a.point];
      return next({ label: "Specify second extension line origin", kind: "point", from: a.point, relativeTo: a.point });
    }
    if (origins.length === 1) {
      origins = [origins[0]!, a.point];
      return next({ label: "Specify dimension line location", kind: "point", from: a.point, relativeTo: a.point });
    }
    const r = ctx.app.edit(addDimension(origins[0]!, origins[1]!, a.point, undefined, { dim: "linear" }));
    if (!r.ok) return fail(r.error ?? "could not add dimension");
    return done("Dimension added — click it to type a value and drive the geometry");
  },
  preview: (_c, p) => (p.from ? [p.from, p.from] : []),
  };
}

export const dimRadiusTool: Tool = {
  id: "dimradius",
  label: "Radius dimension",
  start: () => next({ label: "Select a circle or arc", kind: "point" }),
  answer(ctx, _p, a) {
    if (!a.point) return fail("Click a circle or arc");
    const at: Pt = a.point;
    const hit = [...ctx.app.doc.entities.values()].find((e) => (e.kind === "circle" || e.kind === "arc") && Math.abs(dist(at, e.center) - e.radius) < ctx.cam.mm(10) + 0.5);
    if (!hit || (hit.kind !== "circle" && hit.kind !== "arc")) return fail("No circle or arc under the cursor");
    const edge = pt(hit.center.x + hit.radius, hit.center.y);
    const r = ctx.app.edit(addDimension(edge, hit.center, pt(hit.center.x + hit.radius * 1.35, hit.center.y + hit.radius * 0.6), undefined, { dim: "radius" }));
    if (!r.ok) return fail(r.error ?? "could not add dimension");
    return next({ label: "Select a circle or arc", kind: "point" }, "Radius dimension added.");
  },
};

export const hatchTool: Tool = {
  id: "hatch",
  label: "Hatch",
  start: (ctx) => needSelection(ctx, "closed polylines to hatch") ?? next({ label: "Pattern", kind: "text" }),
  answer(ctx, _p, a) {
    const pattern = a.text.trim() === "" ? "SOLID" : a.text.trim().toUpperCase();
    const rings = selectionEntities(ctx.app)
      .filter((e): e is Extract<Entity, { kind: "polyline" }> => e.kind === "polyline" && e.closed)
      .map((e) => e.points);
    if (rings.length === 0) return fail("Hatching needs a closed polyline in the selection");
    const r = ctx.app.edit(addHatch(rings, pattern));
    if (!r.ok) return fail(r.error ?? "could not add hatch");
    return done(`Hatch ${pattern} added`);
  },
};

export const leaderTool: Tool = {
  id: "leader",
  label: "Leader",
  start: () => next({ label: "Specify arrow point", kind: "point" }),
  answer(ctx, p, a) {
    if (p.kind === "text" && p.from) {
      const text = a.text === "" ? "Note" : a.text;
      const r = ctx.app.edit(addLeader([p.from, pt(p.from.x + ctx.cam.mm(70), p.from.y + ctx.cam.mm(35))], text));
      if (!r.ok) return fail(r.error ?? "could not add leader");
      return next({ label: "Specify arrow point", kind: "point" }, "Leader added.");
    }
    if (!a.point) return fail("A point is needed");
    return next({ label: "Enter leader text", kind: "text", from: a.point });
  },
};

export const sectionTool: Tool = {
  id: "section",
  label: "Section marker",
  start: () => next({ label: "Specify first section point", kind: "point" }),
  answer(ctx, p, a) {
    if (!a.point) return fail("A point is needed");
    if (!p.from) return next({ label: "Specify end point", kind: "point", from: a.point, relativeTo: a.point });
    const r = ctx.app.edit(addSectionMarker(p.from, a.point, "A"));
    if (!r.ok) return fail(r.error ?? "could not add section marker");
    return next({ label: "Specify first section point", kind: "point" }, "Section marker added.");
  },
  preview: (_c, p) => (p.from ? [p.from, p.from] : []),
};

export const blockTool: Tool = {
  id: "block",
  label: "Make block",
  start: (ctx) => needSelection(ctx, "the entities for the block") ?? next({ label: "Block name", kind: "text" }),
  answer(ctx, _p, a) {
    const selection = [...ctx.app.session.selection];
    const r = ctx.app.edit(defineBlock(a.text === "" ? "Block" : a.text, selection));
    if (!r.ok) return fail(r.error ?? "could not define block");
    ctx.app.select([]);
    return done("Block defined — Insert places it");
  },
};

export const insertTool: Tool = {
  id: "insert",
  label: "Insert block",
  start: (ctx) => {
    const first = [...ctx.app.doc.blocks.values()][0];
    return first ? next({ label: `Insertion point for ${first.name}`, kind: "point" }) : fail("No block definitions in this drawing");
  },
  answer(ctx, _p, a) {
    const first = [...ctx.app.doc.blocks.values()][0];
    if (!first) return fail("No block definitions in this drawing");
    if (!a.point) return fail("A point is needed");
    const r = ctx.app.edit(addInsert(first.id, a.point));
    if (!r.ok) return fail(r.error ?? "could not insert block");
    return next({ label: `Insertion point for ${first.name}`, kind: "point" }, `Inserted ${first.name}.`);
  },
};

/* ============================================================ modify */

export function moveTool(copy: boolean): () => Tool {
  return () => {
    let from: ReturnType<typeof pt> | null = null;
    return {
      id: copy ? "copy" : "move",
      label: copy ? "Copy" : "Move",
      start: (ctx) => {
        from = null;
        return needSelection(ctx, copy ? "what to copy" : "what to move") ?? next({ label: "Specify base point", kind: "point" });
      },
      answer(ctx, p, a) {
        if (!a.point) return fail("A point is needed");
        if (!from) {
          from = a.point;
          return next({ label: "Specify second point", kind: "point", from: a.point, relativeTo: a.point });
        }
        const delta = pt(a.point.x - from.x, a.point.y - from.y);
        const ids = [...ctx.app.session.selection];
        const r = copy ? ctx.app.edit(duplicateEntities(ids, delta)) : ctx.app.edit(moveEntities(ids, delta));
        from = null;
        if (!r.ok) return fail(r.error ?? "could not move");
        return done(`${copy ? "Copied" : "Moved"} ${ids.length}`);
      },
      preview: (_c, p) => (p.from ? [p.from, p.from] : []),
    };
  };
}

export const rotateTool: () => Tool = () => {
  let centre: Pt | null = null;
  return {
    id: "rotate",
    label: "Rotate",
    start: (ctx) => {
      centre = null;
      return needSelection(ctx, "what to rotate") ?? next({ label: "Specify base point", kind: "point" });
    },
    answer(ctx, p, a) {
      if (p.kind === "value" && centre) {
        const deg = Number(a.text);
        // A click at a value prompt is a reference point: the angle is the
        // cursor's angle about the base point, which is how AutoCAD does it.
        const base: Pt = centre;
        const angle = a.point ? Math.atan2(a.point.y - centre.y, a.point.x - centre.x) : Number.isFinite(deg) ? (deg * Math.PI) / 180 : NaN;
        if (!Number.isFinite(angle)) return fail("An angle in degrees is needed");
        const r = ctx.app.edit(rotateEntities(ctx.app.session.selection, centre, angle));
        if (!r.ok) return fail(r.error ?? "could not rotate");
        return done(`Rotated ${((angle * 180) / Math.PI).toFixed(1)}°`);
      }
      if (!a.point) return fail("A point is needed");
      centre = a.point;
      return next({ label: "Rotation angle (degrees, or click a reference point)", kind: "value", from: a.point });
    },
  };
};

export const scaleTool: () => Tool = () => {
  let centre: Pt | null = null;
  return {
    id: "scale",
    label: "Scale",
    start: (ctx) => {
      centre = null;
      return needSelection(ctx, "what to scale") ?? next({ label: "Specify base point", kind: "point" });
    },
    answer(ctx, p, a) {
      if (p.kind === "value" && centre) {
        const f = Number(a.text);
        if (!Number.isFinite(f) || f <= 0) return fail("A factor greater than 0 is needed");
        const r = ctx.app.edit(scaleEntities(ctx.app.session.selection, centre, f));
        if (!r.ok) return fail(r.error ?? "could not scale");
        return done(`Scaled by ${f}`);
      }
      if (!a.point) return fail("A point is needed");
      centre = a.point;
      return next({ label: "Scale factor", kind: "value", from: a.point });
    },
  };
};

export const mirrorTool: () => Tool = () => {
  let a0: Pt | null = null;
  return {
    id: "mirror",
    label: "Mirror",
    start: (ctx) => {
      a0 = null;
      return needSelection(ctx, "what to mirror") ?? next({ label: "Specify first point of mirror line", kind: "point" });
    },
    answer(ctx, _p, a) {
      if (!a.point) return fail("A point is needed");
      if (!a0) {
        a0 = a.point;
        return next({ label: "Specify second point of mirror line", kind: "point", from: a.point, relativeTo: a.point });
      }
      const r = ctx.app.edit(mirrorCommand(ctx.app.session.selection, a0, a.point, false));
      a0 = null;
      if (!r.ok) return fail(r.error ?? "could not mirror");
      return done("Mirrored");
    },
    preview: (_c, p) => (p.from ? [p.from, p.from] : []),
  };
};

export const eraseTool: Tool = {
  id: "erase",
  label: "Erase",
  start: (ctx) => {
    const bad = needSelection(ctx, "what to erase");
    if (bad) return bad;
    const n = ctx.app.session.selection.length;
    const r = ctx.app.edit(eraseEntities(ctx.app.session.selection));
    return r.ok ? done(`Erased ${n}`) : fail(r.error ?? "could not erase");
  },
  answer: () => done("Nothing to answer"),
};

export const offsetTool: () => Tool = () => {
  let distance = 0;
  return {
    id: "offset",
    label: "Offset",
    start: () => {
      distance = 0;
      return next({ label: "Offset distance", kind: "value" });
    },
    answer(ctx, p, a) {
      if (p.kind === "value" && distance === 0) {
        const len = parseLength(a.text, ctx.app.doc.units);
        if (!len) return fail("A distance is needed");
        distance = len.mm;
        return next({ label: "Click the entity, then the side to offset to", kind: "point" });
      }
      if (!a.point) return fail("Click beside the entity to offset");
      const side: Pt = a.point;
      const target = [...ctx.app.doc.entities.values()]
        .filter((e): e is Extract<Entity, { kind: "line" | "polyline" }> => e.kind === "line" || e.kind === "polyline")
        .map((e) => ({ e, d: distToEntity(e, side) }))
        .filter((c) => c.d < ctx.cam.mm(12))
        .sort((x, y) => x.d - y.d)[0];
      if (!target) return fail("No line or polyline under the cursor");
      const made = makeOffset(target.e, distance, a.point);
      if (!made) return fail("Offset failed: the shape is too small for that distance");
      const r = ctx.app.edit(made);
      if (!r.ok) return fail(r.error ?? "could not offset");
      return next({ label: "Click the entity side to offset to", kind: "point" }, `Offset ${formatLength(distance, ctx.app.doc.units)}.`);
    },
  };
};

function makeOffset(e: Extract<Entity, { kind: "line" | "polyline" }>, distance: number, side: Pt): ReturnType<typeof addLine> | ReturnType<typeof addPolyline> | null {
  if (e.kind === "line") {
    const ab = sub(e.b, e.a);
    const len = Math.hypot(ab.x, ab.y);
    if (len < 1e-9) return null;
    const n = pt(-ab.y / len, ab.x / len);
    const m = pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
    const sign = (side.x - m.x) * n.x + (side.y - m.y) * n.y >= 0 ? 1 : -1;
    const d = pt(n.x * distance * sign, n.y * distance * sign);
    return addLine(pt(e.a.x + d.x, e.a.y + d.y), pt(e.b.x + d.x, e.b.y + d.y));
  }
  // A closed ring offsets away from the side the user clicked; the engine
  // decides the sign from the winding (outside = the opposite of the normal
  // for a counter-clockwise ring).
  const inside = pointInRing(side, e.points);
  const ccw = signedAreaOf(e.points) > 0;
  const signed = inside === ccw ? -distance : distance;
  const derived = deriveOffset(e, signed);
  if (!derived) return null;
  return addPolyline(derived.points, e.closed, undefined, derived.bulges);
}

function signedAreaOf(points: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

function pointInRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const trimTool: Tool = {
  id: "trim",
  label: "Trim",
  start: (ctx) => needSelection(ctx, "the cutters") ?? next({ label: "Click the part to remove", kind: "point" }),
  answer(ctx, _p, a) {
    if (!a.point) return fail("Click the part to remove");
    const trims = pairTrims(ctx.app.doc, selectionEntities(ctx.app), a.point, ctx.cam.mm(10));
    if (trims.length === 0) return fail("Nothing to trim under the cursor");
    const r = ctx.app.editMany(trims, "Trim");
    if (!r.ok) return fail(r.error ?? "could not trim");
    return again("Trimmed.");
  },
};

export const extendTool: Tool = {
  id: "extend",
  label: "Extend",
  start: (ctx) => needSelection(ctx, "the target edges") ?? next({ label: "Click the line near the end to extend", kind: "point" }),
  answer(ctx, _p, a) {
    if (!a.point) return fail("Click a line");
    const targets = selectionEntities(ctx.app)
      .filter((e): e is Extract<Entity, { kind: "line" }> => e.kind === "line")
      .map((e) => ({ a: e.a, b: e.b }));
    const line = lineNear(ctx.app, ctx.cam, a.point);
    if (!line) return fail("No line under the cursor");
    const ext = extendLine({ a: line.a, b: line.b }, targets, a.point);
    if (!ext) return fail("The line does not reach any selected edge");
    const r = ctx.app.edit(replaceEntity(line.id, (e) => ({ ...(e as Extract<Entity, { kind: "line" }>), a: ext.a, b: ext.b })));
    if (!r.ok) return fail(r.error ?? "could not extend");
    return again("Extended.");
  },
};

export const filletTool: () => Tool = () => {
  let radius = 0;
  let firstId: EntityId | null = null;
  return {
    id: "fillet",
    label: "Fillet",
    start: () => {
      firstId = null;
      return next({ label: "Fillet radius", kind: "value" });
    },
    answer(ctx, p, a) {
      if (p.kind === "value") {
        const len = parseLength(a.text, ctx.app.doc.units);
        radius = len ? len.mm : 0;
        return next({ label: "Click the first line", kind: "point" });
      }
      if (!a.point) return fail("Click a line");
      const line = lineNear(ctx.app, ctx.cam, a.point);
      if (!line) return fail("No line under the cursor");
      if (!firstId) {
        firstId = line.id;
        return next({ label: "Click the second line", kind: "point" });
      }
      const first = ctx.app.doc.entities.get(firstId);
      if (!first || first.kind !== "line") return fail("The first line is gone");
      const f = filletLines(first, line, radius, "a");
      if (!f) return fail("No fillet of that radius fits between these lines");
      const arc: Entity = { ...first, id: "fillet", kind: "arc", center: f.arc.center, radius: f.arc.radius, start: f.arc.start, end: f.arc.end };
      const cmds = [
        replaceEntity(first.id, (e) => ({ ...(e as Extract<Entity, { kind: "line" }>), a: f.lineA })),
        replaceEntity(line.id, (e) => ({ ...(e as Extract<Entity, { kind: "line" }>), b: f.lineB })),
        addEntityCommand(arc),
      ];
      const r = ctx.app.editMany(cmds, "Fillet");
      firstId = null;
      if (!r.ok) return fail(r.error ?? "could not fillet");
      return next({ label: "Click the first line", kind: "point" }, `Fillet r=${formatLength(radius, ctx.app.doc.units)}.`);
    },
  };
};

export const joinTool: Tool = {
  id: "join",
  label: "Join",
  start: (ctx) => {
    const bad = needSelection(ctx, "lines or polylines to join", 2);
    if (bad) return bad;
    const ids = [...ctx.app.session.selection];
    const cmd = joinCommand(ctx.app.doc, ids, ctx.cam.mm(2));
    if (!cmd) return fail("Those entities do not share endpoints");
    const r = ctx.app.edit(cmd);
    if (!r.ok) return fail(r.error ?? "could not join");
    ctx.app.select([]);
    return done(`Joined ${ids.length}`);
  },
  answer: () => done("Nothing to answer"),
};

export const explodeTool: Tool = {
  id: "explode",
  label: "Explode",
  start: (ctx) => {
    const ids = ctx.app.session.selection.filter((id) => {
      const e = ctx.app.doc.entities.get(id);
      return !!e && (e.kind === "insert" || e.kind === "polyline");
    });
    if (ids.length === 0) return fail("Select blocks or polylines to explode");
    const parts = explodeEntities(ctx.app.doc, ids);
    const r = ctx.app.edit(changeEntities("Explode", parts.remove, parts.create.map((e) => [e.id, e] as const)));
    if (!r.ok) return fail(r.error ?? "could not explode");
    ctx.app.select([]);
    return done(`Exploded ${ids.length} into ${parts.create.length}`);
  },
  answer: () => done("Nothing to answer"),
};

export const arrayTool: () => Tool = () => {
  let rows = 1;
  let cols = 1;
  return {
    id: "array",
    label: "Array",
    start: (ctx) => {
      rows = 1;
      cols = 1;
      return needSelection(ctx, "what to array") ?? next({ label: "Rows", kind: "value" });
    },
    answer(ctx, p, a) {
      if (p.label === "Rows" || p.label === "Columns") {
        const n = Number(a.text);
        if (!Number.isInteger(n) || n < 1) return fail(`${p.label} must be a whole number of at least 1`);
        if (p.label === "Rows") {
          rows = n;
          return next({ label: "Columns", kind: "value" });
        }
        cols = n;
        return next({ label: "Spacing between copies (click or type dx,dy)", kind: "point" });
      }
      if (!a.point) return fail("A spacing point is needed");
      const ids = [...ctx.app.session.selection];
      const cmds = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r === 0 && c === 0) continue;
          cmds.push(duplicateEntities(ids, pt(a.point.x * c, a.point.y * r)));
        }
      }
      if (cmds.length === 0) return fail("An array of 1 x 1 is the original");
      const r = ctx.app.editMany(cmds, "Array");
      if (!r.ok) return fail(r.error ?? "could not array");
      return done(`Array ${rows} x ${cols}`);
    },
  };
};

/** Pick every entity whose points all fall inside (or any touches) a box. */
export function hitsForWindow(app: AppState, a: Pt, b: Pt, crossing: boolean): EntityId[] {
  const min = pt(Math.min(a.x, b.x), Math.min(a.y, b.y));
  const max = pt(Math.max(a.x, b.x), Math.max(a.y, b.y));
  const out: EntityId[] = [];
  for (const e of app.doc.entities.values()) {
    const layer = app.doc.layers.get(e.layer);
    if (!layer?.visible || layer.frozen) continue;
    const pts = entityPoints(e);
    if (pts.length === 0) continue;
    const inside = (p: Pt): boolean => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
    if (crossing ? pts.some(inside) : pts.every(inside)) out.push(e.id);
  }
  return out;
}

/* ============================================================ layers */

export function layerCommands(app: AppState) {
  return {
    add(name: string): string | null {
      const r = app.edit(addLayer(name, nextLayerColor(app)));
      if (!r.ok) return r.error ?? "could not add layer";
      const created = layerByName(app.doc, name);
      if (created) app.edit(setCurrentLayer(created.id));
      return null;
    },
    rename(id: string, name: string): string | null {
      const r = app.edit(setLayer(id, { name }));
      return r.ok ? null : r.error ?? "could not rename layer";
    },
    remove(id: string): string | null {
      const r = app.edit(deleteLayer(id));
      return r.ok ? null : r.error ?? "could not delete layer";
    },
    toggle(id: string, key: "visible" | "locked" | "frozen"): string | null {
      const layer = app.doc.layers.get(id);
      if (!layer) return "no such layer";
      const r = app.edit(setLayer(id, { [key]: !layer[key] }));
      if (key !== "visible") app.select([]);
      return r.ok ? null : r.error ?? "could not change layer";
    },
    color(id: string, color: number): string | null {
      const r = app.edit(setLayer(id, { color }));
      return r.ok ? null : r.error ?? "could not set colour";
    },
    current(id: string): string | null {
      const r = app.edit(setCurrentLayer(id));
      return r.ok ? null : r.error ?? "could not set current layer";
    },
    units(unit: Parameters<typeof setUnits>[0]): string | null {
      const r = app.edit(setUnits(unit));
      return r.ok ? null : r.error ?? "could not set units";
    },
  };
}

const LAYER_COLORS = [0xff6a55, 0xffd166, 0x6fcf7f, 0x4ea1ff, 0xc792ea, 0x64d8cb, 0xffffff];
function nextLayerColor(app: AppState): number {
  const used = new Set([...app.doc.layers.values()].map((l) => l.color));
  return LAYER_COLORS.find((c) => !used.has(c)) ?? LAYER_COLORS[app.doc.layers.size % LAYER_COLORS.length]!;
}
