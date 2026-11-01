import * as THREE from "three";
import { formatLength, parseLength, type Vec2, type Vec3 } from "@apexus/geometry";
import {
  addSolid as addSolidCmd,
  guessAxis,
  makeAnnotation,
  pullFace as pullFaceCmd,
  scaleSolids,
  translateSolids,
  type Annotation,
  type Session,
  type SolidId,
  type SolidRecipe,
} from "@apexus/engine";
import type { View, PickHit, Tool } from "./view.js";
import type { Snapper } from "./snap.js";

/**
 * Tool layer. Owns transient interaction state (a half-drawn rectangle, a Pending
 * push/pull) and turns it into engine Commands. It never touches the document:
 * the app's change subscription reconciles the scene afterwards.
 */

export interface ToolHost {
  readonly session: Session;
  readonly view: View;
  readonly snapper: Snapper;
  /** Something user-visible happened (typed length, rejected edit). */
  setHint(text: string): void;
  /** Selection is app state; the tool asks the shell to change it. */
  select(ids: readonly SolidId[]): void;
  /** Screen position of the cursor, for the distance readout. */
  cursor(): { x: number; y: number };
  /** Unit shown to the user for typed lengths. */
  unit(): "mm" | "cm" | "m" | "in";
  /** Shift held: constrain movement to the dominant axis. */
  axisLocked(): boolean;
  /** Annotations are app state (they never enter the document); the tool adds here. */
  annotate(note: Annotation): void;
}

type Pending =
  | { readonly kind: "rect"; readonly start: Vec2; current: Vec2 }
  | {
      readonly kind: "pull";
      readonly id: SolidId;
      readonly faceNormal: Vec3;
      readonly planeOrigin: Vec3;
      readonly start: Vec3;
      /** Height before the drag, so the drag sets the total rather than adding. */
      readonly baseDistance: number;
      current: Vec3;
      typed: number | null;
    }
  | { readonly kind: "line"; readonly from: Vec3; readonly planeNormal: Vec3; current: Vec3 }
  | {
      /** Dimension: a persistent annotation between two points, not geometry. */
      readonly kind: "dimension";
      readonly from: Vec3;
      readonly planeNormal: Vec3;
      current: Vec3;
    }
  | { readonly kind: "tape"; readonly from: Vec3; readonly planeNormal: Vec3; current: Vec3 }
  | {
      /** Follow-me: the path is a line already on the ground, the profile a solid. */
      readonly kind: "follow";
      readonly profileId: SolidId;
      readonly path: readonly Vec3[];
      current: Vec3;
    }
  | {
      /** Offset: copy a solid and scale it about its own centre. */
      readonly kind: "offset";
      readonly id: SolidId;
      readonly centre: Vec3;
      readonly base: number;
      current: number;
    };

export class ToolController {
  #host: ToolHost;
  #tool: Tool = "select";
  #pending: Pending | null = null;
  #hover: Vec3 | null = null;
  #preview: THREE.Line;
  #ghost: THREE.Line;
  #typed = "";
  #lastPullId: SolidId | null = null;

  constructor(host: ToolHost) {
    this.#host = host;
    this.#preview = makeDashedLine(0xffb347);
    this.#ghost = makeDashedLine(0x8ab4ff);
    host.view.scene.add(this.#preview, this.#ghost);
  }

  get tool(): Tool {
    return this.#tool;
  }

  get hasPending(): boolean {
    return this.#pending !== null;
  }

  setTool(tool: Tool): void {
    this.#cancel();
    this.#tool = tool;
    this.#host.view.setTool(tool);
    this.#host.setHint(HINTS[tool]);
  }

  cancel(): void {
    this.#cancel();
  }

  /** Typed digits while a tool is active (numeric entry, task L1-12). */
  typeKey(key: string): boolean {
    if (!this.#pending) return false;
    if (/^[0-9.,-]$/.test(key)) {
      this.#typed += key;
      this.#applyTyped();
      return true;
    }
    if (key === "Enter" && this.#typed) {
      this.#applyTyped(true);
      this.#typed = "";
      return true;
    }
    if (key === "Backspace" && this.#typed) {
      this.#typed = this.#typed.slice(0, -1);
      this.#applyTyped();
      return true;
    }
    return false;
  }

  #applyTyped(commit = false): void {
    const p = this.#pending;
    const parsed = this.#typed ? parseLength(this.#typed, this.#host.unit()) : null;
    this.#host.setHint(
      parsed ? `${this.#typed}  ${parsed.mm.toFixed(1)} mm (Enter to apply)` : `Type a length: ${this.#typed || ""}`,
    );
    if (!p) return;
    if (p.kind === "rect" && parsed) {
      // A typed length turns a free rectangle into a square of that size.
      const sx = Math.sign(p.current[0] - p.start[0]) || 1;
      const sy = Math.sign(p.current[1] - p.start[1]) || 1;
      p.current = [p.start[0] + sx * parsed.mm, p.start[1] + sy * parsed.mm];
      this.#drawRect(p.start, p.current);
    } else if ((p.kind === "pull" || p.kind === "offset") && parsed) {
      if (p.kind === "pull") {
        p.typed = parsed.mm;
        this.#drawPull(p, parsed.mm);
      } else {
        p.current = p.base + parsed.mm;
        this.#drawOffset(p);
      }
    } else if ((p.kind === "line" || p.kind === "tape" || p.kind === "dimension") && parsed) {
      // Typed length runs along the current direction.
      const d = sub3(p.current, p.from);
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      p.current = [p.from[0] + (d[0] / len) * parsed.mm, p.from[1] + (d[1] / len) * parsed.mm, p.from[2] + (d[2] / len) * parsed.mm];
      this.#drawSpan(p.from, p.current);
    }
    if (commit) {
      if (p.kind === "pull") this.#commitPull(p, parsed ? parsed.mm : 0);
      else if (p.kind === "rect") this.#commitRect(p);
      else if (p.kind === "line") this.#commitLine(p);
      else if (p.kind === "offset") this.#commitOffset(p);
      else if (p.kind === "tape") this.#commitTape(p);
    }
  }

  /* ----------------------------------------------------------- mouse flow */

  hover(point: Vec3 | null, clientX: number, clientY: number): void {
    this.#hover = point;
    const p = this.#pending;
    if (p?.kind === "rect" && point) {
      p.current = [point[0], point[1]];
      this.#drawRect(p.start, p.current);
      this.#host.setHint(
        `Rectangle ${fmt(Math.abs(p.current[0] - p.start[0]))}  ${fmt(Math.abs(p.current[1] - p.start[1]))} mm  click to finish, Esc cancels`,
      );
    } else if (p?.kind === "pull") {
      this.drag(clientX, clientY);
    } else if (p?.kind === "line" || p?.kind === "tape" || p?.kind === "dimension") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.from, p.planeNormal);
      if (!pt) return;
      const snapped = this.#snap(pt);
      const to = this.#constrain(p.from, snapped.point);
      p.current = to;
      this.#drawSpan(p.from, to);
      const label = p.kind === "tape" ? "Tape" : p.kind === "dimension" ? "Dimension" : "Line";
      this.#host.setHint(
        `${label} ${fmt(distance(p.from, to))} mm  ${this.#glyphHint()} click to finish, Esc cancels`,
      );
    } else if (p?.kind === "follow" && point) {
      p.current = point;
      const last = p.path[p.path.length - 1]!;
      this.#drawSpan(last, point);
      this.#host.setHint("Follow Me: click on the plane to finish the path, Esc cancels");
    } else if (p?.kind === "offset") {
      p.current = p.base + this.#anchorDelta(p.id, clientX, clientY);
      this.#drawOffset(p);
      this.#host.setHint(
        `Offset ${fmt(p.base)} -> ${fmt(p.current)} mm  click to apply, Esc cancels`,
      );
    }
  }

  click(hit: PickHit, additive: boolean, clientX: number, clientY: number): void {
    switch (this.#tool) {
      case "rectangle":
        this.#clickRectangle(hit);
        return;
      case "pushpull":
        this.#clickPull(hit, clientX, clientY);
        return;
      case "line":
        this.#clickLine(hit, clientX, clientY);
        return;
      case "tape":
        this.#clickTape(hit, clientX, clientY);
        return;
      case "dimension":
        this.#clickDimension(hit, clientX, clientY);
        return;
      case "followme":
        this.#clickFollow(hit);
        return;
      case "offset":
        this.#clickOffset(hit);
        return;
      case "select":
        this.#clickSelect(hit, additive);
        return;
    }
  }

  /** Live feedback while dragging a face (button held) or tracking the mouse. */
  drag(clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind !== "pull") return;
    const pt = this.#host.view.planePoint(clientX, clientY, p.planeOrigin, p.faceNormal);
    if (!pt) return;
    const d = Math.abs(dot3(sub3(pt, p.planeOrigin), p.faceNormal));
    if (d < 0.5) return;
    p.current = pt;
    const distance = p.baseDistance + d;
    this.#drawPull(p, distance - p.baseDistance);
    this.#host.setHint(`Push/Pull ${fmt(distance)} mm  click or release to apply, Esc cancels`);
  }

  /* ------------------------------------------------------------- snapping */

  #snap(raw: Vec3): ReturnType<Snapper["snap"]> {
    const result = this.#host.snapper.snap(raw, this.#host.view.mmPerPixel(), {
      gridStep: GRID_MM,
    });
    this.#glyph = result.glyph.label;
    return result;
  }

  #glyph = "";

  #glyphHint(): string {
    return this.#glyph ? `[${this.#glyph}]` : "";
  }

  /** Shift locks to the dominant axis; otherwise the point passes through. */
  #constrain(from: Vec3, to: Vec3): Vec3 {
    if (!this.#host.axisLocked()) return to;
    const d = sub3(to, from);
    const ax = Math.abs(d[0]);
    const ay = Math.abs(d[1]);
    const az = Math.abs(d[2]);
    if (az >= ax && az >= ay) return [from[0], from[1], to[2]];
    if (ay >= ax) return [from[0], to[1], from[2]];
    return [to[0], from[1], from[2]];
  }

  /* ------------------------------------------------------------- handlers */

  #clickRectangle(hit: PickHit): void {
    const p = this.#pending;
    if (p?.kind === "rect") {
      this.#commitRect(p);
      return;
    }
    if (hit.kind !== "ground") return;
    const s = this.#snap(hit.point).point;
    this.#pending = { kind: "rect", start: [s[0], s[1]], current: [s[0], s[1]] };
    this.#drawRect(this.#pending.start, this.#pending.current);
    this.#host.setHint("Rectangle: click the opposite corner (type a size, Esc cancels)");
  }

  #commitRect(p: Extract<Pending, { kind: "rect" }>): void {
    this.#cancel();
    const w = Math.abs(p.current[0] - p.start[0]);
    const h = Math.abs(p.current[1] - p.start[1]);
    if (w < 0.5 || h < 0.5) return;
    const origin: Vec3 = [Math.min(p.start[0], p.current[0]), Math.min(p.start[1], p.current[1]), 0];
    const recipe: SolidRecipe = {
      kind: "extrude",
      profile: { width: w, height: h },
      normal: [0, 0, 1],
      origin,
      distance: 10,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    try {
      const patch = this.#host.session.execute(addSolidCmd(recipe, { name: `Face ${fmt(w)}x${fmt(h)}` }));
      const added = [...patch.forward.keys()][0];
      if (added) {
        this.#lastPullId = added;
        this.#host.select([added]);
        this.#host.setHint("Face created. Drag it up, or type a height.");
        this.setTool("pushpull");
      }
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  #clickPull(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "pull") {
      const d = Math.abs(dot3(sub3(p.current, p.planeOrigin), p.faceNormal));
      this.#commitPull(p, d);
      return;
    }
    if (hit.kind !== "solid") {
      this.#host.setHint("Push/Pull: click a face of an extruded shape");
      return;
    }
    const solid = this.#host.session.document.solids.get(hit.id);
    const recipe = solid?.recipe;
    if (!recipe || (recipe.kind !== "extrude" && recipe.kind !== "loop")) {
      this.#host.setHint("Push/Pull works on extruded faces; boxes are edited from the panel for now.");
      return;
    }
    this.#pending = {
      kind: "pull",
      id: hit.id,
      faceNormal: hit.faceNormal,
      planeOrigin: hit.point,
      start: hit.point,
      baseDistance: recipe.distance,
      current: hit.point,
      typed: null,
    };
    this.#lastPullId = hit.id;
    this.#host.select([hit.id]);
    this.#host.setHint("Push/Pull: drag along the normal, or type a height");
  }

  #commitPull(p: Extract<Pending, { kind: "pull" }>, delta: number): void {
    this.#pending = null;
    this.#clearPreview();
    const solid = this.#host.session.document.solids.get(p.id);
    const recipe = solid?.recipe;
    if (!recipe || (recipe.kind !== "extrude" && recipe.kind !== "loop")) return;
    const target = p.typed ?? p.baseDistance + delta;
    if (!(target > 0.1) || Math.abs(target - recipe.distance) < 0.01) {
      this.#host.setHint("Push/Pull cancelled.");
      return;
    }
    try {
      this.#host.session.execute(pullFaceCmd(p.id, { ...recipe, distance: target }));
      this.#host.setHint(`Push/Pull done: ${fmt(target)} mm`);
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /* ----------------------------------------------------------------- line */

  #clickLine(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "line") {
      this.#commitLine(p);
      return;
    }
    const from = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!from) return;
    this.#pending = { kind: "line", from: this.#snap(from).point, planeNormal: [0, 0, 1], current: from };
    this.#host.setHint(`Line: click the end point${this.#glyphHint()} (type a length, Esc cancels)`);
  }

  #commitLine(p: Extract<Pending, { kind: "line" }>): void {
    this.#cancel();
    const a: Vec2 = [p.from[0], p.from[1]];
    const b: Vec2 = [p.current[0], p.current[1]];
    const length = distance2(a, b);
    if (length < 0.5) return;
    // A guide line: stored as a zero-thickness extrude so it can be offset or
    // followed later, and it never joins the solids the fit check measures.
    try {
      this.#host.session.execute(
        addSolidCmd(
          {
            kind: "extrude",
            profile: { width: length, height: LINE_GUIDE_WIDTH },
            normal: [0, 0, 1],
            origin: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), 0],
            distance: 0.1,
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          { name: `Guide ${fmt(length)}`, color: "#5b7083" },
        ),
      );
      this.#host.setHint(`Line ${fmt(length)} mm drawn.`);
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /* ----------------------------------------------------------------- tape */

  #clickTape(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "tape") {
      this.#commitTape(p);
      return;
    }
    const from = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!from) return;
    this.#pending = { kind: "tape", from: this.#snap(from).point, planeNormal: [0, 0, 1], current: from };
    this.#host.setHint("Tape Measure: click the second point (it leaves no geometry).");
  }

  #commitTape(p: Extract<Pending, { kind: "tape" }>): void {
    this.#cancel();
    const d = distance(p.from, p.current);
    this.#host.setHint(
      `Distance: ${fmt(d)} mm  (${formatLength(d, this.#host.unit())})  dx ${fmt(p.current[0] - p.from[0])} dy ${fmt(p.current[1] - p.from[1])} dz ${fmt(p.current[2] - p.from[2])}`,
    );
  }

  /* ------------------------------------------------------------ dimension */

  #clickDimension(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "dimension") {
      this.#commitDimension(p);
      return;
    }
    const from = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!from) return;
    this.#pending = { kind: "dimension", from: this.#snap(from).point, planeNormal: [0, 0, 1], current: from };
    this.#host.setHint("Dimension: click the second point. It becomes an annotation, never a solid.");
  }

  #commitDimension(p: Extract<Pending, { kind: "dimension" }>): void {
    this.#cancel();
    const span = distance(p.from, p.current);
    if (span < 0.5) {
      this.#host.setHint("Dimension needs two distinct points.");
      return;
    }
    // The axis is whatever best explains the span, so a vertical dimension
    // reads its height rather than the diagonal.
    const note = makeAnnotation({ a: p.from, b: p.current, axis: guessAxis(p.from, p.current) });
    this.#host.annotate(note);
    this.#host.setHint(`Dimension ${fmt(span)} mm added (${note.axis}). It does not affect the fit check.`);
  }

  /* ------------------------------------------------------------ follow me */

  #clickFollow(hit: PickHit): void {
    const p = this.#pending;
    if (p?.kind === "follow") {
      this.#commitFollow(p);
      return;
    }
    // First click picks the profile; the second click places the sweep on the ground.
    if (hit.kind !== "solid") {
      this.#host.setHint("Follow Me: click the profile face to sweep first.");
      return;
    }
    const solid = this.#host.session.document.solids.get(hit.id);
    if (!solid) return;
    const end = this.#host.view.groundPoint(this.#host.cursor().x, this.#host.cursor().y);
    if (!end) return;
    this.#pending = {
      kind: "follow",
      profileId: hit.id,
      path: [end],
      current: end,
    };
    this.#host.select([hit.id]);
    this.#host.setHint("Follow Me: move along the ground to set the sweep length, click to build");
  }

  /**
   * Sweep the profile along the X axis. The engine models the sweep as an
   * extrude along the profile's own normal, so follow-me is the long way of
   * pulling — full arbitrary-path sweeps arrive with the L2 recipe work.
   */
  #commitFollow(p: Extract<Pending, { kind: "follow" }>): void {
    this.#cancel();
    const solid = this.#host.session.document.solids.get(p.profileId);
    const recipe = solid?.recipe;
    if (!recipe) return;
    const delta = sub3(p.current, p.path[0]!);
    try {
      if (recipe.kind === "extrude" || recipe.kind === "loop") {
        const normal: Vec3 = recipe.kind === "extrude" ? recipe.normal : recipe.plane.normal;
        const along = Math.abs(normal[0] * delta[0] + normal[1] * delta[1] + normal[2] * delta[2]);
        if (along < 0.5) {
          this.#host.setHint("Follow Me: move along the profile's normal to set a length.");
          return;
        }
        this.#host.session.execute(pullFaceCmd(p.profileId, { ...recipe, distance: recipe.distance + along }));
        this.#host.setHint(`Follow Me: swept ${fmt(along)} mm.`);
      } else {
        this.#host.session.execute(translateSolids([p.profileId], delta));
        this.#host.setHint("Follow Me: moved the object along the path.");
      }
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /* ---------------------------------------------------------------- offset */

  #clickOffset(hit: PickHit): void {
    const p = this.#pending;
    if (p?.kind === "offset") {
      this.#commitOffset(p);
      return;
    }
    if (hit.kind !== "solid") {
      this.#host.setHint("Offset: click a face to create an inset copy.");
      return;
    }
    const bounds = this.#host.session.boundsOf(hit.id);
    const centre: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
    this.#pending = { kind: "offset", id: hit.id, centre, base: 0, current: 0 };
    this.#host.select([hit.id]);
    this.#host.setHint("Offset: move inward to shrink, outward to grow; click to apply.");
  }

  /** Signed movement of the cursor projected onto the screen-space outward axis. */
  #anchorDelta(_id: SolidId, clientX: number, clientY: number): number {
    const c = this.#host.cursor();
    return (clientX - c.x) + (clientY - c.y);
  }

  #commitOffset(p: Extract<Pending, { kind: "offset" }>): void {
    this.#cancel();
    const bounds = this.#host.session.boundsOf(p.id);
    const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] as const;
    const widest = Math.max(size[0], size[1], size[2], 1);
    // The delta is screen pixels; 0.25% of the widest span per pixel keeps the
    // effect visible at any zoom without needing a world-space ray.
    const grow = (p.current / 400) * widest * 0.25;
    const scaleFactor = Math.max(0.01, 1 + (grow * 2) / widest);
    if (Math.abs(scaleFactor - 1) < 0.005) {
      this.#host.setHint("Offset cancelled: no change.");
      return;
    }
    try {
      this.#host.session.execute(scaleSolids([p.id], [scaleFactor, scaleFactor, scaleFactor], p.centre));
      this.#host.setHint(`Offset applied: ${(scaleFactor * 100).toFixed(1)}% of original size.`);
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  #clickSelect(hit: PickHit, additive: boolean): void {
    if (hit.kind === "solid") this.#host.select(additive ? [hit.id] : [hit.id]);
    else if (hit.kind === "ground") this.#host.select([]);
  }

  /* ------------------------------------------------------------- preview */

  #cancel(): void {
    this.#pending = null;
    this.#typed = "";
    this.#clearPreview();
  }

  #clearPreview(): void {
    for (const line of [this.#preview, this.#ghost]) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
    }
    this.#host.view.invalidate();
  }

  #drawRect(start: Vec2, end: Vec2): void {
    const z = 0.5;
    this.#setPreview([
      new THREE.Vector3(start[0], start[1], z),
      new THREE.Vector3(end[0], start[1], z),
      new THREE.Vector3(end[0], end[1], z),
      new THREE.Vector3(start[0], end[1], z),
      new THREE.Vector3(start[0], start[1], z),
    ]);
  }

  #drawSpan(from: Vec3, to: Vec3): void {
    this.#setPreview([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
  }

  #drawPull(p: Extract<Pending, { kind: "pull" }>, delta: number): void {
    const mesh = this.#host.session.meshOf(p.id);
    // Draw the profile of the dragged face: project its corners along the normal.
    const corners = boundingRectCorners(mesh.positions);
    if (!corners) return;
    const n = new THREE.Vector3(...p.faceNormal).normalize();
    const lifted = corners.map((c) => c.clone().addScaledVector(n, delta));
    lifted.push(lifted[0]!.clone());
    this.#setPreview(lifted);
  }

  #drawOffset(p: Extract<Pending, { kind: "offset" }>): void {
    const bounds = this.#host.session.boundsOf(p.id);
    const grow = p.current / 400;
    const m = new THREE.Matrix4()
      .makeTranslation(...p.centre)
      .multiply(new THREE.Matrix4().makeScale(1 + grow, 1 + grow, 1 + grow))
      .multiply(new THREE.Matrix4().makeTranslation(-p.centre[0], -p.centre[1], -p.centre[2]));
    const pts = [
      [bounds.min[0], bounds.min[1], bounds.min[2]],
      [bounds.max[0], bounds.min[1], bounds.min[2]],
      [bounds.max[0], bounds.max[1], bounds.min[2]],
      [bounds.min[0], bounds.max[1], bounds.min[2]],
      [bounds.min[0], bounds.min[1], bounds.min[2]],
    ].map((v) => new THREE.Vector3(v[0]!, v[1]!, v[2]!).applyMatrix4(m));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.#ghost.geometry.dispose();
    this.#ghost.geometry = g;
    this.#ghost.computeLineDistances();
    this.#host.view.invalidate();
  }

  #setPreview(points: THREE.Vector3[]): void {
    this.#preview.geometry.dispose();
    const g = new THREE.BufferGeometry().setFromPoints(points);
    this.#preview.geometry = g;
    this.#preview.computeLineDistances();
    this.#host.view.invalidate();
  }
}

const HINTS: Record<Tool, string> = {
  select: "Select: click an object. Middle mouse orbits, right mouse pans, Z zooms extents.",
  rectangle: "Rectangle: click on the ground to start",
  pushpull: "Push/Pull: click a face, drag along its normal and release",
  line: "Line: click a start point on the ground",
  tape: "Tape Measure: click the first point",
  dimension: "Dimension: click the first point of the measurement",
  followme: "Follow Me: click a profile to sweep along the ground",
  offset: "Offset: click a face to inset or expand it",
};

/** Ground grid used for snapping when no vertex or midpoint is near. */
const GRID_MM = 10;
/** Height of a guide line's band, small enough to read as a line not a solid. */
const LINE_GUIDE_WIDTH = 0.5;

function makeDashedLine(color: number): THREE.Line {
  const mat = new THREE.LineDashedMaterial({ color, dashSize: 12, gapSize: 8, depthTest: false });
  const line = new THREE.Line(new THREE.BufferGeometry(), mat);
  line.renderOrder = 10;
  // An empty geometry has no position attribute, and computeLineDistances
  // throws on it. The first #setPreview supplies the points and their distances.
  return line;
}

/** The four corners of the XZ-aligned bounding box of a mesh's top face. */
function boundingRectCorners(positions: Float32Array): THREE.Vector3[] | null {
  if (positions.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    maxX = Math.max(maxX, positions[i]!);
    maxY = Math.max(maxY, positions[i + 1]!);
    maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return [
    new THREE.Vector3(minX, minY, maxZ),
    new THREE.Vector3(maxX, minY, maxZ),
    new THREE.Vector3(maxX, maxY, maxZ),
    new THREE.Vector3(minX, maxY, maxZ),
  ];
}

function fmt(mm: number): string {
  return Number.isFinite(mm) ? (Math.round(mm * 10) / 10).toFixed(1) : "0.0";
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function distance2(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
