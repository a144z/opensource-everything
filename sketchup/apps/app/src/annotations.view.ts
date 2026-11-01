import * as THREE from "three";
import { AnnotationStore, dimensionLength, type Annotation } from "@apexus/engine";
import type { Vec3 } from "@apexus/geometry";

/**
 * Dimension annotations on the canvas (task L2-9).
 *
 * Annotations live beside the document, not inside it: they are app state with
 * no undo entry and no effect on the fit check (see the engine's annotations.ts).
 * This module owns only the drawing of them, because the geometry of a dimension
 * line — where it sits relative to its axis, how high it floats — is a
 * presentation decision that must not leak into the engine.
 */

/** Dimension lines float this far above their plane so they never z-fight. */
export const ANNOTATION_LIFT = 0.6;

/** The 3D endpoints of a dimension: along its axis, offset outward for legibility. */
export function dimensionPoints(note: Annotation): [Vec3, Vec3] {
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

/** A solid-colour overlay line (annotations draw over the model, never depth-tested). */
function overlayLine(color: number): THREE.Line {
  const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const line = new THREE.Line(new THREE.BufferGeometry(), material);
  line.renderOrder = 20;
  return line;
}

/** A camera-facing text label on a small card, so it stays readable at any zoom. */
function labelSprite(text: string, at: Vec3): THREE.Sprite {
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

/** Draws the annotation store into a THREE group, rebuilding only on demand. */
export class AnnotationLayer {
  readonly store = new AnnotationStore();
  readonly #group = new THREE.Group();
  readonly #invalidate: () => void;

  constructor(scene: THREE.Scene, invalidate: () => void) {
    this.#invalidate = invalidate;
    this.#group.name = "annotations";
    scene.add(this.#group);
  }

  /** The number of annotations, for the harness and the status line. */
  get count(): number {
    return this.store.all().length;
  }

  /** Detach the whole layer from the scene (used when a project is loaded). */
  clear(): void {
    for (const note of this.store.all()) this.store.remove(note.id);
    this.render();
  }

  render(): void {
    for (const child of [...this.#group.children]) {
      this.#group.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    for (const note of this.store.all()) {
      if (note.kind !== "dimension") continue;
      const [a, b] = dimensionPoints(note);
      const mm = Math.abs(dimensionLength(note.a, note.b, note.axis));
      const line = overlayLine(0x2f6fed);
      line.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a[0], a[1], a[2] + ANNOTATION_LIFT),
        new THREE.Vector3(b[0], b[1], b[2] + ANNOTATION_LIFT),
      ]);
      this.#group.add(line);
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + ANNOTATION_LIFT];
      this.#group.add(labelSprite(`${mm.toFixed(1)} mm`, mid));
    }
    this.#invalidate();
  }
}
