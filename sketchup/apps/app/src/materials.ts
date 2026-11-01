import type { Session, SolidId } from "@apexus/engine";
import { setColor } from "@apexus/engine";

/**
 * The materials strip: the colours a user keeps, and the bucket colour.
 *
 * Pure state plus DOM rendering, with no knowledge of tools, selection or
 * commands beyond the two it is handed. Persistence is best-effort: a browser
 * with storage blocked still gets the defaults for the session, because a paint
 * bucket that refuses to open is worse than one that forgets.
 */

const STORAGE_KEY = "fitcheck.materials";

/** Hex colours only: the strip renders them straight into `style.background`. */
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS = ["#d64541", "#f0a500", "#2e8b57", "#2f6f9f", "#d9d9d9", "#3b3b3b"] as const;

/** What the strip needs from the app; supplied by the composition root. */
export interface MaterialsHost {
  readonly session: Session;
  /** The ids a click should paint. Empty means "just pick the colour". */
  selection(): readonly SolidId[];
  /** One line of user-visible feedback. */
  say(text: string): void;
  /** Run a command quietly: failures go to the hint line, not a dialog. */
  quietly(action: () => void, success: string): void;
}

export const MAX_MATERIALS = 24;

/**
 * Read the saved strip, dropping anything that is not a hex colour.
 *
 * Dropping per entry rather than per file: one bad swatch from an older build
 * must not cost the user the other twenty.
 */
export function parseMaterials(raw: string | null): string[] {
  if (!raw) return [...DEFAULTS];
  try {
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return [...DEFAULTS];
    const clean = saved.filter((c): c is string => typeof c === "string" && HEX.test(c));
    return clean.length > 0 ? clean.slice(0, MAX_MATERIALS) : [...DEFAULTS];
  } catch {
    return [...DEFAULTS];
  }
}

/** Add a colour to the front of the strip, deduplicating and capping it. */
export function addMaterial(list: readonly string[], color: string): string[] {
  const value = color.toLowerCase();
  if (!HEX.test(value)) return [...list];
  return [value, ...list.filter((c) => c.toLowerCase() !== value)].slice(0, MAX_MATERIALS);
}

export class MaterialsPanel {
  #host: MaterialsHost;
  #colors: string[];
  #paintColor = "#d64541";
  readonly #strip: HTMLElement;
  readonly #input: HTMLInputElement;

  constructor(host: MaterialsHost, strip: HTMLElement, input: HTMLInputElement) {
    this.#host = host;
    this.#strip = strip;
    this.#input = input;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }
    this.#colors = parseMaterials(raw);
    this.#input.value = this.#paintColor;
  }

  /** The colour the Paint tool applies. */
  get paintColor(): string {
    return this.#paintColor;
  }

  get colors(): readonly string[] {
    return this.#colors;
  }

  setPaintColor(color: string): void {
    this.#paintColor = color;
    this.#input.value = color;
  }

  /** Clicking a swatch both picks the colour *and* paints the selection, as a bucket should. */
  use(color: string): void {
    this.setPaintColor(color);
    const ids = [...this.#host.selection()];
    if (ids.length === 0) {
      this.#host.say(`Bucket now holds ${color}. Click objects with the Paint tool.`);
      return;
    }
    this.#host.quietly(() => this.#host.session.execute(setColor(ids, color)), `Painted ${ids.length} object(s) ${color}.`);
  }

  /** Save the input's colour into the strip. */
  remember(color: string): void {
    this.#colors = addMaterial(this.#colors, color);
    this.#save();
    this.render();
    this.#host.say(`Saved ${color.toLowerCase()} to materials.`);
  }

  render(): void {
    this.#strip.replaceChildren();
    for (const color of this.#colors) {
      const b = document.createElement("button");
      b.className = "swatch-chip";
      b.style.background = color;
      b.title = `${color}: paint the selection`;
      b.dataset["color"] = color;
      if (color === this.#paintColor) b.classList.add("active");
      b.addEventListener("click", () => this.use(color));
      this.#strip.append(b);
    }
  }

  #save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#colors));
    } catch {
      // Storage full or blocked: the strip still works this session.
    }
  }
}
