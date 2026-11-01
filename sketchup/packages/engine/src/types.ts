/** Engine types. Units: millimetres everywhere. */

import type { Vec2, Vec3 } from "@apexus/geometry";

export const SCHEMA_VERSION = 6;
export const FIT_TOLERANCE = 1e-2;

export type SolidId = string;

export type BooleanOp = "union" | "difference" | "intersection";

/**
 * Procedural recipe: the only source of truth. A recipe plus its children must
 * rebuild the mesh with no other state (docs/06-data-model.md).
 *
 * Every recipe carries an affine `matrix` (column-major 4x4, applied last), so
 * move/rotate/scale never rewrite the primitive's own numbers. That keeps an
 * extrusion's `distance` meaning "how tall it is", which is what the fit wedge
 * and push/pull talk about.
 */
export type Mat4 = readonly number[];

export interface RecipeBase {
  readonly matrix: Mat4;
}

export type SolidRecipe =
  | (RecipeBase & {
      readonly kind: "box";
      readonly width: number;
      readonly height: number;
      readonly depth: number;
      readonly origin: Vec3;
    })
  | (RecipeBase & {
      readonly kind: "extrude";
      readonly profile: { readonly width: number; readonly height: number };
      readonly normal: Vec3;
      readonly origin: Vec3;
      readonly distance: number;
    })
  | (RecipeBase & {
      /**
       * Pinched copy: the same mesh as `source`, kept as geometry rather than a
       * reference. Moving the source later does NOT move this.
       */
      readonly kind: "transform";
      readonly child: SolidId;
    })
  | (RecipeBase & {
      /**
       * Instance: resolves the source's mesh every time, so editing the source
       * edits every copy. The instance's own matrix is applied on top, which is
       * what lets two instances of one window sit on different walls.
       */
      readonly kind: "instance";
      readonly source: SolidId;
      /**
       * Component definition name, when this instance belongs to a named,
       * reusable component rather than being a one-off live copy.
       *
       * The idea a user holds is "these six windows are the same window". The
       * name is what makes that true of the *set*, not just each copy: renaming
       * the definition renames all six, and the outliner can say "Window x6".
       * A plain instance has no definition and is edited one at a time.
       */
      readonly definition?: string;
      /**
       * Where the source sits in the world, when it is not at the origin. An
       * instance is read as "the source, here": subtracting this makes that
       * true even after the source has been moved.
       */
      readonly origin?: readonly number[];
    })
  | (RecipeBase & {
      /** Closed ring in a plane, extruded along the plane normal by `distance`. */
      readonly kind: "loop";
      readonly points: readonly Vec2[];
      readonly plane: { readonly origin: Vec3; readonly normal: Vec3 };
      readonly distance: number;
    })
  | (RecipeBase & {
      /**
       * Zero-thickness face: a closed ring triangulated in its own plane, no
       * `distance` and no volume.
       *
       * A face is a first-class document object, not a degenerate solid: it is
       * picked and selected by its surface, it is the base push/pull extrudes
       * from, and it is counted by area rather than by volume. Modelling it as a
       * 10 mm-thick `loop` made every box drawn on screen a hidden slab that a
       * BOQ counted as material, which is why the honest shape is its own kind.
       */
      readonly kind: "face";
      readonly points: readonly Vec2[];
      readonly plane: { readonly origin: Vec3; readonly normal: Vec3 };
    })
  | (RecipeBase & {
      /** Boolean of two solids, run through the kernel. */
      readonly kind: "boolean";
      readonly op: BooleanOp;
      readonly a: SolidId;
      readonly b: SolidId;
    })
  | (RecipeBase & {
      /** Imported triangle soup (STL, glTF); already a closed mesh. */
      readonly kind: "mesh";
      readonly positions: readonly number[];
      readonly indices: readonly number[];
    })
  | (RecipeBase & {
      /**
       * Group: an ordered set of solids that move, copy and delete as one.
       *
       * Unlike `instance` (a reference to a single source), a group owns its
       * members: the children stay in the document as children, so their meta,
       * tags and recipes remain editable, and ungrouping is a pure relink.
       * `members` is ordered because the outliner shows it in that order.
       */
      readonly kind: "group";
      readonly members: readonly SolidId[];
    })
  | (RecipeBase & {
      /** Lathe: a profile ring swept once around an axis in the XZ plane. */
      readonly kind: "lathe";
      readonly points: readonly Vec2[];
      /** Distance of the axis from the profile plane, in mm. */
      readonly offset: number;
      readonly segments: number;
    });

export type RecipeKind = SolidRecipe["kind"];

export interface SolidMeta {
  readonly name: string;
  readonly color: string;
  readonly hidden: boolean;
  readonly locked: boolean;
  /** 0 (invisible) to 1 (opaque). Tagged geometry is drawn translucent. */
  readonly opacity: number;
  /**
   * Surface finish, 0 rough to 1 mirror-like, and 0 to 1 metal. Colour alone
   * cannot say "this is brushed steel"; these two are what SketchUp's material
   * browser offers and what a renderer needs beyond a flat `color`.
   */
  readonly roughness: number;
  readonly metallic: number;
  /**
   * The tag (SketchUp calls it a layer). Tags never group geometry — deleting a
   * tag is not a geometry change — they only name a set of objects that share
   * visibility, which is why this is a plain string and not a parent id.
   */
  readonly tag: string;
}

/** Opacity the user cannot meaningfully see; clamping keeps saves honest. */
export function clampOpacity(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Roughness / metal, clamped to their one legal range, with a default. */
export function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export interface Solid {
  readonly id: SolidId;
  readonly revision: number;
  readonly recipe: SolidRecipe;
  readonly meta: SolidMeta;
}

export interface Envelope {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A cut through the whole model; see `setSection` in commands.ts. */
export interface SectionPlane {
  readonly axis: "x" | "y" | "z";
  /** Position along the axis, in mm. */
  readonly offset: number;
  /** True removes the positive side of the axis, false the negative side. */
  readonly flip: boolean;
}

export interface DocumentState {
  readonly schemaVersion: number;
  readonly units: "mm";
  readonly envelope: Envelope | null;
  readonly solids: ReadonlyMap<SolidId, Solid>;
  /** Active section plane, or null. A view setting that is still saved. */
  readonly section: SectionPlane | null;
}

export const DEFAULT_COLORS = [
  "#e8b04b",
  "#5fb0e8",
  "#8fd694",
  "#e87f7f",
  "#c9a4ef",
  "#f2d16b",
  "#7ad0c8",
] as const;
