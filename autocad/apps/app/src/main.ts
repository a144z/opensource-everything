import "./style.css";
import type { DocumentState, EntityId, Pt } from "@apexus/cad";
import {
  SCHEMA_VERSION,
  boundsExpand,
  dist,
  drawingBounds,
  driveDimension,
  emptyDocument,
  eraseEntities,
  formatLength,
  layerByName,
  measureDimension,
  pickEntity,
  plotSvg,
  pt,
  serializeProjectJson,
  setPaperMode,
} from "@apexus/cad";
import { AppState } from "./state.js";
import type { Settings } from "./state.js";
import { Camera, fitCanvas } from "./camera.js";
import { drawScene } from "./render.js";
import { Runner, snapPreview, fitPoint } from "./tools.js";
import type { Prompt, Tool, ToolContext } from "./tools.js";
import {
  arcTool,
  arrayTool,
  blockTool,
  circleTool,
  dimLinearTool,
  dimRadiusTool,
  eraseTool,
  explodeTool,
  extendTool,
  filletTool,
  hatchTool,
  hitsForWindow,
  insertTool,
  joinTool,
  layerCommands,
  leaderTool,
  lineTool,
  mirrorTool,
  moveTool,
  offsetTool,
  parsePointInput,
  pointAlong,
  pointTool,
  polylineTool,
  rectangleTool,
  rotateTool,
  scaleTool,
  sectionTool,
  textTool,
  trimTool,
} from "./tools.js";
import { openDxfText, openProject, plotDrawing, plotOptions, readFileText, saveDxf, saveProject } from "./io.js";

/**
 * The composition root: owns the elements, the session, the camera and the
 * runner, and does nothing else. Every rule it could have lives in a module —
 * `tools.ts` for gestures, `render.ts` for pixels, `io.ts` for files — so this
 * file stays the wiring diagram, not the product.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const app = new AppState();
const cam = new Camera();
const canvas = $<HTMLCanvasElement>("viewport");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("this browser has no 2D canvas");
const hintEl = $("hint");
const cursorEl = $("cursor");
const statusEl = $("status");
const input = $<HTMLInputElement>("command-input");
const promptLabel = $("prompt-label");
const layersEl = $("layers");
const fileInput = $<HTMLInputElement>("file-input");

let lastCursor: Pt = pt(0, 0);
let hoverId: EntityId | null = null;
let snapMark: { client: Pt; label: string } | null = null;
/** Selection window in progress (screen-model points). */
let box: { from: Pt; to: Pt; add: boolean } | null = null;
/** Pending dimension edit: the dimension the user clicked, waiting for a value. */
let editing: EntityId | null = null;
/** Typed text for a text/point prompt arrives through the command line. */
let typedLine = "";

function say(text: string, bad = false): void {
  hintEl.textContent = text;
  hintEl.style.color = bad ? "var(--bad)" : "var(--text)";
  input.classList.toggle("bad", bad);
}

function setStatus(): void {
  const d = app.doc;
  const n = d.entities.size;
  const sel = app.session.selection.length;
  const undo = app.session.history.depth;
  const bits = [`${n} entities${sel ? `, ${sel} selected` : ""}`, `history ${undo}`, d.paper ? "paper" : "model", d.units];
  const bounds = drawingBounds(d);
  if (bounds) bits.push(`${formatLength(bounds.max.x - bounds.min.x, d.units)} x ${formatLength(bounds.max.y - bounds.min.y, d.units)}`);
  statusEl.textContent = bits.join("  ·  ");
  statusEl.classList.remove("bad");
}

function setStatusError(text: string): void {
  statusEl.textContent = text;
  statusEl.classList.add("bad");
}

/* ============================================================== tools */

const registry: Record<string, () => Tool> = {
  line: lineTool,
  polyline: polylineTool,
  rect: () => rectangleTool,
  circle: () => circleTool,
  arc: () => arcTool,
  text: () => textTool,
  point: () => pointTool,
  dimlinear: dimLinearTool,
  dimaligned: dimLinearTool,
  dimradius: () => dimRadiusTool,
  hatch: () => hatchTool,
  leader: () => leaderTool,
  section: () => sectionTool,
  block: () => blockTool,
  insert: () => insertTool,
  move: moveTool(false),
  copy: moveTool(true),
  rotate: rotateTool,
  scale: scaleTool,
  mirror: mirrorTool,
  offset: offsetTool,
  trim: () => trimTool,
  extend: () => extendTool,
  fillet: filletTool,
  join: () => joinTool,
  explode: () => explodeTool,
  array: arrayTool,
  erase: () => eraseTool,
};

/** Aliases, the AutoCAD names users already have in their fingers. */
const ALIASES: Record<string, string> = {
  l: "line",
  pl: "polyline",
  rec: "rect",
  rectangle: "rect",
  c: "circle",
  a: "arc",
  t: "text",
  dt: "text",
  po: "point",
  dli: "dimlinear",
  dim: "dimlinear",
  dral: "dimlinear",
  dra: "dimradius",
  h: "hatch",
  le: "leader",
  sec: "section",
  b: "block",
  i: "insert",
  m: "move",
  co: "copy",
  cp: "copy",
  ro: "rotate",
  sc: "scale",
  mi: "mirror",
  o: "offset",
  tr: "trim",
  ex: "extend",
  f: "fillet",
  j: "join",
  x: "explode",
  ar: "array",
  e: "erase",
  delete: "erase",
  u: "undo",
  z: "zoom",
  p: "pan",
  sa: "save",
  pr: "plot",
};

const toolCtx: ToolContext = {
  app,
  cam,
  say,
  redraw: () => redraw(),
};
const runner = new Runner(toolCtx);

function startTool(id: string): void {
  const factory = registry[id];
  if (!factory) {
    say(`No tool "${id}"`, true);
    return;
  }
  editing = null;
  const t = factory();
  runner.start(t);
  markActiveTool(id);
  input.value = "";
  focusCommand();
}

function markActiveTool(id: string | null): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-cmd]")) {
    b.classList.toggle("active", id !== null && (b.dataset["cmd"] === id || (id === "dimaligned" && b.dataset["cmd"] === "dimlinear")));
  }
}

function focusCommand(): void {
  input.focus();
}

/* ============================================================ redraw */

let pendingFrame = 0;
function redraw(): void {
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    drawScene(ctx!, cam, app.doc, {
      selection: new Set(app.session.selection),
      hover: hoverId,
      grip: lastGrip,
      snap: snapMark,
      rubber: box ? [box.from, box.to] : runner.trail,
      showGrid: app.settings.showGrid,
      layerColors: app.settings.layerColors,
    });
    setStatus();
  });
}

/** The point a rubber band starts from, for `dist<angle` typed input. */
let lastGrip: Pt | null = null;

app.onChange(() => {
  redraw();
  renderLayers();
});

/* ============================================================== input */

function toModel(e: MouseEvent): Pt {
  const r = canvas.getBoundingClientRect();
  return cam.toModel(pt(e.clientX - r.left, e.clientY - r.top));
}

function toClient(e: MouseEvent): Pt {
  const r = canvas.getBoundingClientRect();
  return pt(e.clientX - r.left, e.clientY - r.top);
}

let panning: { from: Pt; start: Pt } | null = null;

canvas.addEventListener("mousedown", (e) => {
  focusCommand();
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    const p = toClient(e);
    panning = { from: p, start: cam.center };
    e.preventDefault();
    return;
  }
  if (e.button === 2) {
    // Right button: repeat the last tool, or Esc out of one (AutoCAD's habit).
    if (runner.tool) runner.cancel();
    else if (lastToolId) startTool(lastToolId);
    markActiveTool(runner.tool?.id ?? null);
    redraw();
    return;
  }
  if (e.button !== 0) return;
  if (editing) return;
  const prompt = runner.prompt;
  if (prompt) {
    const p = toModel(e);
    if (prompt.kind === "point") {
      runner.answer({ point: runner.prompt.kind === "point" ? fitPoint(toolCtx, runner.prompt, p) : p, text: "", byClick: true });
      lastGrip = runner.prompt?.from ?? null;
    } else if (prompt.kind === "value") {
      runner.answer({ point: p, text: "", byClick: true });
    } else {
      say("Type the text for this prompt", true);
    }
    return;
  }
  // Idle: pick or open a selection window.
  const p = toModel(e);
  const hit = pickEntity(app.doc, p, cam.mm(8));
  if (hit) {
    const id = hit.id;
    const entity = app.doc.entities.get(id);
    if (entity?.kind === "dimension" && (entity.dim === "linear" || entity.dim === "aligned")) {
      editing = id;
      setPromptLabel(`New value for ${measureDimension(app.doc, entity).label}`);
      input.value = "";
      input.placeholder = "Type the new measurement, Enter to apply, Esc to cancel";
      focusCommand();
      app.select([id]);
      return;
    }
    const sel = app.session.selection;
    if (e.shiftKey) app.select(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else app.select([id]);
    return;
  }
  if (!e.shiftKey && app.session.selection.length) app.select([]);
  box = { from: p, to: p, add: e.shiftKey };
});

canvas.addEventListener("mousemove", (e) => {
  const client = toClient(e);
  if (panning) {
    cam.center = pt(panning.start.x - (client.x - panning.from.x) / cam.unit, panning.start.y + (client.y - panning.from.y) / cam.unit);
    redraw();
    return;
  }
  const raw = cam.toModel(client);
  lastCursor = raw;
  cursorEl.textContent = `${formatLength(raw.x, app.doc.units)}, ${formatLength(raw.y, app.doc.units)}  ·  ${(cam.unit * 1000).toFixed(2)} px/m`;
  if (box) {
    box.to = raw;
    redraw();
    return;
  }
  if (runner.prompt?.kind === "point") {
    runner.preview(raw);
    const snap = snapPreview(toolCtx, raw);
    snapMark = snap ? { client: cam.toScreen(snap.point), label: snap.label } : null;
    lastGrip = runner.prompt.from ?? null;
    redraw();
    return;
  }
  if (runner.tool) {
    runner.preview(raw);
    redraw();
    return;
  }
  const hit = pickEntity(app.doc, raw, cam.mm(8));
  const id = hit?.id ?? null;
  if (id !== hoverId) {
    hoverId = id;
    canvas.style.cursor = id ? "pointer" : "crosshair";
    redraw();
  }
});

window.addEventListener("mouseup", (e) => {
  if (panning) {
    panning = null;
    return;
  }
  if (!box || e.button !== 0) return;
  const b = box;
  box = null;
  if (dist(b.from, b.to) < cam.mm(3)) {
    redraw();
    return;
  }
  const crossing = b.to.x < b.from.x;
  const hits = hitsForWindow(app, b.from, b.to, crossing);
  if (b.add) {
    const sel = new Set(app.session.selection);
    for (const id of hits) sel.add(id);
    app.select([...sel]);
  } else {
    app.select(hits);
  }
  say(`${hits.length} selected${crossing ? " (crossing)" : ""}`);
  redraw();
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = toClient(e);
  cam.zoomAt(p, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  redraw();
}, { passive: false });

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("dblclick", () => {
  if (runner.tool) {
    runner.cancel();
    markActiveTool(null);
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    input.value = "";
    cancelAll();
    e.preventDefault();
    return;
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const text = input.value.trim();
  input.value = "";
  submit(text);
});

function cancelAll(): void {
  if (editing) {
    editing = null;
    setPromptLabel("Command");
    input.placeholder = "Type a command, coordinate or value";
    say("Dimension edit cancelled");
    redraw();
    return;
  }
  if (runner.cancel()) {
    markActiveTool(null);
    return;
  }
  if (box) box = null;
  app.select([]);
  say("Ready");
  redraw();
}

function submit(text: string): void {
  if (editing) {
    applyDimensionValue(editing, text);
    return;
  }
  const prompt = runner.prompt;
  if (prompt) {
    const point = answerPoint(prompt, text);
    if (prompt.kind === "point" && point === null && text !== "" && !isKeyword(text, prompt)) {
      say(`"${text}" is not a point — type x,y, @dx,dy, dist<angle or a distance`, true);
      return;
    }
    if (prompt.kind === "value" && text !== "" && point === null) {
      // A value prompt (radius, factor, angle) is answered by the number as
      // typed; only a real point turns it into a distance.
      runner.answer({ point: null, text, byClick: false });
      return;
    }
    runner.answer({ point, text, byClick: false });
    lastGrip = runner.prompt?.from ?? null;
    return;
  }
  if (text === "") {
    // An empty Enter at idle repeats the last command, as every CAD tool does.
    if (lastToolId) startTool(lastToolId);
    return;
  }
  runCommand(text);
}

function isKeyword(text: string, p: Prompt): boolean {
  return (p.options ?? []).some((o) => o.toLowerCase() === text.trim().toLowerCase());
}

function answerPoint(p: Prompt, text: string): Pt | null {
  const base = p.relativeTo ?? p.from ?? null;
  const parsed = parsePointInput(text, base, app.doc.units);
  if (parsed) return parsed;
  if (p.kind === "point" && base) {
    // A bare number at a point prompt is a distance along the rubber band.
    const len = text.trim().match(/^-?\d+(\.\d+)?\s*[a-z"']*$/i);
    if (len) {
      const mm = parseDistance(text);
      if (mm !== null) return pointAlong(base, lastCursor, mm);
    }
  }
  return null;
}

function parseDistance(text: string): number | null {
  const t = text.trim();
  const m = t.match(/^(-?\d+(?:[.,]\d+)?)\s*([a-z"']*)$/i);
  if (!m) return null;
  const raw = Number(m[1]!.replace(",", "."));
  const unitText = m[2]!.toLowerCase();
  const factors: Record<string, number> = { "": 1, mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8 };
  const f = factors[unitText];
  return f === undefined || !Number.isFinite(raw) ? null : raw * f;
}

function applyDimensionValue(dimId: string, text: string): void {
  const mm = parseDistance(text);
  if (mm === null || text.trim() === "") {
    say(`"${text}" is not a measurement`, true);
    return;
  }
  const result = driveDimension(app.doc, dimId, mm);
  if (!result.command || result.problem) {
    say(result.problem ?? "constraints do not fit", true);
    setStatusError(result.problem ?? "constraints do not fit");
    editing = null;
    setPromptLabel("Command");
    input.placeholder = "Type a command, coordinate or value";
    redraw();
    return;
  }
  const r = app.edit(result.command);
  editing = null;
  setPromptLabel("Command");
  input.placeholder = "Type a command, coordinate or value";
  if (!r.ok) {
    say(r.error ?? "could not drive the dimension", true);
    return;
  }
  say(`Dimension set to ${formatLength(mm, app.doc.units)}`);
  redraw();
}

function setPromptLabel(text: string): void {
  promptLabel.textContent = `${text}:`;
}

/* ========================================================== commands */

let lastToolId: string | null = null;

function runCommand(text: string): void {
  const word = text.split(/\s+/)[0]!.toLowerCase();
  const rest = text.slice(word.length).trim();
  const id = ALIASES[word] ?? word;
  if (registry[id]) {
    lastToolId = id;
    startToolWithArgs(id, rest);
    return;
  }
  switch (id) {
    case "undo":
      if (!app.undo()) say("Nothing to undo");
      else say(`Undid: ${app.session.history.labels[app.session.history.labels.length - 1] ?? ""}`.trim());
      return;
    case "redo":
      if (!app.redo()) say("Nothing to redo");
      return;
    case "zoom":
      zoomExtents();
      return;
    case "save":
      void saveProject(app, rest || "drawing.dwgcad").then((m) => say(m));
      return;
    case "dxfout":
      void saveDxf(app, rest || "drawing.dxf").then((m) => say(m));
      return;
    case "plot":
      void plotDrawing(app, rest || "plot.svg").then((m) => say(m));
      return;
    case "new":
      newDrawing();
      return;
    case "paper":
      app.edit(setPaperMode(!app.doc.paper));
      syncPaperButton();
      return;
    case "units":
      setUnitsFrom(rest);
      return;
    case "layer":
      createLayer(rest);
      return;
    case "help":
      say(HELP);
      return;
    case "select":
      markActiveTool("select");
      say("Pick, or drag a window (drag left = crossing)");
      return;
    default:
      say(`Unknown command "${word}" — type Help for the list`, true);
  }
}

function startToolWithArgs(id: string, args: string): void {
  startTool(id);
  if (args !== "") {
    // `C 50` = circle with radius 50: seed the first answer the tool accepts.
    const prompt = runner.prompt;
    if (prompt?.kind === "value") submit(args);
  }
}

const HELP = "Commands: L PL REC C A T PO DLI DRA H LE SEC B I M CO RO SC MI O TR EX F J X AR E U Z P SAVE DXFOUT PLOT UNITS LAYER PAPER NEW HELP";

/* ================================================================== ui */

function zoomExtents(): void {
  const b = drawingBounds(app.doc);
  cam.fit(b ? boundsExpand(b, Math.max(1, (b.max.x - b.min.x + b.max.y - b.min.y) * 0.05)) : null);
  redraw();
}

function newDrawing(): void {
  app.load(emptyDocument(app.doc.units));
  editing = null;
  cam.fit(null);
  say("New drawing");
  redraw();
}

function createLayer(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    say("Layer name needed: LAYER name", true);
    return;
  }
  const err = layerCommands(app).add(trimmed);
  if (err) say(err, true);
  else say(`Layer ${trimmed} is current`);
}

function setUnitsFrom(text: string): void {
  const u = text.trim().toLowerCase();
  const L = layerCommands(app);
  if (u === "" || !["mm", "cm", "m", "in", "ft"].includes(u)) {
    say(`Units: ${app.doc.units}. Type UNITS mm|cm|m|in|ft`, true);
    return;
  }
  const err = L.units(u as "mm");
  say(err ?? `Units are now ${u}`);
}

function syncPaperButton(): void {
  const b = $("paper-mode");
  b.textContent = app.doc.paper ? "Paper" : "Model";
  b.classList.toggle("active", app.doc.paper);
}

function renderLayers(): void {
  const doc = app.doc;
  layersEl.textContent = "";
  for (const layer of doc.layers.values()) {
    const li = document.createElement("li");
    if (layer.id === doc.currentLayer) li.classList.add("current");

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "swatch";
    swatch.value = `#${layer.color.toString(16).padStart(6, "0")}`;
    swatch.title = "Layer colour";
    swatch.addEventListener("input", () => {
      const err = layerCommands(app).color(layer.id, Number.parseInt(swatch.value.slice(1), 16));
      if (err) say(err, true);
    });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name;
    name.title = "Double-click to rename, click to make current";
    name.addEventListener("click", () => {
      const err = layerCommands(app).current(layer.id);
      if (err) say(err, true);
      else say(`Current layer ${layer.name}`);
    });
    name.addEventListener("dblclick", () => startRename(li, name, layer.id, layer.name));

    const on = document.createElement("button");
    on.className = `tog${layer.visible ? " on" : ""}`;
    on.textContent = layer.visible ? "On" : "Off";
    on.title = "Visibility";
    on.addEventListener("click", () => toggleLayer(layer.id, "visible"));

    const lock = document.createElement("button");
    lock.className = `tog${layer.locked ? " on" : ""}`;
    lock.textContent = layer.locked ? "Lk" : "Ul";
    lock.title = "Locked: cannot be picked or edited";
    lock.addEventListener("click", () => toggleLayer(layer.id, "locked"));

    const del = document.createElement("button");
    del.className = "tog";
    del.textContent = "×";
    del.title = "Delete the layer (its entities move to layer 0)";
    del.addEventListener("click", () => {
      const err = layerCommands(app).remove(layer.id);
      if (err) say(err, true);
      else say(`Layer ${layer.name} deleted`);
    });

    li.append(swatch, name, on, lock, del);
    layersEl.append(li);
  }
}

function toggleLayer(id: string, key: "visible" | "locked" | "frozen"): void {
  const err = layerCommands(app).toggle(id, key);
  if (err) say(err, true);
}

function startRename(li: HTMLElement, nameEl: HTMLElement, id: string, current: string): void {
  const box = document.createElement("input");
  box.type = "text";
  box.value = current;
  nameEl.replaceWith(box);
  box.focus();
  box.select();
  const commit = (): void => {
    const err = layerCommands(app).rename(id, box.value);
    if (err) say(err, true);
    renderLayers();
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") renderLayers();
    e.stopPropagation();
  });
  box.addEventListener("blur", () => {
    if (box.isConnected) commit();
  });
}

/* ============================================================ buttons */

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-cmd]")) {
  b.addEventListener("click", () => {
    const id = b.dataset["cmd"] ?? "";
    if (id === "select") {
      runner.cancel();
      markActiveTool("select");
      say("Pick, or drag a window");
      return;
    }
    lastToolId = id;
    startTool(id);
  });
}

$("undo").addEventListener("click", () => {
  if (!app.undo()) say("Nothing to undo");
  editing = null;
});
$("redo").addEventListener("click", () => {
  if (!app.redo()) say("Nothing to redo");
});
$("zoom-extents").addEventListener("click", zoomExtents);
$("paper-mode").addEventListener("click", () => {
  app.edit(setPaperMode(!app.doc.paper));
  syncPaperButton();
});
$("layer-add").addEventListener("click", () => {
  const inputEl = $<HTMLInputElement>("layer-new");
  createLayer(inputEl.value);
  inputEl.value = "";
});
$<HTMLInputElement>("layer-new").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    createLayer((e.target as HTMLInputElement).value);
    (e.target as HTMLInputElement).value = "";
  }
});

function toggleSetting(key: keyof Settings, buttonId: string, label: string): void {
  const b = $(buttonId);
  b.addEventListener("click", () => {
    app.settings[key] = !app.settings[key];
    b.classList.toggle("active", app.settings[key] as boolean);
    b.setAttribute("aria-pressed", String(app.settings[key]));
    say(`${label} ${app.settings[key] ? "on" : "off"}`);
    redraw();
  });
}
toggleSetting("osnap", "snap-osnap", "Object snap");
toggleSetting("ortho", "snap-ortho", "Ortho");
toggleSetting("gridSnap", "snap-grid", "Grid snap");
toggleSetting("polar", "snap-polar", "Polar tracking");

$("file-new").addEventListener("click", newDrawing);
$("file-save").addEventListener("click", () => void saveProject(app).then((m) => say(m)));
$("file-dxf-save").addEventListener("click", () => void saveDxf(app).then((m) => say(m)));
$("file-svg").addEventListener("click", () => void plotDrawing(app).then((m) => say(m)));
$("file-open").addEventListener("click", () => pickFile(".dwgcad,application/json"));
$("file-dxf-open").addEventListener("click", () => pickFile(".dxf,text/plain"));

let openMode: "project" | "dxf" = "project";
function pickFile(accept: string): void {
  openMode = accept.startsWith(".dxf") ? "dxf" : "project";
  fileInput.accept = accept;
  fileInput.value = "";
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  await openText(await readFileText(f), openMode);
});

async function openText(text: string, mode: "project" | "dxf"): Promise<void> {
  const r = mode === "project" ? openProject(text) : openDxfText(text);
  if (!r.doc) {
    say(r.message, true);
    return;
  }
  app.load(r.doc);
  runner.cancel();
  editing = null;
  zoomExtents();
  syncPaperButton();
  say(r.message);
}

/* Drag and drop is how most people open a drawing twice a day. */
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  void readFileText(f).then((text) => openText(text, f.name.toLowerCase().endsWith(".dxf") ? "dxf" : "project"));
});

/* ============================================================ keys */

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  const typing = target === input || target.tagName === "INPUT";
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === "z" && !typing) {
      e.preventDefault();
      if (!app.undo()) say("Nothing to undo");
      return;
    }
    if ((e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) && !typing) {
      e.preventDefault();
      if (!app.redo()) say("Nothing to redo");
      return;
    }
    if (e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveProject(app).then((m) => say(m));
      return;
    }
    if (e.key.toLowerCase() === "o") {
      e.preventDefault();
      pickFile(".dwgcad,application/json");
      return;
    }
    if (e.key.toLowerCase() === "a" && !typing) {
      e.preventDefault();
      app.select([...app.doc.entities.keys()]);
      return;
    }
    return;
  }
  if (typing) return;
  switch (e.key) {
    case "Escape":
      cancelAll();
      break;
    case "Delete":
      if (app.session.selection.length) {
        const n = app.session.selection.length;
        const r = app.edit(eraseEntities(app.session.selection));
        if (!r.ok) say(r.error ?? "could not erase", true);
        else say(`Erased ${n}`);
      }
      break;
    case "F3":
      toggleFromKey("osnap", "snap-osnap", "Object snap");
      break;
    case "F7":
      app.settings.showGrid = !app.settings.showGrid;
      say(`Grid ${app.settings.showGrid ? "on" : "off"}`);
      redraw();
      break;
    case "F8":
      toggleFromKey("ortho", "snap-ortho", "Ortho");
      break;
    case "F9":
      toggleFromKey("gridSnap", "snap-grid", "Grid snap");
      break;
    default:
      if (e.key.length === 1 && /[a-zA-Z0-9._\-]/.test(e.key)) {
        focusCommand();
        input.value = e.key;
        e.preventDefault();
      } else if (e.key === "Enter" || e.key === " ") {
        focusCommand();
        e.preventDefault();
        if (e.key === " ") submit("");
      }
  }
});

function toggleFromKey(key: keyof Settings, buttonId: string, label: string): void {
  app.settings[key] = !app.settings[key];
  const b = $(buttonId);
  b.classList.toggle("active", app.settings[key] as boolean);
  say(`${label} ${app.settings[key] ? "on" : "off"}`);
  redraw();
}

/* ============================================================ boot */

function resize(): void {
  fitCanvas(canvas, ctx!, cam);
  redraw();
}
new ResizeObserver(resize).observe(canvas.parentElement ?? canvas);

canvas.dataset["schema"] = String(SCHEMA_VERSION);
canvas.dataset["commands"] = [...Object.keys(registry), "undo", "redo", "zoom", "save", "dxfout", "plot", "new", "paper", "units", "layer", "help", "select"].join(",");

/** The testing surface: intent-level actions, no mouse events synthesised. */
interface TestSurface {
  readonly app: AppState;
  readonly cam: Camera;
  readonly runner: Runner;
  command(text: string): void;
  clickAt(x: number, y: number, opts?: { shift?: boolean }): void;
  zoomExtents(): void;
  doc(): DocumentState;
  version(): number;
  dump(): string;
  layers(): string[];
  addLayer(name: string): void;
  renameLayer(from: string, to: string): string;
  toggleLayer(name: string, key: "visible" | "locked"): string;
  driveDimension(dimId: string, value: number): string;
  openText(text: string, mode: "project" | "dxf"): Promise<void>;
  saveProject(): Promise<string>;
  projectText(): Promise<string>;
  plotText(scale: number): string;
  plot(scale: number): Promise<boolean>;
  hint(): string;
  pickAt(x: number, y: number): string | null;
}
declare global {
  interface Window {
    draftcheckTest?: TestSurface;
  }
}

window.draftcheckTest = {
  app,
  cam,
  runner,
  // The command line is one entry point: while a tool is asking, a line is an
  // answer; at idle it is a command. `submit` is that rule, and tests use it.
  command: (text) => submit(text),
  clickAt: (x, y, opts) => {
    const p = pt(x, y);
    lastCursor = p;
    const prompt = runner.prompt;
    if (prompt) runner.answer({ point: prompt.kind === "point" ? p : p, text: "", byClick: true });
    else {
      const hit = pickEntity(app.doc, p, cam.mm(8));
      if (hit) app.select(opts?.shift ? [...app.session.selection, hit.id] : [hit.id]);
      else app.select([]);
    }
    redraw();
  },
  zoomExtents,
  doc: () => app.doc,
  version: () => app.version,
  dump: () => JSON.stringify({ order: app.doc.order, entities: [...app.doc.entities.values()], layers: [...app.doc.layers.values()] }),
  layers: () => [...app.doc.layers.values()].map((l) => `${l.name}${l.visible ? "" : " (off)"}${l.locked ? " (locked)" : ""}${l.id === app.doc.currentLayer ? " *" : ""}`),
  addLayer: (name) => createLayer(name),
  renameLayer: (from, to) => {
    const l = layerByName(app.doc, from);
    return l ? layerCommands(app).rename(l.id, to) ?? "ok" : `no layer ${from}`;
  },
  toggleLayer: (name, key) => {
    const l = layerByName(app.doc, name);
    return l ? layerCommands(app).toggle(l.id, key) ?? "ok" : `no layer ${name}`;
  },
  driveDimension: (dimId, value) => {
    const res = driveDimension(app.doc, dimId, value);
    if (!res.command || res.problem) return res.problem ?? "constraints do not fit";
    const r = app.edit(res.command);
    return r.ok ? "ok" : r.error ?? "error";
  },
  openText,
  saveProject: () => saveProject(app),
  projectText: async () => serializeProjectJson(app.doc),
  plotText: (scale) => {
    const opts = plotOptions(app, { size: "A4", scale });
    return opts ? plotSvg(app.doc, opts) : "";
  },
  plot: async (scale) => {
    const m = await plotDrawing(app, "plot.svg", { size: "A4", scale });
    return m.startsWith("Plotted");
  },
  hint: () => hintEl.textContent ?? "",
  pickAt: (x, y) => pickEntity(app.doc, pt(x, y), cam.mm(8))?.id ?? null,
};

// Warm the browser's canvas font before the first frame so the first label is
// not drawn with the fallback face.
void document.fonts.ready.then(() => {
  resize();
  zoomExtents();
  cam.unit = Math.min(cam.unit, Math.min(cam.width, cam.height) / 300);
  syncPaperButton();
  renderLayers();
  say("Ready — type Help for commands, or click a tool");
  focusCommand();
});
