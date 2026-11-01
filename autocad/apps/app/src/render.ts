import type { DocumentState, Entity, Layer, Pt } from "@apexus/cad";
import {
  boundsOf,
  dimensionGeometry,
  entityVisible,
  linetypePattern,
  measureDimension,
  placedBlockEntities,
  sampleSpline,
  tessellateArc,
  textWidth,
} from "@apexus/cad";
import type { Camera } from "./camera.js";
import { pt } from "@apexus/cad";

/**
 * Canvas renderer. The engine owns what an entity *is*; this file owns what it
 * looks like — the same split the DXF writer has with arc tessellation, so the
 * picture, the plot and the file cannot drift apart.
 *
 * Everything here is derived from the document every frame. There is no
 * retained scene graph to keep in sync, which on a drawing of a few thousand
 * entities is cheaper than being wrong once.
 */

export interface DrawOptions {
  readonly selection: ReadonlySet<string>;
  readonly hover: string | null;
  readonly grip: Pt | null;
  readonly snap: { client: Pt; label: string } | null;
  readonly rubber: readonly Pt[];
  readonly showGrid: boolean;
  readonly layerColors: boolean;
}

const PAPER_BG = "#0d1117";
const GRID = "#1b2230";
const GRID_MAJOR = "#242e40";
const SELECT = "#4ea1ff";
const HOVER = "#ffd166";
const SNAP = "#6fcf7f";

export function drawScene(ctx: CanvasRenderingContext2D, cam: Camera, doc: DocumentState, opts: DrawOptions): void {
  const W = cam.width;
  const H = cam.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = doc.paper ? "#f6f4ee" : PAPER_BG;
  ctx.fillRect(0, 0, W, H);
  if (opts.showGrid) drawGrid(ctx, cam, doc.paper);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const id of doc.order.length ? doc.order : [...doc.entities.keys()]) {
    const e = doc.entities.get(id);
    if (!e || !entityVisible(doc, e)) continue;
    const layer = doc.layers.get(e.layer);
    const style = strokeStyle(e, layer, opts.layerColors);
    if (opts.selection.has(id)) ctx.strokeStyle = SELECT;
    else if (opts.hover === id) ctx.strokeStyle = HOVER;
    else ctx.strokeStyle = style.color;
    if (opts.selection.has(id) || opts.hover === id) ctx.lineWidth = Math.max(style.width + 1.2, 2);
    else ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash.map((d) => Math.max(1, d * cam.unit)));
    const fill = fillStyle(e, style.color);
    drawEntity(ctx, cam, doc, e, opts, fill);
  }
  ctx.setLineDash([]);

  // Overlay: grips and the rubber band live above the drawing so a white line
  // under a grip cannot hide the handle the user is about to type into.
  if (opts.grip) drawGrip(ctx, cam.toScreen(opts.grip));
  if (opts.rubber.length >= 2) {
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    opts.rubber.forEach((p, i) => {
      const s = cam.toScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (opts.snap) drawSnapMark(ctx, opts.snap.client, opts.snap.label);
  if (doc.paper) drawPaperFrame(ctx, cam, doc);
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, paper: boolean): void {
  const step = cam.gridStep();
  const origin = cam.toModel(pt(0, 0));
  const startX = Math.floor(origin.x / step) * step;
  const startY = Math.floor(origin.y / step) * step;
  const tl = cam.toModel(pt(0, 0));
  const br = cam.toModel(pt(cam.width, cam.height));
  ctx.lineWidth = 1;
  for (let x = startX; x <= br.x + step; x += step) {
    const s = cam.toScreen(pt(x, 0));
    const major = Math.abs(x / (step * 10) - Math.round(x / (step * 10))) < 1e-9;
    ctx.strokeStyle = major ? (paper ? "#d9d3c4" : GRID_MAJOR) : paper ? "#e7e2d6" : GRID;
    ctx.beginPath();
    ctx.moveTo(Math.round(s.x) + 0.5, 0);
    ctx.lineTo(Math.round(s.x) + 0.5, cam.height);
    ctx.stroke();
  }
  for (let y = startY; y <= tl.y + step; y += step) {
    const s = cam.toScreen(pt(0, y));
    const major = Math.abs(y / (step * 10) - Math.round(y / (step * 10))) < 1e-9;
    ctx.strokeStyle = major ? (paper ? "#d9d3c4" : GRID_MAJOR) : paper ? "#e7e2d6" : GRID;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(s.y) + 0.5);
    ctx.lineTo(cam.width, Math.round(s.y) + 0.5);
    ctx.stroke();
  }
}

interface StrokeStyle {
  readonly color: string;
  readonly width: number;
  readonly dash: readonly number[];
}

function strokeStyle(e: Entity, layer: Layer | undefined, layerColors: boolean): StrokeStyle {
  const lw = e.lineweight ?? layer?.lineweight ?? 0.25;
  const dashRaw = e.linetype !== "bylayer" ? linetypePattern(e.linetype) : layer ? linetypePattern(layer.linetype) : [];
  // A dash pattern is in paper mm; below ~0.8 px a dash reads as a gap. Fall
  // back to a solid line so a fine drawing does not look broken when zoomed out.
  const dash = dashRaw.length ? dashRaw : [];
  const base: StrokeStyle = {
    color: layerColors && e.color === 256 && layer ? colorCss(layer.color) : e.color === 256 ? "#dfe4ea" : colorCss(e.color),
    width: Math.max(0.6, Math.min(4, lw * 3.2)),
    dash,
  };
  return base;
}

function fillStyle(e: Entity, color: string): string | null {
  return e.kind === "hatch" ? (e.solid ? color + "44" : color + "22") : null;
}

export function colorCss(rgb: number): string {
  const n = rgb & 0xffffff;
  return `#${n.toString(16).padStart(6, "0")}`;
}

function drawEntity(ctx: CanvasRenderingContext2D, cam: Camera, doc: DocumentState, e: Entity, opts: DrawOptions, fill: string | null): void {
  switch (e.kind) {
    case "line": {
      const a = cam.toScreen(e.a);
      const b = cam.toScreen(e.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case "polyline": {
      if (e.points.length === 0) break;
      ctx.beginPath();
      if (e.bulges && e.bulges.some((b) => b !== 0)) {
        polylineWithBulges(ctx, cam, e.points, e.bulges, e.closed);
      } else {
        e.points.forEach((p, i) => {
          const s = cam.toScreen(p);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        if (e.closed) ctx.closePath();
      }
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
      break;
    }
    case "circle": {
      const c = cam.toScreen(e.center);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(0.5, e.radius * cam.unit), 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arc": {
      const pts = tessellateArc(e.center, e.radius, e.start, e.end);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = cam.toScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      break;
    }
    case "spline": {
      const pts = sampleSpline(e);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = cam.toScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      break;
    }
    case "text": {
      const s = cam.toScreen(e.at);
      const h = Math.max(6, e.height * cam.unit);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(-e.rotation);
      ctx.font = `${h}px "Segoe UI", sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.textAlign = e.align === "left" ? "left" : e.align === "right" ? "right" : "center";
      ctx.fillText(e.value.replace(/\\P/g, "\n"), 0, 0);
      ctx.restore();
      break;
    }
    case "dimension": {
      drawDimension(ctx, cam, doc, e);
      break;
    }
    case "hatch": {
      ctx.beginPath();
      for (const ring of e.rings) {
        ring.forEach((p, i) => {
          const s = cam.toScreen(p);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      }
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      break;
    }
    case "point": {
      const s = cam.toScreen(e.at);
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y);
      ctx.lineTo(s.x + 4, s.y);
      ctx.moveTo(s.x, s.y - 4);
      ctx.lineTo(s.x, s.y + 4);
      ctx.stroke();
      break;
    }
    case "leader": {
      ctx.beginPath();
      e.points.forEach((p, i) => {
        const s = cam.toScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      const last = e.points[e.points.length - 1];
      if (last) {
        const s = cam.toScreen(last);
        const shelf = Math.max(18, textWidth(e.text, e.textHeight) * cam.unit);
        const dir = last.x >= e.points[0]!.x ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + shelf * dir, s.y);
        ctx.stroke();
        ctx.save();
        ctx.font = `${Math.max(6, e.textHeight * cam.unit)}px "Segoe UI", sans-serif`;
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.textAlign = dir > 0 ? "left" : "right";
        ctx.fillText(e.text, s.x + (shelf + 3) * dir, s.y - 3);
        ctx.restore();
      }
      break;
    }
    case "insert": {
      // The engine places the block once; drawing the placed copy is the only
      // way an insert can look exactly like what explode() leaves behind.
      const placed = placedBlockEntities(doc, e);
      if (placed.length === 0) {
        const s = cam.toScreen(e.at);
        ctx.beginPath();
        ctx.rect(s.x - 5, s.y - 5, 10, 10);
        ctx.stroke();
        break;
      }
      for (const child of placed) drawEntity(ctx, cam, doc, child, opts, fillStyle(child, ctx.strokeStyle as string));
      break;
    }
    case "section": {
      const a = cam.toScreen(e.a);
      const b = cam.toScreen(e.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(a.x, a.y, 9, 0, Math.PI * 2);
      ctx.moveTo(b.x + 9, b.y);
      ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(e.label, a.x, a.y + 3.5);
      ctx.fillText(e.label, b.x, b.y + 3.5);
      break;
    }
  }
}

function polylineWithBulges(ctx: CanvasRenderingContext2D, cam: Camera, points: readonly Pt[], bulges: readonly number[], closed: boolean): void {
  const first = points[0]!;
  const s0 = cam.toScreen(first);
  ctx.moveTo(s0.x, s0.y);
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    const b = bulges[i] ?? 0;
    if (b === 0) {
      const s = cam.toScreen(q);
      ctx.lineTo(s.x, s.y);
      continue;
    }
    // Bulge = tan(sweep/4); the arc's centre sits off the chord's midpoint.
    const chord = Math.hypot(q.x - p.x, q.y - p.y);
    if (chord < 1e-12) continue;
    const sweep = 4 * Math.atan(b);
    const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const nx = -(q.y - p.y) / chord;
    const ny = (q.x - p.x) / chord;
    const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
    const sign = b > 0 ? 1 : -1;
    const cx = mx + nx * h * sign;
    const cy = my + ny * h * sign;
    const a0 = Math.atan2(p.y - cy, p.x - cx);
    const a1 = Math.atan2(q.y - cy, q.x - cx);
    const c = cam.toScreen(pt(cx, cy));
    // canvas Y is flipped, so a CCW model sweep is a CW canvas arc.
    ctx.arc(c.x, c.y, radius * cam.unit, -a0, -a1, sweep > 0);
  }
  if (closed) ctx.closePath();
}

function drawDimension(ctx: CanvasRenderingContext2D, cam: Camera, doc: DocumentState, e: Extract<Entity, { kind: "dimension" }>): void {
  const g = dimensionGeometry(e);
  const stroke = ctx.strokeStyle as string;
  const px = (p: Pt): Pt => cam.toScreen(p);
  ctx.lineWidth = 1;
  // Extension lines, dimension line and arrow heads all reduce to strokes;
  // the engine already laid them out, so the picture is the measurement.
  for (const segment of g.lines) {
    const a = px(segment.a);
    const b = px(segment.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const value = measureDimension(doc, e);
  const label = e.textOverride !== "" ? e.textOverride : value.label + (e.prefix ?? "") + (e.suffix ?? "");
  const t = px(g.textAt);
  const angle = g.textRotation;
  const w = textWidth(label, e.textHeight) * cam.unit;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(-angle);
  // A text gap in the dimension line reads as a label without erasing the line
  // underneath (the paper background is opaque on screen and in the plot).
  ctx.fillStyle = "#0d1117";
  ctx.globalAlpha = 0.9;
  ctx.fillRect(-w / 2 - 2, -e.textHeight * cam.unit * 0.6, w + 4, e.textHeight * cam.unit * 1.2);
  ctx.globalAlpha = 1;
  ctx.font = `${Math.max(8, e.textHeight * cam.unit)}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = stroke;
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

function drawGrip(ctx: CanvasRenderingContext2D, s: Pt): void {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = SELECT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(s.x - 4, s.y - 4, 8, 8);
  ctx.fill();
  ctx.stroke();
}

function drawSnapMark(ctx: CanvasRenderingContext2D, s: Pt, label: string): void {
  ctx.strokeStyle = SNAP;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(s.x - 6, s.y - 6, 12, 12);
  ctx.stroke();
  ctx.fillStyle = SNAP;
  const w = ctx.measureText(label).width + 8;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(s.x + 9, s.y - 20, Math.max(w, 24), 16);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#0b0f0c";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(label, s.x + 13, s.y - 8);
}

function drawPaperFrame(ctx: CanvasRenderingContext2D, cam: Camera, doc: DocumentState): void {
  const sheet = doc.sheets[0];
  if (!sheet) return;
  const a = cam.toScreen(pt(-sheet.width / 2, sheet.height / 2));
  const b = cam.toScreen(pt(sheet.width / 2, -sheet.height / 2));
  ctx.strokeStyle = "#5b5346";
  ctx.lineWidth = 1;
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  if (sheet.border) ctx.strokeRect(a.x + 10, a.y + 10, b.x - a.x - 20, b.y - a.y - 20);
  ctx.fillStyle = "#5b5346";
  ctx.font = "11px sans-serif";
  ctx.fillText(`${sheet.name}  1:${sheet.scale}  ${sheet.width} x ${sheet.height} mm`, a.x + 14, b.y - 14);
}

/** Bounding box of an entity, through the same points the engine picks with. */
export function entityBox(e: Entity): { min: Pt; max: Pt } | null {
  switch (e.kind) {
    case "line":
      return boundsOf([e.a, e.b]);
    case "polyline":
      return boundsOf(e.points);
    case "circle":
      return { min: pt(e.center.x - e.radius, e.center.y - e.radius), max: pt(e.center.x + e.radius, e.center.y + e.radius) };
    case "arc":
      return boundsOf(tessellateArc(e.center, e.radius, e.start, e.end));
    case "spline":
      return boundsOf(sampleSpline(e));
    case "text": {
      const w = textWidth(e.value, e.height);
      return boundsOf([e.at, pt(e.at.x + w * Math.cos(e.rotation), e.at.y + w * Math.sin(e.rotation)), pt(e.at.x - e.height * Math.sin(e.rotation), e.at.y + e.height * Math.cos(e.rotation))]);
    }
    case "dimension":
      return boundsOf([e.p1, e.p2, e.at, ...(e.vertex ? [e.vertex] : [])]);
    case "hatch":
      return boundsOf(e.rings.flat());
    case "point":
      return boundsOf([e.at]);
    case "leader":
      return boundsOf(e.points);
    case "insert":
      return boundsOf([e.at]);
    case "section":
      return boundsOf([e.a, e.b]);
  }
}
