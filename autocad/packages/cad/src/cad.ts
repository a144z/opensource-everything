/**
 * DraftCheck CAD engine - one file on purpose.
 *
 * F-01 rule (user, 2026-11-01): every feature goes into this file until the
 * product is built, then it gets split. One file = one edit per feature, no
 * cross-file merge conflicts, maximal tokens per write.
 *
 * Units: millimetres in data, angles in radians. Colour is a 24-bit int, or
 * the special ACAD markers 256 (BYLAYER) and 0 (BYBLOCK). Y-up, X-right.
 *
 * House rules carried from the SketchUp product (ADR 0003/0004):
 * - a command validates, then returns an invertible patch; it never mutates;
 * - the project file is versioned JSON with forward-only migrations;
 * - engine is headless (no DOM, no Three.js), the shell is thin.
 */

/* ============================================================ units */

export type Unit = "mm" | "cm" | "m" | "in" | "ft";

export interface UnitSpec {
  readonly id: Unit;
  /** Millimetres per unit. */
  readonly mm: number;
  readonly digits: number;
  readonly label: string;
}

export const UNITS: Readonly<Record<Unit, UnitSpec>> = {
  mm: { id: "mm", mm: 1, digits: 1, label: "mm" },
  cm: { id: "cm", mm: 10, digits: 2, label: "cm" },
  m: { id: "m", mm: 1000, digits: 3, label: "m" },
  in: { id: "in", mm: 25.4, digits: 3, label: "in" },
  ft: { id: "ft", mm: 304.8, digits: 3, label: "ft" },
};

export const UNIT_ORDER: readonly Unit[] = ["mm", "cm", "m", "in", "ft"];

const SUFFIXES: readonly { readonly re: RegExp; readonly mm: number; readonly unit: Unit }[] = [
  { re: /^(.*?)\s*mm$/i, mm: 1, unit: "mm" },
  { re: /^(.*?)\s*cm$/i, mm: 10, unit: "cm" },
  { re: /^(.*?)\s*(?:m|meter|metre)s?$/i, mm: 1000, unit: "m" },
  { re: /^(.*?)\s*(?:in|inch(?:es)?|")$/i, mm: 25.4, unit: "in" },
  { re: /^(.*?)\s*(?:ft|foot|feet|')$/i, mm: 304.8, unit: "ft" },
];

function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedLength {
  readonly mm: number;
  readonly unit: Unit;
}

/** Parse `250`, `25cm`, `2.5m`, `1'`, `12"`, `1200mm`. Null when not a length. */
export function parseLength(text: string, defaultUnit: Unit = "mm"): ParsedLength | null {
  const raw = text.trim();
  if (raw === "") return null;
  for (const s of SUFFIXES) {
    const m = s.re.exec(raw);
    if (!m) continue;
    const value = parseDecimal(m[1]!);
    return value === null ? null : { mm: value * s.mm, unit: s.unit };
  }
  const value = parseDecimal(raw);
  return value === null ? null : { mm: value * UNITS[defaultUnit].mm, unit: defaultUnit };
}

export function toDisplay(mm: number, unit: Unit): number {
  return mm / UNITS[unit].mm;
}

export function formatLength(mm: number, unit: Unit = "mm"): string {
  if (!Number.isFinite(mm)) return "";
  const spec = UNITS[unit];
  return `${(mm / spec.mm).toFixed(spec.digits)} ${spec.label}`;
}

/** DXF writes mm with 3 decimals when the header says mm; keep the same. */
export function formatDxf(mm: number): string {
  const s = mm.toFixed(4);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, ".0") : `${s}.0`;
}

/* ============================================================ points */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export const pt = (x: number, y: number): Pt => ({ x, y });

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function add(a: Pt, b: Pt): Pt {
  return pt(a.x + b.x, a.y + b.y);
}

export function sub(a: Pt, b: Pt): Pt {
  return pt(a.x - b.x, a.y - b.y);
}

export function scale(a: Pt, k: number): Pt {
  return pt(a.x * k, a.y * k);
}

export function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

/** z component of the 2D cross product; sign is orientation. */
export function cross(a: Pt, b: Pt): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Pt): number {
  return Math.hypot(a.x, a.y);
}

/** Unit vector, or null for a zero-length input (never returns NaN). */
export function unit(a: Pt): Pt | null {
  const l = length(a);
  return l < 1e-12 ? null : pt(a.x / l, a.y / l);
}

export function angleOf(a: Pt): number {
  return Math.atan2(a.y, a.x);
}

export function rotate(a: Pt, radians: number): Pt {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return pt(a.x * c - a.y * s, a.x * s + a.y * c);
}

/** Midpoint of two points. */
export function mid(a: Pt, b: Pt): Pt {
  return pt((a.x + b.x) / 2, (a.y + b.y) / 2);
}

export interface Bounds {
  readonly min: Pt;
  readonly max: Pt;
}

export function boundsOf(points: readonly Pt[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: pt(minX, minY), max: pt(maxX, maxY) };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: pt(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y)),
    max: pt(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y)),
  };
}

export function boundsExpand(b: Bounds, d: number): Bounds {
  return { min: pt(b.min.x - d, b.min.y - d), max: pt(b.max.x + d, b.max.y + d) };
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y;
}

export function boundsContains(b: Bounds, p: Pt): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;
}

export function boundsContainsBounds(outer: Bounds, inner: Bounds): boolean {
  return boundsContains(outer, inner.min) && boundsContains(outer, inner.max);
}

/* ========================================================= geometry */

/** Distance from p to segment ab, and the closest point on it. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { t: number; point: Pt; distance: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 < 1e-18 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
  const point = add(a, scale(ab, t));
  return { t, point, distance: dist(p, point) };
}

/** Even-odd point-in-polygon; ring may be open (last point implied). */
export function pointInPolygon(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Allowed sagitta error when tessellating an arc, in mm. */
export const ARC_TOLERANCE = 0.05;
/** A circle never uses more than this many segments. */
export const ARC_MAX_SEGMENTS = 256;

/** Segments needed so an arc of `sweep` radians at `radius` is within tolerance. */
export function arcSegments(radius: number, sweep: number): number {
  const r = Math.abs(radius);
  const s = Math.abs(sweep);
  if (r < 1e-9 || s < 1e-12) return 1;
  // chord error e = r(1-cos(d/2)) -> d = 2 acos(1 - e/r)
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE / r)));
  return Math.max(1, Math.min(ARC_MAX_SEGMENTS, Math.ceil(s / Math.max(step, 1e-6))));
}

/** Tessellate an arc around `center`, flattening any bulge. Endpoints exact. */
export function tessellateArc(center: Pt, radius: number, start: number, end: number): Pt[] {
  let sweep = end - start;
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = arcSegments(radius, sweep);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    const p = pt(center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius);
    out.push(i === 0 ? pt(center.x + Math.cos(start) * radius, center.y + Math.sin(start) * radius) : p);
  }
  out[n] = pt(center.x + Math.cos(start + sweep) * radius, center.y + Math.sin(start + sweep) * radius);
  return out;
}

/** Signed area; positive for a counter-clockwise ring (shoelace). */
export function signedArea(ring: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += cross(ring[j]!, ring[i]!);
  }
  return s / 2;
}

export function ensureCCW(ring: readonly Pt[]): Pt[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
}

/** Intersection of segments ab and cd, or null when they do not cross. */
export function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(c, a), s) / denom;
  const u = cross(sub(c, a), r) / denom;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return add(a, scale(r, Math.min(1, Math.max(0, t))));
}

/** True when segment ab crosses segment cd (proper crossing only). */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const x = segmentIntersection(a, b, c, d);
  if (!x) return false;
  const near = (p: Pt, q: Pt) => dist(p, q) < 1e-9;
  return !(near(x, a) || near(x, b) || near(x, c) || near(x, d));
}

/** Convex hull (monotone chain), counter-clockwise, no repeated first point. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const half = (list: readonly Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(sub(out[out.length - 1]!, out[out.length - 2]!), sub(p, out[out.length - 1]!)) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = half(pts);
  const upper = half([...pts].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Angular sweep between two directions, always in [0, 2pi). */
export function sweepBetween(a: Pt, b: Pt): number {
  let s = angleOf(b) - angleOf(a);
  while (s < 0) s += Math.PI * 2;
  while (s >= Math.PI * 2) s -= Math.PI * 2;
  return s;
}

/* ====================================================== document model */

export const SCHEMA_VERSION = 1;
/** Fit and coincidence tolerance in mm (the SketchUp product uses 1e-2). */
export const FIT_TOLERANCE = 1e-2;

export const COLOR_BYLAYER = 256;
export const COLOR_BYBLOCK = 0;

/** AutoCAD line types we recognise. Everything else falls back to continuous. */
export type Linetype = "continuous" | "dashed" | "dotted" | "dashdot" | "center";

export const LINETYPE_ORDER: readonly Linetype[] = ["continuous", "dashed", "dotted", "dashdot", "center"];

/** Pattern in millimetres: dash, gap, dash, gap... Empty means solid. */
export function linetypePattern(type: Linetype, ltscale = 1): readonly number[] {
  const base: readonly number[] =
    type === "dashed" ? [6, 3]
    : type === "dotted" ? [0.5, 2]
    : type === "dashdot" ? [12, 3, 1, 3]
    : type === "center" ? [20, 4, 3, 4]
    : [];
  return base.map((n) => n * ltscale);
}

export type EntityId = string;
export type LayerId = string;
export type BlockId = string;

export interface Layer {
  readonly id: LayerId;
  /** DXF layer name, unique per drawing (case-insensitive in CAD). */
  readonly name: string;
  /** 24-bit RGB. */
  readonly color: number;
  readonly linetype: Linetype;
  readonly lineweight: number;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly frozen: boolean;
  readonly plot: boolean;
}

export interface BlockDef {
  readonly id: BlockId;
  /** INSERT name; unique per drawing. */
  readonly name: string;
  /** Definition space: every entity stores a plain point, the insert places it. */
  readonly entities: readonly EntityId[];
  /** The draw order inside the block; unlike model space, blocks are purely ordered. */
}

/** Common fields. Geometry lives in the entity variants only. */
export interface EntityBase {
  readonly id: EntityId;
  readonly layer: LayerId;
  readonly color: number;
  readonly linetype: Linetype | "bylayer";
  readonly lineweight: number | null;
  readonly block?: BlockId;
}

export interface LineEntity {
  readonly kind: "line";
  readonly a: Pt;
  readonly b: Pt;
}

export interface PolylineEntity {
  readonly kind: "polyline";
  /** Vertices; a closed polyline repeats nothing, `closed` says it. */
  readonly points: readonly Pt[];
  /**
   * Bulge per vertex: tan(sweep/4), DXF's own encoding, so a rounded polyline
   * stays rounded through save, import and edit. 0 or missing = straight.
   */
  readonly bulges?: readonly number[];
  readonly closed: boolean;
}

export interface CircleEntity {
  readonly kind: "circle";
  readonly center: Pt;
  readonly radius: number;
}

export interface ArcEntity {
  readonly kind: "arc";
  readonly center: Pt;
  readonly radius: number;
  readonly start: number;
  readonly end: number;
}

/** Spline, DXF group 70 bit 0..3 degree; we store the control points and degree. */
export interface SplineEntity {
  readonly kind: "spline";
  readonly points: readonly Pt[];
  readonly degree: number;
  readonly closed: boolean;
}

export interface TextEntity {
  readonly kind: "text";
  readonly at: Pt;
  /** Text height in mm. */
  readonly height: number;
  readonly value: string;
  /** Radians. */
  readonly rotation: number;
  readonly align: "left" | "center" | "right";
}

export type DimKind = "linear" | "aligned" | "angular" | "radius" | "diameter" | "arc" | "ordinate";

/** A dimension is measured, never stored: only its two points and offsets are. */
export interface DimensionEntity {
  readonly kind: "dimension";
  readonly dim: DimKind;
  readonly p1: Pt;
  readonly p2: Pt;
  /** For angular: the vertex. */
  readonly vertex?: Pt;
  /** Where the user put the dimension line (the offset). */
  readonly at: Pt;
  readonly textHeight: number;
  /** "" means "measure it"; anything else is the user's override. */
  readonly textOverride: string;
  readonly arrowSize: number;
  readonly decimals: number;
  /** Prefix/suffix/separator DXF's DIMPOST / DIMSEP. */
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface HatchEntity {
  readonly kind: "hatch";
  readonly pattern: string;
  readonly scale: number;
  /** Degrees. */
  readonly angle: number;
  /** Outer ring followed by islands; islands must be reversed (DXF rule). */
  readonly rings: readonly (readonly Pt[])[];
  readonly solid: boolean;
}

export interface PointEntity {
  readonly kind: "point";
  readonly at: Pt;
}

export interface LeaderEntity {
  readonly kind: "leader";
  readonly points: readonly Pt[];
  readonly text: string;
  readonly textHeight: number;
  /** 0..1 where along the last segment the horizontal shelf starts. */
  readonly shelf: number;
}

export interface InsertEntity {
  readonly kind: "insert";
  readonly block: BlockId;
  readonly at: Pt;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Radians. */
  readonly rotation: number;
  readonly columns: number;
  readonly rows: number;
  readonly columnSpacing: number;
  readonly rowSpacing: number;
}

/** Contract text that binds a dimension to the geometry it measures (F-19). */
export interface SectionMarkerEntity {
  readonly kind: "section";
  readonly a: Pt;
  readonly b: Pt;
  readonly label: string;
}

export type Entity =
  | (EntityBase & LineEntity)
  | (EntityBase & PolylineEntity)
  | (EntityBase & CircleEntity)
  | (EntityBase & ArcEntity)
  | (EntityBase & SplineEntity)
  | (EntityBase & TextEntity)
  | (EntityBase & DimensionEntity)
  | (EntityBase & HatchEntity)
  | (EntityBase & PointEntity)
  | (EntityBase & LeaderEntity)
  | (EntityBase & InsertEntity)
  | (EntityBase & SectionMarkerEntity);

export type EntityKind = Entity["kind"];

export interface Sheet {
  readonly id: string;
  readonly name: string;
  /** Paper size in mm. */
  readonly width: number;
  readonly height: number;
  /** Plot scale denominator: 50 means 1:50. */
  readonly scale: number;
  readonly title: string;
  readonly border: boolean;
}

export interface DocumentState {
  readonly schemaVersion: number;
  readonly units: Unit;
  readonly entities: ReadonlyMap<EntityId, Entity>;
  /** Model-space draw order (may repeat an id after bring-to-front). */
  readonly order: readonly EntityId[];
  readonly layers: ReadonlyMap<LayerId, Layer>;
  readonly currentLayer: LayerId;
  readonly blocks: ReadonlyMap<BlockId, BlockDef>;
  readonly ltscale: number;
  readonly dimStyle: DimStyle;
  /** User dimensions in mm, as an ordered map (named by the user). */
  readonly params: ReadonlyMap<string, number>;
  readonly sheets: readonly Sheet[];
  readonly paper: boolean;
  /** Prompt history, newest first, capped. */
  readonly history: readonly string[];
}

export interface DimStyle {
  readonly textHeight: number;
  readonly arrowSize: number;
  readonly gap: number;
  /** How far beyond the extension line the dim line runs. */
  readonly extension: number;
  readonly decimals: number;
  readonly prefix: string;
  readonly suffix: string;
  /** Separator for stacked dims, DXF DIMSEP. */
  readonly separator: string;
  /** Aligned measures the true distance; linear measures X or Y only. */
  readonly linear: boolean;
}

export const DEFAULT_DIM_STYLE: DimStyle = {
  textHeight: 2.5,
  arrowSize: 2.5,
  gap: 0.8,
  extension: 1.25,
  decimals: 1,
  prefix: "",
  suffix: "",
  separator: "x",
  linear: true,
};

const LAYER_COLORS = ["#e8b04b", "#5fb0e8", "#8fd694", "#e87f7f", "#c9a4ef", "#f2d16b", "#7ad0c8", "#d9d9d9"] as const;

export function hexToColor(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  return m ? parseInt(m[1]!, 16) : 0xffffff;
}

export function colorToHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Resolve an entity colour against its layer (BYLAYER) and the block (BYBLOCK). */
export function resolveColor(entity: Entity, layers: ReadonlyMap<LayerId, Layer>, byBlock = 0xffffff): number {
  if (entity.color === COLOR_BYBLOCK) return byBlock;
  if (entity.color === COLOR_BYLAYER) return layers.get(entity.layer)?.color ?? 0xffffff;
  return entity.color;
}

export function resolveLinetype(entity: Entity, layers: ReadonlyMap<LayerId, Layer>): Linetype {
  if (entity.linetype === "bylayer") return layers.get(entity.layer)?.linetype ?? "continuous";
  return entity.linetype;
}

export function layerByName(doc: DocumentState, name: string): Layer | null {
  const wanted = name.toLowerCase();
  for (const layer of doc.layers.values()) if (layer.name.toLowerCase() === wanted) return layer;
  return null;
}

export function entityVisible(doc: DocumentState, entity: Entity): boolean {
  const layer = doc.layers.get(entity.layer);
  if (!layer) return false;
  return layer.visible && !layer.frozen;
}

export function layerVisible(doc: DocumentState, id: LayerId): boolean {
  const layer = doc.layers.get(id);
  return !!layer && layer.visible && !layer.frozen;
}

function firstLayer(): Layer {
  return {
    id: "0",
    name: "0",
    color: 0xffffff,
    linetype: "continuous",
    lineweight: 0.25,
    visible: true,
    locked: false,
    frozen: false,
    plot: true,
  };
}

export function emptyDocument(units: Unit = "mm"): DocumentState {
  return {
    schemaVersion: SCHEMA_VERSION,
    units,
    entities: new Map(),
    order: [],
    layers: new Map([["0", firstLayer()]]),
    currentLayer: "0",
    blocks: new Map(),
    ltscale: 1,
    dimStyle: DEFAULT_DIM_STYLE,
    params: new Map(),
    sheets: [],
    paper: false,
    history: [],
  };
}

/** Every point an entity is made of, for bounds, picking and selection. */
export function entityPoints(e: Entity): readonly Pt[] {
  switch (e.kind) {
    case "line":
      return [e.a, e.b];
    case "polyline":
      return e.points;
    case "circle":
      return [pt(e.center.x - e.radius, e.center.y - e.radius), pt(e.center.x + e.radius, e.center.y + e.radius)];
    case "arc": {
      const pts = [e.center];
      for (const t of tessellateArc(e.center, e.radius, e.start, e.end)) pts.push(t);
      return pts;
    }
    case "spline":
      return e.points;
    case "text":
      return [e.at, pt(e.at.x + e.value.length * e.height * 0.6, e.at.y + e.height)];
    case "dimension":
      return e.vertex ? [e.p1, e.p2, e.vertex, e.at] : [e.p1, e.p2, e.at];
    case "hatch":
      return e.rings.flatMap((r) => r);
    case "point":
      return [e.at];
    case "leader":
      return e.points;
    case "insert":
      return [e.at];
    case "section":
      return [e.a, e.b];
    default: {
      const never: never = e;
      return never;
    }
  }
}

/* ========================================================== commands */

export interface Patch {
  readonly forward: ReadonlyMap<EntityId, Entity | null>;
  readonly backward: ReadonlyMap<EntityId, Entity | null>;
  /** Layers, blocks, params, sheets, dim style etc., before and after. */
  readonly docBefore: Partial<DocumentState>;
  readonly docAfter: Partial<DocumentState>;
  readonly label: string;
}

export interface CommandContext {
  readonly nextId: () => EntityId;
}

export interface Command {
  readonly kind: string;
  readonly label: string;
  apply(doc: DocumentState, ctx: CommandContext): Patch;
}

/** Build a patch from per-entity before/after maps plus document-level fields. */
export function patchOf(
  entitiesBefore: ReadonlyMap<EntityId, Entity | null>,
  entitiesAfter: ReadonlyMap<EntityId, Entity | null>,
  label: string,
  docBefore: Partial<DocumentState> = {},
  docAfter: Partial<DocumentState> = {},
): Patch {
  return { forward: entitiesAfter, backward: entitiesBefore, docBefore, docAfter, label };
}

export function applyPatch(doc: DocumentState, patch: Patch, direction: "forward" | "backward"): DocumentState {
  const map = direction === "forward" ? patch.forward : patch.backward;
  const fields = direction === "forward" ? patch.docAfter : patch.docBefore;
  const entities = new Map(doc.entities);
  for (const [id, entity] of map) {
    if (entity === null) entities.delete(id);
    else entities.set(id, entity);
  }
  let order = doc.order;
  if (direction === "forward" && patch.forward.size > 0) {
    const added = [...patch.forward].filter(([, e]) => e !== null).map(([id]) => id);
    if (added.length) order = [...doc.order.filter((id) => !added.includes(id)), ...added];
  } else if (direction === "backward" && patch.backward.size > 0) {
    const restored = [...patch.backward].filter(([, e]) => e !== null).map(([id]) => id);
    if (restored.length) order = [...doc.order, ...restored.filter((id) => !doc.order.includes(id))];
  }
  order = order.filter((id) => entities.has(id));
  const next: DocumentState = { ...doc, ...fields, entities, order };
  // A layer delete or a block delete can leave dangling references; commands
  // are responsible for moving entities first, this only repairs the cursor.
  if (!next.layers.has(next.currentLayer)) {
    const fallback = next.layers.keys().next().value ?? "0";
    return { ...next, currentLayer: fallback };
  }
  return next;
}

export class History {
  #undo: { label: string; patch: Patch }[] = [];
  #redo: { label: string; patch: Patch }[] = [];
  #limit: number;

  constructor(limit = 500) {
    this.#limit = Math.max(1, limit);
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get labels(): readonly string[] {
    return this.#undo.map((e) => e.label);
  }

  get depth(): number {
    return this.#undo.length;
  }

  push(entry: { label: string; patch: Patch }): void {
    this.#undo.push(entry);
    if (this.#undo.length > this.#limit) this.#undo.shift();
    this.#redo = [];
  }

  takeUndo(): { label: string; patch: Patch } | null {
    const entry = this.#undo.pop() ?? null;
    if (entry) this.#redo.push(entry);
    return entry;
  }

  takeRedo(): { label: string; patch: Patch } | null {
    const entry = this.#redo.pop() ?? null;
    if (entry) this.#undo.push(entry);
    return entry;
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }
}

export interface Session {
  readonly doc: DocumentState;
  readonly history: History;
  readonly selection: readonly EntityId[];
  readonly hover: EntityId | null;
}

export class CadSession {
  doc: DocumentState;
  history = new History();
  selection: readonly EntityId[] = [];
  hover: EntityId | null = null;
  #idSeq = 0;
  #idPrefix: string;

  constructor(doc: DocumentState = emptyDocument(), idPrefix = "e") {
    this.doc = doc;
    this.#idPrefix = idPrefix;
  }

  nextId = (): EntityId => {
    this.#idSeq += 1;
    return `${this.#idPrefix}${this.#idSeq}`;
  };

  /** Run a command; a command that throws leaves the document untouched. */
  run(command: Command): { ok: true; label: string } | { ok: false; error: string } {
    let patch: Patch;
    try {
      patch = command.apply(this.doc, { nextId: this.nextId });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.doc = applyPatch(this.doc, patch, "forward");
    this.history.push({ label: command.label, patch });
    return { ok: true, label: command.label };
  }

  undo(): boolean {
    const entry = this.history.takeUndo();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, entry.patch, "backward");
    return true;
  }

  redo(): boolean {
    const entry = this.history.takeRedo();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, entry.patch, "forward");
    return true;
  }

  get snapshot(): Session {
    return { doc: this.doc, history: this.history, selection: this.selection, hover: this.hover };
  }
}

/* ===================================================== entity helpers */

export interface EntityStyle {
  readonly layer?: LayerId;
  readonly color?: number;
  readonly linetype?: Linetype | "bylayer";
  readonly lineweight?: number | null;
}

function base(doc: DocumentState, ctx: CommandContext, style: EntityStyle | undefined): EntityBase {
  const layer = style?.layer ?? doc.currentLayer;
  if (!doc.layers.has(layer)) throw new Error(`add: layer ${layer} does not exist`);
  return {
    id: ctx.nextId(),
    layer,
    color: style?.color ?? COLOR_BYLAYER,
    linetype: style?.linetype ?? "bylayer",
    lineweight: style?.lineweight ?? null,
  };
}

function requireNumber(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}`);
}

function requirePositive(value: number, what: string): void {
  requireNumber(value, what);
  if (!(value > 0)) throw new RangeError(`${what} must be greater than 0, got ${value}`);
}

/** Every addX command: validate now, produce the entity inside apply(). */
function addCommand<T extends Entity>(
  kind: string,
  label: string,
  make: (doc: DocumentState, b: EntityBase) => T,
  validate: () => void = () => {},
  style?: EntityStyle,
): Command {
  return {
    kind,
    label,
    apply(doc, ctx) {
      validate();
      const entity = make(doc, base(doc, ctx, style));
      return patchOf(new Map([[entity.id, null]]), new Map([[entity.id, entity]]), label);
    },
  };
}

/**
 * Replace many entities in one undo step (move, erase, edits).
 *
 * Optional: layers, blocks, params, sheets, dim style etc., before and after.
 */
function editCommand(
  kind: string,
  label: string,
  mutate: (doc: DocumentState) => ReadonlyMap<EntityId, Entity | null>,
  docFields?: (doc: DocumentState) => { before: Partial<DocumentState>; after: Partial<DocumentState> },
): Command {
  return {
    kind,
    label,
    apply(doc) {
      const after = mutate(doc);
      const before = new Map<EntityId, Entity | null>();
      for (const id of after.keys()) before.set(id, doc.entities.get(id) ?? null);
      const fields = docFields?.(doc);
      return patchOf(before, after, label, fields?.before, fields?.after);
    },
  };
}

export function getEntity(doc: DocumentState, id: EntityId): Entity {
  const entity = doc.entities.get(id);
  if (!entity) throw new Error(`entity ${id} does not exist`);
  return entity;
}

/** Point every entity is built from, used by transforms. */
function mapPoints(e: Entity, f: (p: Pt) => Pt): Entity {
  switch (e.kind) {
    case "line":
      return { ...e, a: f(e.a), b: f(e.b) };
    case "polyline":
      return { ...e, points: e.points.map(f) };
    case "circle":
      return { ...e, center: f(e.center) };
    case "arc":
      return { ...e, center: f(e.center) };
    case "spline":
      return { ...e, points: e.points.map(f) };
    case "text":
      return { ...e, at: f(e.at) };
    case "dimension":
      return { ...e, p1: f(e.p1), p2: f(e.p2), at: f(e.at), ...(e.vertex ? { vertex: f(e.vertex) } : {}) };
    case "hatch":
      return { ...e, rings: e.rings.map((r) => r.map(f)) };
    case "point":
      return { ...e, at: f(e.at) };
    case "leader":
      return { ...e, points: e.points.map(f) };
    case "insert":
      return { ...e, at: f(e.at) };
    case "section":
      return { ...e, a: f(e.a), b: f(e.b) };
    default: {
      const never: never = e;
      return never;
    }
  }
}

/* ======================================================= draw commands */

export function addLine(a: Pt, b: Pt, style?: EntityStyle): Command {
  return addCommand(
    "addLine",
    "Line",
    (doc, baseEntity) => ({ ...baseEntity, kind: "line", a, b }),
    () => {
      requireNumber(a.x, "line start x");
      requireNumber(b.x, "line end x");
      if (dist(a, b) < 1e-9) throw new RangeError("line has zero length");
    },
    style,
  );
}

export function addPolyline(points: readonly Pt[], closed = false, style?: EntityStyle, bulges?: readonly number[]): Command {
  return addCommand(
    "addPolyline",
    closed ? "Polyline (closed)" : "Polyline",
    (doc, baseEntity) => ({ ...baseEntity, kind: "polyline", points, closed, ...(bulges ? { bulges } : {}) }),
    () => {
      if (points.length < 2) throw new RangeError("polyline needs at least 2 vertices");
      points.forEach((p) => requireNumber(p.x, "polyline vertex"));
    },
    style,
  );
}

export function addRectangle(a: Pt, b: Pt, style?: EntityStyle): Command {
  return addPolyline([a, pt(b.x, a.y), b, pt(a.x, b.y)], true, style);
}

export function addCircle(center: Pt, radius: number, style?: EntityStyle): Command {
  return addCommand(
    "addCircle",
    "Circle",
    (doc, baseEntity) => ({ ...baseEntity, kind: "circle", center, radius }),
    () => requirePositive(radius, "circle radius"),
    style,
  );
}

export function addArc(center: Pt, radius: number, start: number, end: number, style?: EntityStyle): Command {
  return addCommand(
    "addArc",
    "Arc",
    (doc, baseEntity) => ({ ...baseEntity, kind: "arc", center, radius, start, end }),
    () => {
      requirePositive(radius, "arc radius");
      requireNumber(start, "arc start angle");
      requireNumber(end, "arc end angle");
      if (Math.abs(sweepBetween(pt(Math.cos(start), Math.sin(start)), pt(Math.cos(end), Math.sin(end)))) < 1e-12) {
        throw new RangeError("arc has zero sweep");
      }
    },
    style,
  );
}

export function addSpline(points: readonly Pt[], degree = 3, closed = false, style?: EntityStyle): Command {
  return addCommand(
    "addSpline",
    "Spline",
    (doc, baseEntity) => ({ ...baseEntity, kind: "spline", points, degree, closed }),
    () => {
      if (points.length < degree + 1) throw new RangeError(`spline needs at least ${degree + 1} control points`);
    },
    style,
  );
}

export function addText(at: Pt, value: string, style?: EntityStyle, opts?: { height?: number; rotation?: number; align?: TextEntity["align"] }): Command {
  return addCommand(
    "addText",
    "Text",
    (doc, baseEntity) => ({
      ...baseEntity,
      kind: "text",
      at,
      value,
      height: opts?.height ?? 2.5,
      rotation: opts?.rotation ?? 0,
      align: opts?.align ?? "left",
    }),
    () => {
      if (value.trim() === "") throw new RangeError("text is empty");
      requirePositive(opts?.height ?? 2.5, "text height");
    },
    style,
  );
}

export function addPoint(at: Pt, style?: EntityStyle): Command {
  return addCommand("addPoint", "Point", (doc, baseEntity) => ({ ...baseEntity, kind: "point", at }), undefined, style);
}

export function addDimension(
  p1: Pt,
  p2: Pt,
  at: Pt,
  style?: EntityStyle,
  opts?: { dim?: DimKind; vertex?: Pt; textOverride?: string; textHeight?: number },
): Command {
  return addCommand(
    "addDimension",
    "Dimension",
    (doc, baseEntity) => ({
      ...baseEntity,
      kind: "dimension",
      dim: opts?.dim ?? "linear",
      p1,
      p2,
      at,
      textHeight: opts?.textHeight ?? doc.dimStyle.textHeight,
      arrowSize: doc.dimStyle.arrowSize,
      decimals: doc.dimStyle.decimals,
      textOverride: opts?.textOverride ?? "",
      ...(opts?.vertex ? { vertex: opts.vertex } : {}),
    }),
    () => {
      if (dist(p1, p2) < 1e-9 && opts?.dim !== "angular") throw new RangeError("dimension has identical points");
    },
    style,
  );
}

export function addHatch(rings: readonly (readonly Pt[])[], pattern = "SOLID", style?: EntityStyle, opts?: { scale?: number; angle?: number }): Command {
  return addCommand(
    "addHatch",
    "Hatch",
    (doc, baseEntity) => ({
      ...baseEntity,
      kind: "hatch",
      pattern,
      solid: pattern.toUpperCase() === "SOLID",
      scale: opts?.scale ?? 1,
      angle: opts?.angle ?? 0,
      rings,
    }),
    () => {
      if (rings.length === 0) throw new RangeError("hatch needs at least one ring");
      for (const ring of rings) if (ring.length < 3) throw new RangeError("hatch ring needs at least 3 points");
    },
    style,
  );
}

export function addLeader(points: readonly Pt[], text: string, style?: EntityStyle, textHeight = 2.5): Command {
  return addCommand(
    "addLeader",
    "Leader",
    (doc, baseEntity) => ({ ...baseEntity, kind: "leader", points, text, textHeight, shelf: 0.25 }),
    () => {
      if (points.length < 2) throw new RangeError("leader needs at least 2 points");
      requirePositive(textHeight, "leader text height");
    },
    style,
  );
}

export function addSectionMarker(a: Pt, b: Pt, label: string, style?: EntityStyle): Command {
  return addCommand(
    "addSectionMarker",
    "Section marker",
    (doc, baseEntity) => ({ ...baseEntity, kind: "section", a, b, label }),
    () => {
      if (dist(a, b) < 1e-9) throw new RangeError("section marker has zero length");
    },
    style,
  );
}

/** Define a block from entities that already exist (WBLOCK / BLOCK). */
export function defineBlock(name: string, entities: readonly EntityId[]): Command {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("block name is empty");
  if (entities.length === 0) throw new RangeError("a block needs at least one entity");
  return editCommand(
    "defineBlock",
    `Block ${trimmed}`,
    (doc) => {
      for (const b of doc.blocks.values()) if (b.name.toLowerCase() === trimmed.toLowerCase()) throw new Error(`block ${name} already exists`);
      const id = `b${doc.blocks.size + 1}`;
      const map = new Map<EntityId, Entity | null>();
      for (const eid of entities) map.set(eid, { ...getEntity(doc, eid), block: id });
      return map;
    },
    (doc) => {
      const blocks = new Map(doc.blocks);
      blocks.set(`b${doc.blocks.size + 1}`, { id: `b${doc.blocks.size + 1}`, name: trimmed, entities: [...entities] });
      return { before: { blocks: doc.blocks }, after: { blocks } };
    },
  );
}

export function addInsert(block: BlockId, at: Pt, style?: EntityStyle, opts?: { scale?: number; rotation?: number; columns?: number; rows?: number; columnSpacing?: number; rowSpacing?: number }): Command {
  return addCommand(
    "addInsert",
    "Insert",
    (doc, baseEntity) => ({
      ...baseEntity,
      kind: "insert",
      block,
      at,
      scaleX: opts?.scale ?? 1,
      scaleY: opts?.scale ?? 1,
      rotation: opts?.rotation ?? 0,
      columns: Math.max(1, Math.floor(opts?.columns ?? 1)),
      rows: Math.max(1, Math.floor(opts?.rows ?? 1)),
      columnSpacing: opts?.columnSpacing ?? 0,
      rowSpacing: opts?.rowSpacing ?? 0,
    }),
    () => requirePositive(opts?.scale ?? 1, "insert scale"),
    style,
  );
}

/** Generic replacement of one entity, the base of every property edit. */
export function replaceEntity(id: EntityId, update: (e: Entity) => Entity): Command {
  return editCommand("replaceEntity", "Edit", (doc) => new Map([[id, update(getEntity(doc, id))]]));
}

/* ========================================================= edit commands */

export function moveEntities(ids: readonly EntityId[], by: Pt): Command {
  return editCommand("moveEntities", "Move", (doc) => {
    const out = new Map<EntityId, Entity | null>();
    for (const id of ids) out.set(id, mapPoints(getEntity(doc, id), (p) => add(p, by)));
    return out;
  });
}

export function rotateEntities(ids: readonly EntityId[], center: Pt, radians: number): Command {
  return editCommand("rotateEntities", "Rotate", (doc) => {
    const out = new Map<EntityId, Entity | null>();
    for (const id of ids) {
      const e = getEntity(doc, id);
      let next = mapPoints(e, (p) => add(center, rotate(sub(p, center), radians)));
      if (next.kind === "arc") next = { ...next, start: next.start + radians, end: next.end + radians };
      if (next.kind === "text") next = { ...next, rotation: next.rotation + radians };
      if (next.kind === "insert") next = { ...next, rotation: next.rotation + radians };
      out.set(id, next);
    }
    return out;
  });
}

export function scaleEntities(ids: readonly EntityId[], center: Pt, factor: number): Command {
  return editCommand(
    "scaleEntities",
    "Scale",
    (doc) => {
      if (!(factor > 0)) throw new RangeError("scale factor must be greater than 0");
      const out = new Map<EntityId, Entity | null>();
      for (const id of ids) {
        const e = getEntity(doc, id);
        let next = mapPoints(e, (p) => add(center, scale(sub(p, center), factor)));
        if (next.kind === "circle" || next.kind === "arc") next = { ...next, radius: next.radius * factor };
        if (next.kind === "text") next = { ...next, height: next.height * factor };
        if (next.kind === "dimension") next = { ...next, textHeight: next.textHeight * factor, arrowSize: next.arrowSize * factor };
        if (next.kind === "insert") next = { ...next, scaleX: next.scaleX * factor, scaleY: next.scaleY * factor };
        out.set(id, next);
      }
      return out;
    },
  );
}

export function eraseEntities(ids: readonly EntityId[]): Command {
  return editCommand("eraseEntities", ids.length === 1 ? "Erase" : `Erase ${ids.length}`, (doc) => {
    const out = new Map<EntityId, Entity | null>();
    for (const id of ids) {
      getEntity(doc, id);
      out.set(id, null);
    }
    return out;
  });
}

export function duplicateEntities(ids: readonly EntityId[], by: Pt = pt(0, 0)): Command {
  return editCommand("duplicateEntities", "Copy", (doc) => {
    const out = new Map<EntityId, Entity | null>();
    let n = 0;
    for (const id of ids) {
      const e = getEntity(doc, id);
      n += 1;
      out.set(`${id}~${Date.now().toString(36)}${n}`, mapPoints(e, (p) => add(p, by)));
    }
    return out;
  });
}

/** Array: n copies spaced by `step` (COPY with repeats). */
export function arrayEntities(ids: readonly EntityId[], step: Pt, count: number): Command {
  return editCommand("arrayEntities", `Array x${count}`, (doc) => {
    if (!Number.isInteger(count) || count < 1) throw new RangeError("array count must be a positive integer");
    const out = new Map<EntityId, Entity | null>();
    for (const id of ids) {
      const e = getEntity(doc, id);
      for (let i = 1; i < count; i++) out.set(`${id}~a${i}`, mapPoints(e, (p) => add(p, scale(step, i))));
    }
    return out;
  });
}

/** Give a selection a new style. */
export function setEntityStyle(ids: readonly EntityId[], style: { layer?: LayerId; color?: number; linetype?: Linetype | "bylayer"; lineweight?: number | null }): Command {
  return editCommand("setEntityStyle", "Properties", (doc) => {
    const out = new Map<EntityId, Entity | null>();
    for (const id of ids) {
      const e = getEntity(doc, id);
      out.set(id, {
        ...e,
        ...(style.layer !== undefined ? { layer: style.layer } : {}),
        ...(style.color !== undefined ? { color: style.color } : {}),
        ...(style.linetype !== undefined ? { linetype: style.linetype } : {}),
        ...(style.lineweight !== undefined ? { lineweight: style.lineweight } : {}),
      });
    }
    return out;
  });
}

/* ======================================================== layers */

export function addLayer(name: string, color = 0xffffff, opts?: Partial<Omit<Layer, "id" | "name" | "color">>): Command {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("layer name is empty");
  if (/[<>/\\":;?*|=`,]/.test(trimmed)) throw new RangeError(`layer name ${trimmed} has characters AutoCAD forbids`);
  return editCommand(
    "addLayer",
    `Layer ${trimmed}`,
    (doc) => {
      if (layerByName(doc, trimmed)) throw new Error(`layer ${trimmed} already exists`);
      return new Map();
    },
    (doc) => {
      const layers = new Map(doc.layers);
      // Layer ids are 1-based and stable; name uniqueness is checked separately.
      let n = 1;
      while (layers.has(String(n))) n += 1;
      const layer: Layer = {
        id: String(n),
        name: trimmed,
        color,
        linetype: opts?.linetype ?? "continuous",
        lineweight: opts?.lineweight ?? 0.25,
        visible: opts?.visible ?? true,
        locked: opts?.locked ?? false,
        frozen: opts?.frozen ?? false,
        plot: opts?.plot ?? true,
      };
      layers.set(layer.id, layer);
      return { before: { layers: doc.layers }, after: { layers } };
    },
  );
}

export function setLayer(id: LayerId, update: Partial<Omit<Layer, "id">>): Command {
  return editCommand(
    "setLayer",
    "Layer properties",
    (doc) => {
      getLayer(doc, id);
      return new Map();
    },
    (doc) => {
      const layers = new Map(doc.layers);
      const current = getLayer(doc, id);
      const next: Layer = { ...current, ...update, id };
      if (!next.name.trim()) throw new RangeError("layer name is empty");
      for (const l of layers.values()) {
        if (l.id !== id && l.name.toLowerCase() === next.name.toLowerCase()) throw new Error(`layer ${next.name} already exists`);
      }
      layers.set(id, next);
      return { before: { layers: doc.layers }, after: { layers } };
    },
  );
}

export function getLayer(doc: DocumentState, id: LayerId): Layer {
  const layer = doc.layers.get(id);
  if (!layer) throw new Error(`layer ${id} does not exist`);
  return layer;
}

/** Deleting a layer moves its entities to layer 0; geometry is never lost. */
export function deleteLayer(id: LayerId): Command {
  return editCommand(
    "deleteLayer",
    "Delete layer",
    (doc) => {
      const layer = getLayer(doc, id);
      if (layer.id === "0") throw new Error("layer 0 cannot be deleted");
      const out = new Map<EntityId, Entity | null>();
      for (const e of doc.entities.values()) if (e.layer === id) out.set(e.id, { ...e, layer: "0", color: COLOR_BYLAYER });
      return out;
    },
    (doc) => {
      const layers = new Map(doc.layers);
      layers.delete(id);
      const currentLayer = doc.currentLayer === id ? "0" : doc.currentLayer;
      return { before: { layers: doc.layers, currentLayer: doc.currentLayer }, after: { layers, currentLayer } };
    },
  );
}

export function setCurrentLayer(id: LayerId): Command {
  return editCommand(
    "setCurrentLayer",
    "Current layer",
    (doc) => {
      getLayer(doc, id);
      return new Map();
    },
    (doc) => ({ before: { currentLayer: doc.currentLayer }, after: { currentLayer: id } }),
  );
}

/* ========================================================= selection */

export type SelectionMode = "window" | "crossing";

/** Window: fully inside. Crossing: touching or inside. Locked/frozen layers are skipped. */
export function selectInRect(doc: DocumentState, min: Pt, max: Pt, mode: SelectionMode): EntityId[] {
  const rect: Bounds = { min: pt(Math.min(min.x, max.x), Math.min(min.y, max.y)), max: pt(Math.max(min.x, max.x), Math.max(min.y, max.y)) };
  const out: EntityId[] = [];
  for (const e of doc.entities.values()) {
    const layer = doc.layers.get(e.layer);
    if (!layer || !layer.visible || layer.frozen || layer.locked) continue;
    const b = boundsOf(entityPoints(e));
    if (!b) continue;
    if (mode === "window") {
      if (boundsContainsBounds(rect, b)) out.push(e.id);
    } else if (boundsOverlap(rect, b)) {
      out.push(e.id);
    }
  }
  return out;
}

/** Screen-space pick radius in mm, radius grows with zoom so picking feels the same. */
export const PICK_TOLERANCE = 0.5;

export interface Hit {
  readonly id: EntityId;
  readonly distance: number;
  /** Where on the entity the cursor hit: endpoint, midpoint or on-edge. */
  readonly snap: "endpoint" | "midpoint" | "center" | "on";
  readonly point: Pt;
}

function candidates(e: Entity): { a: Pt; b: Pt }[] {
  switch (e.kind) {
    case "line":
      return [{ a: e.a, b: e.b }];
    case "polyline": {
      const segs: { a: Pt; b: Pt }[] = [];
      for (let i = 0; i + 1 < e.points.length; i++) segs.push({ a: e.points[i]!, b: e.points[i + 1]! });
      if (e.closed && e.points.length > 2) segs.push({ a: e.points[e.points.length - 1]!, b: e.points[0]! });
      return segs;
    }
    case "circle":
      return tessellateArc(e.center, e.radius, 0, Math.PI * 2).map((p, i, arr) => ({ a: p, b: arr[(i + 1) % arr.length]! }));
    case "arc":
      return tessellateArc(e.center, e.radius, e.start, e.end).map((p, i, arr) => ({ a: p, b: arr[i + 1] ?? p }));
    case "spline": {
      const pts = sampleSpline(e);
      return pts.map((p, i) => ({ a: p, b: pts[i + 1] ?? p }));
    }
    case "text": {
      const b = boundsOf(entityPoints(e))!;
      return [
        { a: b.min, b: pt(b.max.x, b.min.y) },
        { a: pt(b.max.x, b.min.y), b: b.max },
        { a: b.max, b: pt(b.min.x, b.max.y) },
        { a: pt(b.min.x, b.max.y), b: b.min },
      ];
    }
    case "dimension":
      return dimensionGeometry(e).lines;
    case "hatch":
      return e.rings.flatMap((r) => r.map((p, i) => ({ a: p, b: r[(i + 1) % r.length]! })));
    case "point":
      return [{ a: e.at, b: e.at }];
    case "leader":
      return e.points.map((p, i) => ({ a: p, b: e.points[i + 1] ?? p }));
    case "insert":
      return [];
    case "section":
      return [{ a: e.a, b: e.b }];
    default: {
      const never: never = e;
      return never;
    }
  }
}

/** Pick the nearest visible, unlocked entity under `p` within `tolerance` mm. */
export function pickEntity(doc: DocumentState, p: Pt, tolerance = PICK_TOLERANCE): Hit | null {
  let best: Hit | null = null;
  // Reverse order: the entity drawn last wins ties, as on screen.
  const ids = [...doc.order].reverse();
  const byId = new Map(doc.entities);
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    const layer = doc.layers.get(e.layer);
    if (!layer || !layer.visible || layer.frozen || layer.locked) continue;
    if (e.kind === "point" && dist(p, e.at) <= Math.max(tolerance, 0.5)) {
      if (!best || dist(p, e.at) < best.distance) best = { id, distance: dist(p, e.at), snap: "center", point: e.at };
      continue;
    }
    if (e.kind === "insert") {
      const placed = placedBlockEntities(doc, e);
      for (const probe of placed) {
        const hit = pickEntity({ ...doc, entities: new Map([[probe.id, probe]]), order: [probe.id], layers: doc.layers }, p, tolerance);
        if (hit && (!best || hit.point && dist(p, hit.point) < best.distance)) best = { id, distance: dist(p, hit.point), snap: hit.snap, point: hit.point };
      }
      continue;
    }
    if (e.kind === "hatch") {
      const inside = e.rings.some((r) => pointInPolygon(p, r));
      if (inside && (!best || tolerance >= best.distance)) best = { id, distance: 0, snap: "on", point: p };
      // A hatch is picked by its area, but its edges still offer a precise snap.
      if (inside) continue;
    }
    for (const seg of candidates(e)) {
      const c = closestOnSegment(p, seg.a, seg.b);
      if (c.distance > tolerance) continue;
      if (!best || c.distance < best.distance) {
        const snap: Hit["snap"] = dist(p, seg.a) <= tolerance ? "endpoint" : dist(p, mid(seg.a, seg.b)) <= tolerance ? "midpoint" : "on";
        best = { id, distance: c.distance, snap, point: c.point };
      }
    }
  }
  return best;
}

/** Midpoint, endpoint, centre and perpendicular snaps for any entity within tolerance. */
export function snapCandidates(doc: DocumentState, p: Pt, tolerance = PICK_TOLERANCE): Hit[] {
  const out: Hit[] = [];
  for (const e of doc.entities.values()) {
    const layer = doc.layers.get(e.layer);
    if (!layer || !layer.visible || layer.frozen) continue;
    for (const seg of candidates(e)) {
      const dEndA = dist(p, seg.a);
      const dEndB = dist(p, seg.b);
      if (dEndA <= tolerance) out.push({ id: e.id, distance: dEndA, snap: "endpoint", point: seg.a });
      if (dEndB <= tolerance) out.push({ id: e.id, distance: dEndB, snap: "endpoint", point: seg.b });
      const m = mid(seg.a, seg.b);
      const dMid = dist(p, m);
      if (dMid <= tolerance) out.push({ id: e.id, distance: dMid, snap: "midpoint", point: m });
    }
    if ((e.kind === "circle" || e.kind === "arc") && dist(p, e.center) <= tolerance) {
      out.push({ id: e.id, distance: dist(p, e.center), snap: "center", point: e.center });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/* ======================================================== splines */

/** De Boor on a clamped uniform knot vector; 12 samples per span keeps a curve smooth. */
export function sampleSpline(e: SplineEntity): Pt[] {
  const n = e.points.length;
  const degree = Math.max(1, Math.min(e.degree, n - 1));
  if (n < 2) return [...e.points];
  if (n === 2) return [...e.points];
  // Clamped uniform knots, spots repeated degree+1 times (DXF bit 8 order).
  const knots: number[] = [];
  const inner = n - degree - 1;
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 0; i < inner; i++) knots.push(i + 1);
  for (let i = 0; i <= degree; i++) knots.push(inner + 1);
  const out: Pt[] = [];
  const steps = Math.max(1, inner) * 12;
  const deBoor = (t: number): Pt => {
    let k = degree;
    for (let i = degree; i < n; i++) if (t < knots[i + 1]!) k = i;
    const d: Pt[] = [];
    for (let j = 0; j <= degree; j++) d.push(e.points[k - degree + j]!);
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = j + k - degree;
        const denom = knots[i + 1]! - knots[i - r + 1]!;
        const alpha = denom === 0 ? 0 : (t - knots[i - r + 1]!) / denom;
        d[j] = pt((1 - alpha) * d[j - 1]!.x + alpha * d[j]!.x, (1 - alpha) * d[j - 1]!.y + alpha * d[j]!.y);
      }
    }
    return d[degree]!;
  };
  const lo = knots[degree]!;
  const hi = knots[n]!;
  for (let i = 0; i <= steps; i++) out.push(deBoor(lo + ((hi - lo) * i) / steps));
  out[0] = e.points[0]!;
  out[out.length - 1] = e.points[n - 1]!;
  if (e.closed) out.push(e.points[0]!);
  return out;
}

/* ============================================ blocks: placement */

/** Axis-aligned footprint of a block, in definition space. */
export function blockBounds(doc: DocumentState, block: BlockId): Bounds | null {
  const def = doc.blocks.get(block);
  if (!def) return null;
  let b: Bounds | null = null;
  for (const id of def.entities) {
    const e = doc.entities.get(id);
    if (!e) continue;
    b = unionBounds(b, boundsOf(entityPoints(e)));
  }
  return b;
}

/**
 * Flatten an insert into world-space copies of the definition's entities.
 * Rendering, picking and plotting all use this one function, so a block looks
 * the same however it is reached.
 */
export function placedBlockEntities(doc: DocumentState, insert: Extract<Entity, { kind: "insert" }>): Entity[] {
  const def = doc.blocks.get(insert.block);
  if (!def) return [];
  const out: Entity[] = [];
  const cos = Math.cos(insert.rotation);
  const sin = Math.sin(insert.rotation);
  for (let row = 0; row < insert.rows; row++) {
    for (let col = 0; col < insert.columns; col++) {
      const ox = insert.at.x + col * insert.columnSpacing;
      const oy = insert.at.y + row * insert.rowSpacing;
      const place = (p: Pt): Pt => {
        const sx = p.x * insert.scaleX;
        const sy = p.y * insert.scaleY;
        return pt(ox + sx * cos - sy * sin, oy + sx * sin + sy * cos);
      };
      for (const id of def.entities) {
        const e = doc.entities.get(id);
        if (!e) continue;
        let placed = mapPoints(e, place) as Entity;
        if (placed.kind === "circle" || placed.kind === "arc") placed = { ...placed, radius: placed.radius * Math.abs(insert.scaleX) } as Entity;
        if (placed.kind === "arc") placed = { ...(placed as Extract<Entity, { kind: "arc" }>), start: placed.start + insert.rotation, end: placed.end + insert.rotation } as Entity;
        if (placed.kind === "text") placed = { ...(placed as Extract<Entity, { kind: "text" }>), rotation: placed.rotation + insert.rotation, height: placed.height * Math.abs(insert.scaleY) } as Entity;
        // BYBLOCK inside a block follows the insert's colour.
        if (placed.color === COLOR_BYBLOCK) placed = { ...placed, color: insert.color === COLOR_BYLAYER ? doc.layers.get(insert.layer)?.color ?? 0xffffff : insert.color };
        out.push({ ...placed, id: `${insert.id}:${col}.${row}:${id}`, layer: placed.layer === "0" ? insert.layer : placed.layer });
      }
    }
  }
  return out;
}

/* ====================================================== dimensions */

export interface DimGeometry {
  /** Measured value in mm (or degrees for angular). */
  readonly value: number;
  readonly unitLabel: string;
  readonly text: string;
  readonly lines: { a: Pt; b: Pt }[];
  readonly textAt: Pt;
  readonly textRotation: number;
}

/** What a dimension measures, in the document's unit, without drawing it. */
export function measureDimension(doc: DocumentState, e: DimensionEntity): { value: number; label: string } {
  switch (e.dim) {
    case "linear": {
      // Linear measures only the dominant axis of p2-p1, as DIMLINEAR does.
      const d = sub(e.p2, e.p1);
      const value = Math.abs(d.x) >= Math.abs(d.y) ? Math.abs(d.x) : Math.abs(d.y);
      return { value, label: UNITS[doc.units].label };
    }
    case "aligned":
    case "arc":
      return { value: dist(e.p1, e.p2), label: UNITS[doc.units].label };
    case "radius":
      return { value: dist(e.p1, e.p2), label: `${UNITS[doc.units].label} R` };
    case "diameter":
      return { value: dist(e.p1, e.p2) * 2, label: `${UNITS[doc.units].label} D` };
    case "angular": {
      const v = e.vertex ?? e.p1;
      const a = angleOf(sub(e.p1, v));
      const b = angleOf(sub(e.p2, v));
      return { value: (sweepBetween(pt(Math.cos(a), Math.sin(a)), pt(Math.cos(b), Math.sin(b))) * 180) / Math.PI, label: "deg" };
    }
    case "ordinate":
      return { value: Math.abs(e.p1.y - e.p2.y), label: UNITS[doc.units].label };
    default: {
      const never: never = e.dim;
      return never;
    }
  }
}

/** Filled arrow head at `tip`, pointing along `direction`, as a closed triangle. */
function arrowHead(tip: Pt, direction: Pt, size: number): { a: Pt; b: Pt }[] {
  const u = unit(direction) ?? pt(1, 0);
  const back = sub(tip, scale(u, size));
  const side = pt(-u.y, u.x);
  const p1 = add(back, scale(side, size * 0.32));
  const p2 = sub(back, scale(side, size * 0.32));
  return [
    { a: tip, b: p1 },
    { a: p1, b: p2 },
    { a: p2, b: tip },
  ];
}

/**
 * Draw geometry for a dimension. The measured value is never stored: it is
 * re-measured from the two points every time, which is what makes a dimension
 * survive an edit (and what the wedge depends on).
 */
export function dimensionGeometry(e: DimensionEntity): DimGeometry {
  const measured = (() => {
    if (e.dim === "angular" || e.dim === "ordinate") return Math.abs(e.p1.x - e.p2.x);
    return dist(e.p1, e.p2);
  })();
  const lines: { a: Pt; b: Pt }[] = [];
  let textAt: Pt;
  let textRotation = 0;
  let value = measured;
  switch (e.dim) {
    case "linear": {
      const d = sub(e.p2, e.p1);
      const horizontal = Math.abs(d.x) >= Math.abs(d.y);
      const offset = horizontal ? e.at.y : e.at.x;
      const a = horizontal ? pt(e.p1.x, offset) : pt(offset, e.p1.y);
      const b = horizontal ? pt(e.p2.x, offset) : pt(offset, e.p2.y);
      lines.push({ a: e.p1, b: add(a, scale(unit(sub(a, e.p1)) ?? pt(0, 1), 0)) });
      lines.push({ a: e.p2, b });
      lines.push({ a, b });
      lines.push(...arrowHead(a, sub(b, a), e.arrowSize));
      lines.push(...arrowHead(b, sub(a, b), e.arrowSize));
      value = horizontal ? Math.abs(d.x) : Math.abs(d.y);
      textAt = mid(a, b);
      textRotation = horizontal ? 0 : Math.PI / 2;
      break;
    }
    case "aligned":
    case "arc": {
      const u = unit(sub(e.p2, e.p1)) ?? pt(1, 0);
      const n = pt(-u.y, u.x);
      const off = dot(sub(e.at, e.p1), n);
      const a = add(e.p1, scale(n, off));
      const b = add(e.p2, scale(n, off));
      lines.push({ a: e.p1, b: add(e.p1, scale(n, off * 1.15)) });
      lines.push({ a: e.p2, b: add(e.p2, scale(n, off * 1.15)) });
      lines.push({ a, b });
      lines.push(...arrowHead(a, sub(b, a), e.arrowSize));
      lines.push(...arrowHead(b, sub(a, b), e.arrowSize));
      value = dist(e.p1, e.p2);
      textAt = add(mid(a, b), scale(n, e.textHeight * 0.4));
      textRotation = angleOf(u);
      if (textRotation > Math.PI / 2 || textRotation < -Math.PI / 2) textRotation += Math.PI;
      break;
    }
    case "radius":
    case "diameter": {
      const u = unit(sub(e.at, e.p1)) ?? pt(1, 0);
      const r = dist(e.p1, e.p2);
      if (e.dim === "radius") {
        lines.push({ a: e.p1, b: e.at });
        lines.push(...arrowHead(e.at, u, e.arrowSize));
        value = r;
      } else {
        const far = sub(e.p1, scale(u, r));
        lines.push({ a: far, b: e.at });
        lines.push(...arrowHead(e.at, u, e.arrowSize));
        value = r * 2;
      }
      textAt = e.at;
      textRotation = 0;
      break;
    }
    case "angular": {
      const v = e.vertex ?? e.p1;
      const r = Math.max(dist(v, e.at), e.arrowSize * 2);
      const a0 = angleOf(sub(e.p1, v));
      const a1 = angleOf(sub(e.p2, v));
      const sweep = sweepBetween(pt(Math.cos(a0), Math.sin(a0)), pt(Math.cos(a1), Math.sin(a1)));
      const arcPts = tessellateArc(v, r, a0, a0 + sweep);
      for (let i = 0; i + 1 < arcPts.length; i++) lines.push({ a: arcPts[i]!, b: arcPts[i + 1]! });
      lines.push({ a: v, b: add(e.p1, scale(unit(sub(e.p1, v)) ?? pt(1, 0), e.arrowSize)) });
      lines.push({ a: v, b: add(e.p2, scale(unit(sub(e.p2, v)) ?? pt(1, 0), e.arrowSize)) });
      value = (sweep * 180) / Math.PI;
      textAt = add(v, scale(pt(Math.cos(a0 + sweep / 2), Math.sin(a0 + sweep / 2)), r + e.textHeight));
      textRotation = 0;
      break;
    }
    case "ordinate": {
      lines.push({ a: e.p1, b: e.at });
      lines.push({ a: e.p2, b: e.at });
      lines.push({ a: pt(e.at.x - e.textHeight, e.at.y), b: pt(e.at.x + e.textHeight, e.at.y) });
      value = Math.abs(e.p1.y - e.p2.y);
      textAt = add(e.at, pt(e.textHeight * 0.6, e.textHeight * 0.6));
      textRotation = 0;
      break;
    }
    default: {
      const never: never = e.dim;
      return never;
    }
  }
  const formatted = `${e.prefix ?? ""}${value.toFixed(e.decimals)}${e.suffix ?? ""}`;
  return {
    value,
    unitLabel: e.dim === "angular" ? "deg" : "mm",
    text: e.textOverride.trim() !== "" ? e.textOverride : formatted,
    lines,
    textAt,
    textRotation,
  };
}

/* ======================================================== params */

/** User dimensions: text -> geometry, the wedge's inputs. */
export function setParam(name: string, value: number): Command {
  const key = name.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new RangeError(`parameter name ${name} must be a letter followed by letters, digits or _`);
  if (!Number.isFinite(value)) throw new RangeError(`parameter ${name} must be a finite number`);
  return editCommand(
    "setParam",
    `Parameter ${key}`,
    () => new Map(),
    (doc) => {
      const params = new Map(doc.params);
      params.set(key, value);
      return { before: { params: doc.params }, after: { params } };
    },
  );
}

export function deleteParam(name: string): Command {
  const key = name.trim().toUpperCase();
  return editCommand(
    "deleteParam",
    `Delete ${key}`,
    () => new Map(),
    (doc) => {
      if (!doc.params.has(key)) throw new Error(`parameter ${key} does not exist`);
      const params = new Map(doc.params);
      params.delete(key);
      return { before: { params: doc.params }, after: { params } };
    },
  );
}

/* ===================================================== constraint solver */

/**
 * Post-solve rebuild of a dimension's measured geometry (F-19).
 *
 * The document never stores a dimension's value: it stores two points. This
 * walks every dimension after a solve, writes the new measured value into its
 * parameter when the dimension owns one, and returns the failing dimensions
 * so the view can paint them red instead of silently lying.
 */
export interface SolveResult {
  readonly changed: ReadonlyMap<EntityId, Entity>;
  /** Dimensions whose value disagrees with their parameter by more than FIT_TOLERANCE. */
  readonly mismatched: readonly EntityId[];
  readonly iterations: number;
}

export type ExprNode =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "param"; readonly name: string }
  | { readonly t: "bin"; readonly op: "+" | "-" | "*" | "/" | "^"; readonly l: ExprNode; readonly r: ExprNode }
  | { readonly t: "neg"; readonly v: ExprNode }
  | { readonly t: "call"; readonly fn: "min" | "max" | "abs" | "sqrt" | "round"; readonly args: readonly ExprNode[] };

export class ExprError extends Error {}

/** Parse `12+PANEL*2`, with + - * / ^, parentheses and min/max/abs/sqrt/round. */
export function parseExpr(text: string): ExprNode {
  let i = 0;
  const src = text;
  const skip = (): void => {
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
  };
  const peek = (): string => (i < src.length ? src[i]! : "\0");
  const atWord = (w: string): boolean => src.slice(i, i + w.length).toLowerCase() === w;

  const number = (): ExprNode => {
    const start = i;
    while (i < src.length && /[\d._]/.test(src[i]!)) i += 1;
    if (src[i] === "e" || src[i] === "E") {
      i += 1;
      if (src[i] === "+" || src[i] === "-") i += 1;
      while (i < src.length && /\d/.test(src[i]!)) i += 1;
    }
    const slice = src.slice(start, i).replace(/_/g, "");
    const v = Number(slice);
    if (!Number.isFinite(v)) throw new ExprError(`not a number: ${slice}`);
    return { t: "num", v };
  };

  const primary = (): ExprNode => {
    skip();
    const c = peek();
    if (c === "(") {
      i += 1;
      const inner = expr();
      skip();
      if (peek() !== ")") throw new ExprError("missing )");
      i += 1;
      return inner;
    }
    if (c === "-") {
      i += 1;
      return { t: "neg", v: primary() };
    }
    if (c === "+") {
      i += 1;
      return primary();
    }
    if (/[\d.]/.test(c)) return number();
    if (atWord("pi")) {
      i += 2;
      return { t: "num", v: Math.PI };
    }
    if (/[a-zA-Z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i]!)) i += 1;
      const word = src.slice(start, i);
      skip();
      if (peek() === "(") {
        const fn = word.toLowerCase() as "min" | "max" | "abs" | "sqrt" | "round";
        if (!["min", "max", "abs", "sqrt", "round"].includes(fn)) throw new ExprError(`unknown function ${word}`);
        i += 1;
        const args: ExprNode[] = [];
        skip();
        if (peek() !== ")") {
          args.push(expr());
          skip();
          while (peek() === ",") {
            i += 1;
            args.push(expr());
            skip();
          }
        }
        if (peek() !== ")") throw new ExprError("missing ) after function arguments");
        i += 1;
        return { t: "call", fn, args };
      }
      return { t: "param", name: word.toUpperCase() };
    }
    throw new ExprError(`unexpected character ${JSON.stringify(c)}`);
  };

  const power = (): ExprNode => {
    const base = primary();
    skip();
    if (peek() === "^") {
      i += 1;
      return { t: "bin", op: "^", l: base, r: power() };
    }
    return base;
  };

  const term = (): ExprNode => {
    let left = power();
    for (;;) {
      skip();
      const c = peek();
      if (c !== "*" && c !== "/") return left;
      i += 1;
      left = { t: "bin", op: c, l: left, r: power() };
    }
  };

  const expr = (): ExprNode => {
    let left = term();
    for (;;) {
      skip();
      const c = peek();
      if (c !== "+" && c !== "-") return left;
      i += 1;
      left = { t: "bin", op: c, l: left, r: term() };
    }
  };

  const out = expr();
  skip();
  if (i < src.length) throw new ExprError(`unexpected ${JSON.stringify(src.slice(i))}`);
  return out;
}

export function evalExpr(node: ExprNode, params: ReadonlyMap<string, number>): number {
  switch (node.t) {
    case "num":
      return node.v;
    case "param": {
      if (node.name === "PI") return Math.PI;
      const v = params.get(node.name);
      if (v === undefined) throw new ExprError(`unknown parameter ${node.name}`);
      return v;
    }
    case "neg":
      return -evalExpr(node.v, params);
    case "bin": {
      const l = evalExpr(node.l, params);
      const r = evalExpr(node.r, params);
      switch (node.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          if (r === 0) throw new ExprError("division by zero");
          return l / r;
        case "^":
          return Math.pow(l, r);
        default: {
          const never: never = node.op;
          return never;
        }
      }
    }
    case "call": {
      const a = node.args.map((n) => evalExpr(n, params));
      switch (node.fn) {
        case "min":
          return Math.min(...a);
        case "max":
          return Math.max(...a);
        case "abs":
          return Math.abs(a[0] ?? 0);
        case "sqrt":
          return Math.sqrt(a[0] ?? 0);
        case "round":
          return Math.round(a[0] ?? 0);
        default: {
          const never: never = node.fn;
          return never;
        }
      }
    }
    default: {
      const never: never = node;
      return never;
    }
  }
}

export function evalExprText(text: string, params: ReadonlyMap<string, number>): number {
  return evalExpr(parseExpr(text), params);
}

/* ------------------------------------------------- solver model */

/**
 * Scalar solver. Every constraint is one residual function of the free
 * variables; Newton with a numeric Jacobian converges in a few iterations for
 * the small, well-behaved systems a drawing has (tens of points per sketch).
 *
 * The engine solves in *drawn* units (mm) and the caller maps back.
 */
export type VarId = string;

export interface Constraint {
  readonly id: string;
  readonly label: string;
  /** Variables this constraint reads; used for ordering, not enforcement. */
  readonly vars: readonly VarId[];
  /** Residual: zero when satisfied. */
  readonly residual: (v: ReadonlyMap<VarId, number>) => number;
}

/**
 * A solve whose worst residual is above this has not really fitted the
 * drawing. Scaled to millimetres: half a thousandth of a millimetre is far
 * finer than any plot, and loose enough that a clean fit never trips it.
 */
export const SOLVE_RESIDUAL_LIMIT = 5e-4;

export interface SolveOptions {
  readonly maxIterations?: number;
  readonly tolerance?: number;
  /** Newton damping factor, 1 is full step. */
  readonly damping?: number;
}

interface LinSolve {
  readonly x: readonly number[];
  readonly iterations: number;
  readonly residual: number;
}

/**
 * Damped Newton with least squares (normal equations + Gaussian elimination)
 * so a system with more constraints than variables still yields a best fit and
 * reports its residual instead of diverging.
 */
export function solveSystem(
  vars: readonly VarId[],
  constraints: readonly Constraint[],
  options: SolveOptions = {},
  start?: ReadonlyMap<VarId, number>,
): LinSolve {
  const tolerance = options.tolerance ?? 1e-9;
  const maxIterations = options.maxIterations ?? 60;
  const damping = options.damping ?? 1;
  // Newton starts from the drawing as it is, so the nearest solution wins.
  const state = new Map<VarId, number>(vars.map((v) => [v, start?.get(v) ?? 0]));
  if (state.size === 0) return { x: [], iterations: 0, residual: 0 };
  // Live view of `state`. A residual may call back into a solver helper that
  // was handed `start` rather than the state map, and a snapshot would then
  // read start values while Newton is probing elsewhere (or report NaN).
  const view: ReadonlyMap<VarId, number> = {
    get: (k) => state.get(k),
    has: (k) => state.has(k),
    forEach: (fn) => state.forEach(fn),
    entries: () => state.entries(),
    keys: () => state.keys(),
    values: () => state.values(),
    get size() {
      return state.size;
    },
    [Symbol.iterator]: () => state[Symbol.iterator](),
  };
  const f = (s: ReadonlyMap<VarId, number>): number[] => constraints.map((c) => c.residual(s));
  let residual = Math.max(0, ...f(view).map(Math.abs));
  let iterations = 0;
  while (residual > tolerance && iterations < maxIterations && constraints.length > 0) {
    iterations += 1;
    const base = f(view);
    const m = constraints.length;
    const n = vars.length;
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      const id = vars[j]!;
      const v = state.get(id)!;
      const h = Math.max(1e-7, Math.abs(v) * 1e-7);
      state.set(id, v + h);
      const plus = f(view);
      state.set(id, v);
      for (let i = 0; i < m; i++) J[i]![j] = (plus[i]! - base[i]!) / h;
    }
    // Normal equations J^T J dx = -J^T f, with a tiny ridge for degenerate rows.
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += J[i]![r]! * J[i]![c]!;
        A[r]![c] = sum + (r === c ? 1e-12 : 0);
      }
      let rhs = 0;
      for (let i = 0; i < m; i++) rhs -= J[i]![r]! * base[i]!;
      A[r]![n] = rhs;
    }
    const dx = gaussA(A, n);
    if (!dx) break;
    let scaleStep = damping;
    let accepted = false;
    for (let k = 0; k < 8; k++) {
      const trial = new Map(state);
      // A degenerate step (NaN) means the system is over-constrained: keep the
      // drawing as it is and let the residual report it, never write NaN.
      for (let j = 0; j < n; j++) trial.set(vars[j]!, state.get(vars[j]!)! + dx[j]! * scaleStep);
      const effective = Math.max(0, ...f(trial).map(Math.abs));
      if (!Number.isFinite(effective)) break;
      if (effective < residual) {
        for (let j = 0; j < n; j++) state.set(vars[j]!, trial.get(vars[j]!)!);
        residual = effective;
        accepted = true;
        break;
      }
      scaleStep /= 2;
    }
    if (!accepted) break;
  }
  return { x: vars.map((v) => state.get(v)!), iterations, residual };
}

/** Gaussian elimination with partial pivoting on a dense n x (n+1) system. */
function gaussA(A: number[][], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    if (Math.abs(A[pivot]![col]!) < 1e-14) return null;
    if (pivot !== col) [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    for (let r = col + 1; r < n; r++) {
      const factor = A[r]![col]! / A[col]![col]!;
      for (let c = col; c <= n; c++) A[r]![c] = A[r]![c]! - factor * A[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = A[r]![n]!;
    for (let c = r + 1; c < n; c++) sum -= A[r]![c]! * x[c]!;
    x[r] = sum / A[r]![r]!;
  }
  return x;
}

/* ------------------------------------------- constraints over geometry */

/** One scalar solved quantity, with the entity and slot it lives in. */
export interface ProjVar {
  readonly entity: EntityId;
  /** Which number of the entity: `x`, `y`, `r`, `start`, `end`. */
  readonly slot: string;
  readonly index: number;
}

/**
 * A variable is addressed as `entity|slot:index`. Points of polylines and
 * splines get one pair each, so a constraint can hold any vertex.
 */
export function varKey(entity: EntityId, slot: string, index = 0): VarId {
  return `${entity}|${slot}:${index}`;
}

export interface SceneProjection {
  readonly vars: ReadonlyMap<VarId, number>;
  readonly byEntity: ReadonlyMap<EntityId, readonly VarId[]>;
}

/** Every solvable number of the visible, unlocked entities. */
export function projectScene(doc: DocumentState): SceneProjection {
  const vars = new Map<VarId, number>();
  const byEntity = new Map<EntityId, VarId[]>();
  const put = (e: EntityId, slot: string, index: number, value: number): void => {
    const key = varKey(e, slot, index);
    vars.set(key, value);
    const list = byEntity.get(e);
    if (list) list.push(key);
    else byEntity.set(e, [key]);
  };
  for (const e of doc.entities.values()) {
    const layer = doc.layers.get(e.layer);
    if (!layer || layer.locked) continue;
    if (e.block) continue;
    switch (e.kind) {
      case "line":
        put(e.id, "x", 0, e.a.x);
        put(e.id, "y", 0, e.a.y);
        put(e.id, "x", 1, e.b.x);
        put(e.id, "y", 1, e.b.y);
        break;
      case "polyline":
        e.points.forEach((p, i) => {
          put(e.id, "x", i, p.x);
          put(e.id, "y", i, p.y);
        });
        break;
      case "spline":
        e.points.forEach((p, i) => {
          put(e.id, "x", i, p.x);
          put(e.id, "y", i, p.y);
        });
        break;
      case "circle":
        put(e.id, "x", 0, e.center.x);
        put(e.id, "y", 0, e.center.y);
        put(e.id, "r", 0, e.radius);
        break;
      case "arc":
        put(e.id, "x", 0, e.center.x);
        put(e.id, "y", 0, e.center.y);
        put(e.id, "r", 0, e.radius);
        put(e.id, "start", 0, e.start);
        put(e.id, "end", 0, e.end);
        break;
      case "text":
        put(e.id, "x", 0, e.at.x);
        put(e.id, "y", 0, e.at.y);
        break;
      case "point":
        put(e.id, "x", 0, e.at.x);
        put(e.id, "y", 0, e.at.y);
        break;
      default:
        break;
    }
  }
  return { vars, byEntity };
}

export function writeBack(e: Entity, v: ReadonlyMap<VarId, number>): Entity {
  const g = (slot: string, index = 0): number => v.get(varKey(e.id, slot, index)) ?? 0;
  switch (e.kind) {
    case "line":
      return { ...e, a: pt(g("x", 0), g("y", 0)), b: pt(g("x", 1), g("y", 1)) };
    case "polyline":
      return { ...e, points: e.points.map((_, i) => pt(g("x", i), g("y", i))) };
    case "spline":
      return { ...e, points: e.points.map((_, i) => pt(g("x", i), g("y", i))) };
    case "circle":
      return { ...e, center: pt(g("x"), g("y")), radius: Math.abs(g("r")) };
    case "arc": {
      const start = g("start");
      let end = g("end");
      while (end <= start) end += Math.PI * 2;
      return { ...e, center: pt(g("x"), g("y")), radius: Math.abs(g("r")), start, end };
    }
    case "text":
      return { ...e, at: pt(g("x"), g("y")) };
    case "point":
      return { ...e, at: pt(g("x"), g("y")) };
    default:
      return e;
  }
}

export function varValue(v: ReadonlyMap<VarId, number>, vid: VarId): number {
  const value = v.get(vid);
  // 0 rather than a throw: the pre-flight check in solveDocument already
  // reports dangling references, and a torn drawing mid-edit (one end moved,
  // the other not yet written) must not crash the solve loop.
  return value ?? 0;
}

/** Variables a constraint names that the drawing no longer has. */
export function danglingVars(c: ConstraintDef, projection: SceneProjection): VarId[] {
  const seen = new Set<VarId>(projection.vars.keys());
  return [...c.vars, ...c.refs].filter((v) => !seen.has(v));
}

export type ConstraintKind = "fixed" | "horizontal" | "vertical" | "parallelTo" | "perpendicularTo" | "equalLength" | "pointOnLine" | "coincident" | "distance" | "radius" | "angle" | "midpoint" | "symmetric";

export interface ConstraintDef {
  readonly id: string;
  readonly kind: ConstraintKind;
  /** The variables this constraint owns (free ones it may move). */
  readonly vars: readonly VarId[];
  /** Extra references (the other line, the value). */
  readonly refs: readonly VarId[];
  readonly value?: number;
  readonly label: string;
}

/** Constraint from explicit variables, in the order each kind reads them. */
export function constraintFromPairs(kind: ConstraintKind, vars: readonly VarId[], value?: number): ConstraintDef {
  const id = `${kind}-${vars.join(",")}`;
  // Every pair constraint needs a fixed arity; a short list would read
  // `undefined` as a variable later and blow up deep inside the solver.
  const arity = CONSTRAINT_ARITY[kind];
  if (arity > 0 && vars.length !== arity) {
    throw new Error(`constraint "${kind}" takes ${arity} variables, got ${vars.length}`);
  }
  if (arity > 0 && vars.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new Error(`constraint "${kind}" was given an empty variable`);
  }
  return value === undefined ? { id, kind, vars, refs: [], label: kind } : { id, kind, vars, refs: [], value, label: kind };
}

/** How many variables each constraint kind reads; 0 means "check at solve time". */
const CONSTRAINT_ARITY: Readonly<Record<ConstraintKind, number>> = {
  fixed: 1,
  horizontal: 4,
  vertical: 4,
  parallelTo: 8,
  perpendicularTo: 8,
  equalLength: 8,
  pointOnLine: 6,
  coincident: 4,
  distance: 4,
  radius: 1,
  angle: 4,
  midpoint: 4,
  symmetric: 8,
};

const dx = (v: ReadonlyMap<VarId, number>, a: VarId, b: VarId): number => varValue(v, a) - varValue(v, b);
const dy = (v: ReadonlyMap<VarId, number>, a: VarId, b: VarId): number => varValue(v, a) - varValue(v, b);

/** The line-like variable pairs of an entity, in vertex order. */
export function lineVars(entity: EntityId, count: number): { x0: VarId; y0: VarId; x1: VarId; y1: VarId } {
  return { x0: varKey(entity, "x", 0), y0: varKey(entity, "y", 0), x1: varKey(entity, "x", count - 1), y1: varKey(entity, "y", count - 1) };
}

export function constraintResidual(c: ConstraintDef): (v: ReadonlyMap<VarId, number>) => number {
  const vars = c.vars;
  switch (c.kind) {
    case "fixed":
      return (v) => 0;
    case "horizontal": {
      const [x0, y0, x1, y1] = vars as [VarId, VarId, VarId, VarId];
      return (v) => dy(v, y1, y0);
    }
    case "vertical": {
      const [x0, y0, x1, y1] = vars as [VarId, VarId, VarId, VarId];
      return (v) => dx(v, x1, x0);
    }
    case "parallelTo": {
      const [ax0, ay0, ax1, ay1, bx0, by0, bx1, by1] = vars as [VarId, VarId, VarId, VarId, VarId, VarId, VarId, VarId];
      return (v) => dx(v, ax1, ax0) * dy(v, by1, by0) - dy(v, ay1, ay0) * dx(v, bx1, bx0);
    }
    case "perpendicularTo": {
      const [ax0, ay0, ax1, ay1, bx0, by0, bx1, by1] = vars as [VarId, VarId, VarId, VarId, VarId, VarId, VarId, VarId];
      return (v) => dx(v, ax1, ax0) * dx(v, bx1, bx0) + dy(v, ay1, ay0) * dy(v, by1, by0);
    }
    case "equalLength": {
      const [ax0, ay0, ax1, ay1, bx0, by0, bx1, by1] = vars as [VarId, VarId, VarId, VarId, VarId, VarId, VarId, VarId];
      return (v) => Math.hypot(dx(v, ax1, ax0), dy(v, ay1, ay0)) - Math.hypot(dx(v, bx1, bx0), dy(v, by1, by0));
    }
    case "pointOnLine": {
      const [px, py, lx0, ly0, lx1, ly1] = vars as [VarId, VarId, VarId, VarId, VarId, VarId];
      return (v) => {
        const ex = dx(v, lx1, lx0);
        const ey = dy(v, ly1, ly0);
        const pxv = dx(v, px, lx0);
        const pyv = dy(v, py, ly0);
        return (ex * pyv - ey * pxv) / (Math.hypot(ex, ey) || 1);
      };
    }
    case "coincident":
      return (v) => dx(v, vars[0]!, vars[2]!) + dy(v, vars[1]!, vars[3]!);
    case "distance": {
      const d = c.value ?? 0;
      return (v) => Math.hypot(dx(v, vars[2]!, vars[0]!), dy(v, vars[3]!, vars[1]!)) - d;
    }
    case "radius": {
      const d = c.value ?? 0;
      return (v) => Math.abs(varValue(v, vars[0]!)) - d;
    }
    case "angle": {
      const t = ((c.value ?? 0) * Math.PI) / 180;
      return (v) => Math.atan2(dy(v, vars[3]!, vars[1]!), dx(v, vars[2]!, vars[0]!)) - t;
    }
    case "midpoint":
      return (v) => dx(v, vars[0]!, vars[2]!) + dx(v, vars[1]!, vars[3]!);
    case "symmetric": {
      const [ax, ay, bx, by, ax0, ay0, ax1, ay1] = vars as [VarId, VarId, VarId, VarId, VarId, VarId, VarId, VarId];
      return (v) => {
        const mx = (dx(v, ax, ax0) + dx(v, bx, ax0)) / 2;
        const my = (dy(v, ay, ay0) + dy(v, by, ay0)) / 2;
        const ex = dx(v, ax1, ax0);
        const ey = dy(v, ay1, ay0);
        return (ex * my - ey * mx) / (Math.hypot(ex, ey) || 1);
      };
    }
    default: {
      const never: never = c.kind;
      return never;
    }
  }
}

/** One solve, described by the shell. `fixed` vars are pinned to their current value. */
export interface SolveProblem {
  readonly fixed: readonly VarId[];
  readonly constraints: readonly ConstraintDef[];
}

export interface SolveOutcome {
  readonly doc: DocumentState;
  readonly solved: number;
  readonly failed: readonly { readonly id: string; readonly message: string }[];
  readonly iterations: number;
}

/**
 * Solve, then write the result into a *new* document, and return only the
 * entities that actually moved, so the caller can compare them with its own
 * copy of the document and un-fix anything reused (an edit does not travel
 * with its original).
 */
export function solveDocument(doc: DocumentState, problem: SolveProblem, nextId: () => EntityId, options: SolveOptions = {}): SolveOutcome {
  const projection = projectScene(doc);
  // A constraint aiming at geometry that was deleted, exploded or moved to a
  // locked layer is a fault in the drawing, not an exception: report it and
  // solve the rest. Throwing here would take the whole session down mid-edit.
  const missing = problem.constraints.flatMap((c) =>
    danglingVars(c, projection).map(() => ({ id: c.id, message: `${c.label} refers to geometry that no longer exists; delete or re-attach it` })),
  );
  const live = problem.constraints.filter((c) => danglingVars(c, projection).length === 0);
  // A number reaching the solver as NaN is a bug in its producer; name it here
  // rather than letting Newton write NaN coordinates into the drawing.
  for (const [k, val] of projection.vars) if (!Number.isFinite(val)) throw new Error(`variable ${k} is not a finite number (${val})`);
  const fixed = new Set(problem.fixed);
  const pinned = live.filter((c) => c.kind === "fixed").map((c) => c.vars[0]!);
  const free = [...projection.vars.keys()].filter((v) => !fixed.has(v) && !pinned.includes(v));
  const constraints: Constraint[] = live
    .filter((c) => c.kind !== "fixed")
    .map((c) => ({ id: c.id, label: c.label, vars: c.vars, residual: constraintResidual(c) }));
  const solved = solveSystem(free, constraints, options, projection.vars);
  const values = new Map(projection.vars);
  free.forEach((v, i) => values.set(v, solved.x[i]!));

  const moved = new Map<EntityId, Entity>();
  for (const [entity, vids] of projection.byEntity) {
    const e = doc.entities.get(entity);
    if (!e) continue;
    const changed = vids.some((v) => Math.abs((values.get(v) ?? 0) - (projection.vars.get(v) ?? 0)) > 1e-7);
    if (!changed) continue;
    const next = writeBack(e, values);
    // Offset geometry is derived, never solved: it follows its source, and is
    // replaced by a fresh derived entity so the link stays live (F-05).
    if (next.kind === "dimension" || next.kind === "leader") continue;
    moved.set(entity, next);
  }

  // Geometry derived from a solved source is rebuilt, never stretched.
  for (const def of doc.entities.values()) {
    if (def.kind !== "polyline") continue;
    const link = perpendicularLinks.get(def.id);
    if (!link) continue;
    const source = doc.entities.get(link.source);
    if (!source || !moved.has(link.source)) continue;
    const solvedSource = moved.get(link.source)!;
    const derived = deriveOffset(solvedSource, link.distance);
    if (derived) moved.set(def.id, { ...def, points: derived.points, bulges: derived.bulges });
  }

  // Two ways to fail, both reported rather than swallowed: the drawing cannot
  // meet the constraints, or there was nothing left to move (every variable
  // pinned) and the constraints were therefore never even tested by Newton.
  const stuck = free.length === 0 && constraints.length > 0;
  const misfit = !stuck && solved.residual > SOLVE_RESIDUAL_LIMIT;
  const failed = stuck || misfit
    ? [...missing, { id: problem.constraints.map((c) => c.id).join("+"), message: `constraints do not fit (${stuck ? "every point is pinned" : `residual ${solved.residual.toFixed(3)}`}); remove one or free a point` }]
    : [...missing];
  if (moved.size === 0) {
    return { doc, solved: 0, failed, iterations: solved.iterations };
  }
  const entities = new Map(doc.entities);
  for (const [id, e] of moved) entities.set(id, e);
  return { doc: { ...doc, entities }, solved: moved.size, failed, iterations: solved.iterations };
}

/**
 * Perpendicular offset of a polyline's ring by `distance` (positive to the
 * left of travel). Refuses a distance that would make a segment collapse
 * (self-intersection of the offset ring is caught by the caller's area check).
 */
export function offsetRing(points: readonly Pt[], distance: number, closed: boolean): Pt[] | null {
  if (points.length < 2) return null;
  const n = points.length;
  const segs: { dir: Pt; nrm: Pt }[] = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const u = unit(sub(b, a));
    if (!u) return null;
    segs.push({ dir: u, nrm: pt(-u.y, u.x) });
  }
  const out: Pt[] = [];
  const vertexNormal = (i: number): Pt | null => {
    const prev = closed ? segs[(i - 1 + segCount) % segCount] : i > 0 ? segs[i - 1] : undefined;
    const next = i < segCount ? segs[i] : undefined;
    if (prev && next) {
      // Mitre: bisector of the two normals, scaled by 1/cos(half the turn).
      const sum = pt(prev.nrm.x + next.nrm.x, prev.nrm.y + next.nrm.y);
      const dir = unit(sum);
      if (!dir) return null;
      // cos of the direction change equals the scalar products of the normals.
      const half = Math.acos(Math.max(-1, Math.min(1, dot(prev.dir, next.dir)))) / 2;
      const cosHalf = Math.max(0.2, Math.cos(half));
      return scale(dir, 1 / cosHalf);
    }
    return (prev ?? next)?.nrm ?? null;
  };
  for (let i = 0; i < n; i++) {
    const m = vertexNormal(i);
    if (!m) return null;
    out.push(add(points[i]!, scale(m, distance)));
  }
  return out;
}

/** Rebuild an offset from its source, keeping bulges and closure. */
export function deriveOffset(source: Entity, distance: number): { points: Pt[]; bulges: number[] } | null {
  if (source.kind !== "polyline") return null;
  const points = offsetRing(source.points, distance, source.closed);
  if (!points) return null;
  const bulges = new Array<number>(points.length).fill(0);
  return { points, bulges };
}

/** Offset links: derived entity -> source entity and distance. A module-level map so a reopened file keeps no stale state. */
export const perpendicularLinks = new Map<EntityId, { source: EntityId; distance: number }>();

/** User dimension linked to an object (F-19): what a mismatch should paint red. */
export const dimensionParams = new Map<EntityId, { param: string; mode: "drive" | "driven" }>();

/** Which parameters a solve refreshes from their driving dimensions. */
export function readDrivenParams(doc: DocumentState): SolveResult["mismatched"] {
  const bad: EntityId[] = [];
  for (const [dimId, link] of dimensionParams) {
    const e = doc.entities.get(dimId);
    if (!e || e.kind !== "dimension") continue;
    if (link.mode !== "drive") continue;
    const objective = doc.params.get(link.param);
    if (objective === undefined) continue;
    if (Math.abs(measureDimension(doc, e).value - objective) > FIT_TOLERANCE) bad.push(dimId);
  }
  return bad;
}

/* ================================================= parametric commands */

/**
 * The set of entities a solve may move: the shell passes the selection plus
 * everything anchored to it. A vessel is the "sketch"; a dimension that binds
 * to it drives it (F-19).
 */
export interface Anchor {
  readonly fixed: readonly EntityId[];
  readonly constraints: readonly ConstraintDef[];
  /** Dimensions whose target is one of these entities; `at` is meaningless for them. */
  readonly rules: readonly ParamRule[];
}

/** A rule a dimension imposes: measured value must equal `param` or a number. */
export type ParamRule =
  | { readonly kind: "distance"; readonly dim: EntityId; readonly p1: VarId; readonly p2: VarId; readonly value: number }
  | { readonly kind: "radius"; readonly target: VarId; readonly value: number };

/**
 * Freeze single variables. The solver has no way to hold one number still
 * while moving the rest of its entity, so the caller says which numbers are
 * the grip: "this corner stays, the edge grows".
 */
export function pinVars(vars: readonly VarId[]): ConstraintDef[] {
  return vars.map((v) => ({ id: `pin-${v}`, kind: "fixed", vars: [v], refs: [], label: "pin" }));
}

/** Point variables of a line-like entity, in the order `pinVars` wants. */
export function endpointVars(e: Entity): VarId[] {
  switch (e.kind) {
    case "line": {
      const l = lineVars(e.id, 2);
      return [l.x0, l.y0, l.x1, l.y1];
    }
    case "polyline":
    case "spline": {
      const out: VarId[] = [];
      e.points.forEach((_, i) => out.push(varKey(e.id, "x", i), varKey(e.id, "y", i)));
      return out;
    }
    case "circle":
    case "arc":
      return [varKey(e.id, "x"), varKey(e.id, "y"), varKey(e.id, "r")];
    default:
      return [];
  }
}

/** Turn a design rule into solver constraints. */
export function constraintsFromRules(rulesToAdd: readonly ParamRule[]): ConstraintDef[] {
  return rulesToAdd.map((r, i) =>
    r.kind === "distance"
      ? { id: `rule-${i}`, kind: "distance", vars: [r.p1, r.p2], refs: [], value: r.value, label: "dimension" }
      : { id: `rule-${i}`, kind: "radius", vars: [r.target], refs: [], value: r.value, label: "radius" },
  );
}

/**
 * Write new free variables into `move`, re-derive anything linked, and commit
 * the whole thing as one undoable patch. The map is built from the solved doc
 * so two solves in one gesture never disagree about the same entity.
 */
export function commitSolved(base: DocumentState, solved: DocumentState, label: string): Command {
  return {
    kind: "commitSolved",
    label,
    apply(doc) {
      const before = new Map<EntityId, Entity | null>();
      const after = new Map<EntityId, Entity | null>();
      for (const e of solved.entities.values()) {
        // Reuse-aware: if an entity was already solved earlier in this gesture
        // and the user separately re-linked it, this gesture wins by *not*
        // overwriting a newer value with an older one.
        const existing = doc.entities.get(e.id);
        if (existing && JSON.stringify(existing) === JSON.stringify(e)) continue;
        if (!existing && base.entities.has(e.id)) continue;
        const original = base.entities.get(e.id) ?? existing ?? null;
        before.set(e.id, doc.entities.get(e.id) ?? original);
        after.set(e.id, existing ? { ...existing, ...e } : e);
      }
      for (const [id, entity] of before) {
        if (entity && after.has(id)) {
          const keep = after.get(id)!;
          if (keep && keep.kind === entity.kind) {
            const merged: Entity = { ...keep, id, layer: keep.layer };
            after.set(id, merged);
          }
        }
      }
      return patchOf(before, after, label);
    },
  };
}

/** Apply a numeric parameter to the drawing: the dimension-drives-geometry gesture. */
export interface ParametricResult {
  readonly doc: DocumentState;
  readonly problems: readonly string[];
  readonly solved: number;
}

/**
 * Solve `anchor` (free geometry) against `rules`, in one pass, and return a new
 * document. Entity ids referenced by a rule that no longer exist are reported,
 * never silently dropped: a drawing must say when it no longer fits.
 */
export function solveAnchor(doc: DocumentState, anchor: Anchor, options: SolveOptions = {}): ParametricResult {
  const problems: string[] = [];
  const projection = projectScene(doc);
  for (const rule of anchor.rules) {
    if (rule.kind === "distance" && (!projection.vars.has(rule.p1) || !projection.vars.has(rule.p2))) problems.push(`dimension target for ${rule.dim} no longer exists`);
    if (rule.kind === "radius" && !projection.vars.has(rule.target)) problems.push(`radius target no longer exists`);
  }
  const fixed = anchor.fixed.flatMap((id) => projection.byEntity.get(id) ?? []);
  const outcome = solveDocument(doc, { fixed, constraints: [...anchor.constraints, ...constraintsFromRules(anchor.rules)] }, () => "", options);
  if (problems.length) return { doc, problems, solved: 0 };
  if (outcome.failed.length) problems.push(...outcome.failed.map((f) => f.message));
  return { doc: outcome.doc, problems, solved: outcome.solved };
}

/** Read a whole drawing's parameters, refreshed from its driving dimensions. */
export function refreshParams(doc: DocumentState): { doc: DocumentState; mismatched: readonly EntityId[] } {
  const mismatched = readDrivenParams(doc);
  return { doc, mismatched };
}

/* ============================================ geometry operations */

/** Point on a segment closest to another segment's infinite line. */
function lineIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(c, a), s) / denom;
  return add(a, scale(r, t));
}

/**
 * Trim: cut away the part of a line, arc or circle outside the two cutters.
 * Line is the common case; a circle cut once becomes an arc.
 */
export function trimEntity(target: Entity, cutters: readonly Entity[], pickAt: Pt): Entity | { readonly remove: true } {
  const cutSegments = cutters.flatMap((c) => candidates(c));
  if (target.kind === "line") {
    const hits: Pt[] = [];
    for (const s of cutSegments) {
      const x = segmentIntersection(target.a, target.b, s.a, s.b);
      if (x) hits.push(x);
    }
    if (hits.length === 0) return target;
    const sorted = hits.map((h) => ({ h, t: dot(sub(h, target.a), sub(target.b, target.a)) / Math.max(1e-12, dot(sub(target.b, target.a), sub(target.b, target.a))) })).sort((p, q) => p.t - q.t);
    const pickT = dot(sub(pickAt, target.a), sub(target.b, target.a)) / Math.max(1e-12, dot(sub(target.b, target.a), sub(target.b, target.a)));
    // The stretch containing the pick is removed.
    let lo = { t: 0, p: target.a };
    let hi = { t: 1, p: target.b };
    for (const s of sorted) {
      if (s.t <= pickT) lo = { t: s.t, p: s.h };
      if (s.t > pickT && hi.t === 1) hi = { t: s.t, p: s.h };
    }
    const keepBefore = pickT - lo.t > 1e-9;
    const keepAfter = hi.t - pickT > 1e-9;
    if (keepBefore && keepAfter) return target; // pick between two cuts: middle removed, so two pieces remain; kept whole for simplicity
    if (keepBefore) return { ...target, a: lo.p };
    if (keepAfter) return { ...target, b: hi.p };
    return { remove: true };
  }
  if (target.kind === "circle") {
    const hits = cutSegments.flatMap((s) => {
      const a = closestOnSegment(target.center, s.a, s.b);
      return a.distance <= target.radius ? intersectionsCircleSegment(target.center, target.radius, s.a, s.b) : [];
    });
    if (hits.length === 0) return target;
    const first = hits[0]!;
    const angle = angleOf(sub(first, target.center));
    const pickAngle = angleOf(sub(pickAt, target.center));
    // Cut at the first hit, remove the arc containing the pick point.
    const sweepToPick = sweepBetween(pt(Math.cos(angle), Math.sin(angle)), pt(Math.cos(pickAngle), Math.sin(pickAngle)));
    return { ...target, kind: "arc", start: angle + sweepToPick, end: angle };
  }
  if (target.kind === "arc") {
    const swept = tessellateArc(target.center, target.radius, target.start, target.end);
    void swept;
    const hits = cutSegments.flatMap((s) => intersectionsCircleSegment(target.center, target.radius, s.a, s.b)).filter((p) => {
      const a = angleOf(sub(p, target.center));
      const s = sweepBetween(pt(Math.cos(target.start), Math.sin(target.start)), pt(Math.cos(a), Math.sin(a)));
      return s <= sweepBetween(pt(Math.cos(target.start), Math.sin(target.start)), pt(Math.cos(target.end), Math.sin(target.end)));
    });
    if (hits.length === 0) return target;
    const pickA = angleOf(sub(pickAt, target.center));
    const pickSweep = sweepBetween(pt(Math.cos(target.start), Math.sin(target.start)), pt(Math.cos(pickA), Math.sin(pickA)));
    const cuts = hits
      .map((p) => ({
        p,
        s: sweepBetween(pt(Math.cos(target.start), Math.sin(target.start)), pt(Math.cos(angleOf(sub(p, target.center))), Math.sin(angleOf(sub(p, target.center))))),
      }))
      .sort((a, b) => a.s - b.s);
    let lo = { s: 0, p: add(target.center, pt(Math.cos(target.start) * target.radius, Math.sin(target.start) * target.radius)) };
    let hi = { s: sweepBetween(pt(Math.cos(target.start), Math.sin(target.start)), pt(Math.cos(target.end), Math.sin(target.end))), p: add(target.center, pt(Math.cos(target.end) * target.radius, Math.sin(target.end) * target.radius)) };
    for (const c of cuts) {
      if (c.s <= pickSweep) lo = c;
      else if (hi.s !== c.s) hi = c;
    }
    if (pickSweep - lo.s <= 1e-9) return { ...target, start: angleOf(sub(hi.p, target.center)) > angleOf(sub(lo.p, target.center)) ? target.start : target.start, end: angleOf(sub(hi.p, target.center)) + (target.end > target.start ? 0 : Math.PI * 2) };
    return { ...target, end: angleOf(sub(lo.p, target.center)) };
  }
  return target;
}

/** Both intersection points of a circle and an infinite segment. */
export function intersectionsCircleSegment(center: Pt, radius: number, a: Pt, b: Pt): Pt[] {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-18) return [];
  const t = dot(sub(center, a), ab) / len2;
  const foot = add(a, scale(ab, t));
  const d = dist(foot, center);
  if (d > radius + 1e-9) return [];
  const dt = Math.sqrt(Math.max(0, radius * radius - d * d)) / Math.sqrt(len2);
  return [add(a, scale(ab, t - dt)), add(a, scale(ab, t + dt))];
}

/** Fillet: a tangent arc of `radius` between two lines. Returns null when it does not fit. */
export function filletLines(a: Extract<Entity, { kind: "line" }>, b: Extract<Entity, { kind: "line" }>, radius: number, preserve: "a" | "b"): { arc: { kind: "arc"; center: Pt; radius: number; start: number; end: number }; lineA: Pt; lineB: Pt } | null {
  if (!(radius > 0)) return null;
  // Two lines drawn corner-to-corner share an endpoint and are parallel to
  // nothing: the corner is that shared point. Only lines that actually cross
  // (or whose extensions cross) need the intersection.
  const ends = [a.a, a.b];
  const shared = ends.find((p) => dist(p, b.a) < FIT_TOLERANCE || dist(p, b.b) < FIT_TOLERANCE) ?? null;
  const corner = shared ?? lineIntersection(a.a, a.b, b.a, b.b);
  if (!corner) return null;
  // Direction away from the corner: the endpoint that is *not* on the corner.
  // (Picking the nearest end would pick the corner itself and there would be
  // no direction left.)
  const far = (line: { a: Pt; b: Pt }): Pt => (dist(corner, line.a) >= dist(corner, line.b) ? line.a : line.b);
  const ta = unit(sub(far(a), corner));
  const tb = unit(sub(far(b), corner));
  if (!ta || !tb) return null;
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(ta, tb))));
  // Collinear passes through and a full fold are both degenerate: no unique
  // centre, so there is nothing to fillet.
  if (theta < 1e-6 || Math.PI - theta < 1e-6) return null;
  // Tangent points sit `radius / tan(theta/2)` from the corner along each ray.
  // For a reflex corner (theta > 90° measured between the rays as drawn) the
  // arc turns the other way, so the distance uses the supplementary angle and
  // the centre goes on the outer bisector.
  const reflex = theta > Math.PI / 2;
  const half = reflex ? (Math.PI - theta) / 2 : theta / 2;
  const tangentDist = Math.tan(half) < 1e-9 ? Infinity : radius / Math.tan(half);
  if (!Number.isFinite(tangentDist)) return null;
  const tangentA = add(corner, scale(ta, tangentDist));
  const tangentB = add(corner, scale(tb, tangentDist));
  const bis = unit(add(ta, tb));
  if (!bis) return null;
  const center = add(corner, scale(bis, reflex ? radius / Math.sin(half) : radius / Math.sin(half)));
  const start = angleOf(sub(tangentB, center));
  const end = angleOf(sub(tangentA, center));
  void preserve;
  return { arc: { kind: "arc", center, radius, start, end }, lineA: tangentA, lineB: tangentB };
}

/** Extend a line (or one end of a polyline's first/last segment) to meet a target. */
export function extendLine(line: { a: Pt; b: Pt }, target: readonly { a: Pt; b: Pt }[], at: Pt): { a: Pt; b: Pt } | null {
  const toB = dist(at, line.b) <= dist(at, line.a);
  const from = toB ? line.a : line.b;
  const dir = unit(sub(toB ? line.b : line.a, from));
  if (!dir) return null;
  let best: { p: Pt; t: number } | null = null;
  const far = add(from, scale(dir, 1e9));
  for (const s of target) {
    const x = lineIntersection(from, far, s.a, s.b);
    if (!x) continue;
    const t = dot(sub(x, from), dir);
    if (t <= 0) continue;
    const within = closestOnSegment(x, s.a, s.b).distance < 1e-6;
    if (!within) continue;
    if (!best || t < best.t) best = { p: x, t };
  }
  if (!best) return null;
  return toB ? { a: line.a, b: best.p } : { a: best.p, b: line.b };
}

/** Join touching lines/polylines into one polyline; null when they do not chain. */
export function joinEntities(doc: DocumentState, ids: readonly EntityId[], tolerance = FIT_TOLERANCE): Pt[] | null {
  const chains: Pt[][] = [];
  for (const id of ids) {
    const e = doc.entities.get(id);
    if (!e) continue;
    if (e.kind === "line") chains.push([e.a, e.b]);
    else if (e.kind === "polyline") chains.push([...e.points]);
  }
  if (chains.length === 0) return null;
  let ring = chains.shift()!;
  let progress = true;
  while (chains.length && progress) {
    progress = false;
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      const head = ring[0]!;
      const tail = ring[ring.length - 1]!;
      if (dist(tail, c[0]!) <= tolerance) ring = [...ring, ...c.slice(1)];
      else if (dist(tail, c[c.length - 1]!) <= tolerance) ring = [...ring, ...[...c].reverse().slice(1)];
      else if (dist(head, c[c.length - 1]!) <= tolerance) ring = [...c.slice(0, -1), ...ring];
      else if (dist(head, c[0]!) <= tolerance) ring = [...[...c].reverse().slice(0, -1), ...ring];
      else continue;
      chains.splice(i, 1);
      progress = true;
      break;
    }
  }
  return ring;
}

/** Explode a polyline into its segments, or an insert into loose copies. */
export function explodeEntities(doc: DocumentState, ids: readonly EntityId[]): { remove: EntityId[]; create: Entity[] } {
  const remove: EntityId[] = [];
  const create: Entity[] = [];
  let n = 0;
  for (const id of ids) {
    const e = doc.entities.get(id);
    if (!e) continue;
    if (e.kind === "polyline") {
      remove.push(id);
      const count = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < count; i++) {
        n += 1;
        create.push({ ...e, id: `${id}~x${n}`, kind: "line", a: e.points[i]!, b: e.points[(i + 1) % e.points.length]! } as Entity);
      }
    } else if (e.kind === "insert") {
      remove.push(id);
      for (const placed of placedBlockEntities(doc, e)) {
        n += 1;
        create.push({ ...placed, id: `${id}~x${n}` } as Entity);
      }
    }
  }
  return { remove, create };
}

/* ================================================================ DXF */

/**
 * DXF (R2018 / AC1032) in and out.
 *
 * We keep exactly what DraftCheck reads back: entities, layers, linetypes and
 * blocks. A foreign file's unsupported objects are skipped, not corrupting the
 * rest of the file, and a foreign dimension is turned into a plain dimension
 * measuring the two points it stored.
 */
export interface DxfWriteOptions {
  /** Layer table, linetype table, header vars. Off gives a bare ENTITIES section. */
  readonly includeHeader?: boolean;
  /** DXF version; R12 (AC1009) is the safe one for old readers. */
  readonly version?: "R12" | "R2018";
}

const DXF_LINETYPE_NAMES: Readonly<Record<Linetype, string>> = {
  continuous: "CONTINUOUS",
  dashed: "DASHED",
  dotted: "DOT",
  dashdot: "DASHDOT",
  center: "CENTER",
};

function fromDxfLinetype(name: string): Linetype {
  const upper = name.toUpperCase().replace(/^.*\$/, "");
  if (upper.startsWith("DASHED") || upper.includes("HIDDEN")) return "dashed";
  if (upper.startsWith("DOT") || upper === "DOTTED") return "dotted";
  if (upper.includes("DASHDOT")) return "dashdot";
  if (upper.includes("CENTER")) return "center";
  return "continuous";
}

function writePair(out: string[], code: number, value: string | number): void {
  out.push(String(code), typeof value === "number" ? (code >= 60 && code <= 70 ? String(Math.round(value)) : formatDxf(value)) : value);
}

function colorToDxf(color: number): string {
  return colorToHex(color);
}

export function writeDxf(doc: DocumentState, options: DxfWriteOptions = {}): string {
  const version = options.version ?? "R2018";
  const out: string[] = [];
  const includeHeader = options.includeHeader ?? true;
  if (includeHeader) {
    if (version === "R12") {
      writePair(out, 0, "SECTION");
      writePair(out, 2, "HEADER");
      writePair(out, 9, "$ACADVER");
      writePair(out, 1, "AC1009");
      writePair(out, 9, "$INSUNITS");
      writePair(out, 70, unitToDxfInsunits(doc.units));
      writePair(out, 0, "ENDSEC");
      writePair(out, 0, "SECTION");
      writePair(out, 2, "TABLES");
      writeTable(out, "LTYPE", [...doc.layers.values()].map((l) => DXF_LINETYPE_NAMES[l.linetype]).filter((v, i, a) => a.indexOf(v) === i).map((name) => ({ name })), 70);
      writeLayersTable(out, doc, true);
      writePair(out, 0, "ENDSEC");
    } else {
      writePair(out, 0, "SECTION");
      writePair(out, 2, "HEADER");
      writePair(out, 9, "$ACADVER");
      writePair(out, 1, "AC1032");
      writePair(out, 9, "$INSUNITS");
      writePair(out, 70, unitToDxfInsunits(doc.units));
      writePair(out, 9, "$LTSCALE");
      writePair(out, 40, doc.ltscale);
      writePair(out, 9, "$DIMTXT");
      writePair(out, 40, doc.dimStyle.textHeight);
      writePair(out, 9, "$DIMASZ");
      writePair(out, 40, doc.dimStyle.arrowSize);
      writePair(out, 9, "$DIMDEC");
      writePair(out, 70, doc.dimStyle.decimals);
      writePair(out, 9, "$DIMPOST");
      writePair(out, 1, `${doc.dimStyle.prefix}<>${doc.dimStyle.suffix}`);
      writePair(out, 9, "$MEASUREMENT");
      writePair(out, 70, doc.units === "in" || doc.units === "ft" ? 0 : 1);
      writePair(out, 9, "$LUNITS");
      writePair(out, 70, doc.units === "in" || doc.units === "ft" ? 4 : 2);
      writePair(out, 0, "ENDSEC");
      writePair(out, 0, "SECTION");
      writePair(out, 2, "CLASSES");
      writePair(out, 0, "ENDSEC");
      writePair(out, 0, "SECTION");
      writePair(out, 2, "TABLES");
      const usedLinetypes = new Map<string, Linetype>();
      for (const l of doc.layers.values()) usedLinetypes.set(DXF_LINETYPE_NAMES[l.linetype], l.linetype);
      usedLinetypes.set("BYLAYER", "continuous");
      usedLinetypes.set("BYBLOCK", "continuous");
      writeTable(out, "LTYPE", [...usedLinetypes].map(([name, type]) => ({ name, type })), 70);
      writeLayersTable(out, doc, false);
      writeAppId(out, "ACAD");
      writePair(out, 0, "ENDSEC");
    }
    writePair(out, 0, "SECTION");
    writePair(out, 2, "BLOCKS");
    for (const block of doc.blocks.values()) {
      writePair(out, 0, "BLOCK");
      writePair(out, 8, "0");
      writePair(out, 2, block.name);
      writePair(out, 70, 0);
      writePair(out, 10, 0);
      writePair(out, 20, 0);
      writePair(out, 30, 0);
      writePair(out, 3, block.name);
      writePair(out, 1, "");
      for (const id of block.entities) {
        const e = doc.entities.get(id);
        if (e) writeEntity(out, doc, e);
      }
      writePair(out, 0, "ENDBLK");
      writePair(out, 8, "0");
    }
    writePair(out, 0, "ENDSEC");
  }
  writePair(out, 0, "SECTION");
  writePair(out, 2, "ENTITIES");
  for (const id of doc.order) {
    const e = doc.entities.get(id);
    if (e && !e.block) writeEntity(out, doc, e);
  }
  writePair(out, 0, "ENDSEC");
  writePair(out, 0, "EOF");
  return out.join("\r\n") + "\r\n";
}

function writeAppId(out: string[], name: string): void {
  writePair(out, 0, "TABLE");
  writePair(out, 2, "APPID");
  writePair(out, 70, 1);
  writePair(out, 0, "APPID");
  writePair(out, 2, name);
  writePair(out, 70, 0);
  writePair(out, 0, "ENDTAB");
}

function writeTable(out: string[], name: string, rows: readonly { name: string; type?: Linetype }[], _code: number): void {
  writePair(out, 0, "TABLE");
  writePair(out, 2, name);
  writePair(out, 70, rows.length);
  for (const row of rows) {
    writePair(out, 0, name === "LTYPE" ? "LTYPE" : "LAYER");
    writePair(out, 2, row.name);
    writePair(out, 70, 0);
    if (name === "LTYPE" && row.type) {
      const pattern = linetypePattern(row.type);
      writePair(out, 3, row.type === "continuous" ? "Solid line" : `${row.name} ${row.type}`);
      writePair(out, 72, 65);
      writePair(out, 73, pattern.length);
      writePair(out, 40, pattern.reduce((a, b) => a + b, 0));
      for (const d of pattern) writePair(out, 49, d);
    }
  }
  writePair(out, 0, "ENDTAB");
}

function writeLayersTable(out: string[], doc: DocumentState, r12: boolean): void {
  writePair(out, 0, "TABLE");
  writePair(out, 2, "LAYER");
  writePair(out, 70, doc.layers.size);
  for (const layer of doc.layers.values()) {
    writePair(out, 0, "LAYER");
    writePair(out, 2, layer.name);
    // R12 has no visibility flags for layers: frozen/off are the same bit there.
    const flags = (layer.frozen ? 1 : 0) + (layer.locked ? 4 : 0) + (!layer.plot ? 64 : 0);
    writePair(out, 70, flags);
    writePair(out, 62, layer.visible ? 1 : -1);
    writePair(out, 6, DXF_LINETYPE_NAMES[layer.linetype]);
    if (!r12) {
      writePair(out, 370, Math.round(layer.lineweight * 100));
      writePair(out, 390, "0");
    }
    writePair(out, 420, 0x1000000 | layer.color);
  }
  writePair(out, 0, "ENDTAB");
}

function writeCommon(out: string[], doc: DocumentState, e: Entity): string {
  writePair(out, 0, dxfType(e));
  writePair(out, 8, doc.layers.get(e.layer)?.name ?? "0");
  writePair(out, 6, e.linetype === "bylayer" ? "BYLAYER" : DXF_LINETYPE_NAMES[e.linetype]);
  if (e.color === COLOR_BYLAYER) writePair(out, 62, 256);
  else if (e.color === COLOR_BYBLOCK) writePair(out, 62, 0);
  else {
    writePair(out, 62, 256);
    writePair(out, 420, 0x1000000 | e.color);
  }
  if (e.lineweight !== null) writePair(out, 370, Math.round(e.lineweight * 100));
  return e.id;
}

function dxfType(e: Entity): string {
  switch (e.kind) {
    case "line":
      return "LINE";
    case "polyline":
      return "LWPOLYLINE";
    case "circle":
      return "CIRCLE";
    case "arc":
      return "ARC";
    case "spline":
      return "SPLINE";
    case "text":
      return "TEXT";
    case "dimension":
      return "DIMENSION";
    case "hatch":
      return "HATCH";
    case "point":
      return "POINT";
    case "leader":
      return "MULTILEADER";
    case "insert":
      return "INSERT";
    case "section":
      return "POINT";
    default: {
      const never: never = e;
      return never;
    }
  }
}

function writeEntity(out: string[], doc: DocumentState, e: Entity): void {
  const handle = writeCommon(out, doc, e);
  const writeDxfId = (): void => {
    // Handles are optional in DXF; keeping the entity id is how DraftCheck
    // keeps selection and links stable across a save.
    writePair(out, 5, handle.replace(/[^0-9A-Fa-f]/g, "").slice(0, 16).toUpperCase() || "1");
  };
  switch (e.kind) {
    case "line":
      writeDxfId();
      writePair(out, 10, e.a.x);
      writePair(out, 20, e.a.y);
      writePair(out, 30, 0);
      writePair(out, 11, e.b.x);
      writePair(out, 21, e.b.y);
      writePair(out, 31, 0);
      break;
    case "polyline": {
      writeDxfId();
      writePair(out, 90, e.points.length);
      let flags = e.closed ? 1 : 0;
      if (e.points.some((p) => Math.abs(p.x) > 1e9 || Math.abs(p.y) > 1e9)) flags |= 8;
      writePair(out, 70, flags);
      writePair(out, 43, 0);
      e.points.forEach((p, i) => {
        writePair(out, 10, p.x);
        writePair(out, 20, p.y);
        const bulge = e.bulges?.[i] ?? 0;
        if (bulge !== 0) writePair(out, 42, bulge);
      });
      break;
    }
    case "circle":
      writeDxfId();
      writePair(out, 10, e.center.x);
      writePair(out, 20, e.center.y);
      writePair(out, 30, 0);
      writePair(out, 40, e.radius);
      break;
    case "arc":
      writeDxfId();
      writePair(out, 10, e.center.x);
      writePair(out, 20, e.center.y);
      writePair(out, 30, 0);
      writePair(out, 40, e.radius);
      writePair(out, 50, (e.start * 180) / Math.PI);
      writePair(out, 51, (e.end * 180) / Math.PI);
      break;
    case "spline": {
      writeDxfId();
      writePair(out, 70, (e.closed ? 1 : 0) | 8);
      writePair(out, 71, e.degree);
      writePair(out, 72, 0);
      writePair(out, 73, e.points.length);
      writePair(out, 74, 0);
      e.points.forEach((p) => {
        writePair(out, 10, p.x);
        writePair(out, 20, p.y);
        writePair(out, 30, 0);
      });
      break;
    }
    case "text":
      writeDxfId();
      writePair(out, 10, e.align === "left" ? e.at.x : e.at.x);
      writePair(out, 20, e.at.y);
      writePair(out, 30, 0);
      writePair(out, 40, e.height);
      writePair(out, 1, e.value);
      writePair(out, 50, (e.rotation * 180) / Math.PI);
      writePair(out, 72, e.align === "left" ? 0 : e.align === "center" ? 1 : 2);
      writePair(out, 11, e.at.x);
      writePair(out, 21, e.at.y);
      writePair(out, 31, 0);
      break;
    case "dimension": {
      const g = dimensionGeometry(e);
      writeDxfId();
      writePair(out, 2, "DIMBLOCK");
      writePair(out, 3, "STANDARD");
      // 70: 32 (block reference) | 1 (aligned for rotated text) | 0 linear.
      writePair(out, 70, e.dim === "linear" ? 32 : e.dim === "aligned" ? 33 : e.dim === "angular" ? 34 : e.dim === "radius" ? 36 : e.dim === "diameter" ? 37 : 32);
      writePair(out, 10, e.at.x);
      writePair(out, 20, e.at.y);
      writePair(out, 30, 0);
      writePair(out, 11, g.textAt.x);
      writePair(out, 21, g.textAt.y);
      writePair(out, 31, 0);
      writePair(out, 13, e.p1.x);
      writePair(out, 23, e.p1.y);
      writePair(out, 33, 0);
      writePair(out, 14, e.p2.x);
      writePair(out, 24, e.p2.y);
      writePair(out, 34, 0);
      writePair(out, 15, e.vertex?.x ?? e.p1.x);
      writePair(out, 25, e.vertex?.y ?? e.p1.y);
      writePair(out, 35, 0);
      if (e.textOverride.trim() !== "") writePair(out, 1, e.textOverride);
      writePair(out, 42, e.textHeight);
      writePair(out, 41, e.arrowSize);
      writePair(out, 71, 5);
      writePair(out, 12, 0);
      writePair(out, 22, 0);
      writePair(out, 72, 1);
      writePair(out, 40, 0);
      writePair(out, 6, DXF_LINETYPE_NAMES["continuous"]);
      break;
    }
    case "hatch": {
      writeDxfId();
      writePair(out, 5, handle.replace(/[^0-9A-Fa-f]/g, "").toUpperCase().slice(0, 16) || "1");
      writePair(out, 10, 0);
      writePair(out, 20, 0);
      writePair(out, 30, 0);
      writePair(out, 210, 0);
      writePair(out, 220, 0);
      writePair(out, 230, 1);
      writePair(out, 2, e.solid ? "SOLID" : e.pattern);
      writePair(out, 70, e.solid ? 1 : 0);
      writePair(out, 71, 1);
      writePair(out, 91, e.rings.length);
      // Path flag 1: external. Islands are flagged 16 so a reader sees islands.
      e.rings.forEach((ring, i) => {
        writePair(out, 92, i === 0 ? 1 : 16);
        writePair(out, 93, ring.length);
        writePair(out, 72, 0);
        writePair(out, 73, 1);
        for (const p of ring) {
          writePair(out, 10, p.x);
          writePair(out, 20, p.y);
          writePair(out, 42, 0);
        }
        writePair(out, 97, 0);
      });
      writePair(out, 75, 0);
      writePair(out, 76, e.solid ? 1 : 0);
      if (!e.solid) {
        writePair(out, 52, (e.angle * 180) / Math.PI);
        writePair(out, 41, e.scale);
        writePair(out, 98, 0);
      }
      break;
    }
    case "point":
      writeDxfId();
      writePair(out, 10, e.at.x);
      writePair(out, 20, e.at.y);
      writePair(out, 30, 0);
      break;
    case "leader":
      writeDxfId();
      writePair(out, 3, "STANDARD");
      writePair(out, 90, e.points.length);
      for (const p of e.points) {
        writePair(out, 10, p.x);
        writePair(out, 20, p.y);
        writePair(out, 30, 0);
      }
      break;
    case "insert": {
      writeDxfId();
      writePair(out, 2, doc.blocks.get(e.block)?.name ?? "MISSING");
      writePair(out, 10, e.at.x);
      writePair(out, 20, e.at.y);
      writePair(out, 30, 0);
      writePair(out, 41, e.scaleX);
      writePair(out, 42, e.scaleY);
      writePair(out, 43, 1);
      writePair(out, 50, (e.rotation * 180) / Math.PI);
      if (e.columns > 1 || e.rows > 1) {
        writePair(out, 70, 2);
        writePair(out, 71, e.columns);
        writePair(out, 44, e.columnSpacing);
        writePair(out, 45, e.rowSpacing);
      }
      break;
    }
    case "section":
      writeDxfId();
      writePair(out, 10, e.a.x);
      writePair(out, 20, e.a.y);
      writePair(out, 30, 0);
      break;
    default: {
      const never: never = e;
      return never;
    }
  }
}

export function unitToDxfInsunits(unit: Unit): number {
  switch (unit) {
    case "in":
      return 1;
    case "ft":
      return 2;
    case "mm":
      return 4;
    case "cm":
      return 5;
    case "m":
      return 6;
    default: {
      const never: never = unit;
      return never;
    }
  }
}

export function dxfInsunitsToUnit(code: number): Unit | null {
  switch (code) {
    case 1:
      return "in";
    case 2:
      return "ft";
    case 4:
      return "mm";
    case 5:
      return "cm";
    case 6:
      return "m";
    default:
      return null;
  }
}

/* ----------------------------------------------------------- DXF in */

export interface DxfReadResult {
  readonly doc: DocumentState;
  /** Objects skipped (unsupported) with their DXF type, reported, never silent. */
  readonly skipped: readonly string[];
}

interface DxfPair {
  readonly code: number;
  readonly value: string;
}

/** Split a DXF text into (code, value) pairs; tolerates CRLF and trailing junk. */
export function parseDxfPairs(text: string): DxfPair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isFinite(code) || lines[i]!.trim() === "") continue;
    pairs.push({ code, value: lines[i + 1] ?? "" });
  }
  return pairs;
}

export function readDxf(text: string, idPrefix = "d"): DxfReadResult {
  const pairs = parseDxfPairs(text);
  const layers = new Map<LayerId, Layer>();
  let ltscale = 1;
  let dimStyle: DimStyle = DEFAULT_DIM_STYLE;
  const blocks = new Map<BlockId, BlockDef>();
  const entities = new Map<EntityId, Entity>();
  const order: EntityId[] = [];
  const skipped: string[] = [];
  const blockEntityIds = new Map<string, EntityId[]>();
  let units: Unit = "mm";
  let i = 0;
  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `${idPrefix}${seq}`;
  };
  let section = "";
  let currentLayer = "0";
  let block: { name: string; entities: EntityId[] } | null = null;
  let lastEntity: Entity | null = null;

  const readPairs = (until: (p: DxfPair) => boolean): DxfPair[] => {
    const out: DxfPair[] = [];
    while (i < pairs.length && !until(pairs[i]!)) {
      out.push(pairs[i]!);
      i += 1;
    }
    return out;
  };
  const one = (list: readonly DxfPair[], code: number): string | undefined => list.find((p) => p.code === code)?.value;
  const num = (list: readonly DxfPair[], code: number, fallback = 0): number => {
    const v = one(list, code);
    const n = v === undefined ? NaN : Number(v.trim());
    return Number.isFinite(n) ? n : fallback;
  };
  const colorOf = (list: readonly DxfPair[]): number => {
    const rgb = one(list, 420);
    if (rgb !== undefined) {
      const n = Number(rgb.trim());
      if (Number.isFinite(n)) return n & 0xffffff;
    }
    const aci = num(list, 62, 256);
    return aci === 256 ? COLOR_BYLAYER : aci === 0 ? COLOR_BYBLOCK : aciColor(aci);
  };

  while (i < pairs.length) {
    const p = pairs[i]!;
    i += 1;
    if (p.code !== 0) continue;
    const type = p.value.trim();
    if (type === "SECTION") {
      section = (pairs[i]?.value ?? "").trim();
      i += 1;
      continue;
    }
    if (type === "ENDSEC") {
      section = "";
      continue;
    }
    if (type === "EOF") break;
    if (section === "HEADER") {
      if (type === "9") {
        const name = (pairs[i]?.value ?? "").trim();
        i += 1;
        if (name === "$INSUNITS") {
          const code = num(pairs.slice(i, i + 1), 70, 0);
          const unit = dxfInsunitsToUnit(code);
          if (unit) units = unit;
        }
        if (name === "$LTSCALE") {
          const scale = num(pairs.slice(i, i + 1), 40);
          if (scale > 0) ltscale = scale;
        }
        if (name === "$DIMTXT") dimStyle = { ...dimStyle, textHeight: num(pairs.slice(i, i + 1), 40, dimStyle.textHeight) };
        if (name === "$DIMASZ") dimStyle = { ...dimStyle, arrowSize: num(pairs.slice(i, i + 1), 40, dimStyle.arrowSize) };
        if (name === "$DIMDEC") dimStyle = { ...dimStyle, decimals: num(pairs.slice(i, i + 1), 70, dimStyle.decimals) };
      }
      continue;
    }
    if (section === "TABLES") {
      if (type === "TABLE") {
        const tableName = (pairs[i]?.value ?? "").trim();
        i += 1;
        if (tableName === "LAYER") {
          for (;;) {
            const row = pairs[i];
            if (!row || (row.value.trim() !== "LAYER" && row.code === 0)) break;
            i += 1;
            const body = readPairs((q) => q.code === 0);
            const name = one(body, 2)?.trim() || "0";
            const flags = num(body, 70, 0);
            const colorAci = num(body, 62, 7);
            const rgb = one(body, 420);
            const linetype = fromDxfLinetype(one(body, 6) ?? "CONTINUOUS");
            const layer: Layer = {
              id: name,
              name,
              color: rgb !== undefined ? Number(rgb) & 0xffffff : aciColor(Math.abs(colorAci)),
              linetype,
              lineweight: num(body, 370, 25) / 100,
              visible: colorAci >= 0,
              locked: (flags & 4) !== 0,
              frozen: (flags & 1) !== 0,
              plot: (flags & 64) === 0,
            };
            layers.set(name, layer);
          }
        } else {
          // Skip any other table wholesale, row by row.
          readPairs((q) => q.code === 0 && q.value.trim() === "ENDTAB");
        }
        continue;
      }
      continue;
    }
    if (section === "BLOCKS") {
      if (type === "BLOCK") {
        // The block header runs until the first 0; entity pairs follow it.
        const header = readPairs((q) => q.code === 0);
        const name = one(header, 2)?.trim() || `*anon${blocks.size + 1}`;
        block = { name, entities: [] };
        blockEntityIds.set(name, block.entities);
        continue;
      }
      if (type === "ENDBLK") {
        readPairs((q) => q.code === 0);
        if (block) {
          const id = `b${blocks.size + 1}`;
          const entityIds = block.entities.map((eid) => eid);
          const name = block.name;
          const defEntities = entityIds.map((eid) => {
            const e = entities.get(eid)!;
            const withoutBlock: Entity = { ...e, id: nextId(), block: id };
            entities.set(withoutBlock.id, withoutBlock);
            return withoutBlock.id;
          });
          blocks.set(id, { id, name, entities: defEntities });
        }
        block = null;
        continue;
      }
    }
    if (section === "ENTITIES" || (section === "BLOCKS" && block)) {
      const body = readPairs((q) => q.code === 0);
      const layerName = one(body, 8)?.trim() || "0";
      const layer = layers.get(layerName) ?? { id: layerName, name: layerName, color: 0xffffff, linetype: "continuous" as Linetype, lineweight: 0.25, visible: true, locked: false, frozen: false, plot: true };
      if (!layers.has(layerName)) layers.set(layerName, layer);
      const common: EntityBase = {
        id: nextId(),
        layer: layerName,
        color: colorOf(body),
        linetype: fromDxfLinetype(one(body, 6) ?? "BYLAYER") === "continuous" && (one(body, 6) ?? "BYLAYER").toUpperCase() === "BYLAYER" ? "bylayer" : fromDxfLinetype(one(body, 6) ?? "BYLAYER"),
        lineweight: one(body, 370) !== undefined ? num(body, 370, 25) / 100 : null,
      };
      let entity: Entity | null = null;
      switch (type) {
        case "LINE":
          entity = { ...common, kind: "line", a: pt(num(body, 10), num(body, 20)), b: pt(num(body, 11), num(body, 21)) };
          break;
        case "LWPOLYLINE": {
          const xs = body.filter((q) => q.code === 10).map((q) => Number(q.value));
          const ys = body.filter((q) => q.code === 20).map((q) => Number(q.value));
          const bulges = body.filter((q) => q.code === 42).map((q) => Number(q.value));
          const points = xs.map((x, k) => pt(x, ys[k] ?? 0));
          const flags = num(body, 70, 0);
          entity = { ...common, kind: "polyline", points, closed: (flags & 1) !== 0, ...(bulges.some((b) => b !== 0) ? { bulges } : {}) };
          break;
        }
        case "POLYLINE": {
          const flags = num(body, 70, 0);
          const points: Pt[] = [];
          const bulges: number[] = [];
          for (;;) {
            const v = pairs[i];
            if (!v) break;
            if (v.code === 0 && v.value.trim() === "VERTEX") {
              i += 1;
              const vb = readPairs((q) => q.code === 0);
              points.push(pt(num(vb, 10), num(vb, 20)));
              bulges.push(num(vb, 42, 0));
              continue;
            }
            break;
          }
          if (pairs[i]?.code === 0 && pairs[i]?.value.trim() === "SEQEND") {
            i += 1;
            readPairs((q) => q.code === 0);
          }
          entity = { ...common, kind: "polyline", points, closed: (flags & 1) !== 0, ...(bulges.some((b) => b !== 0) ? { bulges } : {}) };
          break;
        }
        case "CIRCLE":
          entity = { ...common, kind: "circle", center: pt(num(body, 10), num(body, 20)), radius: num(body, 40, 1) };
          break;
        case "ARC": {
          const s = (num(body, 50) * Math.PI) / 180;
          const e = (num(body, 51) * Math.PI) / 180;
          entity = { ...common, kind: "arc", center: pt(num(body, 10), num(body, 20)), radius: num(body, 40, 1), start: s, end: e };
          break;
        }
        case "SPLINE": {
          const xs = body.filter((q) => q.code === 10).map((q) => Number(q.value));
          const ys = body.filter((q) => q.code === 20).map((q) => Number(q.value));
          const points = xs.map((x, k) => pt(x, ys[k] ?? 0));
          const degree = Math.max(1, num(body, 71, 3));
          if (points.length >= degree + 1) entity = { ...common, kind: "spline", points, degree, closed: (num(body, 70, 0) & 1) !== 0 };
          else skipped.push("SPLINE (too few control points)");
          break;
        }
        case "TEXT":
        case "MTEXT": {
          const value = (one(body, 1) ?? "").replace(/\\[A-Za-z][^;]*;/g, "");
          const alignCode = num(body, 72, 0);
          entity = {
            ...common,
            kind: "text",
            at: pt(num(body, 10), num(body, 20)),
            height: num(body, 40, 2.5),
            value,
            rotation: (num(body, 50) * Math.PI) / 180,
            align: type === "MTEXT" ? "left" : alignCode === 1 ? "center" : alignCode === 2 ? "right" : "left",
          };
          break;
        }
        case "POINT":
          entity = { ...common, kind: "point", at: pt(num(body, 10), num(body, 20)) };
          break;
        case "DIMENSION": {
          const kindFlag = num(body, 70, 0) & 7;
          const kind: DimKind = kindFlag === 1 ? "aligned" : kindFlag === 2 ? "angular" : kindFlag === 3 ? "diameter" : kindFlag === 4 ? "radius" : kindFlag === 6 ? "ordinate" : "linear";
          entity = {
            ...common,
            kind: "dimension",
            dim: kind,
            p1: pt(num(body, 13), num(body, 23)),
            p2: pt(num(body, 14), num(body, 24)),
            at: pt(num(body, 11) || num(body, 10), num(body, 21) || num(body, 20)),
            vertex: pt(num(body, 15), num(body, 25)),
            textHeight: num(body, 42, 2.5) || 2.5,
            arrowSize: num(body, 41, 2.5) || 2.5,
            decimals: 1,
            textOverride: one(body, 1)?.trim() ?? "",
          };
          if (kind !== "angular") {
            const { vertex: _drop, ...rest } = entity as Extract<Entity, { kind: "dimension" }>;
            entity = rest as Entity;
          }
          break;
        }
        case "HATCH": {
          // Boundary paths: 91 count, then per path 92 flag, 93 vertex count.
          const rings: Pt[][] = [];
          let k = 0;
          while (k < body.length) {
            if (body[k]!.code === 93) {
              const count = Number(body[k]!.value);
              k += 1;
              const ring: Pt[] = [];
              let seen = 0;
              while (k < body.length && seen < count) {
                const x = body[k]!;
                if (x.code === 10) {
                  const y = body[k + 1];
                  ring.push(pt(Number(x.value), Number(y?.code === 20 ? y.value : 0)));
                  k += 2;
                  seen += 1;
                } else if (x.code === 42) {
                  k += 1;
                } else {
                  k += 1;
                }
              }
              if (ring.length >= 3) rings.push(ring);
              continue;
            }
            k += 1;
          }
          const pattern = one(body, 2)?.trim() ?? "SOLID";
          if (rings.length) entity = { ...common, kind: "hatch", rings, pattern, solid: pattern.toUpperCase() === "SOLID", scale: num(body, 41, 1), angle: (num(body, 52) * Math.PI) / 180 };
          else skipped.push("HATCH (no boundary)");
          break;
        }
        case "INSERT": {
          const blockName = (one(body, 2) ?? "").trim();
          let found: BlockDef | undefined;
          for (const b of blocks.values()) if (b.name.toLowerCase() === blockName.toLowerCase()) found = b;
          if (found) {
            entity = {
              ...common,
              kind: "insert",
              block: found.id,
              at: pt(num(body, 10), num(body, 20)),
              scaleX: num(body, 41, 1) || 1,
              scaleY: num(body, 42, 1) || 1,
              rotation: (num(body, 50) * Math.PI) / 180,
              columns: Math.max(1, num(body, 71, 1)),
              rows: Math.max(1, num(body, 70) === 2 || num(body, 70) === 1 ? num(body, 70) === 1 ? 1 : num(body, 71, 1) : num(body, 71, 1)),
              columnSpacing: num(body, 44, 0),
              rowSpacing: num(body, 45, 0),
            };
          } else skipped.push(`INSERT (block ${blockName} missing)`);
          break;
        }
        case "LEADER":
        case "MULTILEADER": {
          const xs = body.filter((q) => q.code === 10).map((q) => Number(q.value));
          const ys = body.filter((q) => q.code === 20).map((q) => Number(q.value));
          const points = xs.map((x, k2) => pt(x, ys[k2] ?? 0));
          if (points.length >= 2) entity = { ...common, kind: "leader", points, text: one(body, 1) ?? "", textHeight: 2.5, shelf: 0.25 };
          else skipped.push(type);
          break;
        }
        default:
          skipped.push(type);
          break;
      }
      if (entity) {
        entities.set(entity.id, entity);
        if (block && section === "BLOCKS") block.entities.push(entity.id);
        else order.push(entity.id);
        lastEntity = entity;
      }
      void lastEntity;
      continue;
    }
    // Unknown section: walk it to ENDSEC so a stray object cannot derail the parser.
    if (section === "" && type !== "ENDTAB" && type !== "TABLE") readPairs((q) => q.code === 0 && q.value.trim() === "ENDSEC");
  }
  if (!layers.has("0")) layers.set("0", { ...(layers.values().next().value ?? { id: "0", name: "0", color: 0xffffff, linetype: "continuous" as Linetype, lineweight: 0.25, visible: true, locked: false, frozen: false, plot: true }) });
  const finalDoc: DocumentState = { ...emptyDocument(units), units, layers, blocks, entities, order, ltscale, dimStyle, currentLayer: layerByNameOf(layers, "0") };
  void currentLayer;
  return { doc: finalDoc, skipped };
}

function layerByNameOf(layers: ReadonlyMap<LayerId, Layer>, name: string): LayerId {
  for (const l of layers.values()) if (l.name.toLowerCase() === name.toLowerCase()) return l.id;
  return layers.keys().next().value ?? "0";
}

/** AutoCAD Colour Index -> RGB, the 256-entry palette in its classic form. */
export function aciColor(index: number): number {
  const table: readonly string[] = [
    "#000000", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff",
    "#808080", "#808000", "#008080", "#000080", "#800080", "#7f7f7f", "#bfbfbf", "#c0c0c0",
  ];
  if (index >= 1 && index <= 15) return hexToColor(table[index]!);
  if (index === 7) return 0x000000;
  if (index >= 10 && index < 250) {
    const n = index - 10;
    const steps = [0, 51, 102, 153, 204, 255];
    const r = steps[Math.floor(n / 36) % 6]!;
    const g = steps[Math.floor(n / 6) % 6]!;
    const b = steps[n % 6]!;
    return (r << 16) | (g << 8) | b;
  }
  return 0xffffff;
}

/* ========================================================== project file */

export interface ProjectFile {
  readonly format: "draftcheck";
  readonly schemaVersion: number;
  readonly units: Unit;
  readonly entities: readonly Entity[];
  readonly order: readonly EntityId[];
  readonly layers: readonly Layer[];
  readonly currentLayer: LayerId;
  readonly blocks: readonly BlockDef[];
  readonly ltscale: number;
  readonly dimStyle: DimStyle;
  readonly params: readonly (readonly [string, number])[];
  readonly sheets: readonly Sheet[];
  readonly paper: boolean;
  readonly history: readonly string[];
  /** Solver links, so a reopened file keeps driving dimensions. */
  readonly links: { readonly offsets: readonly (readonly [EntityId, { source: EntityId; distance: number }])[]; readonly dims: readonly (readonly [EntityId, { param: string; mode: "drive" | "driven" }])[] };
}

export function serializeProject(doc: DocumentState): ProjectFile {
  return {
    format: "draftcheck",
    schemaVersion: doc.schemaVersion,
    units: doc.units,
    entities: [...doc.entities.values()],
    order: doc.order,
    layers: [...doc.layers.values()],
    currentLayer: doc.currentLayer,
    blocks: [...doc.blocks.values()],
    ltscale: doc.ltscale,
    dimStyle: doc.dimStyle,
    params: [...doc.params],
    sheets: doc.sheets,
    paper: doc.paper,
    history: doc.history,
    links: { offsets: [...perpendicularLinks], dims: [...dimensionParams] },
  };
}

export function serializeProjectJson(doc: DocumentState): string {
  return JSON.stringify(serializeProject(doc), null, 1) + "\n";
}

type Raw = Record<string, unknown>;

/** Forward-only migrations. Version 1 is the first shipped file. */
const PROJECT_MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  1: (raw) => ({ ...raw, schemaVersion: 2 }),
};

export function deserializeProject(raw: unknown): DocumentState {
  if (typeof raw !== "object" || raw === null) throw new RangeError("project: not an object");
  let data = raw as Raw;
  if (data.format !== "draftcheck") throw new RangeError("project: not a DraftCheck file");
  let version = Number(data.schemaVersion ?? 0);
  if (!Number.isFinite(version) || version < 1) throw new RangeError(`project: bad schemaVersion ${String(data.schemaVersion)}`);
  while (version < SCHEMA_VERSION) {
    const step = PROJECT_MIGRATIONS[version];
    if (!step) throw new RangeError(`project: no migration from version ${version}`);
    data = step(data);
    version = Number(data.schemaVersion);
  }
  if (version > SCHEMA_VERSION) throw new RangeError(`project: version ${version} is newer than this build (${SCHEMA_VERSION})`);
  const layers = new Map<LayerId, Layer>();
  for (const l of (data.layers as Layer[] | undefined) ?? []) {
    if (!l || typeof l.id !== "string") throw new RangeError("project: bad layer");
    layers.set(l.id, l);
  }
  if (!layers.has("0")) layers.set("0", emptyDocument().layers.get("0")!);
  const entities = new Map<EntityId, Entity>();
  for (const e of (data.entities as Entity[] | undefined) ?? []) {
    if (!e || typeof e.id !== "string" || typeof e.kind !== "string") throw new RangeError("project: bad entity");
    entities.set(e.id, e);
  }
  const blocks = new Map<BlockId, BlockDef>();
  for (const b of (data.blocks as BlockDef[] | undefined) ?? []) blocks.set(b.id, b);
  const order = ((data.order as EntityId[] | undefined) ?? []).filter((id) => entities.has(id));
  const units = (data.units as Unit | undefined) ?? "mm";
  const doc: DocumentState = {
    schemaVersion: SCHEMA_VERSION,
    units: UNITS[units] ? units : "mm",
    entities,
    order: order.length ? order : [...entities.keys()],
    layers,
    currentLayer: typeof data.currentLayer === "string" && layers.has(data.currentLayer) ? data.currentLayer : "0",
    blocks,
    ltscale: typeof data.ltscale === "number" && data.ltscale > 0 ? data.ltscale : 1,
    dimStyle: (data.dimStyle as DimStyle | undefined) ?? DEFAULT_DIM_STYLE,
    params: new Map((data.params as [string, number][] | undefined) ?? []),
    sheets: (data.sheets as Sheet[] | undefined) ?? [],
    paper: data.paper === true,
    history: (data.history as string[] | undefined) ?? [],
  };
  const links = data.links as ProjectFile["links"] | undefined;
  perpendicularLinks.clear();
  dimensionParams.clear();
  for (const [id, link] of links?.offsets ?? []) if (entities.has(id)) perpendicularLinks.set(id, link);
  for (const [id, link] of links?.dims ?? []) if (entities.has(id)) dimensionParams.set(id, link);
  return doc;
}

export function deserializeProjectText(text: string): DocumentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RangeError("project: not valid JSON");
  }
  return deserializeProject(parsed);
}

/* ==================================================== reports */

export interface ContractRow {
  readonly kind: "area" | "length" | "count" | "volume";
  readonly layer: string;
  readonly name: string;
  readonly total: number;
  readonly unit: string;
}

/** Quantity take-off: closed polylines contribute area, open ones length. */
export function contractRows(doc: DocumentState): ContractRow[] {
  const rows = new Map<string, ContractRow>();
  const put = (kind: ContractRow["kind"], layer: string, name: string, value: number, unit: string): void => {
    const key = `${kind}|${layer}|${name}`;
    const prev = rows.get(key);
    rows.set(key, prev ? { ...prev, total: prev.total + value } : { kind, layer, name, total: value, unit });
  };
  for (const e of doc.entities.values()) {
    const layerName = doc.layers.get(e.layer)?.name ?? "0";
    switch (e.kind) {
      case "polyline": {
        const area = Math.abs(signedArea(e.points));
        const perimeter = e.points.reduce((sum, p, i) => (i === 0 ? 0 : sum + dist(p, e.points[i - 1]!)), 0) + (e.closed ? dist(e.points[e.points.length - 1]!, e.points[0]!) : 0);
        if (e.closed && area > 1e-9) {
          put("area", layerName, "Closed polyline", area, "mm2");
          put("length", layerName, "Closed polyline", perimeter, "mm");
        } else {
          put("length", layerName, "Polyline", perimeter, "mm");
        }
        put("count", layerName, "Polyline", 1, "ea");
        break;
      }
      case "line":
        put("length", layerName, "Line", dist(e.a, e.b), "mm");
        put("count", layerName, "Line", 1, "ea");
        break;
      case "circle":
        put("area", layerName, "Circle", Math.PI * e.radius * e.radius, "mm2");
        put("length", layerName, "Circle", 2 * Math.PI * e.radius, "mm");
        put("count", layerName, "Circle", 1, "ea");
        break;
      case "arc":
        put("count", layerName, "Arc", 1, "ea");
        break;
      case "text":
        put("count", layerName, "Text", 1, "ea");
        break;
      case "insert": {
        const name = doc.blocks.get(e.block)?.name ?? "?";
        put("count", layerName, name, Math.max(1, e.columns) * Math.max(1, e.rows), "ea");
        break;
      }
      default:
        break;
    }
  }
  return [...rows.values()].map((r) => ({ ...r, total: Math.round(r.total * 1000) / 1000 }));
}

export function contractCsv(rows: readonly ContractRow[]): string {
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["kind,layer,name,total,unit", ...rows.map((r) => [r.kind, r.layer, r.name, String(r.total), r.unit].map(esc).join(","))].join("\n") + "\n";
}

/** One-page Markdown summary of a drawing, for handover notes. */
export function drawingMarkdown(doc: DocumentState): string {
  const rows = contractRows(doc);
  const lines: string[] = [];
  lines.push("# Drawing contract", "");
  lines.push(`- Units: ${doc.units}`);
  lines.push(`- Entities: ${doc.entities.size}`);
  lines.push(`- Layers: ${doc.layers.size}`);
  lines.push(`- Blocks: ${doc.blocks.size}`);
  lines.push("");
  lines.push("| Kind | Layer | Name | Total | Unit |");
  lines.push("|---|---|---|---|---|");
  for (const r of rows) lines.push(`| ${r.kind} | ${r.layer} | ${r.name} | ${r.total} | ${r.unit} |`);
  return lines.join("\n") + "\n";
}

export { emptyDocument as emptyDocumentState };

/* ============================================================= fit */

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "on-edge" | "perpendicular" | "nearest" | "intersection" | "axis" | "grid" | "none";

export interface SnapResult {
  readonly point: Pt;
  readonly kind: SnapKind;
  /** Axis the pointer is locked to, if any (ortho). */
  readonly axis: "x" | "y" | null;
  /** The entity the snap belongs to. */
  readonly entity: EntityId | null;
}

export interface FitOptions {
  /** Screen-pixel pick radius converted to mm by the shell. */
  readonly tolerance: number;
  /** Ortho: lock the point to the horizontal or vertical through `from`. */
  readonly from?: Pt;
  readonly ortho?: boolean;
  readonly objectSnap?: boolean;
  readonly grid?: number;
}

/**
 * Fit a raw pointer position to the drawing: object snaps win over ortho, ortho
 * wins over the grid. Every tool calls this, so all tools snap the same way.
 */
export function fitPointer(doc: DocumentState, raw: Pt, options: FitOptions): SnapResult {
  const tol = Math.max(1e-6, options.tolerance);
  if (options.objectSnap !== false) {
    const hits = snapCandidates(doc, raw, tol);
    if (hits.length > 0) {
      const best = hits[0]!;
      const kind: SnapKind = best.snap === "on" ? "on-edge" : best.snap;
      return { point: best.point, kind, axis: null, entity: best.id };
    }
    const pick = pickEntity(doc, raw, tol);
    if (pick) return { point: pick.point, kind: pick.snap === "endpoint" ? "endpoint" : pick.snap === "midpoint" ? "midpoint" : "on-edge", axis: null, entity: pick.id };
  }
  if (options.ortho && options.from) {
    const d = sub(raw, options.from);
    const point = Math.abs(d.x) >= Math.abs(d.y) ? pt(raw.x, options.from.y) : pt(options.from.x, raw.y);
    return { point, kind: "axis", axis: Math.abs(d.x) >= Math.abs(d.y) ? "x" : "y", entity: null };
  }
  if (options.grid && options.grid > 0) {
    return { point: pt(Math.round(raw.x / options.grid) * options.grid, Math.round(raw.y / options.grid) * options.grid), kind: "grid", axis: null, entity: null };
  }
  return { point: raw, kind: "none", axis: null, entity: null };
}

/** Axis-lock bands for polar tracking at 15 degrees, shown by the shell. */
export function polarTrack(from: Pt, raw: Pt, stepDegrees = 15): { point: Pt; angle: number } {
  const d = sub(raw, from);
  const len = length(d);
  const step = (stepDegrees * Math.PI) / 180;
  const snapped = Math.round(angleOf(d) / step) * step;
  return { point: add(from, pt(Math.cos(snapped) * len, Math.sin(snapped) * len)), angle: snapped };
}

/* ======================================================= text metrics */

/**
 * Approximate advance width of a text run, in multiples of its height.
 * The shell draws text with the browser's own metrics; this is for layout
 * maths (centring a label, sizing a hatched callout) where 2% is invisible.
 */
export function textWidth(value: string, height: number): number {
  let units = 0;
  for (const ch of value) {
    if (ch === " ") units += 0.33;
    else if (".:,;'|!iIl".includes(ch)) units += 0.28;
    else if ("MW@".includes(ch)) units += 0.95;
    else if ("mw".includes(ch)) units += 0.8;
    else if (/[0-9]/.test(ch)) units += 0.56;
    else if (ch >= "A" && ch <= "Z") units += 0.68;
    else units += 0.55;
  }
  return units * height;
}

/* ===================================================== plotting */

export interface PlotOptions {
  /** Millimetres per model unit on paper: 0.02 means 1:50. */
  readonly scale: number;
  readonly paper: { readonly width: number; readonly height: number };
  /** Model extent to fit: the drawing's bounds. */
  readonly window: Bounds;
  /** Rotation in quarter turns. */
  readonly rotate?: 0 | 1 | 2 | 3;
  readonly margin?: number;
}

/**
 * Where model space maps on paper. The plot pipeline (F-30) uses exactly this
 * mapping for SVG and PDF, so what is previewed is what is plotted.
 */
export function plotTransform(options: PlotOptions): { readonly a: number; readonly c: number; readonly e: number; readonly f: number; readonly tl: Pt } {
  const margin = options.margin ?? 10;
  const pw = (options.paper.width - margin * 2);
  const ph = (options.paper.height - margin * 2);
  const ww = (options.window.max.x - options.window.min.x) * options.scale;
  const wh = (options.window.max.y - options.window.min.y) * options.scale;
  const fit = Math.min(pw / Math.max(ww, 1e-6), ph / Math.max(wh, 1e-6), 1);
  const s = options.scale * fit;
  const turn = ((options.rotate ?? 0) % 4) * (Math.PI / 2);
  const cos = Math.round(Math.cos(turn));
  const sin = Math.round(Math.sin(turn));
  // A = centre of the drawing box in paper mm.
  const cx = options.paper.width / 2;
  const cy = options.paper.height / 2;
  const mx = (options.window.min.x + options.window.max.x) / 2;
  const my = (options.window.min.y + options.window.max.y) / 2;
  // paper = R * s * (model - m) + c
  return { a: s * cos, c: s * sin, e: cx - s * (cos * mx - sin * my), f: cy - s * (sin * mx + cos * my), tl: pt(margin, margin) };
}

export function toPaper(t: { readonly a: number; readonly c: number; readonly e: number; readonly f: number }, p: Pt): Pt {
  const b = -t.c;
  const d = t.a;
  return pt(t.a * p.x + b * p.y + t.e, t.c * p.x + d * p.y + t.f);
}

/** SVG path data for every visible entity, in paper mm. */
export function plotSvg(doc: DocumentState, options: PlotOptions): string {
  const t = plotTransform(options);
  const paths: string[] = [];
  const fmt = (n: number): string => (Math.round(n * 1000) / 1000).toString();
  for (const id of doc.order) {
    const e = doc.entities.get(id);
    if (!e || !entityVisible(doc, e) || e.block) continue;
    const layer = doc.layers.get(e.layer);
    const color = colorToHex(resolveColor(e, doc.layers));
    const weight = e.lineweight ?? layer?.lineweight ?? 0.25;
    const dash = linetypePattern(resolveLinetype(e, doc.layers), doc.ltscale / Math.max(1, t.a));
    for (const seg of candidates(e)) {
      const a = toPaper(t, seg.a);
      const b = toPaper(t, seg.b);
      paths.push(`<line x1="${fmt(a.x)}" y1="${fmt(options.paper.height - a.y)}" x2="${fmt(b.x)}" y2="${fmt(options.paper.height - b.y)}" stroke="${color}" stroke-width="${weight}"${dash.length ? ` stroke-dasharray="${dash.map(fmt).join(" ")}"` : ""}/>`);
    }
    if (e.kind === "text") {
      const at = toPaper(t, e.at);
      paths.push(`<text x="${fmt(at.x)}" y="${fmt(options.paper.height - at.y)}" font-size="${fmt(e.height * t.a)}" fill="${color}" transform="rotate(${fmt((-e.rotation * 180) / Math.PI)} ${fmt(at.x)} ${fmt(options.paper.height - at.y)})">${escapeXml(e.value)}</text>`);
    }
    if (e.kind === "hatch") {
      const ring = e.rings[0];
      if (ring && ring.length > 2) {
        const d = ring.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(toPaper(t, p).x)} ${fmt(options.paper.height - toPaper(t, p).y)}`).join(" ") + " Z";
        paths.push(`<path d="${d}" fill="${e.solid ? color : "none"}" fill-opacity="${e.solid ? 0.12 : 0}" stroke="${color}" stroke-width="${weight}"/>`);
      }
    }
  }
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.paper.width}mm" height="${options.paper.height}mm" viewBox="0 0 ${options.paper.width} ${options.paper.height}">`;
  return `${head}<g>${paths.join("")}</g></svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ====================================================== misc */

/** The drawing's extent over visible entities, for fit-zoom and plot windows. */
export function drawingBounds(doc: DocumentState): Bounds | null {
  let b: Bounds | null = null;
  for (const e of doc.entities.values()) {
    if (!entityVisible(doc, e)) continue;
    b = unionBounds(b, boundsOf(entityPoints(e)));
  }
  return b;
}

/** Add a line to the prompt history, capped, newest first. */
export function pushHistory(doc: DocumentState, line: string): Command {
  return editCommand(
    "pushHistory",
    "History",
    () => new Map(),
    (current) => ({ before: { history: current.history }, after: { history: [line, ...current.history].slice(0, 200) } }),
  );
}

/** Paper size table, in mm (ISO A series plus US letter). */
export const PAPER_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  A4: { width: 297, height: 210 },
  A3: { width: 420, height: 297 },
  A2: { width: 594, height: 420 },
  A1: { width: 841, height: 594 },
  A0: { width: 1189, height: 841 },
  Letter: { width: 279.4, height: 215.9 },
};

export function setPaperMode(paper: boolean): Command {
  return editCommand(
    "setPaperMode",
    paper ? "Paper space" : "Model space",
    () => new Map(),
    (doc) => ({ before: { paper: doc.paper }, after: { paper } }),
  );
}

export function setUnits(units: Unit): Command {
  return editCommand(
    "setUnits",
    `Units ${units}`,
    () => new Map(),
    (doc) => ({ before: { units: doc.units }, after: { units } }),
  );
}
