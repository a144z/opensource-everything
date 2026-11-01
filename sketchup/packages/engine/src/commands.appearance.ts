import { patchOf, type Command } from "./command.js";
import { metaPatch, requireSolid } from "./seams.js";
import { clampOpacity, clampUnit } from "./types.js";
import type { DocumentState, SectionPlane, Solid, SolidId, SolidMeta } from "./types.js";

/**
 * Appearance and organisation: things a user can change about an object without
 * changing its shape.
 *
 * Every one of these is a meta edit, so they share `metaPatch`: one undo step
 * and one label for a whole selection, with "which objects this touches" written
 * once instead of in every command. None of them meshes anything, which is why
 * this module never calls `ctx.resolve`.
 */

/**
 * Rename one object. A blank name would leave an unclickable outliner row.
 */
export function renameSolid(id: SolidId, name: string): Command {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("a solid's name cannot be blank");
  if (trimmed.length > 80) throw new RangeError("a name is at most 80 characters");
  return {
    kind: "renameSolid",
    label: `Rename to ${trimmed}`,
    apply(doc) {
      const prev = requireSolid(doc, id);
      const next: Solid = { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, name: trimmed } };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), `Rename to ${trimmed}`);
    },
  };
}

/** Arbitrary meta fields in one patch. Fields are clamped by `setMeta`'s caller. */
export function setMeta(id: SolidId, patch: Partial<SolidMeta>, label = "Edit"): Command {
  return {
    kind: "setMeta",
    label,
    apply(doc) {
      const prev = requireSolid(doc, id);
      const next: Solid = { ...prev, revision: prev.revision + 1, meta: { ...prev.meta, ...patch } };
      return patchOf(doc, new Map([[id, next]]), new Map([[id, prev]]), label);
    },
  };
}

/** Paint: the object's base colour, as the colour swatches use it. */
export function setColor(ids: readonly SolidId[], color: string): Command {
  return {
    kind: "setColor",
    label: "Colour",
    apply(doc) {
      return metaPatch(doc, ids, (meta) => (meta.color === color ? null : { ...meta, color }), "Colour");
    },
  };
}

/**
 * Surface finish: roughness (0 mirror to 1 rough) and metal (0 to 1). Both are
 * clamped rather than refused, the same policy as opacity, because a slider can
 * overshoot by a rounding error and that must not fail a whole command.
 */
export function setFinish(ids: readonly SolidId[], roughness: number, metallic: number): Command {
  if (typeof roughness !== "number" || !Number.isFinite(roughness)) {
    throw new RangeError("roughness must be a number from 0 to 1");
  }
  if (typeof metallic !== "number" || !Number.isFinite(metallic)) {
    throw new RangeError("metallic must be a number from 0 to 1");
  }
  const rough = clampUnit(roughness, 0.75);
  const metal = clampUnit(metallic, 0);
  const label = metal > 0.5 ? "Finish: metal" : rough > 0.9 ? "Finish: matte" : "Finish";
  return {
    kind: "setFinish",
    label,
    apply(doc) {
      return metaPatch(
        doc,
        ids,
        (meta) => (meta.roughness === rough && meta.metallic === metal ? null : { ...meta, roughness: rough, metallic: metal }),
        label,
      );
    },
  };
}

/** Opacity, clamped to 0..1. 1 is "make opaque", the label the panel shows. */
export function setOpacity(ids: readonly SolidId[], opacity: number): Command {
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
    throw new RangeError("opacity must be a number from 0 to 1");
  }
  const value = clampOpacity(opacity);
  const label = value === 1 ? "Make opaque" : `Opacity ${Math.round(value * 100)}%`;
  return {
    kind: "setOpacity",
    label,
    apply(doc) {
      return metaPatch(doc, ids, (meta) => (meta.opacity === value ? null : { ...meta, opacity: value }), label);
    },
  };
}

/**
 * Put objects on a tag (SketchUp's "layer"). A tag is a name only: it never owns
 * geometry, so this is a meta edit and undo is a plain restore.
 */
export function setTag(ids: readonly SolidId[], tag: string): Command {
  const name = tag.trim();
  if (name.length > 40) throw new RangeError("a tag name is at most 40 characters");
  const label = name === "" ? "Clear tag" : `Tag: ${name}`;
  return {
    kind: "setTag",
    label,
    apply(doc) {
      return metaPatch(doc, ids, (meta) => (meta.tag === name ? null : { ...meta, tag: name }), label);
    },
  };
}

/**
 * Show or hide a whole tag. Visibility lives in each solid's meta (not in a tag
 * table) so a project file needs no second source of truth: hiding a tag is
 * exactly setting `hidden` on every object wearing it, one undo step.
 */
export function setTagVisible(tag: string, visible: boolean): Command {
  const name = tag.trim();
  const label = `${visible ? "Show" : "Hide"} tag ${name}`;
  return {
    kind: "setTagVisible",
    label,
    apply(doc) {
      const ids = [...doc.solids.values()]
        .filter((solid) => solid.meta.tag === name && solid.meta.hidden === !visible)
        .map((solid) => solid.id);
      return metaPatch(doc, ids, (meta) => ({ ...meta, hidden: !visible }), label);
    },
  };
}

/** Every tag in use, sorted, with how many visible and hidden objects wear it. */
export function tagsInUse(doc: DocumentState): { tag: string; total: number; hidden: number }[] {
  const counts = new Map<string, { total: number; hidden: number }>();
  for (const solid of doc.solids.values()) {
    const tag = solid.meta.tag;
    if (tag === "") continue;
    const row = counts.get(tag) ?? { total: 0, hidden: 0 };
    row.total += 1;
    if (solid.meta.hidden) row.hidden += 1;
    counts.set(tag, row);
  }
  return [...counts.entries()]
    .map(([tag, row]) => ({ tag, ...row }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/* --------------------------------------------------------------- sections */

/** A section plane: everything on the +side of `offset` along `axis` is hidden. */
export function setSection(plane: SectionPlane | null): Command {
  // Validate at construction: a NaN offset is a caller's bug, and it must fail
  // where the caller can see it, not halfway through an undo transaction.
  if (plane) {
    if (!Number.isFinite(plane.offset)) throw new RangeError("a section plane needs a finite position");
    if (!["x", "y", "z"].includes(plane.axis)) throw new RangeError("section axis must be x, y or z");
  }
  const label = plane ? `Section ${plane.axis.toUpperCase()} at ${Math.round(plane.offset)} mm` : "Clear section";
  return {
    kind: "setSection",
    label,
    apply(doc) {
      return {
        forward: new Map(),
        backward: new Map(),
        envelopeBefore: doc.envelope,
        envelopeAfter: doc.envelope,
        label,
        sectionBefore: doc.section,
        sectionAfter: plane,
      };
    },
  };
}
