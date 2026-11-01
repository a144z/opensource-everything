/**
 * Command palette (Ctrl/Cmd+K).
 *
 * Pure presentation: it renders a ranked list and reports the chosen id. It
 * never runs a command, never touches the document, and knows nothing about
 * tools - the shell owns that. That keeps the palette testable by eye and the
 * command semantics in one place.
 */

import { commandAll, commandDescribe, commandLabels, rank, type CommandId } from "@apexus/engine";

export interface PaletteOptions {
  /** Runs the command; the palette closes first so focus returns to the canvas. */
  run(id: CommandId): void;
  /** Optional extra filter: a command the current state cannot run is hidden. */
  enabled?(id: CommandId): boolean;
  /**
   * The user's live shortcut table. Passed in rather than imported so a rebound
   * key shows what the user actually has, not the shipped default, and so the
   * palette never needs to know where the keymap is stored.
   */
  keys?(): Readonly<Record<string, string | undefined>>;
  /**
   * Rebind a command, or return a refusal reason. Present only when the palette
   * should offer editing; without it the shortcut is shown read-only.
   */
  rebind?(id: CommandId, spec: string): { ok: true } | { ok: false; message: string };
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

        const key = this.#options.keys?.()[hit.item.id];
        if (this.#options.rebind) {
          // A shortcut that is clickable to change it. Recording happens here,
          // so the editor cannot drift from the list it edits.
          const kbd = document.createElement("kbd");
          kbd.className = "editable";
          kbd.textContent = key ?? "click to set";
          kbd.title = "Click, then press the new keys";
          kbd.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.#record(kbd, hit.item.id);
          });
          li.append(kbd);
        } else if (key) {
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

  /**
   * Record one keystroke for `id`. The binding is stored in canonical form
   * (`ctrl+shift+g`), which is what the lookup compares, so the editor and the
   * keyboard can never disagree about spelling. Escape cancels; a refusal (key
   * already taken, key the browser needs) is shown on the row and nothing is
   * saved, because a half-applied binding is a shortcut that silently never runs.
   */
  #record(kbd: HTMLElement, id: CommandId): void {
    const previous = kbd.textContent ?? "";
    kbd.textContent = "press keys...";
    kbd.classList.add("recording");
    const done = (): void => {
      window.removeEventListener("keydown", onKey, true);
      kbd.classList.remove("recording");
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        kbd.textContent = previous;
        done();
        return;
      }
      // A bare modifier is not a shortcut; wait for a real key.
      if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
      const spec = describeBinding(e);
      done();
      const result = this.#options.rebind?.(id, spec);
      if (result && !result.ok) {
        kbd.textContent = previous;
        kbd.classList.add("refused");
        kbd.title = result.message;
        window.setTimeout(() => kbd.classList.remove("refused"), 1200);
        return;
      }
      this.#render();
    };
    window.addEventListener("keydown", onKey, true);
  }
}

/**
 * A key event as the table spells it: `Ctrl+Shift+G`, `Delete`, ` `.
 *
 * This is the inverse of `bindKey` and is here rather than in the engine because
 * it is about turning an event into *text a person reads*, not about deciding
 * which command a key names.
 */
export function describeBinding(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join("+");
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
