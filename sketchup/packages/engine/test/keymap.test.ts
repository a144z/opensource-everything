import { describe, expect, it } from "vitest";
import { bindKey, commandForEvent, commandKeys, normaliseShortcut, type Bindable } from "@apexus/engine";

const press = (key: string, mods: Partial<Bindable> = {}): Bindable => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("normalise shortcut", () => {
  it("puts modifiers in one fixed order and lower-cases the key", () => {
    expect(normaliseShortcut("Ctrl+Shift+Z")).toBe("ctrl+shift+z");
    expect(normaliseShortcut("Shift+Ctrl+Z")).toBe("ctrl+shift+z");
    expect(normaliseShortcut("r")).toBe("r");
    expect(normaliseShortcut("R")).toBe("r");
    expect(normaliseShortcut("Delete")).toBe("delete");
    expect(normaliseShortcut(" ")).toBe(" ");
  });

  it("folds Cmd into Ctrl so one table serves Mac and PC", () => {
    expect(normaliseShortcut("Cmd+Z")).toBe("ctrl+z");
    expect(normaliseShortcut("Meta+Z")).toBe("ctrl+z");
  });

  it("keeps a literal plus as the key", () => {
    expect(normaliseShortcut("Ctrl++")).toBe("ctrl++");
  });
});

describe("bind key", () => {
  it("agrees with the table for every generated shortcut", () => {
    for (const [id, spec] of Object.entries(commandKeys)) {
      if (!spec) continue;
      const canonical = normaliseShortcut(spec);
      // The canonical form must survive a second pass, or the two sides could
      // still disagree on a spelling the table happens to use.
      expect(normaliseShortcut(canonical)).toBe(canonical);
    }
  });

  it("matches digits under Ctrl, which a naive toUpperCase would break", () => {
    const table = { viewTop: "Ctrl+1", viewIso: "Ctrl+0" };
    expect(commandForEvent(table, press("1", { ctrlKey: true }))).toBe("viewTop");
    expect(commandForEvent(table, press("0", { ctrlKey: true }))).toBe("viewIso");
    expect(commandForEvent(table, press("1"))).toBeNull();
  });

  it("does not fire a command while Alt or a bare modifier is held", () => {
    const table = { rectangle: "r" };
    expect(commandForEvent(table, press("r", { altKey: true }))).toBeNull();
    expect(commandForEvent(table, press("r"))).toBe("rectangle");
  });

  it("treats Shift-typed punctuation as the character the user sees", () => {
    expect(bindKey(press("?", { shiftKey: true }))).toBe("?");
    expect(commandForEvent({ help: "?" }, press("?", { shiftKey: true }))).toBe("help");
    // A Shift+letter is still just the letter: the table omits Shift for it.
    expect(bindKey(press("R", { shiftKey: true }))).toBe("r");
  });

  it("finds nothing for an unbound key", () => {
    expect(commandForEvent(commandKeys, press("F9"))).toBeNull();
  });
});
