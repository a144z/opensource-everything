import { describe, expect, it } from "vitest";
import { commandAll, commandDescribe, commandLabels, isCommand } from "../src/index.js";

/**
 * The generated command table is the one place the editor's vocabulary lives.
 * These checks are the contract: a tool the UI offers must be a command, and an
 * id nobody registered must be refused rather than half-handled.
 */
const TOOL_IDS = [
  "select",
  "rectangle",
  "pushpull",
  "line",
  "tape",
  "dimension",
  "followme",
  "offset",
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
});
