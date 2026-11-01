import { describe, expect, it } from "vitest";
import { commandKeys } from "../src/commands.gen.js";
import {
  bindShortcut,
  conflicts,
  effectiveKeys,
  holderOf,
  parseOverrides,
  resetAll,
  resetShortcut,
  serialiseOverrides,
  unbindShortcut,
  type KeyOverrides,
} from "../src/keybindings.js";
import { commandForEvent } from "../src/keymap.js";

const DEFAULTS = { rectangle: "r", circle: "c", group: "Ctrl+g", undo: "Ctrl+z", select: " " } as const;

/** A key event shaped the way a browser reports it. */
const press = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("the generated table is usable as a keymap", () => {
  it("has no two commands on one shortcut", () => {
    // If the shipped table clashes, nothing the user rebinds will be trustworthy.
    const table = effectiveKeys(commandKeys, {});
    const seen = new Map<string, string>();
    for (const [id, spec] of Object.entries(table)) {
      if (spec === undefined) continue;
      expect(seen.get(spec), `${id} and ${seen.get(spec)} both claim ${spec}`).toBeUndefined();
      seen.set(spec, id);
    }
  });
});

describe("effective keymap", () => {
  it("starts as the defaults, in canonical form", () => {
    expect(effectiveKeys(DEFAULTS, {}).group).toBe("ctrl+g");
  });

  it("an override replaces the default", () => {
    expect(effectiveKeys(DEFAULTS, { rectangle: "Alt+q" }).rectangle).toBe("alt+q");
  });

  it("null removes the shortcut and does not restore the default", () => {
    // A user who clears a key means it; reloading must not silently put it back.
    expect(effectiveKeys(DEFAULTS, { rectangle: null }).rectangle).toBeUndefined();
  });

  it("ignores an override for a command that no longer exists", () => {
    expect(effectiveKeys(DEFAULTS, { longGone: "Ctrl+Shift+F12" })).not.toHaveProperty("longGone");
  });
});

describe("binding", () => {
  it("binds a free key and stores the typed spelling", () => {
    const r = bindShortcut(DEFAULTS, {}, "rectangle", "Alt+R");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(effectiveKeys(DEFAULTS, r.overrides).rectangle).toBe("alt+r");
  });

  it("refuses a key another command holds, and names it", () => {
    const r = bindShortcut(DEFAULTS, {}, "rectangle", "Ctrl+G");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("taken");
    expect(r.holder).toBe("group");
  });

  it("a refused binding changes nothing", () => {
    const before: KeyOverrides = { circle: "b" };
    const r = bindShortcut(DEFAULTS, before, "rectangle", "b");
    expect(r.ok).toBe(false);
    expect(before).toEqual({ circle: "b" });
  });

  it("lets a command keep the key it already has", () => {
    // Re-recording the same key should not report a clash with itself.
    const r = bindShortcut(DEFAULTS, {}, "group", "Ctrl+g");
    expect(r.ok).toBe(true);
  });

  it("refuses keys the browser owns", () => {
    // Ctrl+R reloads the page; binding it would look like the app crashed.
    const r = bindShortcut(DEFAULTS, {}, "rectangle", "Ctrl+R");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved");
  });

  it("refuses an empty key", () => {
    const r = bindShortcut(DEFAULTS, {}, "rectangle", "   ");
    expect(r.ok).toBe(false);
  });
});

describe("unbinding and resetting", () => {
  it("unbind keeps the command unbound", () => {
    const o = unbindShortcut({}, "rectangle");
    expect(effectiveKeys(DEFAULTS, o).rectangle).toBeUndefined();
  });

  it("reset one command puts its default back", () => {
    const o = resetShortcut({ rectangle: "q", circle: "b" }, "rectangle");
    expect(effectiveKeys(DEFAULTS, o).rectangle).toBe("r");
    expect(effectiveKeys(DEFAULTS, o).circle).toBe("b");
  });

  it("reset all returns the shipped table", () => {
    expect(effectiveKeys(DEFAULTS, resetAll())).toEqual(effectiveKeys(DEFAULTS, {}));
  });
});

describe("storage", () => {
  it("round-trips through text with a stable order and canonical spelling", () => {
    const o: KeyOverrides = { rectangle: "Q", circle: null };
    const text = serialiseOverrides(o);
    // Stored as typed by the user, one spelling per key on disk.
    expect(text).toBe('{"circle":null,"rectangle":"q"}');
    expect(parseOverrides(text)).toEqual({ circle: null, rectangle: "q" });
  });

  it("writes modifiers in canonical order", () => {
    expect(serialiseOverrides({ group: "Shift+Ctrl+G" })).toBe('{"group":"ctrl+shift+g"}');
  });

  it("an empty or missing value parses as the defaults", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides("")).toEqual({});
  });

  it("corrupt text parses as the defaults rather than throwing", () => {
    // A hand-edited or half-written blob must not stop the editor starting.
    expect(parseOverrides("{oops")).toEqual({});
    expect(parseOverrides("[1,2,3]")).toEqual({});
    expect(parseOverrides('"a string"')).toEqual({});
  });

  it("drops bad entries but keeps the good ones", () => {
    expect(parseOverrides('{"rectangle":"q","circle":7,"undo":null}')).toEqual({ rectangle: "q", undo: null });
  });
});

describe("detection", () => {
  it("finds the holder of a key", () => {
    const table = effectiveKeys(DEFAULTS, {});
    expect(holderOf(table, "ctrl+z")).toBe("undo");
    expect(holderOf(table, "ctrl+z", "undo")).toBeUndefined();
  });

  it("reports a clash imported from storage", () => {
    // A hand-edited file can put two commands on one key. Binding refuses it, but
    // a file loaded from disk was never "bound", so the editor must detect it.
    const table = effectiveKeys(DEFAULTS, { circle: "r" });
    expect(table.circle).toBe("r");
    expect(table.rectangle).toBe("r");
    expect(conflicts(DEFAULTS, { circle: "r" })).toEqual(["r"]);
  });

  it("no clash when every key is distinct", () => {
    expect(conflicts(DEFAULTS, { circle: "b" })).toEqual([]);
  });
});

describe("lookup uses the user's table", () => {
  it("a rebound key fires its command and the old key does not", () => {
    const table = effectiveKeys(DEFAULTS, { rectangle: "Alt+q" });
    expect(commandForEvent(table, press("q", { altKey: true }))).toBe("rectangle");
    expect(commandForEvent(table, press("r"))).toBeNull();
  });

  it("a cleared key no longer fires", () => {
    const table = effectiveKeys(DEFAULTS, { rectangle: null });
    expect(commandForEvent(table, press("r"))).toBeNull();
  });
});
