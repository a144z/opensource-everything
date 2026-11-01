import "./style.css";
import * as THREE from "three";
import { formatLength, formatSize, parseLength, toStlAsciiNamed, type Vec3 } from "@apexus/geometry";
import {
  Annotation,
  AnnotationStore,
  Session,
  addSolid,
  arrayCopy,
  booleanSolids,
  centreInEnvelope,
  commandKeys,
  deleteSolids,
  deserializeJson,
  dimensionLength,
  duplicateSolid,
  fitToEnvelope,
  serializeJson,
  setEnvelope,
  setMatrix,
  setMeta,
  type CommandId,
  type FitResult,
  type SolidId,
} from "@apexus/engine";
import { initKernel, kernelReady } from "@apexus/kernel";
import { View, type PickHit, type Tool } from "./view.js";
import { ToolController } from "./tools.js";
import { Snapper } from "./snap.js";
import { CommandPalette } from "./palette.js";

/**
 * Composition root: wires engine <-> kernel <-> view <-> tools <-> DOM.
 * The only thing this file knows about geometry is how to show it.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/* -------------------------------------------------------------- session */

const session = new Session({ idPrefix: "o" });
const viewport = $("viewport");
const hint = $("hint");
const snapper = new Snapper(session);
let unit: "mm" | "cm" | "m" | "in" = "mm";
let selection: ReadonlySet<SolidId> = new Set();
let gizmoMode: "translate" | "rotate" | "scale" = "translate";
const cursor = { x: 0, y: 0 };

const view = new View(viewport, session, {
  onPick: (hit: PickHit, additive, copy) => {
    tools.click(hit, additive, cursor.x, cursor.y, copy ?? false);
    if (hit.kind === "solid" && additive) setSelection([hit.id], true);
    renderPanel();
  },
  onHover: (point) => tools.hover(point, cursor.x, cursor.y),
  onGizmoCommit: (id, matrix) => {
    try {
      session.execute(setMatrix([id], matrix));
      hint.textContent = "Transformed.";
    } catch (err) {
      hint.textContent = (err as Error).message;
    }
    refresh();
  },
});

const tools = new ToolController({
  session,
  view,
  snapper,
  setHint: (text) => {
    hint.textContent = text;
  },
  select: (ids, additive) => setSelection(ids, additive ?? false),
  cursor: () => cursor,
  unit: () => unit,
  axisLocked: () => view.axisLocked,
  annotate: (note) => {
    annotations.add(note);
    renderAnnotations();
  },
  selection: () => [...selection],
});

/* ----------------------------------------------------------- annotations */

// Annotations live beside the document, not inside it: they are app state with
// no undo entry and no effect on the fit check (see annotations.ts).
const annotations = new AnnotationStore();
const annotationGroup = new THREE.Group();
view.scene.add(annotationGroup);

/** Dimension lines float this far above their plane so they never z-fight. */
const ANNOTATION_LIFT = 0.6;

/** The 3D endpoints of a dimension: along its axis, offset outward for legibility. */
function dimensionPoints(note: Annotation): [Vec3, Vec3] {
  const a = note.a;
  const b = note.b;
  if (note.axis === "free" || note.axis === "z") {
    return [
      [a[0], a[1], a[2] + note.offset],
      [b[0], b[1], b[2] + note.offset],
    ];
  }
  if (note.axis === "x") {
    const y = a[1] - note.offset;
    return [
      [a[0], y, a[2]],
      [b[0], y, b[2]],
    ];
  }
  const x = a[0] - note.offset;
  return [
    [x, a[1], a[2]],
    [x, b[1], b[2]],
  ];
}

function renderAnnotations(): void {
  for (const child of [...annotationGroup.children]) {
    annotationGroup.remove(child);
    if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
  for (const note of annotations.all()) {
    if (note.kind !== "dimension") continue;
    const [a, b] = dimensionPoints(note);
    const mm = Math.abs(dimensionLength(note.a, note.b, note.axis));
    const line = makeOverlayLine(0x2f6fed);
    line.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a[0], a[1], a[2] + ANNOTATION_LIFT),
      new THREE.Vector3(b[0], b[1], b[2] + ANNOTATION_LIFT),
    ]);
    annotationGroup.add(line);
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + ANNOTATION_LIFT];
    annotationGroup.add(makeLabel(`${mm.toFixed(1)} mm`, mid));
  }
  view.invalidate();
}

/** A solid-colour overlay line (annotations draw over the model, never depth-tested). */
function makeOverlayLine(color: number): THREE.Line {
  const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const line = new THREE.Line(new THREE.BufferGeometry(), material);
  line.renderOrder = 20;
  return line;
}

/** A camera-facing text label on a small card, so it stays readable at any zoom. */
function makeLabel(text: string, at: Vec3): THREE.Sprite {
  const pad = 8;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 28px system-ui, sans-serif";
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = width;
  canvas.height = 40;
  ctx.font = "600 28px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1c4fd8";
  ctx.fillText(text, pad, 30);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  // Keep the card's aspect: 1 world unit of sprite = 1 mm of height.
  sprite.scale.set(width * 2.2, 40 * 2.2, 1);
  sprite.position.set(at[0], at[1], at[2]);
  sprite.renderOrder = 21;
  return sprite;
}

/* ------------------------------------------------------------ selection */

/**
 * Selection is a set. A plain click replaces it; Shift-click toggles one object
 * so Move and Rotate can act on several (task L2-4c).
 */
function setSelection(ids: readonly SolidId[], additive = false): void {
  if (additive) {
    const next = new Set(selection);
    for (const id of ids) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    selection = next;
  } else {
    selection = new Set(ids);
  }
  view.attachGizmo(selection.size === 1 ? [...selection][0]! : null);
  renderPanel();
}

function renderPanel(): void {
  const doc = session.document;
  const outliner = $("outliner");
  outliner.innerHTML = "";
  for (const solid of doc.solids.values()) {
    const li = document.createElement("li");
    li.className = selection.has(solid.id) ? "selected" : "";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = solid.meta.color;
    const label = document.createElement("span");
    label.textContent = `${solid.meta.name} - ${(session.analyse(solid.id).volume / 1000).toFixed(1)} cm3`;
    const eye = document.createElement("button");
    eye.textContent = solid.meta.hidden ? "-" : "o";
    eye.title = solid.meta.hidden ? "Show" : "Hide";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        session.execute(setMeta(solid.id, { hidden: !solid.meta.hidden }, solid.meta.hidden ? "Show" : "Hide"));
      } catch (err) {
        hint.textContent = (err as Error).message;
      }
      refresh();
    });
    li.append(swatch, label, eye);
    li.addEventListener("click", (e) => {
      if (e.shiftKey) {
        const next = new Set(selection);
        if (next.has(solid.id)) next.delete(solid.id);
        else next.add(solid.id);
        setSelection([...next]);
      } else {
        setSelection([solid.id]);
      }
    });
    outliner.append(li);
  }

  const fit = session.fit();
  renderFit(fit);
  view.markFailures(failures(), selection);

  ($("undo") as HTMLButtonElement).disabled = !session.canUndo;
  ($("redo") as HTMLButtonElement).disabled = !session.canRedo;
  $("kernel-status").textContent = kernelReady() ? "Solid kernel: ready" : "Solid kernel: loading";

  const pair = selection.size === 2;
  for (const id of ["op-union", "op-subtract", "op-intersect"]) {
    ($(id) as HTMLButtonElement).disabled = !(pair && kernelReady());
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    b.classList.toggle("active", b.dataset["tool"] === tools.tool);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-gizmo]")) {
    b.classList.toggle("active", b.dataset["gizmo"] === gizmoMode);
  }
  const enabled = selection.size >= 1;
  ($("sel-array") as HTMLButtonElement).disabled = !enabled;
  ($("sel-duplicate") as HTMLButtonElement).disabled = !enabled;
}

function renderFit(fit: FitResult): void {
  const verdict = $("fit-verdict");
  const detail = $("fit-detail");
  verdict.classList.remove("pass", "fail");
  if (!fit.envelope) {
    verdict.textContent = "No envelope";
    detail.textContent = "Set the space it has to fit in, then model against it.";
  } else if (fit.pass) {
    verdict.classList.add("pass");
    verdict.textContent = "FITS";
    detail.textContent = boundsLine(fit);
  } else {
    verdict.classList.add("fail");
    verdict.textContent = "DOES NOT FIT";
    const w = fit.worst;
    detail.textContent = `${boundsLine(fit)}\nOver by ${w ? `${w.mm.toFixed(1)} mm on ${w.axis.toUpperCase()}` : ""}`;
  }
  const sel = [...selection][0];
  if (sel) {
    const solid = session.document.solids.get(sel);
    if (solid) {
      const b = session.boundsOf(sel);
      detail.textContent += `\n${solid.meta.name}: ${(b.max[0] - b.min[0]).toFixed(1)} x ${(b.max[1] - b.min[1]).toFixed(1)} x ${(b.max[2] - b.min[2]).toFixed(1)} mm`;
    }
  }
}

function boundsLine(fit: FitResult): string {
  const b = fit.bounds;
  if (!Number.isFinite(b.min[0])) return "Model is empty.";
  return `Model ${(b.max[0] - b.min[0]).toFixed(1)} x ${(b.max[1] - b.min[1]).toFixed(1)} x ${(b.max[2] - b.min[2]).toFixed(1)} mm`;
}

function failures(): Set<SolidId> {
  const out = new Set<SolidId>();
  const env = session.document.envelope;
  if (!env) return out;
  for (const solid of session.document.solids.values()) {
    if (solid.meta.hidden) continue;
    const b = session.boundsOf(solid.id);
    if (
      b.min[0] < env.min[0] ||
      b.min[1] < env.min[1] ||
      b.min[2] < env.min[2] ||
      b.max[0] > env.max[0] ||
      b.max[1] > env.max[1] ||
      b.max[2] > env.max[2]
    ) {
      out.add(solid.id);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ I/O */

function download(name: string, data: string, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveProject(): void {
  download("untitled.fcproj", serializeJson(session.document), "application/json");
}

function exportStl(): void {
  const parts: { name: string; mesh: ReturnType<typeof session.meshOf> }[] = [];
  for (const solid of session.document.solids.values()) {
    if (solid.meta.hidden) continue;
    parts.push({ name: solid.meta.name.replace(/[^A-Za-z0-9_-]/g, "_"), mesh: session.meshOf(solid.id) });
  }
  if (parts.length === 0) {
    hint.textContent = "Nothing to export yet.";
    return;
  }
  download("model.stl", toStlAsciiNamed(parts), "model/stl");
}

function openProject(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = deserializeJson(String(reader.result));
      session.load(doc);
      setSelection([]);
      view.sync();
      view.zoomExtents();
      refresh();
      hint.textContent = `Loaded ${doc.solids.size} object${doc.solids.size === 1 ? "" : "s"}.`;
    } catch (err) {
      hint.textContent = `Could not open file: ${(err as Error).message}`;
    }
  };
  reader.readAsText(file);
}

/* --------------------------------------------------------------- wiring */

function refresh(): void {
  view.sync();
  renderPanel();
}

/**
 * One command, one entry point. The toolbar, the keyboard and the palette all
 * call this, so a command can never mean two things.
 */
function runCommand(id: CommandId): void {
  try {
    switch (id) {
      case "select":
        selectTool("select");
        return;
      case "rectangle":
      case "circle":
      case "arc":
      case "line":
      case "pushpull":
      case "offset":
      case "followme":
      case "move":
      case "rotate":
      case "tape":
      case "dimension":
        selectTool(id);
        return;
      case "undo":
        session.undo();
        setSelection([]);
        refresh();
        return;
      case "redo":
        session.redo();
        setSelection([]);
        refresh();
        return;
      case "delete": {
        const ids = [...selection];
        if (ids.length === 0) return;
        session.execute(deleteSolids(ids));
        setSelection([]);
        hint.textContent = `Deleted ${ids.length} object(s).`;
        refresh();
        return;
      }
      case "duplicate": {
        const first = [...selection][0];
        if (!first) {
          hint.textContent = "Duplicate: select something first.";
          return;
        }
        const patch = session.execute(duplicateSolid(first, [50, 50, 0]));
        setSelection([...patch.forward.keys()]);
        hint.textContent = "Duplicated (50/50/0 mm).";
        refresh();
        return;
      }
      case "array":
        runArray();
        return;
      case "union":
      case "subtract":
      case "intersect": {
        const [a, b] = [...selection];
        if (!a || !b) {
          hint.textContent = "Booleans need exactly two objects selected.";
          return;
        }
        const op = id === "union" ? "union" : id === "subtract" ? "difference" : "intersection";
        const patch = session.execute(booleanSolids(a, b, op));
        const created = [...patch.forward.keys()].find((k) => !selection.has(k));
        setSelection(created ? [created] : []);
        refresh();
        hint.textContent = `${op} done.`;
        return;
      }
      case "fit":
        session.execute(fitToEnvelope());
        hint.textContent = "Scaled down to fit the envelope.";
        refresh();
        return;
    }
  } catch (err) {
    hint.textContent = (err as Error).message;
  }
}

/** Commands that need objects, and how many. Used by the palette to hide dead ends. */
function commandEnabled(id: CommandId): boolean {
  const count = selection.size;
  switch (id) {
    case "delete":
    case "duplicate":
      return count >= 1;
    case "union":
    case "subtract":
    case "intersect":
      return count === 2;
    default:
      return true;
  }
}

function selectTool(tool: Tool): void {
  tools.setTool(tool);
  renderPanel();
}

const palette = new CommandPalette({ run: runCommand, enabled: commandEnabled });

function setGizmo(mode: "translate" | "rotate" | "scale"): void {
  gizmoMode = mode;
  view.setGizmoMode(mode);
  renderPanel();
}

/** Envelope inputs accept any unit; they convert to internal mm. */
function readEnvelope(): Vec3 | null {
  const w = parseLength(($("env-w") as HTMLInputElement).value, unit);
  const h = parseLength(($("env-h") as HTMLInputElement).value, unit);
  const d = parseLength(($("env-d") as HTMLInputElement).value, unit);
  if (!w || !h || !d || !(w.mm > 0 && h.mm > 0 && d.mm > 0)) return null;
  return [w.mm, h.mm, d.mm];
}

function setEnvelopeFromInputs(): void {
  const size = readEnvelope();
  if (!size) {
    hint.textContent = "Envelope needs a positive width, height and depth (e.g. 600, 60cm, 2m).";
    return;
  }
  try {
    session.execute(setEnvelope({ min: [0, 0, 0], max: size }));
    hint.textContent = `Envelope ${formatSize(size, unit)}.`;
  } catch (err) {
    hint.textContent = (err as Error).message;
  }
  refresh();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
  b.addEventListener("click", () => selectTool(b.dataset["tool"] as Tool));
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-gizmo]")) {
  b.addEventListener("click", () => setGizmo(b.dataset["gizmo"] as "translate" | "rotate" | "scale"));
}

$("env-set").addEventListener("click", setEnvelopeFromInputs);
$("env-clear").addEventListener("click", () => {
  session.execute(setEnvelope(null));
  refresh();
});
$("env-fit").addEventListener("click", () => {
  try {
    session.execute(fitToEnvelope());
    hint.textContent = "Scaled down to fit the envelope.";
  } catch (err) {
    hint.textContent = (err as Error).message;
  }
  refresh();
});
$("env-centre").addEventListener("click", () => {
  try {
    session.execute(centreInEnvelope());
    hint.textContent = "Centred in the envelope.";
  } catch (err) {
    hint.textContent = (err as Error).message;
  }
  refresh();
});

for (const [button, command] of [
  ["op-union", "union"],
  ["op-subtract", "subtract"],
  ["op-intersect", "intersect"],
] as const) {
  $(button).addEventListener("click", () => runCommand(command));
}

function runArray(): void {
  const id = [...selection][0];
  if (!id) {
    hint.textContent = "Array: select one object first.";
    return;
  }
  const count = Math.trunc(Number(($("array-count") as HTMLInputElement).value));
  const step = parseLength(($("array-step") as HTMLInputElement).value, unit);
  const axis = ($("array-axis") as HTMLSelectElement).value;
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    hint.textContent = "Array: count must be a whole number from 1 to 500.";
    return;
  }
  if (!step || step.mm <= 0) {
    hint.textContent = "Array: step must be a positive length (e.g. 100, 60cm, 2in).";
    return;
  }
  const offset: Vec3 = [axis === "x" ? step.mm : 0, axis === "y" ? step.mm : 0, axis === "z" ? step.mm : 0];
  // One command, one undo step: an array is a single user intention.
  session.execute(arrayCopy(id, count, offset));
  hint.textContent = `Array: ${count} copies ${formatLength(step.mm, unit)} apart along ${axis.toUpperCase()}.`;
  refresh();
}

$("sel-array").addEventListener("click", () => {
  try {
    runArray();
  } catch (err) {
    hint.textContent = (err as Error).message;
    refresh();
  }
});

$("sel-duplicate").addEventListener("click", () => {
  const id = [...selection][0];
  if (!id) return;
  try {
    const patch = session.execute(duplicateSolid(id, [50, 50, 0]));
    const created = [...patch.forward.keys()];
    setSelection(created);
    hint.textContent = "Duplicated (50/50/0 mm).";
  } catch (err) {
    hint.textContent = (err as Error).message;
  }
  refresh();
});

$("save").addEventListener("click", saveProject);
$("export").addEventListener("click", exportStl);
$("open").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) openProject(file);
  (e.target as HTMLInputElement).value = "";
});

$("undo").addEventListener("click", () => runCommand("undo"));
$("redo").addEventListener("click", () => runCommand("redo"));
$("zoom").addEventListener("click", () => view.zoomExtents());

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

  // The palette owns the keyboard while it is open.
  if (palette.isOpen) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette.open();
    return;
  }

  // Typing a length beats every shortcut, or "2" would change the tool.
  if (tools.typeKey(e.key)) {
    e.preventDefault();
    return;
  }

  const typed = shortcutFor(e);
  if (typed) {
    e.preventDefault();
    runCommand(typed);
    return;
  }

  switch (e.key) {
    case "Escape":
      tools.cancel();
      setSelection([]);
      break;
    case "Delete":
    case "Backspace":
      runCommand("delete");
      break;
  }
});

/** The command a key event maps to, from the generated shortcut table. */
function shortcutFor(e: KeyboardEvent): CommandId | null {
  const key = e.key === " " ? " " : e.key;
  const mod = e.ctrlKey || e.metaKey;
  const wanted = [
    mod ? `Ctrl+${e.shiftKey ? "Shift+" : ""}${key.toUpperCase()}` : null,
    mod ? `Ctrl+${key.toUpperCase()}` : null,
    !mod && !e.altKey ? key.toLowerCase() : null,
  ].filter((k): k is string => k !== null);

  for (const candidate of wanted) {
    for (const [id, shortcut] of Object.entries(commandKeys)) {
      if (shortcut.toLowerCase() === candidate.toLowerCase()) return id as CommandId;
    }
  }
  return null;
}

view.renderer.domElement.addEventListener("pointermove", (e) => {
  cursor.x = e.clientX;
  cursor.y = e.clientY;
  if (e.buttons === 1 && tools.hasPending) tools.drag(e.clientX, e.clientY);
});
view.renderer.domElement.addEventListener("pointerup", () => {
  if (tools.hasPending) renderPanel();
});

/* ---------------------------------------------------------------- startup */

async function start(): Promise<void> {
  view.setTool("select");
  view.setGizmoMode(gizmoMode);
  try {
    await initKernel();
    refresh();
    hint.textContent = "Ready. Solid kernel online: booleans available.";
  } catch {
    refresh();
    hint.textContent = "Ready (solid kernel unavailable; booleans disabled).";
  }
  const demo = new URLSearchParams(location.search).get("demo") === "1";
  if (demo) {
    session.execute(setEnvelope({ min: [0, 0, 0], max: [600, 400, 300] }));
    session.execute(
      addSolid(
        {
          kind: "extrude",
          profile: { width: 600, height: 400 },
          normal: [0, 0, 1],
          origin: [0, 0, 0],
          distance: 300,
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        { name: "Carcass", color: "#e8b04b" },
      ),
    );
    session.execute(
      addSolid(
        {
          kind: "box",
          width: 200,
          height: 120,
          depth: 120,
          origin: [640, 0, 0],
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        { name: "Oversized shelf unit", color: "#e87f7f" },
      ),
    );
  }
  refresh();
  view.zoomExtents();
  if (!demo) hint.textContent = "Click the ground to draw a rectangle (R).";
}

void start();
