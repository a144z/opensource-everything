import "./style.css";
import * as THREE from "three";
import { formatLength, formatSize, parseLength, toStlAsciiNamed, type Vec3 } from "@apexus/geometry";
import {
  Annotation,
  AnnotationStore,
  Session,
  addSolid,
  ancestorsThroughGroups,
  arrayCopy,
  booleanSolids,
  bindShortcut,
  centreInEnvelope,
  commandAll,
  commandForEvent,
  commandKeys,
  commandLabels,
  deleteSolids,
  descendantsOf,
  deserializeJson,
  dimensionLength,
  drawnSolids,
  duplicateSolid,
  effectiveKeys,
  fitToEnvelope,
  groupSolids,
  instanceCopy,
  isCommand,
  isHiddenByAncestor,
  parseOverrides,
  renameSolid,
  rootsOf,
  serialiseOverrides,
  serializeJson,
  setColor,
  setEnvelope,
  setFinish,
  setMatrix,
  setMeta,
  setOpacity,
  setSection,
  setTag,
  setTagVisible,
  tagsInUse,
  ungroupSolid,
  type CommandId,
  type FitResult,
  type Solid,
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
let projection: "ortho" | "perspective" = "ortho";
const cursor = { x: 0, y: 0 };
/** Folded group ids: outliner view state, never persisted, never a command. */
const collapsed = new Set<SolidId>();
/**
 * The group the user is inside, or null at the model's top level.
 *
 * This is view state, not document state: entering a group changes what a click
 * means, not what the model is, so it must never enter the undo stack or the
 * file. It exists so a click can reach a member instead of being swallowed by
 * the group that owns it.
 */
let contextId: SolidId | null = null;

const view = new View(viewport, session, {
  onPick: (hit: PickHit, additive, copy) => {
    // A click inside a group means the member, not the group: resolve the hit
    // through the context so every tool (and the selection) sees the object the
    // user is actually pointing at. Outside the group the group is the object.
    const resolved = hit.kind === "solid" ? withContext(hit) : hit;
    tools.click(resolved, additive, cursor.x, cursor.y, copy ?? false);
    if (resolved.kind === "solid" && additive) setSelection([resolved.id], true);
    renderPanel();
  },
  onHover: (point) => tools.hover(point, cursor.x, cursor.y),
  onMarquee: (ids, additive) => {
    // Window/crossing drags *replace* the selection; Shift adds to it. A drag
    // selects a set at once, so it must never toggle like a Shift-click does.
    const next = new Set(additive ? [...selection, ...ids] : ids);
    selection = next;
    view.attachGizmo(next.size === 1 ? [...next][0]! : null);
    renderPanel();
    hint.textContent = ids.length === 0 ? "Drag selected nothing." : `Selected ${next.size} object(s).`;
  },
  onGizmoCommit: (id, matrix) => {
    try {
      session.execute(setMatrix([id], matrix));
      hint.textContent = "Transformed.";
    } catch (err) {
      hint.textContent = (err as Error).message;
    }
    refresh();
  },
  onEnter: (id) => enterGroup(id),
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
  erase: (ids) => {
    session.execute(deleteSolids(ids));
    setSelection([...selection].filter((id) => !ids.includes(id)));
    hint.textContent = `Erased ${ids.length} object(s).`;
    refresh();
  },
  paintColor: () => paintColor,
  transformBlocked: (id) => {
    const verdict = view.canTransform(id);
    return verdict.ok ? null : verdict.reason;
  },
  painted: (id, color) => {
    // Paint is the one tool that colours without a selection, so it must not
    // disturb what is already selected.
    session.execute(setColor([id], color));
    hint.textContent = `Painted ${color}.`;
    refresh();
  },
});

/** The bucket's current colour. A paint tool needs a held colour to be a tool. */
let paintColor = "#d64541";

/* ----------------------------------------------------------- materials */

const MATERIALS_KEY = "fitcheck.materials";

/** Colours the user saved. Seeded with a usable set so the strip is never empty. */
let materials: string[] = (() => {
  try {
    const raw = localStorage.getItem(MATERIALS_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(saved)) {
      const clean = saved.filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c));
      if (clean.length > 0) return clean.slice(0, 24);
    }
  } catch {
    // Corrupt or unavailable storage falls back to the defaults below.
  }
  return ["#d64541", "#f0a500", "#2e8b57", "#2f6f9f", "#d9d9d9", "#3b3b3b"];
})();

function saveMaterials(): void {
  try {
    localStorage.setItem(MATERIALS_KEY, JSON.stringify(materials));
  } catch {
    // Storage full or blocked: the strip still works this session.
  }
}

function setPaintColor(color: string): void {
  paintColor = color;
  ($("paint-color") as HTMLInputElement).value = color;
}

/** Clicking a swatch both picks the colour *and* paints the selection, as a bucket should. */
function useMaterial(color: string): void {
  setPaintColor(color);
  const ids = [...selection];
  if (ids.length === 0) {
    hint.textContent = `Bucket now holds ${color}. Click objects with the Paint tool.`;
    return;
  }
  quietly(() => session.execute(setColor(ids, color)), `Painted ${ids.length} object(s) ${color}.`);
}

function renderMaterials(): void {
  const strip = $("swatches");
  strip.replaceChildren();
  for (const color of materials) {
    const b = document.createElement("button");
    b.className = "swatch-chip";
    b.style.background = color;
    b.title = `${color}: paint the selection`;
    b.dataset["color"] = color;
    if (color === paintColor) b.classList.add("active");
    b.addEventListener("click", () => useMaterial(color));
    strip.append(b);
  }
}

$("paint-color").addEventListener("change", () =>
  setPaintColor(($("paint-color") as HTMLInputElement).value),
);
$("paint-add").addEventListener("click", () => {
  const color = ($("paint-color") as HTMLInputElement).value.toLowerCase();
  if (!materials.includes(color)) materials = [color, ...materials].slice(0, 24);
  saveMaterials();
  renderMaterials();
  hint.textContent = `Saved ${color} to materials.`;
});
$("paint-apply").addEventListener("click", () => useMaterial(paintColor));


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
/**
 * Map a hit on a drawn mesh onto the object the current context points at.
 *
 * Meshes exist only for drawn solids, so a click always lands on a root or a
 * referenced child. Inside a group the user means the member under the cursor,
 * so walk the group's members and keep the innermost one whose bounds contain
 * the hit point. The point is the ray's impact on the group's surface, so a
 * member the user can see is a member that contains it; the innermost wins when
 * a child sits inside its parent's box, which is the one on top.
 */
function withContext(hit: Extract<PickHit, { kind: "solid" }>): PickHit {
  if (contextId === null) return hit;
  const doc = session.document;
  let current = doc.solids.get(hit.id);
  if (!current || current.recipe.kind !== "group") return hit;
  let best: SolidId | null = null;
  // Descend while the object under the point is still a group. Each level
  // prefers the member that owns the context, so following the user into a
  // nested group keeps landing on the objects they are working with.
  for (;;) {
    const recipe = current.recipe;
    if (recipe.kind !== "group") break;
    const under = recipe.members.filter((m) => boundsContain(session.boundsOf(m), hit.point));
    if (under.length === 0) break;
    const next = under.find((m) => m === contextId || descendantsOf(doc, m).includes(contextId!)) ?? under[0]!;
    best = next;
    const child = doc.solids.get(next);
    if (!child) break;
    current = child;
  }
  if (best === null) return hit;
  return { ...hit, id: best };
}

/** Inclusive containment with a hair of slack for float noise at a face. */
function boundsContain(b: { min: readonly number[]; max: readonly number[] }, p: readonly number[]): boolean {
  const slack = 1e-6;
  for (let i = 0; i < 3; i++) {
    if (p[i]! < b.min[i]! - slack || p[i]! > b.max[i]! + slack) return false;
  }
  return true;
}

/**
 * Double-click a group to stand inside it. A double-click on something that is
 * not a group, or on a member, leaves the context alone rather than resetting
 * it: the user's mistake should not throw them out of where they were working.
 */
function enterGroup(id: SolidId): void {
  const solid = session.document.solids.get(id);
  if (!solid || solid.recipe.kind !== "group" || solid.recipe.members.length === 0) return;
  contextId = id;
  collapsed.delete(id);
  hint.textContent = `Inside "${solid.meta.name}". Escape to step out.`;
  refresh();
}

/**
 * Step out one level. At the top level Escape clears the selection, which is
 * what it does in every other tool; the two never fight because a context only
 * exists after a double-click.
 */
function leaveGroup(): void {
  if (contextId === null) return;
  const owner = ancestorsThroughGroups(session.document, contextId)[0] ?? null;
  contextId = owner;
  const name = owner ? session.document.solids.get(owner)?.meta.name : null;
  hint.textContent = owner ? `Inside "${name}".` : "Back at the model.";
  refresh();
}

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

/**
 * One outliner row. Everything here is a command, so every row action is one
 * undo step and shows up in the palette and the history alike.
 *
 * `collapsed` is outliner view state: folded groups, remembered for the session.
 */
function outlinerRow(solid: Solid, depth = 0): HTMLLIElement {
  const li = document.createElement("li");
  li.className = selection.has(solid.id) ? "selected" : "";
  if (solid.meta.hidden) li.classList.add("hidden");
  if (solid.meta.locked) li.classList.add("locked");
  li.dataset["id"] = solid.id;
  li.style.setProperty("--depth", String(depth));

  const swatch = document.createElement("input");
  swatch.type = "color";
  swatch.className = "swatch";
  swatch.value = solid.meta.color;
  swatch.title = "Colour";
  swatch.addEventListener("click", (e) => e.stopPropagation());
  swatch.addEventListener("change", () =>
    quietly(() => session.execute(setColor([solid.id], swatch.value)), "Colour changed."),
  );

  // A group row says so, and its triangle folds the tree. Folding is view state
  // only (`collapsed`), deliberately not a command: a folded group is not an
  // editable fact and must not land in the undo stack or the project file.
  const members = solid.recipe.kind === "group" ? solid.recipe.members : [];
  const folded = collapsed.has(solid.id);
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.title = members.length > 0 ? (folded ? "Expand group" : "Collapse group") : "Group";
  chip.textContent = members.length === 0 ? "G" : folded ? "\u25b8" : "\u25be";
  chip.disabled = members.length === 0;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (folded) collapsed.delete(solid.id);
    else collapsed.add(solid.id);
    renderPanel();
  });

  const label = document.createElement("span");
  label.className = "name";
  label.textContent = `${solid.meta.name} - ${(session.analyse(solid.id).volume / 1000).toFixed(1)} cm3`;
  label.title = "Double-click to rename";
  label.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    beginRename(li, solid);
  });

  const eye = iconButton(solid.meta.hidden ? "Shown" : "Hide", solid.meta.hidden ? "+" : "-", () => {
    quietly(() => session.execute(setMeta(solid.id, { hidden: !solid.meta.hidden }, solid.meta.hidden ? "Show" : "Hide")));
  });
  const lock = iconButton(solid.meta.locked ? "Unlock" : "Lock", solid.meta.locked ? "L" : "u", () => {
    quietly(() =>
      session.execute(setMeta(solid.id, { locked: !solid.meta.locked }, solid.meta.locked ? "Unlock" : "Lock")),
    );
  });

  li.append(chip, swatch, label, eye, lock);
  li.addEventListener("click", () => setSelection([solid.id], true));

  // Children are rows in their own right inside the group's <li>, so a click
  // still bubbles to the group row's handler and selects exactly what was hit.
  if (members.length > 0 && !folded) {
    const kids = document.createElement("ul");
    kids.className = "children";
    for (const member of members) {
      const child = session.document.solids.get(member);
      if (child) kids.append(outlinerRow(child, depth + 1));
    }
    li.append(kids);
  }
  return li;
}

/**
 * Tag groups in display order, each keeping document order inside it.
 * Untagged objects come last under their own heading; with no tags at all the
 * outliner stays a plain list, exactly as before groups existed.
 */
function groupByTag(solids: Iterable<Solid>): Map<string | null, Solid[]> {
  const groups = new Map<string | null, Solid[]>();
  let tagged = false;
  for (const solid of solids) {
    if (solid.meta.tag !== "") tagged = true;
    const key = solid.meta.tag === "" ? null : solid.meta.tag;
    const list = groups.get(key);
    if (list) list.push(solid);
    else groups.set(key, [solid]);
  }
  if (!tagged) return new Map([[null, [...solids]]]);
  // Named tags first, alphabetically, then whatever has no tag.
  const ordered = new Map<string | null, Solid[]>();
  for (const key of [...groups.keys()].filter((k): k is string => k !== null).sort((a, b) => a.localeCompare(b))) {
    ordered.set(key, groups.get(key)!);
  }
  const loose = groups.get(null);
  if (loose) ordered.set(null, loose);
  return ordered;
}

/** Run a mutation and report its failure in the hint line; never throws at the UI. */
function quietly(action: () => void, done?: string): void {
  try {
    action();
    if (done) hint.textContent = done;
  } catch (err) {
    hint.textContent = (err as Error).message;
  }
  refresh();
}

function iconButton(title: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon";
  b.title = title;
  b.textContent = glyph;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Swap the name span for an input; Enter commits, Escape and blur cancel. */
function beginRename(row: HTMLLIElement, solid: Solid): void {
  const name = row.querySelector<HTMLSpanElement>(".name");
  if (!name) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = solid.meta.name;
  input.maxLength = 80;
  let finished = false;
  const finish = (commit: boolean): void => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (commit && next && next !== solid.meta.name) {
      quietly(() => session.execute(renameSolid(solid.id, next)), `Renamed to "${next}".`);
    } else {
      refresh(); // put the row back as it was
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // tool shortcuts must not fire while typing a name
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  name.replaceWith(input);
  input.focus();
  input.select();
}

function renderPanel(): void {
  const doc = session.document;
  // The command list is published on the panel so a headless check can prove the
  // palette and the toolbar are backed by the generated table, not by literals.
  $("panel").dataset["commands"] = commandAll.join(",");
  const outliner = $("outliner");
  outliner.innerHTML = "";
  // Nesting is real now: a group owns its members, so the tree mirrors the
  // document. Tag headings stay at the top level only, because a tag is a
  // label on an object, not a container that can hold other objects.
  for (const [tag, solids] of groupByTag(rootsOf(doc).map((id) => doc.solids.get(id)!).filter(Boolean))) {
    if (tag !== null) {
      const head = document.createElement("li");
      head.className = "group";
      head.textContent = `${tag || "Untagged"} (${solids.length})`;
      outliner.append(head);
    }
    for (const solid of solids) outliner.append(outlinerRow(solid));
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
  ($("proj-ortho") as HTMLButtonElement).classList.toggle("active", projection === "ortho");
  ($("proj-persp") as HTMLButtonElement).classList.toggle("active", projection === "perspective");
  ($("style-shaded") as HTMLButtonElement).classList.toggle("active", view.style === "shaded");
  ($("style-hidden") as HTMLButtonElement).classList.toggle("active", view.style === "hiddenLine");
  ($("style-edges") as HTMLButtonElement).classList.toggle("active", view.style === "edges");
  ($("toggle-shadows") as HTMLButtonElement).classList.toggle("active", view.shadows);
  ($("toggle-axes") as HTMLButtonElement).classList.toggle("active", view.axesVisible);
  const enabled = selection.size >= 1;
  ($("sel-array") as HTMLButtonElement).disabled = !enabled;
  ($("sel-duplicate") as HTMLButtonElement).disabled = !enabled;
  ($("sel-instance") as HTMLButtonElement).disabled = !enabled;
  ($("sel-group") as HTMLButtonElement).disabled = !enabled;
  ($("sel-ungroup") as HTMLButtonElement).disabled = !commandEnabled("ungroup");
  ($("sel-explode") as HTMLButtonElement).disabled = !commandEnabled("explode");
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
  // The opacity slider follows the selection, so it never claims a value the
  // selected object does not have.
  const slider = $("opacity") as HTMLInputElement;
  const first = sel ? session.document.solids.get(sel) : undefined;
  slider.value = String(Math.round((first?.meta.opacity ?? 1) * 100));
  slider.disabled = selection.size === 0;
  // Finish follows the selection for the same reason: two sliders that read
  // "rough 75, metal 0" on a chrome object would be lying about the model.
  const rough = $("roughness") as HTMLInputElement;
  const metal = $("metallic") as HTMLInputElement;
  rough.value = String(Math.round((first?.meta.roughness ?? 0.75) * 100));
  metal.value = String(Math.round((first?.meta.metallic ?? 0) * 100));
  rough.disabled = selection.size === 0;
  metal.disabled = selection.size === 0;
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
  const doc = session.document;
  // Drawn solids only: a group is checked once as a group, not again per member,
  // or one overrun would redden the same box three times.
  for (const id of drawnSolids(doc)) {
    const solid = doc.solids.get(id);
    if (!solid || solid.meta.hidden || isHiddenByAncestor(doc, id)) continue;
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
  const doc = session.document;
  // Only drawn solids, or a grouped object would be written twice: once on its
  // own and once inside its group.
  for (const id of drawnSolids(doc)) {
    const solid = doc.solids.get(id);
    if (!solid || solid.meta.hidden || isHiddenByAncestor(doc, id)) continue;
    parts.push({ name: solid.meta.name.replace(/[^A-Za-z0-9_-]/g, "_"), mesh: session.meshOf(id) });
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
  // A context can be undone away (delete, ungroup, then Ctrl+Z). Rather than
  // trusting every command to remember, check here: a context that no longer
  // names a live group is dropped, so a click can never be routed into nothing.
  if (contextId !== null) {
    const ctx = session.document.solids.get(contextId);
    if (!ctx || ctx.recipe.kind !== "group") contextId = null;
  }
  view.sync();
  renderPanel();
  renderTags();
  renderMaterials();
}

/** Rebuild the tag list: one row per tag, with show/hide and a count. */
function renderTags(): void {
  const list = $("tags");
  const rows = tagsInUse(session.document);
  // A tag with no members is invisible to `tagsInUse`, so the name in the box
  // is shown as a zero-object row: the user's own entry is never lost.
  const pending = ($("tag-name") as HTMLInputElement).value.trim();
  if (pending !== "" && !rows.some((r) => r.tag === pending)) rows.push({ tag: pending, total: 0, hidden: 0 });
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = row.tag;
      name.title = `${row.total} object(s), ${row.hidden} hidden`;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = row.hidden === 0 ? `${row.total}` : `${row.total} (${row.hidden} hidden)`;
      const toggle = iconButton(row.hidden === row.total ? "Show tag" : "Hide tag", row.hidden === row.total ? "+" : "-", () =>
        quietly(
          () => session.execute(setTagVisible(row.tag, row.hidden === row.total)),
          row.hidden === row.total ? `Tag "${row.tag}" shown.` : `Tag "${row.tag}" hidden.`,
        ),
      );
      li.append(name, count, toggle);
      li.addEventListener("click", () => {
        const ids = [...session.document.solids.values()].filter((s) => s.meta.tag === row.tag).map((s) => s.id);
        setSelection(ids);
      });
      return li;
    }),
  );
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No tags yet";
    list.append(li);
  }
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
      case "scale":
      case "paint":
      case "eraser":
      case "rotatedRectangle":
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
      case "instance": {
        const first = [...selection][0];
        if (!first) {
          hint.textContent = "Make Instance: select something first.";
          return;
        }
        const patch = session.execute(instanceCopy(first, [200, 0, 0]));
        setSelection([...patch.forward.keys()]);
        hint.textContent = "Instance made (200 mm to the right); edit the source and this follows.";
        refresh();
        return;
      }
      case "array":
        runArray();
        return;
      case "group": {
        const ids = [...selection];
        if (ids.length === 0) {
          hint.textContent = "Make Group: select something first.";
          return;
        }
        const patch = session.execute(groupSolids(ids));
        // A new solid is exactly the one whose backward entry is null; that is
        // the patch's own definition, so no snapshotting is needed.
        const created = [...patch.backward].filter(([, s]) => s === null).map(([k]) => k).find((k) => !ids.includes(k));
        // Selecting the new group is what lets the user name it or move it next;
        // leaving the children selected would move them out of the group's idea
        // of "together" on the very next drag.
        setSelection(created ? [created] : []);
        hint.textContent = `Grouped ${ids.length} object(s).`;
        refresh();
        return;
      }
      case "ungroup": {
        const groups = [...selection].filter((id) => session.document.solids.get(id)?.recipe.kind === "group");
        if (groups.length === 0) {
          hint.textContent = "Ungroup: select a group first.";
          return;
        }
        session.batch(groups.map((id) => ungroupSolid(id)));
        // The wrapper ids are gone; selecting them would leave a phantom
        // selection that the next Delete would silently ignore.
        setSelection([]);
        hint.textContent = `Ungrouped ${groups.length} group(s).`;
        refresh();
        return;
      }
      case "explode": {
        const groups = [...selection].filter((id) => session.document.solids.get(id)?.recipe.kind === "group");
        if (groups.length === 0) {
          hint.textContent = "Explode: select a group first.";
          return;
        }
        // Explode is ungroup applied to the group's groups, one level deep: the
        // exact command the user would type twice is not run twice, because the
        // second pass would silently remove a level they did not ask for.
        const inner = groups.flatMap((id) => {
          const recipe = session.document.solids.get(id)?.recipe;
          return recipe?.kind === "group"
            ? recipe.members.filter((m) => session.document.solids.get(m)?.recipe.kind === "group")
            : [];
        });
        if (inner.length === 0) {
          hint.textContent = "Explode: no nested groups inside the selection.";
          return;
        }
        session.batch(inner.map((id) => ungroupSolid(id)));
        hint.textContent = `Exploded ${inner.length} nested group(s).`;
        refresh();
        return;
      }
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
      case "viewIso":
      case "viewTop":
      case "viewFront":
      case "viewRight":
      case "viewBack":
      case "viewLeft":
      case "viewBottom":
        view.standardView(id.slice(4).toLowerCase() as "iso" | "top" | "front" | "right" | "back" | "left" | "bottom");
        hint.textContent = `${commandLabels[id]} view.`;
        renderPanel();
        return;
      case "zoomExtents":
        view.zoomExtents();
        hint.textContent = "Framed the model.";
        return;
      case "projectionOrtho":
      case "projectionPersp":
        setProjection(id === "projectionPersp" ? "perspective" : "ortho");
        return;
      case "viewShaded":
      case "viewHiddenLine":
      case "viewEdges":
        setStyle(id === "viewShaded" ? "shaded" : id === "viewHiddenLine" ? "hiddenLine" : "edges");
        return;
      case "toggleShadows":
        setShadows(!view.shadows);
        return;
      case "toggleAxes":
        setAxes(!view.axesVisible);
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
    case "instance":
      return count >= 1;
    case "scale":
      // Scaling needs a pivot, so it needs something selected to be useful.
      return count >= 1;
    case "union":
    case "subtract":
    case "intersect":
      return count === 2;
    case "group":
      return count >= 1;
    case "ungroup":
    case "explode":
      return [...selection].some((id) => session.document.solids.get(id)?.recipe.kind === "group");
    default:
      return true;
  }
}

function selectTool(tool: Tool): void {
  tools.setTool(tool);
  renderPanel();
}

const palette = new CommandPalette({
  run: runCommand,
  enabled: commandEnabled,
  keys: () => keys,
  rebind: (id, spec) => {
    // The keymap lives outside the undo stack on purpose: a shortcut is not part
    // of the model, and Ctrl+Z after rebinding must undo the last edit, not the
    // rebind.
    const result = bindShortcut(commandKeys, overrides, id, spec);
    if (!result.ok) {
      if (result.reason === "taken") {
        const who = result.holder ? commandLabels[result.holder as CommandId] : "another command";
        return { ok: false, message: `${spec} is already used by ${who}.` };
      }
      if (result.reason === "reserved") return { ok: false, message: `${spec} belongs to the browser.` };
      return { ok: false, message: "That key cannot be used." };
    }
    overrides = result.overrides;
    saveKeymap();
    hint.textContent = `${commandLabels[id]} is now ${spec}.`;
    return { ok: true };
  },
});

function setGizmo(mode: "translate" | "rotate" | "scale"): void {
  gizmoMode = mode;
  view.setGizmoMode(mode);
  renderPanel();
}

/**
 * Switch lens. The renderer keeps orbiting the same target, so this is the
 * cheap, reversible half of the View commands; the toolbar buttons and the
 * palette both route here rather than touching the camera themselves.
 */
function setProjection(kind: "ortho" | "perspective"): void {
  view.setProjection(kind);
  projection = kind;
  hint.textContent = kind === "ortho" ? "Orthographic projection." : "Perspective projection.";
  renderPanel();
}

/** Drawing style: shaded, hidden line or edges only. */
function setStyle(style: "shaded" | "hiddenLine" | "edges"): void {
  view.setStyle(style);
  hint.textContent =
    style === "shaded" ? "Shaded style." : style === "hiddenLine" ? "Hidden line style." : "Edges only.";
  renderPanel();
}

function setShadows(on: boolean): void {
  view.setShadows(on);
  hint.textContent = on ? "Shadows on." : "Shadows off.";
  renderPanel();
}

function setAxes(on: boolean): void {
  view.setAxesVisible(on);
  hint.textContent = on ? "Axes shown." : "Axes hidden.";
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
// View buttons are shortcuts for palette commands, so the two cannot disagree.
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  b.addEventListener("click", () => {
    const name = b.dataset["view"] as "iso" | "top" | "front" | "right" | "back" | "left" | "bottom";
    runCommand(`view${name[0]!.toUpperCase()}${name.slice(1)}` as CommandId);
  });
}
$("zoom-extents").addEventListener("click", () => runCommand("zoomExtents"));
$("proj-ortho").addEventListener("click", () => runCommand("projectionOrtho"));
$("proj-persp").addEventListener("click", () => runCommand("projectionPersp"));
// Style, shadow and axis buttons are the same commands the palette runs.
$("style-shaded").addEventListener("click", () => runCommand("viewShaded"));
$("style-hidden").addEventListener("click", () => runCommand("viewHiddenLine"));
$("style-edges").addEventListener("click", () => runCommand("viewEdges"));
$("toggle-shadows").addEventListener("click", () => runCommand("toggleShadows"));
$("toggle-axes").addEventListener("click", () => runCommand("toggleAxes"));

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

$("opacity").addEventListener("change", () => {
  const ids = [...selection];
  if (ids.length === 0) {
    hint.textContent = "Opacity: select something first.";
    return;
  }
  const percent = Number(($("opacity") as HTMLInputElement).value);
  quietly(() => session.execute(setOpacity(ids, percent / 100)), `Opacity ${percent}%.`);
});

/** Both finish sliders write together, so a drag of one never resets the other. */
function applyFinish(): void {
  const ids = [...selection];
  if (ids.length === 0) {
    hint.textContent = "Finish: select something first.";
    return;
  }
  const rough = Number(($("roughness") as HTMLInputElement).value) / 100;
  const metal = Number(($("metallic") as HTMLInputElement).value) / 100;
  quietly(() => session.execute(setFinish(ids, rough, metal)), `Finish: rough ${Math.round(rough * 100)}%, metal ${Math.round(metal * 100)}%.`);
}
$("roughness").addEventListener("change", applyFinish);
$("metallic").addEventListener("change", applyFinish);
$("sel-instance").addEventListener("click", () => runCommand("instance"));
$("sel-group").addEventListener("click", () => runCommand("group"));
$("sel-ungroup").addEventListener("click", () => runCommand("ungroup"));
$("sel-explode").addEventListener("click", () => runCommand("explode"));
$("keys-open").addEventListener("click", () => palette.open());

$("tag-apply").addEventListener("click", () => {
  const ids = [...selection];
  if (ids.length === 0) {
    hint.textContent = "Tag: select something first.";
    return;
  }
  const name = ($("tag-name") as HTMLInputElement).value.trim();
  quietly(() => session.execute(setTag(ids, name)), name === "" ? "Tag cleared." : `Tagged "${name}".`);
});

$("section-apply").addEventListener("click", () => {
  const axis = ($("section-axis") as HTMLSelectElement).value as "x" | "y" | "z";
  const at = parseLength(($("section-at") as HTMLInputElement).value, unit);
  if (!at) {
    hint.textContent = "Section: the cut position must be a length (e.g. 0, 30cm, 2in).";
    return;
  }
  quietly(
    () => session.execute(setSection({ axis, offset: at.mm, flip: false })),
    `Cut at ${axis.toUpperCase()} = ${formatLength(at.mm, unit)}.`,
  );
});

$("section-clear").addEventListener("click", () => quietly(() => session.execute(setSection(null)), "Section cleared."));

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
$("zoom").addEventListener("click", () => runCommand("zoomExtents"));

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
      // A tool's own cancel comes first: Escape should end the half-drawn
      // rectangle, not also throw the user out of the group they are editing.
      if (tools.hasPending) {
        tools.cancel();
      } else if (contextId !== null) {
        leaveGroup();
      } else {
        setSelection([]);
      }
      break;
    case "Delete":
    case "Backspace":
      runCommand("delete");
      break;
  }
});

/**
 * The user's keymap: generated defaults plus whatever they rebound, kept in
 * `localStorage` so a rebound key survives a reload. `keys` is the live table
 * every lookup uses; `commandKeys` is only ever the shipped default.
 */
const KEYMAP_KEY = "fitcheck.keymap.v1";
let overrides = parseOverrides(localStorage.getItem(KEYMAP_KEY));
let keys: Record<string, string | undefined> = effectiveKeys(commandKeys, overrides);

function saveKeymap(): void {
  keys = effectiveKeys(commandKeys, overrides);
  localStorage.setItem(KEYMAP_KEY, serialiseOverrides(overrides));
}

/** The command a key event maps to, from the user's keymap. */
function shortcutFor(e: KeyboardEvent): CommandId | null {
  return commandForEvent(keys, e) as CommandId | null;
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

/* -------------------------------------------------------------- harness */

/**
 * A narrow testing surface for `scripts/smoke.mjs`. It exposes *intent*
 * (run a command, add a starter box) and *observations* (colours, undo depth),
 * never a second way to mutate the document: every write below goes through
 * `runCommand` or `session.execute`. With VITE_STRICT_HARNESS unset it is always
 * attached, because the smoke test is the guard that proves the toolbar, the
 * keyboard and the palette stay wired.
 */
interface FitCheckHarness {
  run(id: CommandId): boolean;
  addBox(size: { width: number; height: number; depth: number }): boolean;
  paintFirst(color: string): boolean;
  solids(): { id: string; name: string; color: string }[];
  undoCount(): number;
  /** Select every top-level object, the way a marquee over all of it would. */
  selectAll(): number;
  /** Group/ungroup observations: what the outliner draws and what is inside. */
  groups(): { id: string; name: string; members: string[]; rows: number }[];
  /** How many outliner rows the tree currently shows, nesting included. */
  outlinerRows(): number;
  /** The group the user is editing, or null. */
  context(): string | null;
  /** Simulated double-click on a group, through the same handler as the mouse. */
  enter(id: string): boolean;
  /** Escape, through the same handler as the keyboard. */
  escape(): void;
  /** Type a string into the tool as if through the keyboard, then optionally Enter. */
  typeText(text: string, enter: boolean): void;
  /** Bounds minimum of a solid, in mm, so a move can be measured. */
  minOf(id: string): number[] | null;
  /** [minX,minY,minZ,maxX,maxY,maxZ] of a solid, in mm. */
  boundsOf(id: string): number[];
  /** ids of every top-level object. */
  rootIds(): string[];
  /** Select exactly one object. */
  selectOnly(id: string): void;
  /** Choose a tool exactly as the toolbar button does. */
  useTool(tool: string): void;
  /** The stored keymap text, or null, so persistence can be checked. */
  keymapStorage(): string | null;
  /** Rebind through the same path the palette uses. */
  rebind(id: string, spec: string): { ok: boolean; message?: string };
  /** Press a key through the app's real handler (not the harness shortcut). */
  pressKey(key: string, mods?: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): void;
  /** What shortcut a given key would now run, if any. */
  commandForKey(key: string, mods?: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): string | null;
}

declare global {
  interface Window {
    fitcheck?: FitCheckHarness;
  }
}

window.fitcheck = {
  run(id) {
    if (!isCommand(id)) return false;
    runCommand(id);
    return true;
  },
  addBox(size) {
    try {
      session.execute(
        addSolid(
          {
            kind: "box",
            width: size.width,
            height: size.height,
            depth: size.depth,
            origin: [0, 0, 0],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          { name: "Probe box" },
        ),
      );
      refresh();
      return true;
    } catch {
      return false;
    }
  },
  paintFirst(color) {
    const first = [...session.document.solids.values()][0];
    if (!first) return false;
    setPaintColor(color);
    session.execute(setColor([first.id], color));
    refresh();
    return true;
  },
  solids: () =>
    [...session.document.solids.values()].map((s) => ({ id: s.id, name: s.meta.name, color: s.meta.color })),
  undoCount: () => session.historyDepth,
  selectAll() {
    const roots = rootsOf(session.document);
    setSelection(roots);
    return roots.length;
  },
  groups: () =>
    [...session.document.solids.values()]
      .filter((s) => s.recipe.kind === "group")
      .map((s) => ({
        id: s.id,
        name: s.meta.name,
        members: s.recipe.kind === "group" ? [...s.recipe.members] : [],
        rows: document.querySelectorAll("#outliner li[data-id]").length,
      })),
  outlinerRows: () => document.querySelectorAll("#outliner li[data-id]").length,
  context: () => contextId,
  enter(id) {
    enterGroup(id);
    return contextId === id;
  },
  escape() {
    if (tools.hasPending) {
      tools.cancel();
    } else if (contextId !== null) {
      leaveGroup();
    } else {
      setSelection([]);
    }
  },
  typeText(text, enter) {
    for (const ch of text) tools.typeKey(ch);
    if (enter) tools.typeKey("Enter");
  },
  minOf(id) {
    const solid = session.document.solids.get(id as SolidId);
    if (!solid) return null;
    const b = session.boundsOf(solid.id);
    return [...b.min];
  },
  rootIds: () => rootsOf(session.document),
  selectOnly(id) {
    setSelection([id as SolidId]);
  },
  boundsOf(id) {
    const solid = session.document.solids.get(id as SolidId);
    if (!solid) return [0, 0, 0, 0, 0, 0];
    const b = session.boundsOf(solid.id);
    return [...b.min, ...b.max];
  },  useTool(tool) {
    runCommand(tool as CommandId);
  },
  keymapStorage: () => localStorage.getItem(KEYMAP_KEY),
  rebind: (id, spec) => {
    const result = bindShortcut(commandKeys, overrides, id, spec);
    if (!result.ok) {
      return { ok: false, message: result.reason === "taken" ? `${spec} is taken.` : `${spec} cannot be used.` };
    }
    overrides = result.overrides;
    saveKeymap();
    return { ok: true };
  },
  pressKey(key, mods) {
    const e = new KeyboardEvent("keydown", {
      key,
      ctrlKey: mods?.ctrlKey ?? false,
      shiftKey: mods?.shiftKey ?? false,
      altKey: mods?.altKey ?? false,
      bubbles: true,
    });
    window.dispatchEvent(e);
  },
  commandForKey: (key, mods) => {
    const bindable = {
      key,
      ctrlKey: mods?.ctrlKey ?? false,
      shiftKey: mods?.shiftKey ?? false,
      altKey: mods?.altKey ?? false,
      metaKey: false,
    };
    return commandForEvent(keys, bindable);
  },
};

