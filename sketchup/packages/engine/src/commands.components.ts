import type { Vec3 } from "@apexus/geometry";
import { patchOf, type Command } from "./command.js";
import { assertResolvable, liveCopyRecipe } from "./commands.family.js";
import { requireSolid } from "./seams.js";
import type { DocumentState, Solid, SolidId, SolidRecipe } from "./types.js";

/**
 * Components: named definitions and the instances that follow them (task L2-12).
 *
 * A component is not a fourth kind of object. It is a live copy that carries a
 * `definition` string, and that string is the only thing that makes the copies
 * behave as one unit. Everything here keeps that invariant: a name exists only
 * while at least one instance carries it, and renaming touches exactly the
 * instances that carry it.
 */

export interface ComponentInfo {
  readonly definition: string;
  readonly count: number;
  readonly instances: readonly SolidId[];
}

/**
 * Make a component: the source becomes the definition, and one named instance
 * is placed at `delta` from it.
 *
 * SketchUp makes a component the moment you create one, which is why a user
 * never has a "loose" copy that is secretly an instance. Doing it in two steps
 * would let the first step half-succeed: a source renamed but no copy placed is
 * a component nobody can reach. This one command either leaves a definition and
 * one instance, or throws and leaves nothing.
 */
export function makeComponent(id: SolidId, delta: Vec3 = [0, 0, 0], name?: string): Command {
  return {
    kind: "makeComponent",
    label: "Make Component",
    apply(doc, ctx) {
      const src = requireSolid(doc, id);
      const index = componentIndex(doc);
      // A body that already belongs to a set can still be promoted: the user
      // picked "Make Component" on the corner window, and forcing them to detach
      // first is a step SketchUp does not ask for. It may not *rename* the set it
      // is in, though: that would silently rename every sibling.
      const already = src.recipe.kind === "instance" ? src.recipe.definition : undefined;
      const definition = normaliseDefinition(name ?? already ?? src.meta.name);
      if (already && already !== definition) {
        throw new Error(`this object belongs to "${already}", so making it "${definition}" would rename every copy; detach it first`);
      }
      // Joining the set you are already in is the one repeat that is not a clash.
      const joining = already === definition && index.has(definition);
      if (index.has(definition) && !joining) {
        throw new Error(`a component called "${definition}" already exists; pick another name`);
      }
      if (delta.every((d) => d === 0)) throw new Error("place the first instance away from the source");

      // Placement comes from the same helper `instanceCopy` uses, so a component
      // and a plain instance can never land in different places for the same
      // source. The definition is then stamped on, here, rather than inside the
      // helper: an instance is only a component because this command says so.
      const { recipe: placed } = liveCopyRecipe(doc, src, delta);
      const instanceRecipe: SolidRecipe = {
        ...placed,
        source: src.recipe.kind === "transform" ? placed.source : id,
        definition,
      };
      const newId = ctx.nextId();
      // The label for the definition row, the same either way (see
      // `definitionRowName`).
      const meta = { ...src.meta, name: definitionRowName(definition) };
      // The source becomes a bare definition: it keeps a labelled row in the
      // model, but it is no longer a drawable body, so it must not be rendered
      // (or mesh-validated) as a second copy sitting on the first one. The
      // instance below carries the volume.
      const renamed: Solid = {
        ...src,
        revision: src.revision + 1,
        meta: { ...meta, hidden: true },
      };
      const instance: Solid = {
        id: newId,
        revision: 1,
        recipe: instanceRecipe,
        meta: { ...src.meta, name: definition, hidden: false, locked: false },
      };
      // Validate the instance against the patch it will live in. The source's own
      // mesh is no longer the thing that has volume (it is a hidden definition
      // now), so it is deliberately not re-validated here: hiding it is what
      // makes "one component, one body on screen" true.
      const after: DocumentState = { ...doc, solids: new Map([...doc.solids, [id, renamed]]) };
      assertResolvable(after, ctx, newId, instance, instanceRecipe);
      return patchOf(
        doc,
        new Map<SolidId, Solid | null>([
          [id, renamed],
          [newId, instance],
        ]),
        new Map<SolidId, Solid | null>([
          [id, src],
          [newId, null],
        ]),
        `Make Component ${definition}`,
      );
    },
  };
}

/**
 * Rename a component definition: every instance of it at once, and only those.
 *
 * The unit the user sees is the set ("Window ×6"), so renaming one window by the
 * outliner's normal rename would make five windows and one "Window" — the exact
 * surprise a component exists to prevent. That is why this is its own command.
 */
export function renameDefinition(definition: string, name: string): Command {
  const from = normaliseDefinition(definition);
  const to = normaliseDefinition(name);
  return {
    kind: "renameDefinition",
    label: `Rename Component ${to}`,
    apply(state, ctx) {
      if (from === to) return patchOf(state, new Map(), new Map(), "No change");
      const index = componentIndex(state);
      // "Is this name taken?" must ignore the set being renamed: taking a name it
      // held before (Post cap -> Window -> Post cap) is legal, and only a
      // *different* set already using `to` is a clash, so `from` itself is exempt.
      if (index.has(to) && from !== to) {
        throw new Error(`a component called "${to}" already exists`);
      }
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const solid of state.solids.values()) {
        // The set's definition row follows the rename, so the outliner keeps
        // saying which set that hidden body belongs to.
        if (solid.recipe.kind !== "instance" && solid.meta.name === `${from} (definition)`) {
          forward.set(solid.id, {
            ...solid,
            revision: solid.revision + 1,
            meta: { ...solid.meta, name: definitionRowName(to) },
          });
          backward.set(solid.id, solid);
        }
      }
      for (const solid of state.solids.values()) {
        const r = solid.recipe;
        if (r.kind !== "instance" || r.definition !== from) continue;
        const next: Solid = {
          ...solid,
          revision: solid.revision + 1,
          recipe: { ...r, definition: to },
          // The instance's own label follows too, unless the user had named it
          // something of their own; that is what "(definition)" marks.
          meta:
            solid.meta.name === from || solid.meta.name === `${from} (definition)`
              ? { ...solid.meta, name: solid.meta.name.endsWith("(definition)") ? `${to} (definition)` : to }
              : solid.meta,
        };
        ctx.resolveWith?.(next.recipe, new Map([...state.solids, [next.id, next]]));
        forward.set(solid.id, next);
        backward.set(solid.id, solid);
      }
      if (forward.size === 0) throw new Error(`no component called "${from}"`);
      return patchOf(state, forward, backward, `Rename Component ${to}`);
    },
  };
}

/**
 * Put the selected instances back to a plain, unnamed copy set: each keeps its
 * geometry but stops following the definition's name. Friends with `explode`:
 * this removes the relationship, not the objects.
 */
export function detachDefinition(definition: string): Command {
  const from = normaliseDefinition(definition);
  return {
    kind: "detachDefinition",
    label: `Detach Component ${from}`,
    apply(state, ctx) {
      const forward = new Map<SolidId, Solid | null>();
      const backward = new Map<SolidId, Solid | null>();
      for (const solid of state.solids.values()) {
        const r = solid.recipe;
        if (r.kind !== "instance" || r.definition !== from) continue;
        const { definition: _drop, ...rest } = r;
        // Dropping the name turns an instance into a plain transform whose
        // `source` must still resolve; a second detach on a set that has already
        // lost a definition (an undo re-issue) must not slip past this check.
        ctx.resolveWith?.(rest, new Map(state.solids));
        forward.set(solid.id, { ...solid, revision: solid.revision + 1, recipe: rest });
        backward.set(solid.id, solid);
      }
      if (forward.size === 0) throw new Error(`no component called "${from}"`);
      return patchOf(state, forward, backward, `Detach Component ${from}`);
    },
  };
}

/**
 * Every component definition in the document: its name, how many instances use
 * it, and one representative id.
 *
 * "How many" counts instances, not the source. The source is one object a user
 * placed; the component is the set of copies, and reporting the source as a
 * seventh instance would make the count disagree with what is on screen.
 */
export function componentsOf(doc: DocumentState): readonly ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const [name, ids] of componentIndex(doc)) {
    out.push({ definition: name, count: ids.length, instances: ids });
  }
  return out.sort((a, b) => a.definition.localeCompare(b.definition));
}

/** Instances grouped by definition name, in document order. */
function componentIndex(doc: DocumentState): Map<string, SolidId[]> {
  const index = new Map<string, SolidId[]>();
  for (const solid of doc.solids.values()) {
    const r = solid.recipe;
    if (r.kind !== "instance" || !r.definition) continue;
    const list = index.get(r.definition);
    if (list) list.push(solid.id);
    else index.set(r.definition, [solid.id]);
  }
  return index;
}

/** The definition an instance belongs to, or its own name for a one-off. */
export function definitionName(solid: Solid): string {
  return solid.recipe.kind === "instance" && solid.recipe.definition ? solid.recipe.definition : solid.meta.name;
}

/**
 * A definition row is a hidden body with no instance pointing at it by name, so
 * its label is the only way to tell which set it belongs to in the outliner. It
 * is derived from the set's name, never carried over: the body may have been
 * called anything before it became a definition.
 */
export function definitionRowName(definition: string): string {
  return `${definition} (definition)`;
}

/**
 * A valid definition name, or a throw.
 *
 * Names are the join key between instances, so two spellings of the same word
 * must be the same key: trimming and collapsing inner whitespace means "Post
 * cap" and " Post  cap " are one component, not two nobody can tell apart.
 */
export function normaliseDefinition(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean === "") throw new Error("a component needs a name");
  if (clean.length > 64) throw new Error("a component name is at most 64 characters");
  if (/[\u0000-\u001f]/.test(clean)) throw new Error("a component name has a control character in it");
  return clean;
}
