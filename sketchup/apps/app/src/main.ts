import "./style.css";
import * as THREE from "three";
import { parseLength, polygonArea, toStlAsciiNamed, type Vec3 } from "@apexus/geometry";
import {
  Session,
  addSolid,
  arrayCopy,
  booleanSolids,
  bindShortcut,
  centreInEnvelope,
  commandAll,
  commandForEvent,
  commandKeys,
  commandLabels,
  componentsOf,
  definitionName,
  deleteSolids,
  deserializeJson,
  detachDefinition,
  drawnSolids,
  duplicateSolid,
  effectiveKeys,
  fitToEnvelope,
  groupSolids,
  instanceCopy,
  isCommand,
  isHiddenByAncestor,
  makeComponent,
  parseOverrides,
  renameDefinition,
  renameSolid,
  rootsOf,
  serialiseOverrides,
  serializeJson,
  selectByLasso,
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
import { MaterialsPanel } from "./materials.js";
import { AnnotationLayer } from "./annotations.view.js";
import { formatLengthIn, formatSizeIn, isUnit, UNIT_MENU, type Unit } from "./display.js";
import { statusLine } from "./measure.js";
import { formatOf, readImport } from "./importers.js";
import { applyImport } from "./applyImport.js";
import { Autosave, clearDraft, describeDraft, draftWorthOffering, readDraft, writeDraft } from "./draft.js";
import {
  applyPick,
  canEnter,
  contextAfterExit,
  resolveHit,
  sanitiseContext,
  pruneSelection,
  soleSelection,
} from "./selection.js";

/**
 * Composition root: wires engine <-> kernel <-> view <-> tools <-> DOM.
 *
 * This file owns three things and no others (ADR 0006):
 *
 *   1. **instances** — the session, the view, the panels, created once, in order;
 *   2. **wiring** — the ports each actor is handed, and the one `refresh()` that
 *      tells everyone the model changed;
 *   3. **dispatch** — `runCommand(id)`, the single place an id becomes an effect,
 *      shared by the toolbar, the keyboard and the palette.
 *
 * Anything with a rule of its own is a module: selection and group context in
 * `selection.ts`, the material strip in `materials.ts`, dimensions in
 * `annotations.view.ts`, picking in `view.ts`, gestures in `tools.ts`. The
 * dependency direction is one way — this file imports them, never the reverse —
 * so a module can be read and tested on its own.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/** Where the display unit is remembered. Same browser-invisible class of state as the keymap. */
const UNIT_KEY = "fitcheck.unit.v1";

/* -------------------------------------------------------------- session */

const session = new Session({ idPrefix: "o" });
const viewport = $("viewport");
const hint = $("hint");
const snapper = new Snapper(session);
/**
 * The display unit. View state, never document state: it changes how a number
 * reads and what a bare typed number means, not what the model is, so it is
 * neither saved into `.fcproj` nor an undo step. It *is* remembered per browser,
 * which is the one part of it that survives a reload.
 */
let unit: Unit = readStoredUnit();

function readStoredUnit(): Unit {
  try {
    const stored = localStorage.getItem(UNIT_KEY);
    return stored !== null && isUnit(stored) ? stored : "mm";
  } catch {
    return "mm";
  }
}
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
  onHover: (point, shift) => {
    // Modifiers reach the tool before the move, so a Shift-held rectangle is
    // already square on the very frame the key goes down.
    tools.setModifiers({ shift });
    tools.hover(point, cursor.x, cursor.y);
    renderHint();
  },
  onMarquee: (ids, additive) => {
    // Window/crossing drags *replace* the selection; Shift adds to it. A drag
    // selects a set at once, so it must never toggle like a Shift-click does.
    const next = new Set(additive ? [...selection, ...ids] : ids);
    selection = next;
    view.attachGizmo(next.size === 1 ? [...next][0]! : null);
    renderPanel();
    setHint(ids.length === 0 ? "Drag selected nothing." : `Selected ${next.size} object(s).`);
  },
  onGizmoCommit: (id, matrix) => {
    try {
      session.execute(setMatrix([id], matrix));
      setHint("Transformed.");
    } catch (err) {
      setHint((err as Error).message);
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
    setHint(text);
  },
  select: (ids, additive) => setSelection(ids, additive ?? false),
  cursor: () => cursor,
  unit: () => unit,
  axisLocked: () => view.axisLocked,
  annotate: (note) => {
    annotations.store.add(note);
    annotations.render();
  },
  selection: () => [...selection],
  erase: (ids) => {
    session.execute(deleteSolids(ids));
    setSelection([...selection].filter((id) => !ids.includes(id)));
    setHint(`Erased ${ids.length} object(s).`);
    refresh();
  },
  paintColor: () => materials.paintColor,
  transformBlocked: (id) => {
    const verdict = view.canTransform(id);
    return verdict.ok ? null : verdict.reason;
  },
  painted: (id, color) => {
    // Paint is the one tool that colours without a selection, so it must not
    // disturb what is already selected.
    session.execute(setColor([id], color));
    setHint(`Painted ${color}.`);
    refresh();
  },
});

/* ----------------------------------------------------------- materials */

// The strip, its persistence and the bucket colour live in `materials.ts`.
// The panel needs the selection and a quiet executor, both of which are wired
// here because only the composition root may see every module.
const materials = new MaterialsPanel(
  {
    session,
    selection: () => [...selection],
    say: (text) => {
    setHint(text);
  },
    quietly,
  },
  $("swatches"),
  $("paint-color") as HTMLInputElement,
);

$("paint-color").addEventListener("change", () =>
  materials.setPaintColor(($("paint-color") as HTMLInputElement).value),
);
$("paint-add").addEventListener("click", () =>
  materials.remember(($("paint-color") as HTMLInputElement).value),
);
$("paint-apply").addEventListener("click", () => materials.use(materials.paintColor));

/* ----------------------------------------------------------- annotations */

// Annotations live beside the document, not inside it: app state with no undo
// entry and no effect on the fit check. The layer owns the drawing.
const annotations = new AnnotationLayer(view.scene, () => view.invalidate());

/* ------------------------------------------------------------ selection */

/**
 * A hit resolved through the group the user is standing in. The walk itself is
 * pure and lives in `selection.ts`; this only supplies the live document.
 */
function withContext(hit: Extract<PickHit, { kind: "solid" }>): PickHit {
  const id = resolveHit(session.document, contextId, hit.id, hit.point, (solidId) => session.boundsOf(solidId));
  return id === hit.id ? hit : { ...hit, id };
}

/**
 * Double-click a group to stand inside it. A double-click on something that is
 * not a group, or on a member, leaves the context alone rather than resetting
 * it: the user's mistake should not throw them out of where they were working.
 */
function enterGroup(id: SolidId): void {
  if (!canEnter(session.document, id)) return;
  const solid = session.document.solids.get(id)!;
  contextId = id;
  collapsed.delete(id);
  setHint(`Inside "${solid.meta.name}". Escape to step out.`);
  refresh();
}

/**
 * Step out one level. At the top level Escape clears the selection, which is
 * what it does in every other tool; the two never fight because a context only
 * exists after a double-click.
 */
function leaveGroup(): void {
  if (contextId === null) return;
  const owner = contextAfterExit(session.document, contextId);
  contextId = owner;
  const name = owner ? session.document.solids.get(owner)?.meta.name : null;
  setHint(owner ? `Inside "${name}".` : "Back at the model.");
  refresh();
}

/**
 * Replace or toggle the selection.
 *
 * A single id goes through `applyPick`, which is exactly the rule a viewport
 * click obeys, so a click and a click on an outliner row can never disagree
 * about what Shift means. A list of ids replaces outright: toggling twelve
 * objects because the user Shift-clicked a group row is never what they meant.
 */
function setSelection(ids: readonly SolidId[], additive = false): void {
  selection = ids.length === 1 ? applyPick(selection, ids[0]!, additive) : new Set(ids);
  view.attachGizmo(soleSelection(selection));
  renderPanel();
}

/**
 * What an outliner row says about an object: its name, and its size in its own
 * terms.
 *
 * A face has area and no volume, so it is named "Face" and measured in square
 * units; anything else is a solid and measured in cubic ones. Deciding here
 * rather than at the row keeps the rule in one place, and keeps the zero that
 * a face's volume would report from ever reaching the user as a real answer.
 */
function describeExtent(solid: Solid, from: Session): { readonly name: string; readonly extent: string } {
  if (solid.recipe.kind === "face") {
    // The ring is planar and unprojected, so its 2D area is its true area even
    // after a move or a rotation: the recipe matrix leaves the recipe alone.
    const area = Math.abs(polygonArea(solid.recipe.points)) / 100;
    return { name: "Face", extent: `${area.toFixed(1)} cm2` };
  }
  return { name: solid.meta.name, extent: `${(from.analyse(solid.id).volume / 1000).toFixed(1)} cm3` };
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
  const definition = solid.recipe.kind === "instance" ? solid.recipe.definition : undefined;
  const siblings = definition
    ? componentsOf(session.document).find((c) => c.definition === definition)
    : undefined;
  const folded = collapsed.has(solid.id);
  const chip = document.createElement("button");
  chip.className = "chip";
  if (definition) {
    // An instance's chip is not a fold arrow: it says how many of this
    // component exist, which is the thing that makes it a component.
    chip.textContent = `\u29c9${siblings?.count ?? 1}`;
    chip.title = `Component "${definition}", ${siblings?.count ?? 1} in the model. Click to select them all.`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      setSelection([...(siblings?.instances ?? [])]);
    });
  } else {
    chip.title = members.length > 0 ? (folded ? "Expand group" : "Collapse group") : "Group";
    chip.textContent = members.length === 0 ? "G" : folded ? "\u25b8" : "\u25be";
    chip.disabled = members.length === 0;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (folded) collapsed.delete(solid.id);
      else collapsed.add(solid.id);
      renderPanel();
    });
  }

  const label = document.createElement("span");
  label.className = "name";
  // A face is named for what it is and measured by its area; every other object
  // is a solid and measured by its volume. Reporting "0.0 cm3" for a face would
  // read as a broken object rather than a flat one.
  const shape = describeExtent(solid, session);
  label.textContent = `${shape.name} - ${shape.extent}`;
  label.title = definition
    ? `Component "${definition}". Double-click to rename every instance.`
    : "Double-click to rename";
  label.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (definition) beginRenameDefinition(li, definition);
    else beginRename(li, solid);
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
    if (done) setHint(done);
  } catch (err) {
    setHint((err as Error).message);
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

/**
 * Rename a component definition from its row: one edit, every instance.
 *
 * Deliberately the same gesture as renaming a solid, because the user's mental
 * model is "rename this window". The difference is what it affects, and the hint
 * line says so afterwards, since a rename that quietly changed five other rows is
 * the one outcome nobody would guess.
 */
function beginRenameDefinition(row: HTMLLIElement, definition: string): void {
  const name = row.querySelector<HTMLSpanElement>(".name");
  if (!name) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = definition;
  input.maxLength = 64;
  let finished = false;
  const finish = (commit: boolean): void => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (commit && next && next !== definition) {
      try {
        const patch = session.execute(renameDefinition(definition, next));
        setHint(`Renamed component "${definition}" to "${next}" (${patch.forward.size} instance(s)).`);
        refresh();
      } catch (err) {
        setHint((err as Error).message);
        refresh();
      }
    } else {
      refresh();
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
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
  ($("toggle-xray") as HTMLButtonElement).classList.toggle("active", view.xray);
  const enabled = selection.size >= 1;
  ($("sel-array") as HTMLButtonElement).disabled = !enabled;
  ($("sel-duplicate") as HTMLButtonElement).disabled = !enabled;
  ($("sel-instance") as HTMLButtonElement).disabled = !enabled;
  ($("sel-component") as HTMLButtonElement).disabled = !enabled;
  ($("sel-detach") as HTMLButtonElement).disabled = !commandEnabled("detachComponent");
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
  const json = serializeJson(session.document);
  download("untitled.fcproj", json, "application/json");
  // A real save makes any pending draft redundant: clear the slot so a crash
  // two seconds later cannot offer older work than the file on disk.
  savedJson = json;
  autosave.markSaved(json);
  clearDraft(localStorage);
  refreshDraftBadge(null);
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
    setHint("Nothing to export yet.");
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
      savedJson = serializeJson(session.document);
      autosave.markSaved(savedJson);
      currentFile = file.name;
      refresh();
      setHint(`Loaded ${doc.solids.size} object${doc.solids.size === 1 ? "" : "s"} from ${file.name}.`);
    } catch (err) {
      setHint(`Could not open file: ${(err as Error).message}`);
    }
  };
  reader.readAsText(file);
}

/**
 * Import an interchange file. A mesh becomes one object, placed at the origin
 * (not nudged aside), because the file already says where it belongs; a DXF
 * outline becomes one flat face per closed loop, which is the only shape a
 * polyline can become without a guess.
 */
function importFile(file: File): void {
  if (formatOf(file.name) === "project") {
    openProject(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = readImport(file.name, String(reader.result));
    if (result.kind === "error") {
      setHint(result.reason);
      return;
    }
    try {
      const applied = applyImport(session, result);
      setSelection(applied.ids);
      setHint(applied.message);
      view.sync();
      view.zoomExtents();
    } catch (err) {
      setHint(`Could not import "${file.name}": ${(err as Error).message}`);
    }
    refresh();
  };
  reader.readAsText(file);
}

/* ------------------------------------------------------------ autosave */

/**
 * A draft every 30 s, so a crash costs at most half a minute. `savedJson` is the
 * last state the user actually saved; the autosave compares against it and
 * writes only when the document has moved on, so an idle tab writes nothing.
 */
let savedJson: string | null = null;
/** The file the user last opened or saved as, so a recovery prompt can name it. */
let currentFile: string | null = null;

const autosave = new Autosave(
  30_000,
  () => ({ json: serializeJson(session.document), fileName: currentFile }),
  (draft) => {
    if (writeDraft(localStorage, draft)) refreshDraftBadge(draft.at);
  },
);

/**
 * The recovery prompt. A draft is only offered when it is newer than the last
 * save and not ancient, so a clean session never nags.
 */
function offerRecovery(): void {
  const draft = readDraft(localStorage);
  if (!draft || !draftWorthOffering(draft, savedJson, Date.now())) return;
  const label = describeDraft(draft);
  if (!window.confirm(`${label}.\n\nOpen the recovered draft? Cancel discards it.`)) {
    clearDraft(localStorage);
    return;
  }
  try {
    session.load(deserializeJson(draft.json));
    currentFile = draft.fileName;
    setSelection([]);
    view.sync();
    view.zoomExtents();
    refresh();
    setHint(`${label}: recovered. Save it under a name when you are happy.`);
  } catch (err) {
    clearDraft(localStorage);
    setHint(`The recovered draft could not be opened (${(err as Error).message}); it has been discarded.`);
  }
}

/** A quiet line in the panel saying a draft exists, with its time. */
function refreshDraftBadge(at: number | null): void {
  const badge = document.getElementById("draft-badge");
  if (!badge) return;
  const when = at === null ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  badge.textContent = at === null ? "" : `Draft saved ${when}`;
  badge.hidden = at === null;
}

/* ---------------------------------------------------------------- units */

/**
 * One place turns the display unit into everything that shows a number: the
 * select, the envelope inputs (re-labelled, not re-scaled, so `600` typed in mm
 * is not silently read as `600 cm`), and the status line.
 */
function applyUnit(next: Unit): void {
  unit = next;
  try {
    localStorage.setItem(UNIT_KEY, next);
  } catch {
    /* a browser with storage off still gets the unit for this session */
  }
  ($("unit") as HTMLSelectElement).value = next;
  const label = UNIT_MENU.find((u) => u.id === next)?.label ?? next;
  for (const id of ["env-w", "env-h", "env-d"]) {
    const input = $(id) as HTMLInputElement;
    input.title = `Length in ${label}`;
  }
  renderHint();
  setHint(`Lengths now read in ${label}.`);
}

/** The unit select and the autosave badge, built from the one unit table. */
function wireUnits(): void {
  const select = $("unit") as HTMLSelectElement;
  select.replaceChildren(...UNIT_MENU.map((u) => new Option(u.label, u.id)));
  select.value = unit;
  select.addEventListener("change", () => applyUnit(select.value as Unit));
  const badge = document.createElement("div");
  badge.id = "draft-badge";
  badge.hidden = true;
  badge.className = "draft-badge";
  $("keys-table").before(badge);
}

/* --------------------------------------------------------------- wiring */

/**
 * The status line. A tool's own sentence is transient (it is replaced by the
 * next hint); the *measurement* is the part that must persist, so it is drawn
 * in its own element that only the tool can clear. That split is why a reading
 * does not flicker back to the previous message between two mouse moves.
 */
const monitor = $("monitor");

function setHint(text: string): void {
  hint.textContent = text;
}

function renderHint(): void {
  const measure = tools.measure();
  monitor.textContent = measure && measure.text !== "" ? statusLine(measure) : "";
  monitor.hidden = monitor.textContent === "";
}

function refresh(): void {
  // A context can be undone away (delete, ungroup, then Ctrl+Z), and so can a
  // selected object. Rather than trusting every command to remember, check here:
  // a context that no longer names a live group is dropped, so a click can never
  // be routed into nothing, and a stale selection cannot drive the gizmo.
  contextId = sanitiseContext(session.document, contextId);
  selection = pruneSelection(session.document, selection);
  view.sync();
  renderPanel();
  renderTags();
  materials.render();
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
      case "polygon":
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
        setHint(`Deleted ${ids.length} object(s).`);
        refresh();
        return;
      }
      case "duplicate": {
        const first = [...selection][0];
        if (!first) {
          setHint("Duplicate: select something first.");
          return;
        }
        const patch = session.execute(duplicateSolid(first, [50, 50, 0]));
        setSelection([...patch.forward.keys()]);
        setHint(`Duplicated (${formatSizeIn(unit, [50, 50, 0])}).`);
        refresh();
        return;
      }
      case "instance": {
        const first = [...selection][0];
        if (!first) {
          setHint("Make Instance: select something first.");
          return;
        }
        const patch = session.execute(instanceCopy(first, [200, 0, 0]));
        setSelection([...patch.forward.keys()]);
        setHint(`Instance made (${formatLengthIn(unit, 200)} to the right); edit the source and this follows.`);
        refresh();
        return;
      }
      case "makeComponent": {
        const first = [...selection][0];
        if (!first) {
          setHint("Make Component: select something first.");
          return;
        }
        const solid = session.document.solids.get(first);
        const patch = session.execute(
          makeComponent(first, [200, 0, 0], solid ? definitionName(solid) : undefined),
        );
        // Select the new instance, not the definition: the next thing a user
        // does with a fresh component is place more of them, or move this one.
        const placed = [...patch.backward].filter(([, prev]) => prev === null).map(([id]) => id);
        setSelection(placed);
        setHint(`Component "${definitionName(session.document.solids.get(first)!)}" made; double-click a row to rename every instance.`);
        refresh();
        return;
      }
      case "detachComponent": {
        const defs = new Set<string>();
        for (const id of selection) {
          const solid = session.document.solids.get(id);
          if (solid?.recipe.kind === "instance" && solid.recipe.definition) defs.add(solid.recipe.definition);
        }
        if (defs.size === 0) {
          setHint("Detach Component: select a component instance first.");
          return;
        }
        session.batch([...defs].map((d) => detachDefinition(d)));
        setHint(`Detached ${defs.size} component(s); the objects stay, only the link goes.`);
        refresh();
        return;
      }
      case "array":
        runArray();
        return;
      case "group": {
        const ids = [...selection];
        if (ids.length === 0) {
          setHint("Make Group: select something first.");
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
        setHint(`Grouped ${ids.length} object(s).`);
        refresh();
        return;
      }
      case "ungroup": {
        const groups = [...selection].filter((id) => session.document.solids.get(id)?.recipe.kind === "group");
        if (groups.length === 0) {
          setHint("Ungroup: select a group first.");
          return;
        }
        session.batch(groups.map((id) => ungroupSolid(id)));
        // The wrapper ids are gone; selecting them would leave a phantom
        // selection that the next Delete would silently ignore.
        setSelection([]);
        setHint(`Ungrouped ${groups.length} group(s).`);
        refresh();
        return;
      }
      case "explode": {
        const groups = [...selection].filter((id) => session.document.solids.get(id)?.recipe.kind === "group");
        if (groups.length === 0) {
          setHint("Explode: select a group first.");
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
          setHint("Explode: no nested groups inside the selection.");
          return;
        }
        session.batch(inner.map((id) => ungroupSolid(id)));
        setHint(`Exploded ${inner.length} nested group(s).`);
        refresh();
        return;
      }
      case "union":
      case "subtract":
      case "intersect": {
        const [a, b] = [...selection];
        if (!a || !b) {
          setHint("Booleans need exactly two objects selected.");
          return;
        }
        const op = id === "union" ? "union" : id === "subtract" ? "difference" : "intersection";
        const patch = session.execute(booleanSolids(a, b, op));
        const created = [...patch.forward.keys()].find((k) => !selection.has(k));
        setSelection(created ? [created] : []);
        refresh();
        setHint(`${op} done.`);
        return;
      }
      case "fit":
        session.execute(fitToEnvelope());
        setHint("Scaled down to fit the envelope.");
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
        setHint(`${commandLabels[id]} view.`);
        renderPanel();
        return;
      case "zoomExtents":
        view.zoomExtents();
        setHint("Framed the model.");
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
      case "toggleXray":
        view.setXray(!view.xray);
        setHint(view.xray ? "X-ray on: faces are see-through." : "X-ray off.");
        renderPanel();
        return;
      case "toggleAxes":
        setAxes(!view.axesVisible);
        return;
    }
  } catch (err) {
    setHint((err as Error).message);
  }
}

/** Commands that need objects, and how many. Used by the palette to hide dead ends. */
function commandEnabled(id: CommandId): boolean {
  const count = selection.size;
  switch (id) {
    case "delete":
    case "duplicate":
    case "instance":
    case "makeComponent":
      return count >= 1;
    case "detachComponent":
      return [...selection].some((id) => {
        const r = session.document.solids.get(id)?.recipe;
        return r?.kind === "instance" && Boolean(r.definition);
      });
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
  // The rail belongs to the tool that produced it: switching tools retires the
  // last reading instead of leaving a stale number under the new cursor.
  renderHint();
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
    setHint(`${commandLabels[id]} is now ${spec}.`);
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
  setHint(kind === "ortho" ? "Orthographic projection." : "Perspective projection.");
  renderPanel();
}

/** Drawing style: shaded, hidden line or edges only. */
function setStyle(style: "shaded" | "hiddenLine" | "edges"): void {
  view.setStyle(style);
  setHint(style === "shaded" ? "Shaded style." : style === "hiddenLine" ? "Hidden line style." : "Edges only.");
  renderPanel();
}

function setShadows(on: boolean): void {
  view.setShadows(on);
  setHint(on ? "Shadows on." : "Shadows off.");
  renderPanel();
}

function setAxes(on: boolean): void {
  view.setAxesVisible(on);
  setHint(on ? "Axes shown." : "Axes hidden.");
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
    setHint("Envelope needs a positive width, height and depth (e.g. 600, 60cm, 2m).");
    return;
  }
  try {
    session.execute(setEnvelope({ min: [0, 0, 0], max: size }));
    setHint(`Envelope ${formatSizeIn(unit, size)}.`);
  } catch (err) {
    setHint((err as Error).message);
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
$("toggle-xray").addEventListener("click", () => runCommand("toggleXray"));

$("env-set").addEventListener("click", setEnvelopeFromInputs);
$("env-clear").addEventListener("click", () => {
  session.execute(setEnvelope(null));
  refresh();
});
$("env-fit").addEventListener("click", () => {
  try {
    session.execute(fitToEnvelope());
    setHint("Scaled down to fit the envelope.");
  } catch (err) {
    setHint((err as Error).message);
  }
  refresh();
});
$("env-centre").addEventListener("click", () => {
  try {
    session.execute(centreInEnvelope());
    setHint("Centred in the envelope.");
  } catch (err) {
    setHint((err as Error).message);
  }
  refresh();
});

$("opacity").addEventListener("change", () => {
  const ids = [...selection];
  if (ids.length === 0) {
    setHint("Opacity: select something first.");
    return;
  }
  const percent = Number(($("opacity") as HTMLInputElement).value);
  quietly(() => session.execute(setOpacity(ids, percent / 100)), `Opacity ${percent}%.`);
});

/** Both finish sliders write together, so a drag of one never resets the other. */
function applyFinish(): void {
  const ids = [...selection];
  if (ids.length === 0) {
    setHint("Finish: select something first.");
    return;
  }
  const rough = Number(($("roughness") as HTMLInputElement).value) / 100;
  const metal = Number(($("metallic") as HTMLInputElement).value) / 100;
  quietly(() => session.execute(setFinish(ids, rough, metal)), `Finish: rough ${Math.round(rough * 100)}%, metal ${Math.round(metal * 100)}%.`);
}
$("roughness").addEventListener("change", applyFinish);
$("metallic").addEventListener("change", applyFinish);
$("sel-instance").addEventListener("click", () => runCommand("instance"));
$("sel-component").addEventListener("click", () => runCommand("makeComponent"));
$("sel-detach").addEventListener("click", () => runCommand("detachComponent"));
$("sel-group").addEventListener("click", () => runCommand("group"));
$("sel-ungroup").addEventListener("click", () => runCommand("ungroup"));
$("sel-explode").addEventListener("click", () => runCommand("explode"));
$("keys-open").addEventListener("click", () => palette.open());

$("tag-apply").addEventListener("click", () => {
  const ids = [...selection];
  if (ids.length === 0) {
    setHint("Tag: select something first.");
    return;
  }
  const name = ($("tag-name") as HTMLInputElement).value.trim();
  quietly(() => session.execute(setTag(ids, name)), name === "" ? "Tag cleared." : `Tagged "${name}".`);
});

$("section-apply").addEventListener("click", () => {
  const axis = ($("section-axis") as HTMLSelectElement).value as "x" | "y" | "z";
  const at = parseLength(($("section-at") as HTMLInputElement).value, unit);
  if (!at) {
    setHint("Section: the cut position must be a length (e.g. 0, 30cm, 2in).");
    return;
  }
  quietly(
    () => session.execute(setSection({ axis, offset: at.mm, flip: false })),
    `Cut at ${axis.toUpperCase()} = ${formatLengthIn(unit, at.mm)}.`,
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
    setHint("Array: select one object first.");
    return;
  }
  const count = Math.trunc(Number(($("array-count") as HTMLInputElement).value));
  const step = parseLength(($("array-step") as HTMLInputElement).value, unit);
  const axis = ($("array-axis") as HTMLSelectElement).value;
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    setHint("Array: count must be a whole number from 1 to 500.");
    return;
  }
  if (!step || step.mm <= 0) {
    setHint("Array: step must be a positive length (e.g. 100, 60cm, 2in).");
    return;
  }
  const offset: Vec3 = [axis === "x" ? step.mm : 0, axis === "y" ? step.mm : 0, axis === "z" ? step.mm : 0];
  // One command, one undo step: an array is a single user intention.
  session.execute(arrayCopy(id, count, offset));
  setHint(`Array: ${count} copies ${formatLengthIn(unit, step.mm)} apart along ${axis.toUpperCase()}.`);
  refresh();
}

$("sel-array").addEventListener("click", () => {
  try {
    runArray();
  } catch (err) {
    setHint((err as Error).message);
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
    setHint(`Duplicated (${formatSizeIn(unit, [50, 50, 0])}).`);
  } catch (err) {
    setHint((err as Error).message);
  }
  refresh();
});

$("save").addEventListener("click", saveProject);
$("export").addEventListener("click", exportStl);
$("open").addEventListener("click", () => $("file-input").click());
$("import").addEventListener("click", () => $("import-input").click());
for (const id of ["file-input", "import-input"]) {
  $(id).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) (id === "import-input" ? importFile : openProject)(file);
    // Clearing the value lets the same file be chosen twice in a row, which a
    // user does the moment the first attempt warns them the unit was assumed.
    input.value = "";
  });
}

/**
 * Drag and drop, for the gesture people actually use: a file dragged from a
 * folder must not open in a new tab (the browser default) and must not be
 * treated as a project when it is an OBJ.
 */
const viewRoot = $("viewport").parentElement ?? document.body;
for (const type of ["dragenter", "dragover"]) {
  viewRoot.addEventListener(type, (e) => {
    e.preventDefault();
    // DOM events are untyped; a drag event carries its payload here.
    const drag = e as DragEvent;
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = "copy";
  });
}
viewRoot.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) importFile(file);
});

$("undo").addEventListener("click", () => runCommand("undo"));
$("redo").addEventListener("click", () => runCommand("redo"));
$("zoom").addEventListener("click", () => runCommand("zoomExtents"));

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

  // The palette owns the keyboard while it is open.
  if (palette.isOpen) return;

  // Shift with no mouse movement must still square the rectangle being sized,
  // so the modifier is passed on the key press, not only on the next move. It
  // also must not reach the typed-length path, where Shift+1 would be "!".
  if (e.key === "Shift") {
    tools.setModifiers({ shift: true });
    renderHint();
    return;
  }

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
  // A drag must update the reading too, or the number freezes while the edge is
  // being pulled, which is exactly when it matters.
  if (e.buttons === 1 && tools.hasPending) {
    tools.drag(e.clientX, e.clientY);
    renderHint();
  }
});
view.renderer.domElement.addEventListener("pointerup", () => {
  if (tools.hasPending) renderPanel();
});

// Releasing Shift un-squares the pending rectangle, so the next move is free
// again; the reading is redrawn in the same frame the constraint lifts.
window.addEventListener("keyup", (e) => {
  if (e.key !== "Shift") return;
  tools.setModifiers({ shift: false });
  renderHint();
});

/* ---------------------------------------------------------------- startup */

/**
 * The keys table in the panel footer, generated from the live keymap: a printed
 * table would be the first thing to lie the day a binding changes. Only bound
 * commands appear, so the table is short and every row is true.
 */
function renderKeysTable(): void {
  const table = $("keys-table");
  const rows: string[] = [];
  for (const [key, id] of Object.entries(keys)) {
    // Overrides are stored as plain strings, so an id no longer in the table is
    // possible after a command is removed; that stale binding is simply skipped.
    if (id === undefined || !Object.prototype.hasOwnProperty.call(commandLabels, id)) continue;
    rows.push(`${key} ${commandLabels[id as CommandId].toLowerCase()}`);
  }
  rows.sort((a, b) => a.localeCompare(b));
  const line = document.createElement("p");
  line.className = "keys-line";
  line.textContent = rows.join("  ·  ");
  table.replaceChildren(line);
}

async function start(): Promise<void> {
  view.setTool("select");
  view.setGizmoMode(gizmoMode);
  wireUnits();
  renderKeysTable();
  autosave.start();
  try {
    await initKernel();
    refresh();
    setHint("Ready. Solid kernel online: booleans available.");
  } catch {
    refresh();
    setHint("Ready (solid kernel unavailable; booleans disabled).");
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
  if (!demo) offerRecovery();
  if (!demo) setHint("Click the ground to draw a rectangle (R).");
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
  /** Component definitions and how many instances each has. */
  components(): { definition: string; count: number; instances: string[] }[];
  /** The definition a solid belongs to, if any. */
  definitionOf(id: string): string | null;
  /** X-ray state, so a toggle can be proven to reach the renderer. */
  xray(): boolean;
  /** What a given lasso path would select, through the engine's own rule. */
  lassoSelect(path: { x: number; y: number }[]): string[];
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
    materials.setPaintColor(color);
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
  components: () =>
    componentsOf(session.document).map((c) => ({ definition: c.definition, count: c.count, instances: [...c.instances] })),
  definitionOf(id) {
    const solid = session.document.solids.get(id as SolidId);
    if (!solid || solid.recipe.kind !== "instance") return null;
    return solid.recipe.definition ?? null;
  },
  xray: () => view.xray,
  lassoSelect(path) {
    // The engine rule, over the same screen boxes the viewport uses; this proves
    // the selection logic without a synthetic pointer drag.
    const ids = view.selectableIds();
    return selectByLasso(
      ids,
      path.map((p) => [p.x, p.y] as const),
      (id) => view.screenBox(id as SolidId),
    );
  },
};

;