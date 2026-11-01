import type { Pt } from "@apexus/cad";
import { pt } from "@apexus/cad";

/**
 * Model space <-> canvas. One scale for both axes (a drafting viewport never
 * squashes), Y up on screen the way CAD users expect, origin anywhere.
 *
 * `unit` is CSS pixels per mm; the grid is drawn from the scale so a line at
 * 100 mm is always 100 mm of paper-equivalent distance, never a fixed pixel
 * count that lies when you zoom.
 */
export class Camera {
  /** mm at the centre of the canvas. */
  center: Pt = pt(0, 0);
  /** Device-independent pixels per mm. */
  unit = 1;
  /** CSS size of the canvas. */
  width = 800;
  height = 600;

  toScreen(p: Pt): Pt {
    return pt(this.width / 2 + (p.x - this.center.x) * this.unit, this.height / 2 - (p.y - this.center.y) * this.unit);
  }

  toModel(p: Pt): Pt {
    return pt(this.center.x + (p.x - this.width / 2) / this.unit, this.center.y - (p.y - this.height / 2) / this.unit);
  }

  /** Screen pixels converted to model mm, for pick radii and text sizes. */
  mm(px: number): number {
    return px / this.unit;
  }

  /** Zoom about a screen point: the model point under the cursor does not move. */
  zoomAt(screen: Pt, factor: number): void {
    const before = this.toModel(screen);
    this.unit = Math.min(1e5, Math.max(1e-4, this.unit * factor));
    const after = this.toModel(screen);
    this.center = pt(this.center.x + (before.x - after.x), this.center.y + (before.y - after.y));
  }

  panBy(dx: number, dy: number): void {
    this.center = pt(this.center.x - dx / this.unit, this.center.y + dy / this.unit);
  }

  /** Fit a model box with a margin, clamped to something readable. */
  fit(box: { min: Pt; max: Pt } | null): void {
    if (!box) {
      this.center = pt(0, 0);
      this.unit = Math.min(this.width, this.height) / 200;
      return;
    }
    const w = Math.max(box.max.x - box.min.x, 1e-6);
    const h = Math.max(box.max.y - box.min.y, 1e-6);
    this.center = pt((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2);
    this.unit = Math.min((this.width * 0.9) / w, (this.height * 0.9) / h);
    this.unit = Math.min(1e5, Math.max(1e-4, this.unit));
  }

  /** Nearest "nice" grid step (1, 2, 5 x 10^n) whose line is at least `px` apart. */
  gridStep(px = 18): number {
    const raw = px / this.unit;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
    return 10 * pow;
  }
}

/** Device pixel ratio aware canvas sizing; returns the CSS size. */
export function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, camera: Camera): void {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  camera.width = Math.max(1, Math.round(rect.width));
  camera.height = Math.max(1, Math.round(rect.height - 2));
  canvas.width = Math.round(camera.width * dpr);
  canvas.height = Math.round(camera.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
