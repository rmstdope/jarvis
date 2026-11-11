import { afterEach, describe, expect, test } from "bun:test";
import type { WebEnv } from "./webEnv.ts";
import { boot, button, emptyBrowse, go, ITEM, q, qa, text, type } from "./webBoot.ts";

let env: WebEnv;
afterEach(() => env.restore());
const pg = (offset: number, total: number, hasMore = false) => ({ offset, limit: 20, total, hasMore });
const sum = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ ...ITEM, id, title, ...extra });

describe("every page", () => {
  test("a page that fails to load says so, with the reason, and Try again reloads it", async () => {
    let fail = true;
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/browse", () => (fail ? { status: 500, json: { error: "disk is full" } } : { json: emptyBrowse })) });
    expect(text(".jv-errbox")).toContain("Couldn't load this page.");
    expect(text(".jv-errbox")).toContain("disk is full");
    fail = false;
    button("Try again")!.click();
    await env.tick(60);
    expect(q(".jv-errbox")).toBeNull();
    expect(text(".jv-pt")).toBe("Browse & search");
  });
  test("an item, briefing or presentation that does not exist opens a tab that says so", async () => {
    env = await boot("#/item/NOPE");
    expect(text(".jv-docstate h2")).toBe("This document isn't here any more.");
    expect(text(".jv-docstate p")).toBe("It may have been removed, or renamed by a sync.");
    await go(env, "#/briefing/NOPE");
    expect(qa(".jv-docstate h2").length).toBe(2);
    await go(env, "#/presentation/NOPE");
    expect(qa(".jv-docstate h2").length).toBe(3);
  });
});

describe("Browse & search", () => {
  test("opens with the cursor in the search box; nothing captured yet shows both empty boxes and a Capture button", async () => {
    env = await boot();
    expect(document.activeElement).toBe(q(".jv-searchbar input"));
    expect(q(".jv-searchbar input").getAttribute("placeholder")).toBe("Search J.A.R.V.I.S.…");
    expect(qa(".jv-sh").map((e) => e.textContent)).toEqual(["Recently added", "Recently updated"]);
    const boxes = qa(".jv-empty").map((e) => e.textContent);
    expect(boxes[0]).toContain("Nothing captured yet.");
    expect(boxes[0]).toContain("Save a note or a link and it shows up here.");
    expect(boxes[1]).toContain("Nothing updated yet.");
    button("＋ Capture")!.click();
    await env.tick(60);
    expect(text(".jv-pt")).toBe("Capture");
  });
  test("lists are cards: title, details line, summary, tag pills; filters are pill dropdowns that tint when in use", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/browse", () => ({ json: { added: [sum("I1", "On-call rollout", { summary: "How we roll out.", tags: ["ops"] })], updated: [], pagination: { added: pg(0, 1), updated: pg(0, 0) }, facets: { sources: [{ value: "note", count: 1 }], authors: [{ value: "mia", count: 1 }], tags: [{ value: "ops", count: 1 }] } } })) });
    const card = q(".jv-card");
    expect(card.querySelector("a")!.textContent).toBe("On-call rollout");
    expect(card.querySelector(".jv-m")!.textContent).toBe("note · mia · 2026-01-01");
    expect(card.querySelector(".jv-s")!.textContent).toBe("How we roll out.");
    expect(card.querySelector(".jv-tag")!.textContent).toBe("ops");
    const filters = qa(".jv-filters select");
    expect(filters.map((s) => (s as HTMLSelectElement).options[0].textContent)).toEqual(["All sources", "All contributors", "All tags", "Any time"]);
    expect(filters[0].classList.contains("on")).toBe(false);
    (filters[0] as HTMLSelectElement).value = "note";
    filters[0].dispatchEvent(new Event("change", { bubbles: true }));
    await env.tick(60);
    expect(env.calls.some((c) => c.path.includes("source=note"))).toBe(true);
    expect(qa(".jv-filters select")[0].classList.contains("on")).toBe(true);
  });
  test("paging reads '1–20 of 45' with ‹ Previous and Next ›", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/browse", (_b, r) => { const off = Number(new URL("http://x" + r.path).searchParams.get("addedOffset") ?? 0); return { json: { ...emptyBrowse, added: [sum("A" + off, "Item " + off)], pagination: { added: pg(off, 45, off + 20 < 45), updated: pg(0, 0) } } }; }) });
    expect(text(".jv-pager")).toContain("1–20 of 45");
    expect((button("‹ Previous") as HTMLButtonElement).disabled).toBe(true);
    button("Next ›")!.click();
    await env.tick(60);
    expect(text(".jv-pager")).toContain("21–40 of 45");
  });
  test("a search hit without author or date shows just its kind", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/search", () => ({ json: [{ docId: "I1", title: "T", snippet: "s", score: 1, source: "note" }] })) });
    type(q(".jv-searchbar input"), "t");
    q(".jv-searchbar").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    expect(q(".jv-card .jv-m").textContent).toBe("note");
  });
  test("a search shows one list, no score, highlighted words, '<n> results'; ✕ clears it", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/search", () => ({ json: [{ docId: "I1", title: "On-call rollout", snippet: "the [rollout] plan <b>", score: 0.91234, source: "note", author: "mia", createdAt: "2026-01-05T10:00:00Z" }] })) });
    type(q(".jv-searchbar input"), "rollout");
    q(".jv-searchbar").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    expect(text(".jv-sh")).toBe("1 result");
    expect(qa(".jv-sh").length).toBe(1);
    expect(q(".jv-card mark").textContent).toBe("rollout");
    expect(q(".jv-card").innerHTML).toContain("&lt;b&gt;");
    expect(q(".jv-card").textContent).not.toContain("0.91");
    expect(q(".jv-card .jv-m").textContent).toBe("note · mia · 2026-01-05");
    expect(env.calls.find((c) => c.path.startsWith("/api/search"))!.path).toContain("mode=hybrid");
    button("✕")!.click();
    await env.tick(60);
    expect(qa(".jv-sh").map((e) => e.textContent)).toEqual(["Recently added", "Recently updated"]);
  });
  test("the kind dropdown offers Best match, By meaning, Exact words and sends today's modes", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/search", () => ({ json: [] })) });
    const kind = q(".jv-kind") as HTMLSelectElement;
    expect([...kind.options].map((o) => o.textContent)).toEqual(["Best match", "By meaning", "Exact words"]);
    kind.value = "keyword";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    type(q(".jv-searchbar input"), "zzz");
    q(".jv-searchbar").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    expect(env.calls.find((c) => c.path.startsWith("/api/search"))!.path).toContain("mode=keyword");
    expect(text(".jv-empty")).toContain("No matches for “zzz”.");
    expect(text(".jv-empty")).toContain("Try fewer or different words, or switch the search to Exact words.");
  });
  test("a search with filters in use sends every filter, so only matching results come back", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/search", () => ({ json: [] })) });
    localStorage.setItem("jv.browse", JSON.stringify({ q: "zoom drift", mode: "keyword", source: "note", author: "mia", tag: "ops", days: "7" }));
    await go(env, "#/capture");
    await go(env, "#/browse");
    const sp = new URL("http://x" + env.calls.filter((c) => c.path.startsWith("/api/search")).at(-1)!.path).searchParams;
    expect([sp.get("source"), sp.get("author"), sp.get("tag")]).toEqual(["note", "mia", "ops"]);
    const since = Date.parse(sp.get("since") ?? "");
    expect(Math.abs(Date.now() - 7 * 86_400_000 - since)).toBeLessThan(86_400_000);
  });
  test("the search, filters and paging survive a reload, and Chat-and-back", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/search", () => ({ json: [] })) });
    type(q(".jv-searchbar input"), "kept");
    q(".jv-searchbar").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    await go(env, "#/capture");
    await go(env, "#/browse");
    expect((q(".jv-searchbar input") as HTMLInputElement).value).toBe("kept");
    const store = JSON.parse(localStorage.getItem("jv.browse")!);
    expect(store.q).toBe("kept");
  });
  test("kind, a filter and the paging offset come back after leaving and returning", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/browse", () => ({ json: { ...emptyBrowse, added: [sum("A", "A")], pagination: { added: pg(20, 45, true), updated: pg(0, 0) }, facets: { sources: [{ value: "note", count: 1 }], authors: [], tags: [] } } })) });
    localStorage.setItem("jv.browse", JSON.stringify({ mode: "semantic", source: "note", addedOffset: 20 }));
    await go(env, "#/capture");
    await go(env, "#/browse");
    expect((q(".jv-kind") as HTMLSelectElement).value).toBe("semantic");
    expect((qa(".jv-fp")[0] as HTMLSelectElement).value).toBe("note");
    expect(qa(".jv-fp")[0].classList.contains("on")).toBe(true);
    expect(env.calls.at(-1)!.path).toContain("addedOffset=20");
  });
  test("a stored page past the end goes back to the first page; a stored filter the library lost still shows", async () => {
    env = await boot("#/browse", { setup: (e) => {
      localStorage.setItem("jv.browse", JSON.stringify({ addedOffset: 40, tag: "gone" }));
      e.routes.set("GET /api/browse", (_b, r) => { const off = Number(new URL("http://x" + r.path).searchParams.get("addedOffset") ?? 0); return { json: { ...emptyBrowse, added: off >= 30 ? [] : [sum("A", "First")], pagination: { added: pg(off, 30), updated: pg(0, 0) } } }; });
    } });
    expect(text(".jv-ct")).toBe("First");
    expect(text(".jv-empty")).not.toContain("Nothing captured yet.");
    expect(qa(".jv-fp")[2].classList.contains("on")).toBe(true);
    expect((qa(".jv-fp")[2] as HTMLSelectElement).value).toBe("gone");
  });
  describe("filters that match nothing", () => {
    const withFilter = (added: unknown[], updated: unknown[], filters: Record<string, string> = { source: "slack", author: "mia", tag: "ops", days: "7" }) => (e: WebEnv) => {
      localStorage.setItem("jv.browse", JSON.stringify({ mode: "keyword", addedOffset: 0, updatedOffset: 0, ...filters }));
      e.routes.set("GET /api/browse", () => ({ json: { ...emptyBrowse, added, updated, pagination: { added: pg(0, added.length), updated: pg(0, updated.length) }, facets: { sources: [{ value: "slack", count: 1 }], authors: [], tags: [] } } }));
    };
    test("both lists empty: one message replaces both columns, with Clear filters", async () => {
      env = await boot("#/browse", { setup: withFilter([], []) });
      expect(qa(".jv-sh").length).toBe(0);
      expect(qa(".jv-empty").length).toBe(1);
      expect(text(".jv-empty")).toContain("Nothing matches these filters.");
      expect(text(".jv-empty")).toContain("Remove a filter to see more.");
      expect(text(".jv-empty")).not.toContain("Nothing captured yet.");
      expect(button("＋ Capture") === undefined).toBe(true);
      expect((qa(".jv-fp")[0] as HTMLSelectElement).value).toBe("slack");
    });
    for (const f of <Record<string, string>[]>[{ source: "slack" }, { author: "mia" }, { tag: "ops" }, { days: "7" }]) {
      test(`${Object.keys(f)[0]} alone counts as a filter`, async () => {
        env = await boot("#/browse", { setup: withFilter([], [], f) });
        expect(text(".jv-empty")).toContain("Nothing matches these filters.");
      });
    }
    test("Clear filters resets the four filters, keeps the kind, reloads and focuses the search box", async () => {
      env = await boot("#/browse", { setup: withFilter([], []) });
      const before = env.calls.length;
      button("Clear filters")!.click();
      await env.tick(60);
      expect(env.calls.length).toBeGreaterThan(before);
      expect(env.calls.at(-1)!.path).not.toContain("source=");
      expect(env.calls.at(-1)!.path).not.toContain("since=");
      const store = JSON.parse(localStorage.getItem("jv.browse")!);
      expect([store.source, store.author, store.tag, store.days, store.addedOffset, store.updatedOffset, store.mode]).toEqual(["", "", "", "", 0, 0, "keyword"]);
      expect(document.activeElement).toBe(q(".jv-searchbar input"));
      expect(qa(".jv-fp").some((s) => s.classList.contains("on"))).toBe(false);
    });
    test("only one list empty: the columns stay and the empty one says the filters are why, without a button", async () => {
      env = await boot("#/browse", { setup: withFilter([sum("A", "Kept")], []) });
      expect(qa(".jv-sh").map((e) => e.textContent)).toEqual(["Recently added", "Recently updated"]);
      expect(text(".jv-empty")).toBe("Nothing updated matches these filters.");
      expect(button("Clear filters") === undefined).toBe(true);
    });
    test("only Recently added empty: says so without a Capture button", async () => {
      env = await boot("#/browse", { setup: withFilter([], [sum("B", "Kept")]) });
      expect(text(".jv-empty")).toBe("Nothing added matches these filters.");
      expect(button("＋ Capture") === undefined).toBe(true);
    });
  });
  test("page styles never reuse a class the chat or the sidebar already own", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const cls = (src: string) => new Set([...src.matchAll(/jv-[a-z0-9-]+/g)].map((m) => m[0]));
    const owned = new Set([...cls(readFileSync("web/src/chat.ts", "utf8")), ...cls(readFileSync("web/src/shell.ts", "utf8")), ...cls(readFileSync("web/src/tasks.ts", "utf8"))]);
    for (const f of readdirSync("web/src/pages")) for (const c of cls(readFileSync(`web/src/pages/${f}`, "utf8"))) expect([f, owned.has(c)]).toEqual([f, false]);
  });
});

describe("Capture", () => {
  const draft = () => qa(".jv-write input, .jv-write textarea") as (HTMLInputElement | HTMLTextAreaElement)[];
  test("a blank page: title and text, greyed out until both are filled; the cursor starts on the title", async () => {
    env = await boot("#/capture");
    const [title, body] = draft();
    expect(document.activeElement).toBe(title);
    expect(title.placeholder).toBe("Title");
    expect(body.placeholder).toBe("Paste or write anything…");
    expect(text(".jv-write .jv-whint")).toBe("⌘/Ctrl+Enter to capture");
    const btn = button("Capture") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    type(title, "T");
    expect(btn.disabled).toBe(true);
    type(body, "B");
    expect(btn.disabled).toBe(false);
  });
  test("capturing opens the item with the message; the draft is cleared", async () => {
    env = await boot("#/capture", { setup: (e) => { e.routes.set("POST /api/capture", () => ({ json: { id: "I1", status: "created" } })); e.routes.set("GET /api/item/I1", () => ({ json: { item: ITEM, edges: [] } })); } });
    const [title, body] = draft();
    type(title, "My note"); type(body, "Hello");
    expect(JSON.parse(localStorage.getItem("jv.capture")!)).toEqual({ title: "My note", text: "Hello" });
    q(".jv-write").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await env.tick(80);
    expect(env.calls.find((c) => c.path === "/api/capture")!.body).toEqual({ source: "paste", title: "My note", body: "Hello" });
    expect(text(".toast")).toBe("Captured: My note");
    expect(text(".jv-dtitle")).toBe("On-call rollout");
    expect(localStorage.getItem("jv.capture")).toBeNull();
  });
  test("⌘/Ctrl+Enter captures from outside the form too", async () => {
    env = await boot("#/capture", { setup: (e) => { e.routes.set("POST /api/capture", () => ({ json: { id: "I1", status: "created" } })); e.routes.set("GET /api/item/I1", () => ({ json: { item: ITEM, edges: [] } })); } });
    type(draft()[0], "T"); type(draft()[1], "B");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await env.tick(80);
    expect(env.calls.some((c) => c.path === "/api/capture")).toBe(true);
  });
  test("a failure keeps the text and says so; a half-written draft survives leaving the page", async () => {
    env = await boot("#/capture", { setup: (e) => e.routes.set("POST /api/capture", () => ({ status: 500, json: { error: "repo locked" } })) });
    const [title, body] = draft();
    type(title, "T"); type(body, "B");
    button("Capture")!.click();
    await env.tick(60);
    expect(text(".jv-errbox")).toContain("Couldn't capture this.");
    expect(text(".jv-errbox")).toContain("repo locked");
    expect(text(".jv-errbox")).toContain("Your text is still here.");
    expect(draft()[0].value).toBe("T");
    await go(env, "#/browse");
    await go(env, "#/capture");
    expect(draft()[1].value).toBe("B");
  });
});
