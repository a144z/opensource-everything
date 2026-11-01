/**
 * Turning an imported file into something the document can hold (tasks
 * L3-1/L3-2/L3-3, plus DAE and OBJ).
 *
 * Everything here is pure: text in, a description out. The app decides what to
 * do with it, so the rules live in one place rather than being re-typed in each
 * event handler, and this can be tested without a DOM.
 *
 * Two rules every mesh importer obeys:
 *
 *   1. **What this module returns is already in millimetres.** A file's own unit
 *      is applied here, once, so nothing downstream has to remember which files
 *      were metres.
 *   2. **Every triangle is welded by the geometry layer.** STL repeats a vertex
 *      for every face that uses it; a `mesh` recipe keyed on raw corners would
 *      report a closed box as open. `fromStlAscii` welds; OBJ and DAE are welded
 *      on import here.
 *
 * A DXF is a set of polylines, not a mesh, so it comes back as closed outlines:
 * turning a loop into a face is a decision the user should make, not one an
 * importer may guess.
 */

import {
  EMPTY_AABB,
  fromDxf,
  fromStlAscii,
  meshBounds,
  weld,
  type Aabb,
  type MeshData,
  type Vec2,
} from "@apexus/geometry";
import type { SolidRecipe } from "@apexus/engine";
import { parseDae } from "./dae.js";
import { objUnitMm, parseObj } from "./obj.js";

export type ImportedFile =
  | {
      readonly kind: "mesh";
      readonly name: string;
      readonly recipe: SolidRecipe;
      readonly bounds: Aabb;
      /** A sentence the caller should show: an assumption, or a unit it applied. */
      readonly note: string;
    }
  | { readonly kind: "outline"; readonly name: string; readonly loops: readonly (readonly Vec2[])[]; readonly note: string };

export type ImportFailure = { readonly kind: "error"; readonly reason: string };

export type ImportOutcome = ImportedFile | ImportFailure;

/** Extension to reader, so a dragged file with no name still has a chance. */
export function formatOf(fileName: string): "stl" | "obj" | "dae" | "dxf" | "project" | null {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith(".stl")) return "stl";
  if (lower.endsWith(".obj")) return "obj";
  if (lower.endsWith(".dae")) return "dae";
  if (lower.endsWith(".dxf")) return "dxf";
  if (lower.endsWith(".fcproj") || lower.endsWith(".json")) return "project";
  return null;
}

/** Read any supported interchange file. Never throws: a refusal is a value. */
export function readImport(fileName: string, text: string): ImportOutcome {
  const format = formatOf(fileName);
  if (format === null) {
    return { kind: "error", reason: `Cannot import "${fileName}": use .stl, .obj, .dae or .dxf.` };
  }
  try {
    switch (format) {
      case "stl": {
        // STL carries no unit either; millimetres is the 3D-printing default and
        // the same assumption the exporter makes.
        const mesh = fromStlAscii(text);
        return meshFile("Imported STL", mesh, "STL has no unit; read as millimetres.");
      }
      case "obj": {
        const obj = parseObj(text);
        const mm = objUnitMm(obj.declaredUnit);
        const scaled = scaleVertices({ positions: new Float32Array(obj.positions), indices: new Uint32Array(obj.indices) }, mm ?? 1);
        return meshFile(
          obj.name,
          weld(scaled),
          mm === null ? "OBJ declares no unit; read as millimetres." : `Scaled from ${obj.declaredUnit}.`,
        );
      }
      case "dae": {
        const dae = parseDae(text);
        const mesh = weld({ positions: new Float32Array(dae.positions), indices: new Uint32Array(dae.indices) });
        // COLLADA states metres per file unit; `meter="0.01"` is centimetres.
        return meshFile(dae.name, scaleVertices(mesh, dae.unitMetres * 1000), `Scaled ×${dae.unitMetres * 1000} from COLLADA units.`);
      }
      case "dxf": {
        const loops = fromDxf(text);
        if (loops.length === 0) {
          return {
            kind: "error",
            reason:
              "That DXF has no closed polylines. Only closed LWPOLYLINE/POLYLINE outlines are read; an open one would be closed by a guess.",
          };
        }
        return { kind: "outline", name: "Imported DXF", loops, note: `${loops.length} closed outline(s).` };
      }
      case "project":
        return { kind: "error", reason: "That is a project file; use Open rather than Import." };
    }
  } catch (err) {
    return { kind: "error", reason: `Could not import "${fileName}": ${(err as Error).message}` };
  }
}

function meshFile(name: string, mesh: MeshData, note: string): ImportOutcome {
  if (mesh.indices.length < 3) return { kind: "error", reason: `${name}: the file has no faces.` };
  // A mesh recipe carries raw arrays and an identity matrix; the document never
  // stores a second copy of the transform, per schema 5.
  const recipe: SolidRecipe = {
    kind: "mesh",
    positions: Array.from(mesh.positions),
    indices: Array.from(mesh.indices),
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  return { kind: "mesh", name, recipe, bounds: mesh.indices.length === 0 ? EMPTY_AABB : meshBounds(mesh), note };
}

/** Scale positions in place; `weld` has not run yet, so every corner moves once. */
function scaleVertices(mesh: MeshData, factor: number): MeshData {
  if (factor === 1) return mesh;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i++) p[i] = p[i]! * factor;
  return mesh;
}
