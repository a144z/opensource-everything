/** Engine types. Units: millimetres everywhere. */

import type { Vec2, Vec3 } from "@apexus/geometry";

export const SCHEMA_VERSION = 1;
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
      /** Closed ring in a plane, extruded along the plane normal by `distance`. */
      readonly kind: "loop";
      readonly points: readonly Vec2[];
      readonly plane: { readonly origin: Vec3; readonly normal: Vec3 };
      readonly distance: number;
    })
  | (RecipeBase & {
      /** Boolean of two solids, run through the kernel. */
      readonly kind: "boolean";
      readonly op: BooleanOp;
      readonly a: SolidId;
      readonly b: SolidId;
    })
  | (RecipeBase & {
      /** Rigid move / rotate / uniform scale of another solid's mesh. */
      readonly kind: "transform";
      readonly child: SolidId;
    })
  | (RecipeBase & {
      /** Imported triangle soup (STL, glTF); already a closed mesh. */
      readonly kind: "mesh";
      readonly positions: readonly number[];
      readonly indices: readonly number[];
    });

export type RecipeKind = SolidRecipe["kind"];

export interface SolidMeta {
  readonly name: string;
  readonly color: string;
  readonly hidden: boolean;
  readonly locked: boolean;
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

export interface DocumentState {
  readonly schemaVersion: number;
  readonly units: "mm";
  readonly envelope: Envelope | null;
  readonly solids: ReadonlyMap<SolidId, Solid>;
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
