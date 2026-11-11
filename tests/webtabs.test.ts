import { beforeEach, describe, expect, test } from "bun:test";
import { createTabs, KEY_TABS_STORE, type Store } from "../web/src/tabs.ts";

let mem: Store;
beforeEach(() => { let v: string | null = null; mem = { get: () => v, set: (s) => { v = s; } }; });
const note = (id: string) => ({ type: "item" as const, id });

describe("tabs model", () => {
  test("opening the same document twice keeps one tab and shows it", () => {
    const t = createTabs(mem);
    t.open(note("a"), "A", "Note", { show: true });
    t.open(note("b"), "B", "Note", { show: false });
    t.open(note("a"), "A", "Note", { show: true });
    expect(t.list().map((x) => x.key)).toEqual(["item:a", "item:b"]);
    expect(t.shown()).toBe("item:a");
  });
  test("a quiet open carries a dot and does not change what is shown; showing clears it", () => {
    const t = createTabs(mem);
    t.open(note("a"), "A", "Note", { show: false, dot: true });
    expect(t.shown()).toBeNull();
    expect(t.list()[0].dot).toBe(true);
    t.show("item:a");
    expect(t.list()[0].dot).toBe(false);
    expect(t.shown()).toBe("item:a");
  });
  test("closing shows the tab to the left, the last close shows Chat", () => {
    const t = createTabs(mem);
    for (const id of ["a", "b", "c"]) t.open(note(id), id, "Note", { show: true });
    t.close("item:c");
    expect(t.shown()).toBe("item:b");
    t.close("item:a"); // not shown: unchanged
    expect(t.shown()).toBe("item:b");
    t.close("item:b");
    expect(t.shown()).toBeNull();
    expect(t.list()).toEqual([]);
  });
  test("closing the first shown tab shows Chat, the tab to its left", () => {
    const t = createTabs(mem);
    t.open(note("a"), "A", "Note", { show: true });
    t.open(note("b"), "B", "Note", { show: false });
    t.close("item:a");
    expect(t.shown()).toBeNull();
    expect(t.list().map((x) => x.key)).toEqual(["item:b"]);
  });
  test("tabs, order and the shown tab survive a reload; corrupt storage is ignored", () => {
    const t = createTabs(mem);
    t.open(note("a"), "A", "Note", { show: false, dot: true });
    t.open({ type: "briefing", id: "b" }, "B", "Briefing", { show: true });
    const again = createTabs(mem);
    expect(again.list().map((x) => [x.key, x.title, x.dot])).toEqual([["item:a", "A", true], ["briefing:b", "B", false]]);
    expect(again.shown()).toBe("briefing:b");
    const bad = createTabs({ get: () => "{nope", set: () => {} });
    expect(bad.list()).toEqual([]);
    expect(KEY_TABS_STORE).toBe("jv.tabs");
  });
});
