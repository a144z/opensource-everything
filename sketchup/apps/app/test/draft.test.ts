import { describe, expect, it, vi } from "vitest";
import {
  Autosave,
  DRAFT_KEY,
  clearDraft,
  describeDraft,
  draftWorthOffering,
  readDraft,
  writeDraft,
  type Draft,
  type SlotStore,
} from "../src/draft.js";

/** A `localStorage` stand-in that can be told to fail the way a full quota does. */
function memoryStore(): SlotStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe("draft slot", () => {
  it("round-trips a draft", () => {
    const store = memoryStore();
    const draft: Draft = { json: '{"solids":{}}', at: 1_700_000_000_000, fileName: "desk.fcproj" };
    expect(writeDraft(store, draft)).toBe(true);
    expect(readDraft(store)).toEqual(draft);
  });

  it("returns null for an empty slot", () => {
    expect(readDraft(memoryStore())).toBeNull();
  });

  it("drops a malformed draft rather than failing to open the app", () => {
    for (const raw of ["", "not json", "null", "{}", '{"json":""}', '{"at":1}']) {
      const store = memoryStore();
      store.data.set(DRAFT_KEY, raw);
      expect(readDraft(store)).toBeNull();
    }
  });

  it("repairs a missing time or name instead of rejecting the draft", () => {
    const store = memoryStore();
    store.data.set(DRAFT_KEY, JSON.stringify({ json: "{}" }));
    expect(readDraft(store)).toEqual({ json: "{}", at: 0, fileName: null });
  });

  it("clears the slot", () => {
    const store = memoryStore();
    writeDraft(store, { json: "{}", at: 1, fileName: null });
    clearDraft(store);
    expect(readDraft(store)).toBeNull();
  });

  it("swallows a storage failure: losing a draft must not end the session", () => {
    const store: SlotStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => writeDraft(store, { json: "{}", at: 1, fileName: null })).not.toThrow();
    expect(writeDraft(store, { json: "{}", at: 1, fileName: null })).toBe(false);
    expect(readDraft(store)).toBeNull();
    expect(() => clearDraft(store)).not.toThrow();
  });
});

describe("draftWorthOffering", () => {
  const now = 1_700_000_000_000;
  const draft: Draft = { json: '"a"', at: now - 1000, fileName: null };

  it("offers nothing when there is no draft", () => {
    expect(draftWorthOffering(null, null, now)).toBe(false);
  });

  it("offers a fresh draft that differs from the saved file", () => {
    expect(draftWorthOffering(draft, '"b"', now)).toBe(true);
  });

  it("does not offer a draft identical to the saved file: that is noise after a clean close", () => {
    expect(draftWorthOffering(draft, draft.json, now)).toBe(false);
  });

  it("does not offer a stale draft", () => {
    // The bound is inclusive: exactly a week old is still offered, one ms more is not.
    expect(draftWorthOffering(draft, null, now + 1000 + 7 * 24 * 3600_000)).toBe(false);
    expect(draftWorthOffering(draft, null, now + 1000 + 6 * 24 * 3600_000)).toBe(true);
  });

  it("offers a draft even with no saved file to compare against", () => {
    expect(draftWorthOffering(draft, null, now)).toBe(true);
  });
});

describe("describeDraft", () => {
  it("names the file and the time", () => {
    const at = new Date(2024, 0, 2, 14, 5).getTime();
    expect(describeDraft({ json: "{}", at, fileName: "desk.fcproj" })).toBe(`Recover "desk.fcproj" from 14:05`);
  });

  it("says unsaved work when the file was never named", () => {
    const at = new Date(2024, 0, 2, 9, 30).getTime();
    expect(describeDraft({ json: "{}", at, fileName: null })).toBe("Recover unsaved work from 09:30");
  });
});

describe("Autosave", () => {
  it("writes on the first tick, then stays quiet while nothing changes", () => {
    vi.useFakeTimers();
    let json = '"a"';
    const written: Draft[] = [];
    const save = new Autosave(
      1000,
      () => ({ json, fileName: null }),
      (d) => written.push(d),
    );
    save.start();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(3000);
    expect(written).toHaveLength(1);
    json = '"b"';
    vi.advanceTimersByTime(1000);
    expect(written).toHaveLength(2);
    expect(written[1]!.json).toBe('"b"');
    save.stop();
    vi.useRealTimers();
  });

  it("never writes twice for the same document", () => {
    const written: Draft[] = [];
    let json = '"a"';
    const save = new Autosave(1, () => ({ json, fileName: null }), (d) => written.push(d));
    save.tick(1000);
    save.tick(2000);
    json = '"b"';
    save.tick(3000);
    save.tick(4000);
    expect(written.map((d) => d.at)).toEqual([1000, 3000]);
  });

  it("does not re-offer a document that was just saved", () => {
    const written: Draft[] = [];
    let json = '"a"';
    const save = new Autosave(1, () => ({ json, fileName: null }), (d) => written.push(d));
    save.tick(1000);
    save.markSaved(json);
    save.tick(2000);
    expect(written).toHaveLength(1);
  });

  it("stops while paused (a modal or a file write must not interleave)", () => {
    const written: Draft[] = [];
    const save = new Autosave(1, () => ({ json: Math.random().toString(), fileName: null }), (d) => written.push(d));
    save.pause();
    save.tick(1000);
    save.resume();
    save.tick(2000);
    expect(written).toHaveLength(1);
  });

  it("reports no write when the snapshot is unavailable", () => {
    const written: Draft[] = [];
    const save = new Autosave(1, () => null, (d) => written.push(d));
    expect(save.tick(1000)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("start is idempotent and stop is safe when never started", () => {
    vi.useFakeTimers();
    const written: Draft[] = [];
    let json = '"a"';
    const save = new Autosave(1000, () => ({ json, fileName: null }), (d) => written.push(d));
    save.start();
    save.start();
    vi.advanceTimersByTime(1000);
    expect(written).toHaveLength(1);
    save.stop();
    json = '"b"';
    vi.advanceTimersByTime(5000);
    expect(written).toHaveLength(1);
    save.stop();
    new Autosave(1, () => null, () => {}).stop();
    vi.useRealTimers();
  });
});
