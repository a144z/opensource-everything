import * as THREE from "three";
import {
  arcPoints,
  axisInference,
  circlePoints,
  closedArc,
  counterClockwise,
  parseLength,
  polygonPoints,
  polylineLength,
  type Vec2,
  type Vec3,
} from "@apexus/geometry";
import { formatLengthIn } from "./display.js";
import {
  addEdges as addEdgesCmd,
  addFace as addFaceCmd,
  addSolid as addSolidCmd,
  angleFromText,
  deltaFromText,
  duplicateSolid,
  guessAxis,
  makeAnnotation,
  planeBasis,
  pullFace as pullFaceCmd,
  rotateSolids,
  scaleAbout,
  scaleSolids,
  translateSolids,
  type Annotation,
  type Axis,
  type Session,
  type SolidId,
  type SolidMeta,
  type SolidRecipe,
} from "@apexus/engine";
import type { View, PickHit, Tool } from "./view.js";
import type { Snapper } from "./snap.js";
import {
  angleOnGround,
  angleValue,
  formatAngle,
  lengthValue,
  rectangleSize,
  round2,
  sizeValue,
  type MeasureValue,
} from "./measure.js";

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
  select(ids: readonly SolidId[], additive?: boolean): void;
  /** Screen position of the cursor, for the distance readout. */
  cursor(): { x: number; y: number };
  /** Unit shown to the user for typed lengths. */
  unit(): "mm" | "cm" | "m" | "in";
  /** Shift held: constrain movement to the dominant axis. */
  axisLocked(): boolean;
  /** Annotations are app state (they never enter the document); the tool adds here. */
  annotate(note: Annotation): void;
  /** What is selected right now; move and rotate act on all of it. */
  selection(): readonly SolidId[];
  /** Eraser: the host owns undo grouping, so erasing goes through it. */
  erase(ids: readonly SolidId[]): void;
  /** Paint: the colour the bucket currently holds. */
  paintColor(): string;
  /** Paint: report the colour applied so the host can echo it in a toast. */
  painted(id: SolidId, color: string): void;
  /** Why this solid cannot be moved/rotated/scaled right now, or null if it can. */
  transformBlocked(id: SolidId): string | null;
}

type Pending =
  | { readonly kind: "rect"; readonly start: Vec2; current: Vec2 }
  | {
      /** Circle: centre on the ground, radius follows the mouse. */
      readonly kind: "circle";
      readonly centre: Vec3;
      current: Vec3;
    }
  | {
      /**
       * Polygon: centre, then a point on the circumscribed circle. `sides` is
       * chosen by typing a number before or during the gesture, as in SketchUp.
       */
      readonly kind: "polygon";
      readonly centre: Vec3;
      readonly sides: number;
      current: Vec3;
    }
  | {
      /** Arc: three points on the ground - start, a point on the arc, the end. */
      readonly kind: "arc";
      readonly points: Vec3[];
      current: Vec3;
    }
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
  | {
      /**
       * Line: a chain of clicked points on one plane. `points` holds every click
       * that stays, so Backspace can drop the last one without throwing the
       * whole chain away; `current` is where the next segment would end.
       */
      readonly kind: "line";
      /** The far end of the chain so far: where the next segment starts. */
      from: Vec3;
      readonly planeNormal: Vec3;
      readonly points: Vec3[];
      current: Vec3;
    }
  | {
      /** Dimension: a persistent annotation between two points, not geometry. */
      readonly kind: "dimension";
      readonly from: Vec3;
      readonly planeNormal: Vec3;
      current: Vec3;
    }
  | { readonly kind: "tape"; readonly from: Vec3; readonly planeNormal: Vec3; current: Vec3 }
  | {
      /** Move: grab a point, drop it elsewhere. Copy mode duplicates instead. */
      readonly kind: "move";
      readonly from: Vec3;
      readonly planeNormal: Vec3;
      readonly copy: boolean;
      current: Vec3;
    }
  | {
      /** Rotate: a pivot, then a reference direction, about one world axis. */
      readonly kind: "rotate";
      readonly pivot: Vec3;
      readonly from: Vec3;
      readonly axis: Axis;
      current: Vec3;
    }
  | {
      /**
       * Rotated rectangle: base edge by two clicks, then width, then depth.
       * `edge` is the placed corner behind the first; the rest is computed.
       */
      readonly kind: "rrect";
      readonly start: Vec3;
      /** Set once the base edge is placed; compared by identity to know which click is next. */
      corner: Vec3;
      current: Vec3;
    }
  | {
      /** Scale: pivot on the ground, then distance from it sets the factor. */
      readonly kind: "scale";
      readonly pivot: Vec3;
      readonly base: number;
      current: Vec3;
    }
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
  /** The axis the Rotate tool turns about; arrow keys change it. */
  #rotateAxis: Axis = "z";
  /** Side count for the next polygon; typed digits change it. */
  #polygonSides = 6;
  /** The last number the active tool measured, shown in the status line. */
  #measure: MeasureValue | null = null;
  /** Shift held over a rectangle: the next two edges stay equal. */
  #square = false;

  /** Typed digits that name a rectangle size, or null when they do not yet. */
  #typedSize(): readonly [number, number] | null {
    if (this.#typed === "") return null;
    const parts = this.#typed.split(",").map((p) => parseLength(p.trim(), this.#host.unit())?.mm);
    if (parts.length === 2 && parts.every((n) => n !== undefined && n > 0)) return [parts[0]!, parts[1]!];
    if (parts.length === 1 && parts[0] !== undefined && parts[0] > 0) {
      // One number names both edges only where a square is already implied.
      return this.#square ? [parts[0]!, parts[0]!] : null;
    }
    return null;
  }

  /**
   * Shift is the square grip: it must be readable *before* the next mouse move,
   * so the host tells the tool rather than the tool asking on every frame.
   */
  setModifiers(mods: { shift?: boolean }): void {
    const shift = mods.shift ?? false;
    this.#square = shift;
    // One key, two meanings, as in SketchUp: on a rectangle Shift squares the
    // corner, and every other tool reads it as "stay on this axis". The view
    // owns the flag because the move/rotate handlers ask it too.
    this.#host.view.setAxisLock(shift);
  }

  /** Show the side count as it is typed, and adopt it live where it is valid. */
  #applyPolygonSides(): void {
    const n = Number.parseInt(this.#typed, 10);
    if (Number.isFinite(n) && n >= 3 && n <= 96) this.#polygonSides = n;
    const p = this.#pending;
    if (p?.kind === "polygon") {
      // Mutating the pending shape is what SketchUp does: the polygon under the
      // cursor gains a side as you type, so the result is never a surprise.
      (p as { sides: number }).sides = this.#polygonSides;
    }
    this.#host.setHint(
      Number.isFinite(n)
        ? `Polygon sides: ${this.#polygonSides}${n < 3 ? " (at least 3)" : n > 96 ? " (at most 96)" : ""}`
        : `Polygon sides: ${this.#typed}`,
    );
  }

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

  /** The digits typed so far, for tests and the status line's own reading. */
  get typedText(): string {
    return this.#typed;
  }

  /** How many points the live line chain holds; 0 when there is no chain. */
  get chainLength(): number {
    return this.#pending?.kind === "line" ? this.#pending.points.length : 0;
  }

  setTool(tool: Tool): void {
    this.#cancel();
    this.#tool = tool;
    // A new gesture starts about the blue axis again; carrying the last axis
    // over would make Rotate surprise the user long after they chose it.
    if (tool === "rotate") this.#rotateAxis = "z";
    this.#host.view.setTool(tool);
    this.#host.setHint(HINTS[tool]);
  }

  cancel(): void {
    this.#cancel();
  }

  /** Typed digits while a tool is active (numeric entry, task L1-12). */
  typeKey(key: string): boolean {
    // Polygon's number is a side count, not a length: "6" must not be read as
    // six millimetres of radius.
    if (this.#tool === "polygon") {
      if (/^[0-9]$/.test(key)) {
        this.#typed += key;
        this.#applyPolygonSides();
        return true;
      }
      if (key === "Backspace" && this.#typed) {
        this.#typed = this.#typed.slice(0, -1);
        this.#applyPolygonSides();
        return true;
      }
      if (key === "Enter" && this.#typed) {
        this.#polygonSides = clampSides(this.#typed);
        this.#typed = "";
        this.#host.setHint(`Polygon will have ${this.#polygonSides} sides.`);
        return true;
      }
      if (key === "Escape" && this.#typed) {
        this.#typed = "";
        this.#host.setHint("Typed side count cleared.");
        return true;
      }
    }
    // Arrow keys choose the rotate axis, before and during the gesture. This is
    // SketchUp's own control, and it is what makes an X or Y turn reachable at
    // all: without it, a door hinged on its side can never be swung open.
    if (this.#tool === "rotate") {
      const axis = key === "ArrowLeft" || key === "ArrowRight" ? "y" : key === "ArrowUp" || key === "ArrowDown" ? "x" : null;
      if (axis) {
        this.#rotateAxis = axis;
        const p = this.#pending;
        if (p?.kind === "rotate") {
          // Re-seat the reference direction in the new plane so the first angle
          // read is 0 rather than a leftover from the other axis.
          const basis = planeBasis(axis);
          p.current = [p.pivot[0] + basis.u[0] * 100, p.pivot[1] + basis.u[1] * 100, p.pivot[2] + basis.u[2] * 100];
        }
        this.#host.setHint(`Rotate about ${axisName(axis)}. Arrow keys change the axis.`);
        return true;
      }
    }
    // Move and Rotate accept a typed offset without any half-finished gesture:
    // select, press M, type "500,0". SketchUp's precision input is a property of
    // the tool, not of how far the user has got with the mouse, and without it a
    // user without a steady hand cannot place anything exactly.
    if (!this.#pending) {
      if ((this.#tool === "move" || this.#tool === "rotate") && /^[0-9.,\-]$/.test(key)) {
        this.#typed += key;
        this.#explainTypedMove();
        return true;
      }
      if (this.#typed && (this.#tool === "move" || this.#tool === "rotate") && key === "Enter") {
        this.#commitTypedMove();
        return true;
      }
      if (this.#typed && key === "Backspace") {
        this.#typed = this.#typed.slice(0, -1);
        this.#explainTypedMove();
        return true;
      }
      if (this.#typed && key === "Escape") {
        this.#typed = "";
        this.#host.setHint("Typed input cleared.");
        return true;
      }
      return false;
    }
    // `,` is the separator in "width,angle"; `.` is the decimal point.
    if (/^[0-9.,\-]$/.test(key)) {
      this.#typed += key;
      this.#applyTyped();
      return true;
    }
    if (key === "Enter" && !this.#typed && this.#pending?.kind === "line") {
      // Enter with nothing typed ends the chain where it stands: an open run of
      // edges, not a face, which is what SketchUp does.
      this.#finishLine(this.#pending, false);
      return true;
    }
    if (key === "Enter" && this.#typed) {
      // The size path clears its own text: it has just built the face, so a
      // stale "600,400" must not be re-applied to the next rectangle.
      this.#applyTyped(true);
      this.#typed = "";
      this.#measure = null;
      return true;
    }
    if (key === "Backspace" && this.#typed) {
      this.#typed = this.#typed.slice(0, -1);
      this.#applyTyped();
      return true;
    }
    // A line chain has no digits in play once the last one has been placed, so
    // Backspace means the thing SketchUp means by Undo here: step back one
    // point. A chain of two would leave a single click, which is no line.
    if (key === "Backspace" && this.#pending?.kind === "line") {
      const p = this.#pending;
      if (p.points.length < 2) {
        this.#cancel();
        this.#host.setHint(HINTS.line);
        return true;
      }
      const dropped = p.points.pop()!;
      p.from = dropped;
      p.current = dropped;
      this.#drawChain(p.points, dropped);
      this.#host.setHint("Point removed.");
      return true;
    }
    return false;
  }

  /** The hint for a typed Move/Rotate offset, before Enter commits it. */
  #explainTypedMove(): void {
    const unit = this.#host.unit();
    const ids = [...this.#host.selection()];
    if (ids.length === 0) {
      this.#typed = "";
      this.#host.setHint(`${this.#tool === "move" ? "Move" : "Rotate"}: select something first.`);
      return;
    }
    if (this.#tool === "rotate") {
      const deg = angleFromText(this.#typed);
      this.#host.setHint(
        deg !== null ? `Rotate ${deg}\u00b0 about Z (Enter to apply)` : `Type an angle in degrees: ${this.#typed}`,
      );
      return;
    }
    const parts = this.#typed.split(",");
    // Each axis is shown in the reader's unit; a blank or unparsable axis is "-".
    const at = (i: number): string => {
      const text = parts[i];
      const parsed = text ? parseLength(text, unit) : null;
      return parsed ? formatLengthIn(this.#host.unit(), parsed.mm) : "-";
    };
    this.#host.setHint(`Move by X ${at(0)}, Y ${at(1)}, Z ${at(2)} (Enter to apply; commas separate axes)`);
  }

  /** Enter on a typed offset: one batched command, so one undo step. */
  #commitTypedMove(): void {
    const ids = [...this.#host.selection()];
    const text = this.#typed;
    this.#typed = "";
    if (ids.length === 0) {
      this.#host.setHint("Nothing selected to move.");
      return;
    }
    try {
      if (this.#tool === "rotate") {
        const deg = angleFromText(text);
        if (deg === null) {
          this.#host.setHint("Rotate needs a number of degrees.");
          return;
        }
        const pivot = this.#pivotForSelection(ids);
        const axis = this.#rotateAxis;
        this.#host.session.batch(ids.map((id) => rotateSolids([id], axis, deg, pivot)));
        this.#host.setHint(`Rotated ${ids.length} object(s) ${deg}\u00b0 about ${axisName(axis)}.`);
        return;
      }
      const delta = deltaFromText(text, this.#host.unit());
      if (delta === null) {
        this.#host.setHint("Move takes up to three lengths, X,Y,Z.");
        return;
      }
      if (Math.hypot(delta[0], delta[1], delta[2]) < 1e-9) {
        this.#host.setHint("Move by zero is no change.");
        return;
      }
      this.#host.session.batch(ids.map((id) => translateSolids([id], delta)));
      this.#host.setHint(`Moved ${ids.length} object(s).`);
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /**
   * The pivot a typed rotate turns about: the centre of the selection on the
   * ground plane. The mouse path lets the user choose it; typing cannot, and a
   * typed angle that silently turned about the world origin would move objects
   * the user never asked to move.
   */
  #pivotForSelection(ids: readonly SolidId[]): Vec3 {
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const b = this.#host.session.boundsOf(id);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, b.min[i]!);
        hi[i] = Math.max(hi[i]!, b.max[i]!);
      }
    }
    if (!Number.isFinite(lo[0])) return [0, 0, 0];
    return [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, 0];
  }

  #applyTyped(commit = false): void {
    const p = this.#pending;
    const parsed = this.#typed ? parseLength(this.#typed, this.#host.unit()) : null;
    // A rectangle is the one shape where typing two numbers is natural, so
    // `600,400` is read before the single-length path would refuse it.
    // `pair` already implied `kind === "rect"`; the narrowing is restated here
    // because this.#typedSize() is a method call, which TS cannot narrow through.
    // A line chain takes one length: it places the next point that far along
    // the direction the cursor already set, which is how a wall gets an exact
    // length without a steady hand.
    const line = p?.kind === "line" ? p : null;
    if (line && parsed) {
      // The cursor sets the direction, but it may still sit exactly on the last
      // placed point (a click and a type with no move between them). Then the
      // last segment is the direction: typing 500 after a 1 m wall carries on
      // straight, which is how a run of equal bays gets drawn.
      const cursor = sub3(line.current, line.from);
      const last = line.points.length >= 2 ? sub3(line.from, line.points[line.points.length - 2]!) : cursor;
      const known = Math.hypot(cursor[0], cursor[1], cursor[2]) > 1e-6 ? cursor : last;
      // With nothing to go on yet, the red axis is where a typed first segment
      // goes: the inference engine would have drawn that line under the cursor,
      // and a length still has to mean a place.
      const dir = Math.hypot(known[0], known[1], known[2]) > 1e-6 ? known : ([1, 0, 0] as Vec3);
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      if (len > 1e-6) {
        const scale = parsed.mm / len;
        const placed: Vec3 = [
          line.from[0] + dir[0] * scale,
          line.from[1] + dir[1] * scale,
          line.from[2] + dir[2] * scale,
        ];
        if (commit) this.#placeLinePoint(placed);
        else {
          this.#drawChain(line.points, placed);
          this.#measure = lengthValue("Line", parsed.mm, this.#host.unit(), "Enter to place", "typed");
        }
        return;
      }
    }
    const rect = p?.kind === "rect" ? p : null;
    const pair = rect ? this.#typedSize() : null;
    if (pair && rect) {
      const sx = Math.sign(rect.current[0] - rect.start[0]) || 1;
      const sy = Math.sign(rect.current[1] - rect.start[1]) || 1;
      rect.current = [rect.start[0] + sx * pair[0], rect.start[1] + sy * pair[1]];
      this.#drawRect(rect.start, rect.current);
      this.#measure = sizeValue("Width × Depth", pair, this.#host.unit(), "", "typed");
      this.#host.setHint("");
      if (commit) this.#commitRect(rect);
      return;
    }
    this.#host.setHint(
      parsed
        ? `${this.#typed}  ${formatLengthIn(this.#host.unit(), parsed.mm)} (Enter to apply)`
        : `Type a length: ${this.#typed || ""}`,
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
    } else if (p.kind === "scale") {
      // A bare number is a factor; "2x" and "200%" read the same way.
      const factor = parseFactor(this.#typed);
      this.#host.setHint(`Scale x${factor.toFixed(3)} (Enter to apply, Esc cancels)`);
      if (commit) {
        this.#cancel();
        const ids = [...this.#host.selection()];
        try {
          this.#host.session.execute(scaleAbout(ids, factor, p.pivot));
          this.#host.setHint(`Scaled ${ids.length} object(s) by x${factor.toFixed(3)}.`);
        } catch (err) {
          this.#host.setHint((err as Error).message);
        }
        return;
      }
    } else if (p.kind === "rrect" && p.corner !== p.start) {
      // With the base edge placed, a bare length is the depth: "400" means a
      // 400 mm deep rectangle. `depth` is kept so the preview agrees.
      if (parsed) {
        const ux = (p.corner[0] - p.start[0]) / Math.hypot(p.corner[0] - p.start[0], p.corner[1] - p.start[1]);
        const uy = (p.corner[1] - p.start[1]) / Math.hypot(p.corner[0] - p.start[0], p.corner[1] - p.start[1]);
        p.current = [p.corner[0] - uy * parsed.mm, p.corner[1] + ux * parsed.mm, p.corner[2]];
        const quad = rotatedRectQuad(p.start, p.corner, p.current);
        this.#setPreview(
          quad.map((q) => new THREE.Vector3(q[0], q[1], 0.5)).concat([new THREE.Vector3(quad[0]![0], quad[0]![1], 0.5)]),
        );
        this.#host.setHint(`Rotated rectangle depth ${formatLengthIn(this.#host.unit(), parsed.mm)} (Enter to finish, Esc cancels)`);
        if (commit) {
          const width = Math.hypot(p.corner[0] - p.start[0], p.corner[1] - p.start[1]);
          const degrees = (Math.atan2(p.corner[1] - p.start[1], p.corner[0] - p.start[0]) * 180) / Math.PI;
          this.#cancel();
          this.#buildRotatedRect(width, parsed.mm, p.start, degrees);
        }
        return;
      }
      // "width,angle" - the base edge's length and its heading in degrees.
      const [widthText, angleText] = this.#typed.split(",");
      const width = widthText ? parseLength(widthText, this.#host.unit()) : null;
      const degrees = angleText ? Number(angleText) : 0;
      if (width && Number.isFinite(degrees)) {
        const a = (degrees * Math.PI) / 180;
        p.corner = [
          p.start[0] + Math.cos(a) * width.mm,
          p.start[1] + Math.sin(a) * width.mm,
          p.start[2],
        ];
        const quad = rotatedRectQuad(p.start, p.corner, p.current);
        this.#setPreview(
          quad.map((q) => new THREE.Vector3(q[0], q[1], 0.5)).concat([new THREE.Vector3(quad[0]![0], quad[0]![1], 0.5)]),
        );
        this.#host.setHint(
          `Rotated rectangle base ${formatLengthIn(this.#host.unit(), width.mm)} at ${degrees.toFixed(1)} deg. ` +
            `Type "depth" or click to set the depth, Esc cancels`,
        );
      } else {
        this.#host.setHint(`Rotated rectangle: type "width,angle" (e.g. 400,30): ${this.#typed}`);
      }
    }
    if (commit) {
      if (p.kind === "pull") this.#commitPull(p, parsed ? parsed.mm : 0);
      else if (p.kind === "rect") this.#commitRect(p);
      // A typed length was already applied above through `#applyTyped`; with
      // no digits in play Enter ends the chain.
      else if (p.kind === "line") this.#finishLine(p, p.points.length >= 3 && distance(p.current, p.points[0]!) < CLOSE_MM);
      else if (p.kind === "offset") this.#commitOffset(p);
      else if (p.kind === "tape") this.#commitTape(p);
    }
  }

  /* ----------------------------------------------------------- mouse flow */

  /**
   * The number under the cursor, as the tool's last `hover`/`drag` computed it.
   * Tools that do not yet publish one leave the previous reading alone, so the
   * status line only ever shows numbers the tool actually measured.
   */
  measure(): MeasureValue | null {
    return this.#measure;
  }

  hover(point: Vec3 | null, clientX: number, clientY: number): void {
    this.#hover = point;
    const p = this.#pending;
    if (p?.kind === "rect" && point) {
      const sx = Math.abs(point[0] - p.start[0]);
      const sy = Math.abs(point[1] - p.start[1]);
      // Shift makes a rectangle square, the way a corner grip does. The typed
      // size is what wins, so a square stays square while digits are entered.
      const side = Math.max(sx, sy);
      if (this.#square) {
        p.current = [p.start[0] + Math.sign(point[0] - p.start[0] || 1) * side, p.start[1] + Math.sign(point[1] - p.start[1] || 1) * side];
      } else {
        p.current = [point[0], point[1]];
      }
      this.#drawRect(p.start, p.current);
      // A typed size is an override: the cursor must not erase what the user
      // just typed, so the reading keeps showing it until they clear it.
      const typed = this.#typedSize();
      if (typed) {
        this.#measure = sizeValue("Width × Depth", typed, this.#host.unit(), "Enter to build", "typed");
      } else {
        this.#measure = sizeValue("Width × Depth", rectangleSize(p.start, p.current), this.#host.unit(), "click to finish", "proposed");
      }
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "pull") {
      this.drag(clientX, clientY);
    } else if (p?.kind === "line") {
      // Every segment so far plus the one under the cursor: a chain that only
      // showed its last edge would give no sense of the outline being drawn.
      // The caller's 3D hover point wins: a snap already found the vertex, and
      // re-projecting the raw pixel would throw that candidate away.
      const pt = point ?? this.#host.view.planePoint(clientX, clientY, p.from, p.planeNormal);
      if (!pt) return;
      const snapped = this.#snap(pt);
      const to = this.#constrain(p.from, snapped.point);
      p.current = to;
      this.#drawChain(p.points, to);
      this.#guideAxis(p.from, to);
      // Typed text wins over the cursor, the same rule every other tool uses.
      const typed = this.#typed ? parseLength(this.#typed, this.#host.unit())?.mm ?? null : null;
      this.#measure = lengthValue(
        "Line",
        typed ?? distance(p.from, to),
        this.#host.unit(),
        typed ? "Enter to place" : `${this.#glyphHint()} click to place, on the start point to close`.trim(),
        typed ? "typed" : "proposed",
      );
      // The inference badge leads: while drawing, "on the red axis" is the
      // reading the user needs, and the key help can follow it.
      this.#host.setHint(
        `${this.#glyphHint()} ${p.points.length >= 2 ? "Esc cancels, Backspace steps back, Enter finishes the chain" : "Esc cancels, Backspace steps back"}`.trim(),
      );
    } else if (p?.kind === "tape" || p?.kind === "dimension") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.from, p.planeNormal);
      if (!pt) return;
      const snapped = this.#snap(pt);
      const to = this.#constrain(p.from, snapped.point);
      p.current = to;
      this.#drawSpan(p.from, to);
      const label = p.kind === "tape" ? "Tape" : p.kind === "dimension" ? "Dimension" : "Line";
      this.#measure = lengthValue(label, distance(p.from, to), this.#host.unit(), `${this.#glyphHint()} click to finish`.trim());
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "circle") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.centre, GLOSSARY_UP);
      if (!pt) return;
      p.current = this.#snap(pt).point;
      this.#drawCircle(p.centre, distance(p.centre, p.current));
      this.#measure = lengthValue("Radius", distance(p.centre, p.current), this.#host.unit(), `${this.#glyphHint()} click to place`.trim());
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "polygon") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.centre, GLOSSARY_UP);
      if (!pt) return;
      p.current = this.#snap(pt).point;
      const radius = distance(p.centre, p.current);
      this.#drawPolygon(p.centre, p.current, radius, p.sides);
      this.#measure = lengthValue(`Radius, ${p.sides} sides`, radius, this.#host.unit(), `${this.#glyphHint()} click to place`.trim());
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "arc") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.points[0]!, GLOSSARY_UP);
      if (!pt) return;
      p.current = this.#snap(pt).point;
      const ring = arcPoints(p.points, p.current);
      this.#setPreview(this.#ring3(ring));
      this.#measure = lengthValue("Arc length", polylineLength(ring), this.#host.unit(), p.points.length === 1 ? "click a point on the arc" : "click the end point");
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "follow" && point) {
      p.current = point;
      const last = p.path[p.path.length - 1]!;
      this.#drawSpan(last, point);
      this.#host.setHint("Follow Me: click on the plane to finish the path, Esc cancels");
    } else if (p?.kind === "offset") {
      p.current = p.base + this.#anchorDelta(p.id, clientX, clientY);
      this.#drawOffset(p);
      const shown = p.current - p.base;
      this.#measure = lengthValue(shown < 0 ? "Offset inward" : "Offset outward", Math.abs(shown), this.#host.unit(), "click to apply");
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "move" || p?.kind === "rotate") {
      const plane = p.kind === "move" ? { at: p.from, n: p.planeNormal } : { at: p.pivot, n: GLOSSARY_UP };
      const pt = this.#host.view.planePoint(clientX, clientY, plane.at, plane.n);
      if (!pt) return;
      const to = this.#snap(pt).point;
      p.current = p.kind === "move" ? this.#constrain(p.from, to) : to;
      this.#drawSpan(p.kind === "move" ? p.from : p.pivot, p.current);
      if (p.kind === "move") {
        const d = sub3(p.current, p.from);
        this.#measure = lengthValue("Distance", Math.hypot(d[0], d[1], d[2]), this.#host.unit(), `${this.#glyphHint()} ${p.copy ? "" : "Ctrl = copy, "}click to apply`.trim());
      } else {
        this.#measure = angleValue(this.#angle(p, p.current), `${this.#glyphHint()} click to apply`.trim());
      }
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "rrect") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.start, GLOSSARY_UP);
      if (!pt) return;
      p.current = this.#snap(pt).point;
      const quad = rotatedRectQuad(p.start, p.corner, p.current);
      this.#setPreview(quad.map((q) => new THREE.Vector3(q[0], q[1], 0.5)).concat([new THREE.Vector3(quad[0]![0], quad[0]![1], 0.5)]));
      const base = Math.hypot(p.corner[0] - p.start[0], p.corner[1] - p.start[1]);
      const depth = Math.hypot(p.current[0] - p.corner[0], p.current[1] - p.corner[1]);
      this.#measure = sizeValue("Width × Depth", [round2(base), round2(depth)], this.#host.unit(), "type width,angle to be exact");
      this.#host.setHint("Esc cancels");
    } else if (p?.kind === "scale") {
      const pt = this.#host.view.planePoint(clientX, clientY, p.pivot, GLOSSARY_UP);
      if (!pt) return;
      p.current = this.#snap(pt).point;
      const factor = Math.hypot(p.current[0] - p.pivot[0], p.current[1] - p.pivot[1]) / p.base;
      this.#drawSpan(p.pivot, this.#constrain(p.pivot, p.current));
      this.#measure = { phase: "proposed", label: "Scale", text: `×${factor.toFixed(3)}`, prompt: `${this.#glyphHint()} click to apply`.trim() };
      this.#host.setHint("Esc cancels");
    }
  }

  click(hit: PickHit, additive: boolean, clientX: number, clientY: number, copy = false): void {
    // Ask once, at the start of a transform, whether these objects can move at
    // all. A group member cannot: say so on the first click, not after the user
    // has already clicked a grab point and an end point.
    if ((this.#tool === "move" || this.#tool === "rotate" || this.#tool === "scale") && !this.#pending) {
      const blocked = this.#host.selection().map((id) => this.#host.transformBlocked(id)).find((r) => r !== null);
      if (blocked) {
        this.#host.setHint(blocked);
        return;
      }
    }
    switch (this.#tool) {
      case "rotatedRectangle":
        this.#clickRotatedRect(hit, clientX, clientY);
        return;
      case "scale":
        this.#clickScale(hit, clientX, clientY);
        return;
      case "paint":
        this.#applyPaint(hit);
        return;
      case "eraser":
        this.#applyErase(hit);
        return;
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
      case "move":
        this.#clickMove(hit, clientX, clientY, copy);
        return;
      case "rotate":
        this.#clickRotate(hit, clientX, clientY);
        return;
      case "circle":
        this.#clickCircle(hit, clientX, clientY);
        return;
      case "polygon":
        this.#clickPolygon(hit, clientX, clientY);
        return;
      case "arc":
        this.#clickArc(hit, clientX, clientY);
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
    this.#measure = lengthValue("Push/Pull", distance, this.#host.unit(), "click or release to apply");
    this.#host.setHint("Esc cancels");
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
  /** The axis the pointer is locked to, when it is on one. */
  #axis: "x" | "y" | "z" | null = null;

  /** The axis the pointer is locked to, for tests and the status line. */
  get axisName(): "x" | "y" | "z" | null {
    return this.#axis;
  }

  #glyphHint(): string {
    // The axis wins the badge when both apply: "on the green axis" is the more
    // useful thing to read while drawing a wall than "on grid".
    if (this.#axis) return `[On ${axisWord(this.#axis)} axis]`;
    return this.#glyph ? `[${this.#glyph}]` : "";
  }

  /**
   * Show the coloured guide for a segment that lies on a world axis, and record
   * the axis so the status line can name it. A free segment hides the guide.
   */
  #guideAxis(from: Vec3, to: Vec3): void {
    const found = axisInference(from, to);
    this.#axis = found ? found.name : null;
    this.#host.view.showAxisGuide(found ? { from, to, colour: found.colour } : null);
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

  /* ------------------------------------------------------- circle and arc */

  #clickCircle(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "circle") {
      this.#cancel();
      const radius = distance(p.centre, p.current);
      if (radius < 0.5) return;
      const ring = circlePoints(p.centre, p.current, radius);
      this.#addFace(ring, `Circle r${fmt(radius)}`);
      return;
    }
    const at = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!at) return;
    this.#pending = { kind: "circle", centre: at, current: [at[0] + 1, at[1], at[2]] };
    this.#host.setHint("Circle: move to set the radius, click to place, Esc cancels");
  }

  /**
   * Polygon: centre, then a point on the circumscribed circle. The side count
   * comes from typing a number (3-96), which is how SketchUp asks for it, and
   * the shape is drawn with one vertex on the reference direction.
   */
  #clickPolygon(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "polygon") {
      this.#cancel();
      const radius = distance(p.centre, p.current);
      if (radius < 0.5) return;
      const ring = polygonPoints(p.centre, p.current, radius, p.sides);
      this.#addFace(ring, `Polygon ${p.sides}s r${fmt(radius)}`);
      return;
    }
    const at = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!at) return;
    const sides = this.#polygonSides;
    this.#pending = { kind: "polygon", centre: at, sides, current: [at[0] + 1, at[1], at[2]] };
    this.#host.setHint(`Polygon (${sides} sides): move to set the radius, type a number to change sides, click to place`);
  }

  /**
   * Arc is the SketchUp two-step: start point, then a point the arc passes
   * through, then the end. Three clicks, one solid, one undo step.
   */
  #clickArc(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    const at = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!at) return;
    if (p?.kind === "arc") {
      p.points.push(at);
      if (p.points.length === 3) {
        this.#cancel();
        const ring = arcPoints(p.points, null);
        if (polylineLength(ring) < 0.5) return;
        // An open path is closed back to the chord so it reads as one surface.
        this.#addFace(closedArc(ring), "Arc");
      }
      return;
    }
    this.#pending = { kind: "arc", points: [at], current: at };
    this.#host.setHint("Arc: click a point the arc passes through, then its end, Esc cancels");
  }

  /**
   * One place where a closed path becomes a face: the circle, polygon and arc
   * tools all end here.
   *
   * The result is a zero-thickness face, not a 10 mm slab wearing a "Face" name.
   * A drawn outline is a surface until someone pushes it, and a face says so:
   * it has an area and no volume, so a bill of quantities, the snap solver and a
   * saved file all read it for what it is. Push/pull is what turns it into a
   * solid, along the ring's own normal.
   *
   * The ring is always on the ground: every caller builds it from snapped ground
   * points, so a matrix would only be a second way to say where the ground is.
   */
  #addFace(ring: readonly Vec2[], name: string): void {
    try {
      const patch = this.#host.session.execute(addFaceCmd(counterClockwise(ring), GROUND_PLANE, { name }));
      const added = [...patch.forward.keys()][0];
      if (added) {
        this.#lastPullId = added;
        this.#host.select([added]);
      }
      this.#host.setHint(`${name}: added. Push/Pull to give it height.`);
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  #drawCircle(centre: Vec3, radius: number): void {
    const ring = circlePoints(centre, [centre[0] + radius, centre[1], centre[2]], radius, 48);
    this.#setPreview(this.#ring3(ring));
  }

  #drawPolygon(centre: Vec3, towards: Vec3, radius: number, sides: number): void {
    this.#setPreview(this.#ring3(polygonPoints(centre, towards, radius, sides)));
  }

  /** Ring as a THREE polyline with the first point repeated to close it. */
  #ring3(ring: readonly Vec2[]): THREE.Vector3[] {
    const out = ring.map((q) => new THREE.Vector3(q[0], q[1], 0.5));
    if (out.length > 0) out.push(out[0]!.clone());
    return out;
  }

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

  /**
   * The rectangle tool's result, the gesture SketchUp starts every model with.
   *
   * It is a zero-thickness face: four corners on the ground, nothing else. The
   * tool then hands over to push/pull, because a face is the base of a solid and
   * the drag that follows is what gives it a height. Building an extrude here
   * instead made the "face" a 10 mm slab the user never asked for.
   */
  #commitRect(p: Extract<Pending, { kind: "rect" }>): void {
    this.#cancel();
    const w = Math.abs(p.current[0] - p.start[0]);
    const h = Math.abs(p.current[1] - p.start[1]);
    if (w < 0.5 || h < 0.5) return;
    const origin: Vec3 = [Math.min(p.start[0], p.current[0]), Math.min(p.start[1], p.current[1]), 0];
    const ring: Vec2[] = [
      [origin[0], origin[1]],
      [origin[0] + w, origin[1]],
      [origin[0] + w, origin[1] + h],
      [origin[0], origin[1] + h],
    ];
    try {
      const patch = this.#host.session.execute(addFaceCmd(ring, GROUND_PLANE, { name: `Face ${fmt(w)}x${fmt(h)}` }));
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

  /**
   * Push/pull: click a face or a face's solid, then drag along its normal.
   *
   * A face has no height yet, so its drag starts from zero and the release turns
   * it into an extrusion of the same ring; a solid already extruded adds to the
   * height it has. Everywhere else in this tool the difference is invisible:
   * `pullFace` owns the conversion, and the app only ever names a target distance.
   */
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
    const base = solid ? pullableDistance(solid.recipe) : null;
    if (base === null) {
      this.#host.setHint("Push/Pull works on extruded faces; boxes are edited from the panel for now.");
      return;
    }
    this.#pending = {
      kind: "pull",
      id: hit.id,
      faceNormal: hit.faceNormal,
      planeOrigin: hit.point,
      start: hit.point,
      baseDistance: base,
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
    const base = solid ? pullableDistance(solid.recipe) : null;
    if (base === null) return;
    const target = p.typed ?? p.baseDistance + delta;
    if (!(target > 0.1) || Math.abs(target - base) < 0.01) {
      this.#host.setHint("Push/Pull cancelled.");
      return;
    }
    try {
      // The distance, not a recipe: `pullFace` picks the right shapes to change
      // for a face (convert) and for a solid (resize), so the maths is not
      // copied here where it would be free to drift.
      this.#host.session.execute(pullFaceCmd(p.id, target));
      this.#host.setHint(`Push/Pull done: ${formatLengthIn(this.#host.unit(), target)}`);
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /* ----------------------------------------------------------------- line */

  #clickLine(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    if (p?.kind === "line") {
      // Close on the first point, SketchUp's oldest gesture: the loop becomes a
      // face, ready to push/pull. It is the *chain's start* that closes the ring,
      // not the tail the last segment grew from.
      const start = p.points[0]!;
      if (p.points.length >= 3 && distance(p.current, start) < CLOSE_MM) {
        this.#finishLine(p, true);
        return;
      }
      this.#placeLinePoint(p.current);
      return;
    }
    const raw = hit.kind === "ground" ? hit.point : this.#host.view.groundPoint(clientX, clientY);
    if (!raw) return;
    const from = this.#snap(raw).point;
    this.#pending = { kind: "line", from, planeNormal: [0, 0, 1], points: [from], current: from };
    this.#host.setHint(`Line: click the next point${this.#glyphHint()} (type a length, Esc cancels)`);
  }

  /** Append a point to the live chain and keep the next segment attached to it. */
  #placeLinePoint(to: Vec3): void {
    const p = this.#pending;
    if (p?.kind !== "line") return;
    if (distance(p.from, to) < 0.5) return;
    p.points.push(to);
    p.from = to;
    p.current = to;
    this.#typed = "";
    this.#drawChain(p.points, to);
    this.#host.setHint(
      p.points.length >= 3
        ? "Click the start point to close into a face, Enter to finish, Esc cancels"
        : "Line: click the next point",
    );
  }

  /** The whole chain as one object: one undo step for a drawn outline. */
  #finishLine(p: Extract<Pending, { kind: "line" }>, close: boolean): void {
    const ring: Vec2[] = p.points.map((pt) => [pt[0], pt[1]]);
    this.#cancel();
    if (ring.length < 2) return;
    const total = polylineLength(ring);
    if (total < 0.5) return;
    try {
      // Closing and drawing are one command each, so the chain is one object and
      // one undo step: SketchUp removes a whole drawn loop with one Ctrl+Z.
      const command = close
        ? addFaceCmd(counterClockwise(ring), GROUND_PLANE, { name: `Face ${fmt(total)}` })
        : addEdgesCmd(ring, GROUND_PLANE, { name: `Edges ${fmt(total)}` });
      const patch = this.#host.session.execute(command);
      const added = [...patch.forward.keys()][0];
      if (added) {
        this.#lastPullId = added;
        this.#host.select([added]);
      }
      this.#host.setHint(
        close
          ? `Closed loop (${formatLengthIn(this.#host.unit(), total)}): push/pull to give it height.`
          : `Edges drawn (${formatLengthIn(this.#host.unit(), total)}).`,
      );
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /** Preview the chain, including the segment under the cursor. */
  #drawChain(points: readonly Vec3[], cursor: Vec3): void {
    const all = [...points, cursor];
    if (all.length < 2) {
      this.#clearPreview();
      return;
    }
    this.#setPreview(all.map((pt) => new THREE.Vector3(pt[0], pt[1], pt[2])));
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
      `Distance: ${formatLengthIn(this.#host.unit(), d)}  dx ${fmt(p.current[0] - p.from[0])} dy ${fmt(p.current[1] - p.from[1])} dz ${fmt(p.current[2] - p.from[2])}`,
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
    this.#host.setHint(`Dimension ${formatLengthIn(this.#host.unit(), span)} added (${note.axis}). It does not affect the fit check.`);
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
        this.#host.setHint(`Follow Me: swept ${formatLengthIn(this.#host.unit(), along)}.`);
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

  /* ----------------------------------------------------------- move, rotate */

  /**
   * Move works like SketchUp's: pick a grab point, then a landing point. With
   * `additive` (Ctrl/Shift at the first click) it copies instead of moving.
   * Both are one command, so one undo step either way.
   */
  #clickMove(hit: PickHit, clientX: number, clientY: number, copy: boolean): void {
    const p = this.#pending;
    const ids = [...this.#host.selection()];
    if (p?.kind === "move") {
      this.#cancel();
      const delta = sub3(p.current, p.from);
      if (Math.hypot(delta[0], delta[1], delta[2]) < 0.5) {
        this.#host.setHint("Move: that is zero distance, nothing done.");
        return;
      }
      try {
        // One undo step for the whole gesture: dragging four objects and
        // pressing Ctrl+Z must put all four back, not the last one.
        this.#host.session.batch(
          ids.map((id) => (p.copy ? duplicateSolid(id, delta) : translateSolids([id], delta))),
        );
        this.#host.setHint(
          `${p.copy ? "Copied" : "Moved"} ${ids.length} object(s) ${formatLengthIn(this.#host.unit(), Math.hypot(delta[0], delta[1], delta[2]))}.`,
        );
      } catch (err) {
        this.#host.setHint((err as Error).message);
      }
      return;
    }
    if (ids.length === 0) {
      this.#host.setHint("Move: select something first.");
      return;
    }
    const from = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!from) return;
    this.#pending = { kind: "move", from, planeNormal: GLOSSARY_UP, copy, current: from };
    this.#host.setHint(
      `Move: click where it lands${copy ? " (copy mode)" : " (hold Ctrl at the grab point to copy)"}`,
    );
  }

  /**
   * Rotate: click the pivot, then the reference direction, then the angle.
   *
   * The turn is about `this.#rotateAxis`: Z on the ground, X or Y when the user
   * holds the corresponding arrow key (or when a gizmo axis was chosen). A
   * SketchUp rotate about the blue axis is only one of three, and a user who
   * wants a door to swing on its hinge needs the other two.
   */
  #clickRotate(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    const ids = [...this.#host.selection()];
    if (p?.kind === "rotate") {
      this.#cancel();
      const degrees = this.#angle(p, p.current);
      if (Math.abs(degrees) < 0.05) {
        this.#host.setHint("Rotate: zero angle, nothing done.");
        return;
      }
      try {
        this.#host.session.batch(ids.map((id) => rotateSolids([id], p.axis, degrees, p.pivot)));
        this.#host.setHint(`Rotated ${ids.length} object(s) ${degrees.toFixed(1)} deg about ${axisName(p.axis)}.`);
      } catch (err) {
        this.#host.setHint((err as Error).message);
      }
      return;
    }
    if (ids.length === 0) {
      this.#host.setHint("Rotate: select something first, then click the pivot.");
      return;
    }
    const at =
      hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!at) return;
    const axis = this.#rotateAxis;
    const basis = planeBasis(axis);
    // The reference direction is the first basis vector, so the first hint
    // reads plainly ("0 deg") instead of starting part-way round.
    const from: Vec3 = [at[0] + basis.u[0] * 100, at[1] + basis.u[1] * 100, at[2] + basis.u[2] * 100];
    this.#pending = { kind: "rotate", pivot: at, from, current: from, axis };
    this.#host.setHint(`Rotate about ${axisName(axis)}: move to set the angle, click to apply, Esc cancels`);
  }

  /** Signed turn about the pending axis, measured in that axis's plane. */
  #angle(p: Extract<Pending, { kind: "rotate" }>, to: Vec3): number {
    const { u, v } = planeBasis(p.axis);
    const project = (q: Vec3): [number, number] => {
      const d: Vec3 = [q[0] - p.pivot[0], q[1] - p.pivot[1], q[2] - p.pivot[2]];
      return [d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * v[0] + d[1] * v[1] + d[2] * v[2]];
    };
    const [ax, ay] = project(p.from);
    const [bx, by] = project(to);
    // A point on the axis has no angle; report none rather than a random one.
    if (Math.hypot(ax, ay) < 1e-9 || Math.hypot(bx, by) < 1e-9) return 0;
    let deg = ((Math.atan2(by, bx) - Math.atan2(ay, ax)) * 180) / Math.PI;
    // Normalise to (-180, 180] so a small nudge never reads as 359.
    while (deg > 180) deg -= 360;
    while (deg <= -180) deg += 360;
    return deg;
  }

  /**
   * Rotated rectangle, the SketchUp gesture: first click sets a corner, second
   * sets the base edge (so the rectangle may face any direction), third sets
   * the depth. The loop is built in local space and placed with a rotation
   * matrix, which is why the base edge is squared off rather than trusted raw:
   * a slanted second click still gives four right angles.
   */
  #clickRotatedRect(hit: PickHit, clientX: number, clientY: number): void {
    const at = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!at) return;
    const p = this.#pending;
    if (p?.kind !== "rrect") {
      this.#pending = { kind: "rrect", start: at, corner: at, current: at };
      this.#host.setHint("Rotated rectangle: click the end of the base edge, then its depth");
      return;
    }
    if (p.corner === p.start) {
      if (Math.hypot(at[0] - p.start[0], at[1] - p.start[1]) < 0.5) return;
      p.corner = at;
      this.#host.setHint("Rotated rectangle: click to set the depth");
      return;
    }
    this.#cancel();
    const width = Math.hypot(p.corner[0] - p.start[0], p.corner[1] - p.start[1]);
    const depth = Math.hypot(at[0] - p.corner[0], at[1] - p.corner[1]);
    const angle = (Math.atan2(p.corner[1] - p.start[1], p.corner[0] - p.start[0]) * 180) / Math.PI;
    this.#buildRotatedRect(width, Math.max(depth, 0.1), p.start, angle);
  }

  /**
   * One place where a placed rotated rectangle becomes geometry.
   *
   * A rotated rectangle is still a rectangle, so it is still a face. The ring is
   * wound once and the face's normal turned into world space by `turnOnGround`:
   * winding alone does not survive a rotation, and a face lit from underneath
   * would be invisible from above.
   */
  #buildRotatedRect(width: number, depth: number, start: Vec3, degrees: number): void {
    if (width < 0.5 || depth < 0.5) {
      this.#host.setHint("Rotated rectangle: both sides must be at least 0.5 mm.");
      return;
    }
    // Local ring starts at the origin so `start` is exactly the clicked corner.
    const local: Vec2[] = [
      [0, 0],
      [width, 0],
      [width, -depth],
      [0, -depth],
    ];
    const name = `Rect ${fmt(width)}x${fmt(depth)} @ ${degrees.toFixed(0)}`;
    const plane = { origin: start, normal: turnOnGround(degrees) };
    try {
      const patch = this.#host.session.execute(addFaceCmd(counterClockwise(local), plane, { name }));
      const added = [...patch.forward.keys()][0];
      if (added) {
        this.#lastPullId = added;
        this.#host.select([added]);
      }
      this.#host.setHint("Rotated rectangle created. Push/Pull to give it height.");
    } catch (err) {
      this.#host.setHint((err as Error).message);
    }
  }

  /** Scale: click the point that stays put, then drag out from it. */
  #clickScale(hit: PickHit, clientX: number, clientY: number): void {
    const p = this.#pending;
    const ids = [...this.#host.selection()];
    if (p?.kind === "scale") {
      this.#cancel();
      const distance = Math.hypot(p.current[0] - p.pivot[0], p.current[1] - p.pivot[1]);
      const factor = distance / p.base;
      if (ids.length === 0) {
        this.#host.setHint("Scale: nothing selected.");
        return;
      }
      try {
        this.#host.session.execute(scaleAbout(ids, factor, p.pivot));
        this.#host.setHint(`Scaled ${ids.length} object(s) by x${factor.toFixed(3)}.`);
      } catch (err) {
        this.#host.setHint((err as Error).message);
      }
      return;
    }
    if (ids.length === 0) {
      this.#host.setHint("Scale: select something first, then click the point that should stay put.");
      return;
    }
    const at = hit.kind === "ground" ? this.#snap(hit.point).point : this.#host.view.groundPoint(clientX, clientY);
    if (!at) return;
    this.#pending = { kind: "scale", pivot: at, base: 100, current: [at[0] + 100, at[1], at[2]] };
    this.#host.setHint("Scale: drag away from the pivot, click to apply, or type a factor");
  }

  /** Paint bucket: the object under the cursor takes the current colour. */
  #applyPaint(hit: PickHit): void {
    if (hit.kind !== "solid") {
      this.#host.setHint("Paint: click an object to paint it.");
      return;
    }
    const solid = this.#host.session.document.solids.get(hit.id);
    if (solid?.meta.locked) {
      this.#host.setHint("Paint: that object is locked.");
      return;
    }
    this.#host.painted(hit.id, this.#host.paintColor());
  }

  /** Eraser: click an object and it is gone, one object per undo step. */
  #applyErase(hit: PickHit): void {
    if (hit.kind !== "solid") {
      this.#host.setHint("Eraser: click an object to erase it.");
      return;
    }
    const solid = this.#host.session.document.solids.get(hit.id);
    if (solid?.meta.locked) {
      this.#host.setHint("Eraser: that object is locked.");
      return;
    }
    this.#host.erase([hit.id]);
  }

  #clickSelect(hit: PickHit, additive: boolean): void {
    // Shift toggles (the host flips membership); a plain click replaces.
    if (hit.kind === "solid") this.#host.select([hit.id], additive);
    else if (hit.kind === "ground" && !additive) this.#host.select([]);
  }

  /* ------------------------------------------------------------- preview */

  #cancel(): void {
    this.#pending = null;
    this.#typed = "";
    this.#measure = null;
    this.#axis = null;
    this.#host.view.showAxisGuide(null);
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

const AXIS_WORDS = { x: "red", y: "green", z: "blue" } as const;

/** The colour name of an axis, which is what SketchUp's inference calls it. */
function axisWord(axis: "x" | "y" | "z"): string {
  return AXIS_WORDS[axis];
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
  move: "Move: click a grab point, then where it goes",
  rotate: "Rotate: click the pivot, then drag to set the angle",
  circle: "Circle: click the centre, then move to set the radius",
  polygon: "Polygon: click the centre, move to set the radius, type a number for the sides",
  arc: "Arc: click the start, a point on the arc, then the end",
  rotatedRectangle: "Rotated Rectangle: click a corner, the end of the base edge, then the depth",
  scale: "Scale: click the point that stays put, then drag outward to grow (type a factor)",
  paint: "Paint: click an object to give it the current colour",
  eraser: "Eraser: click an object to erase it",
};

/** Ground grid used for snapping when no vertex or midpoint is near. */
const GRID_MM = 10;
/** Plane normal for ground-plane interactions (move/rotate). */
const GLOSSARY_UP: Vec3 = [0, 0, 1];
/** The ground plane a tool-drawn face lies in; faces carry no matrix of their own. */
const GROUND_PLANE: { readonly origin: Vec3; readonly normal: Vec3 } = { origin: [0, 0, 0], normal: GLOSSARY_UP };
/** How near the start point a click counts as closing the loop (one pixel of slop). */
const CLOSE_MM = 2;

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

/** The axis colour name SketchUp uses in its own prompts. */
export function axisName(axis: Axis): "X" | "Y" | "Z" {
  return axis === "x" ? "X" : axis === "y" ? "Y" : "Z";
}

/** A typed side count, clamped to the range a polygon can actually use. */
export function clampSides(text: string): number {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return 6;
  return Math.min(96, Math.max(3, n));
}

/**
 * The four corners of a rectangle whose base edge runs `start -> corner` and
 * whose depth reaches towards `current`. The second edge is squared off against
 * the base edge, so a slanted third click still draws right angles: that is the
 * whole point of the tool. Pure, so the preview and the commit agree exactly.
 */
function rotatedRectQuad(start: Vec3, corner: Vec3, current: Vec3): Vec2[] {
  const bx = corner[0] - start[0];
  const by = corner[1] - start[1];
  const base = Math.hypot(bx, by);
  if (base < 1e-9) return [[start[0], start[1]]];
  // Unit base vector, and its left normal.
  const ux = bx / base;
  const uy = by / base;
  const nx = -uy;
  const ny = ux;
  // Depth is the component of (current - corner) along the normal, signed.
  const depth = (current[0] - corner[0]) * nx + (current[1] - corner[1]) * ny;
  return [
    [start[0], start[1]],
    [corner[0], corner[1]],
    [corner[0] + nx * depth, corner[1] + ny * depth],
    [start[0] + nx * depth, start[1] + ny * depth],
  ];
}

/**
 * Scale factor from typed text: `2`, `2x`, `200%` and `0.5` all read plainly.
 * Rejects anything that is not a positive finite number rather than guessing.
 */
function parseFactor(text: string): number {
  const t = text.trim().replace(/x$/i, "").replace(/%$/, "");
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return text.trim().endsWith("%") ? n / 100 : n;
}

/**
 * The up vector turned `degrees` about the vertical.
 *
 * A rotated rectangle is built as a face with no matrix: its own normal would
 * otherwise stay world-up while the ring turned, and a plane whose normal is not
 * perpendicular to it would skew every point lifted off it.
 */
function turnOnGround(degrees: number): Vec3 {
  const r = (degrees * Math.PI) / 180;
  return [-Math.sin(r), Math.cos(r), 0];
}

/**
 * What push/pull starts from: the height a recipe already has.
 *
 * A face has no `distance` because it has no thickness yet, so it reads as zero.
 * Returning zero rather than null is what makes one code path serve both cases:
 * the drag adds to nothing and the release asks for the height it drew. Null
 * means there is nothing to grow — a box or a mesh — and the caller says so.
 */
export function pullableDistance(recipe: SolidRecipe): number | null {
  if (recipe.kind === "face") return 0;
  // An edge has no surface to grow from.
  if (recipe.kind === "edge") return null;
  if (recipe.kind === "extrude" || recipe.kind === "loop") return recipe.distance;
  return null;
}

