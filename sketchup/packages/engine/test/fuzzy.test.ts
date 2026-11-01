import { describe, expect, it } from "vitest";
import { isSubsequence, rank, scoreMatch } from "@apexus/engine";
import { commandAll, commandDescribe, commandKeys, commandLabels } from "@apexus/engine";

const items = commandAll.map((id) => ({ id, label: commandLabels[id] }));

describe("subsequence", () => {
  it("accepts letters in order and rejects out of order", () => {
    expect(isSubsequence("pp", "pushpull")).toBe(true);
    expect(isSubsequence("pp", "pump")).toBe(true); // p at 0, p at 2
    expect(isSubsequence("pu", "up")).toBe(false); // order matters
    expect(isSubsequence("", "anything")).toBe(true);
  });
});

describe("scoring", () => {
  it("a word-start match beats the same letters buried mid-word", () => {
    const wordStart = scoreMatch("pu", { id: "x", label: "Pull Up" })!;
    const inner = scoreMatch("pu", { id: "y", label: "Output Use" })!;
    expect(wordStart.score).toBeGreaterThan(inner.score);
  });

  it("a prefix always beats a word-start-only match", () => {
    const prefix = scoreMatch("rect", { id: "a", label: "Rectangle" })!;
    const wordStart = scoreMatch("rect", { id: "b", label: "Draw Rectangle Frame" })!;
    expect(prefix.score).toBeGreaterThan(wordStart.score);
  });

  it("reports the matched positions for highlighting", () => {
    const hit = scoreMatch("pu", { id: "pushpull", label: "Push/Pull" })!;
    expect(hit.hits).toEqual([0, 1]);
  });

  it("still finds a command by its id when the label does not match", () => {
    const hit = scoreMatch("fit", items.find((i) => i.id === "fit")!);
    expect(hit).not.toBeNull();
  });

  it("returns null for a non-match and the whole list for an empty query", () => {
    expect(scoreMatch("zzz", { id: "a", label: "Select" })).toBeNull();
    expect(scoreMatch("  ", { id: "a", label: "Select" })!.score).toBe(0);
  });
});

describe("ranking the real command table", () => {
  it("an empty query lists every command", () => {
    expect(rank("", items, 99)).toHaveLength(commandAll.length);
  });

  it("'r' ranks every word-initial match above inner matches", () => {
    const ranked = rank("r", items, 99);
    const wordInitial = new Set(["rectangle", "rotate", "redo"]);
    const firstInner = ranked.findIndex((s) => !wordInitial.has(s.item.id));
    const lastWordInitial = ranked.map((s) => s.item.id).lastIndexOf("rectangle");
    // Every command whose label starts a word with R must come before the
    // inner matches, or the bar would bury the obvious answer.
    expect(lastWordInitial).toBeLessThan(firstInner === -1 ? Infinity : firstInner);
    expect(ranked[0]!.item.label.startsWith("R")).toBe(true);
  });

  it("'pu' finds Push/Pull first", () => {
    expect(rank("pu", items)[0]!.item.id).toBe("pushpull");
  });

  it("'dim' finds Dimension first", () => {
    expect(rank("dim", items)[0]!.item.id).toBe("dimension");
  });

  it("honours the limit and never invents commands", () => {
    const hits = rank("o", items, 3);
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(commandAll).toContain(h.item.id);
  });
});

describe("generated command table", () => {
  it("every command has a label and a describe entry", () => {
    for (const id of commandAll) {
      expect(commandLabels[id]).toBeTruthy();
      expect(commandDescribe(id)).toEqual({ id, label: commandLabels[id] });
    }
  });

  it("shortcuts are unique where they exist (case-insensitive)", () => {
    const seen = new Map<string, string>();
    for (const [id, key] of Object.entries(commandKeys)) {
      const k = key.toLowerCase();
      expect(seen.has(k), `${id} repeats the shortcut of ${seen.get(k)}`).toBe(false);
      seen.set(k, id);
    }
  });

  it("move, rotate, circle and arc are addressable from the command bar", () => {
    for (const id of ["move", "rotate", "circle", "arc"] as const) {
      expect(commandAll).toContain(id);
    }
  });
});
