import { describe, expect, it } from "vitest";
import { commandAll, commandDescribe, commandForEvent, commandKeys, commandLabels, isCommand } from "../src/index.js";

/**
 * The generated command table is the one place the editor's vocabulary lives.
 * These checks are the contract: a tool the UI offers must be a command, and an
 * id nobody registered must be refused rather than half-handled.
 */
const TOOL_IDS = [
  "select",
  "rectangle",
  "rotatedRectangle",
  "pushpull",
  "line",
  "tape",
  "dimension",
  "followme",
  "offset",
  "scale",
  "paint",
  "eraser",
] as const;

describe("generated command table", () => {
  it("lists every tool the view can be in", () => {
    for (const tool of TOOL_IDS) {
      expect(isCommand(tool), `tool ${tool} is not a command`).toBe(true);
    }
  });

  it("has no duplicate labels", () => {
    const labels = Object.values(commandLabels);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("describes only registered ids", () => {
    expect(commandDescribe("dimension")).toEqual({ id: "dimension", label: "Dimension" });
    expect(commandAll).toHaveLength(Object.keys(commandLabels).length);
    expect(isCommand("teleport")).toBe(false);
  });

  it("keeps destructive verbs out of the tool palette", () => {
    // Tools are the things a single click can start; delete/undo are not.
    expect(commandLabels["delete"]).toBe("Delete");
    expect(commandLabels["undo"]).toBe("Undo");
  });

  it("binds the L2 tools to the keys SketchUp uses", () => {
    const bind = (key: string, alt = false) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: alt,
      shiftKey: false,
    });
    expect(commandForEvent(commandKeys, bind("s"))).toBe("scale");
    expect(commandForEvent(commandKeys, bind("b"))).toBe("paint");
    expect(commandForEvent(commandKeys, bind("e"))).toBe("eraser");
    expect(commandForEvent(commandKeys, bind("r", true))).toBe("rotatedRectangle");
    // Plain R stays the axis-aligned rectangle: Alt is what tells them apart.
    expect(commandForEvent(commandKeys, bind("r"))).toBe("rectangle");
  });
});
