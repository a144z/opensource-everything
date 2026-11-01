/**
 * Command palette (Ctrl/Cmd+K).
 *
 * Pure presentation: it renders a ranked list and reports the chosen id. It
 * never runs a command, never touches the document, and knows nothing about
 * tools - the shell owns that. That keeps the palette testable by eye and the
 * command semantics in one place.
 */

import { commandAll, commandDescribe, commandKeys, commandLabels, rank, type CommandId } from "@apexus/engine";

export interface PaletteOptions {
  /** Runs the command; the palette closes first so focus returns to the canvas. */
  run(id: CommandId): void;
  /** Optional extra filter: a command the current state cannot run is hidden. */
  enabled?(id: CommandId): boolean;
}

const ALL = commandAll.map((id) => ({ id, label: commandLabels[id] }));

export class CommandPalette {
  readonly #root: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #list: HTMLUListElement;
  readonly #options: PaletteOptions;
  #results: readonly CommandId[] = [];
  #active = 0;

  constructor(options: PaletteOptions) {
    this.#options = options;
    this.#root = document.getElementById("palette") as HTMLElement;
    this.#input = document.getElementById("palette-input") as HTMLInputElement;
    this.#list = document.getElementById("palette-list") as HTMLUListElement;
    if (!this.#root || !this.#input || !this.#list) {
      throw new Error("palette markup missing: #palette, #palette-input, #palette-list");
    }

    this.#input.addEventListener("input", () => this.#render());
    this.#input.addEventListener("keydown", (e) => this.#onKey(e));
    // Click anywhere else closes without running anything.
    window.addEventListener("pointerdown", (e) => {
      if (this.isOpen && !this.#root.contains(e.target as Node)) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.#root.hidden;
  }

  open(): void {
    this.#root.hidden = false;
    this.#input.value = "";
    this.#active = 0;
    this.#render();
    this.#input.focus();
  }

  close(): void {
    this.#root.hidden = true;
    this.#input.value = "";
    this.#input.blur();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  #render(): void {
    const query = this.#input.value;
    const allowed = this.#options.enabled;
    const candidates = allowed ? ALL.filter((c) => allowed(c.id)) : ALL;
    const hits = rank(query, candidates, 10);
    this.#results = hits.map((h) => h.item.id);
    this.#active = Math.min(this.#active, Math.max(0, this.#results.length - 1));

    this.#list.replaceChildren(
      ...hits.map((hit, index) => {
        const li = document.createElement("li");
        li.role = "option";
        li.className = index === this.#active ? "active" : "";
        li.dataset["id"] = hit.item.id;
        li.append(...highlight(hit.item.label, hit.hits));

        const key = commandKeys[hit.item.id];
        if (key) {
          const kbd = document.createElement("kbd");
          kbd.textContent = key;
          li.append(kbd);
        }
        // mousedown, not click: the input blur would close the bar first.
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.#activate(index);
        });
        return li;
      }),
    );
    if (hits.length === 0) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = "No command matches";
      this.#list.append(li);
    }
  }

  #onKey(e: KeyboardEvent): void {
    const n = this.#results.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.#active = (this.#active + step + n) % n;
      this.#render();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (n > 0) this.#activate(this.#active);
      return;
    }
    // The palette owns the keyboard while it is open; the shell's tool
    // shortcuts must not fire behind it.
    e.stopPropagation();
  }

  #activate(index: number): void {
    const id = this.#results[index];
    this.close();
    if (id) this.#options.run(id);
  }
}

/** Split a label into plain and matched spans, so the matched letters stand out. */
function highlight(label: string, hits: readonly number[]): Node[] {
  const set = new Set(hits);
  const nodes: Node[] = [];
  let buffer = "";
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) {
      if (buffer) nodes.push(document.createTextNode(buffer));
      buffer = "";
      const mark = document.createElement("mark");
      mark.textContent = label[i]!;
      nodes.push(mark);
    } else {
      buffer += label[i]!;
    }
  }
  if (buffer) nodes.push(document.createTextNode(buffer));
  return nodes;
}

/** Human text for a command id, for hints and titles. */
export function commandTitle(id: CommandId): string {
  return commandDescribe(id).label;
}
