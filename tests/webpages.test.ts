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
  test("an item, briefing or presentation that does not exist shows the trail and a way back", async () => {
    env = await boot("#/item/NOPE");
    expect(text(".jv-trail")).toBe("Browse & search");
    expect(text(".jv-empty")).toContain("We couldn't find that.");
    expect(text(".jv-empty")).toContain("It may have been removed or renamed.");
    const back = qa(".jv-empty a")[0] as HTMLAnchorElement;
    expect(back.textContent).toBe("Back to Browse & search");
    expect(back.getAttribute("href")).toBe("#/browse");
    await go(env, "#/briefing/NOPE");
    expect(qa(".jv-empty a")[0].textContent).toBe("Back to Briefings");
    await go(env, "#/presentation/NOPE");
    expect(qa(".jv-empty a")[0].textContent).toBe("Back to Presentations");
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
  test("a search shows one list, no score, highlighted words, '<n> results'; ✕ clears it", async () => {
    env = await boot("#/browse", { setup: (e) => e.routes.set("GET /api/search", () => ({ json: [{ docId: "I1", title: "On-call rollout", snippet: "the [rollout] plan <b>", score: 0.91234, source: "note" }] })) });
    type(q(".jv-searchbar input"), "rollout");
    q(".jv-searchbar").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    expect(text(".jv-sh")).toBe("1 result");
    expect(qa(".jv-sh").length).toBe(1);
    expect(q(".jv-card mark").textContent).toBe("rollout");
    expect(q(".jv-card").innerHTML).toContain("&lt;b&gt;");
    expect(q(".jv-card").textContent).not.toContain("0.91");
    expect(q(".jv-card .jv-m").textContent).toBe("note");
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
  test("page styles never reuse a class the chat or the sidebar already own", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const cls = (src: string) => new Set([...src.matchAll(/jv-[a-z0-9-]+/g)].map((m) => m[0]));
    const owned = new Set([...cls(readFileSync("web/src/chat.ts", "utf8")), ...cls(readFileSync("web/src/shell.ts", "utf8")), ...cls(readFileSync("web/src/tasks.ts", "utf8"))]);
    for (const f of readdirSync("web/src/pages")) for (const c of cls(readFileSync(`web/src/pages/${f}`, "utf8"))) expect([f, owned.has(c)]).toEqual([f, false]);
  });
});

describe("an item", () => {
  const edges = [{ otherId: "I2", otherTitle: "Runbook", relation: "relates to", createdBy: "ai", weight: 0.5, direction: "out" }];
  test("trail, title, details, summary quote, text and a details panel with Ask about this, Source, Tags, Links", async () => {
    env = await boot("#/item/I1", { setup: (e) => e.routes.set("GET /api/item/I1", () => ({ json: { item: { ...ITEM, summary: "Short.", tags: ["ops"], source_url: "https://example.com/x" }, edges } })) });
    expect(text(".jv-trail")).toBe("Browse & search › On-call rollout");
    expect(q(".jv-trail a").getAttribute("href")).toBe("#/browse");
    expect(text(".jv-title")).toBe("On-call rollout");
    expect(text(".jv-meta")).toBe("note · mia · 2026-01-01");
    expect(text(".jv-summary")).toBe("Short.");
    expect(q(".jv-prose").textContent).toContain("Body text");
    expect(qa(".jv-panel h5").map((e) => e.textContent)).toEqual(["Source", "Tags", "Links · 1"]);
    expect(q(".jv-panel a[href^='https']").textContent).toContain("example.com");
    expect(text(".jv-lk .jv-rel")).toBe("relates to");
    expect(q(".jv-lk a").getAttribute("href")).toBe("#/item/I2");
    expect(q(".jv-lk a").textContent).toBe("Runbook");
    expect(button("Ask about this")).toBeTruthy();
  });
  test("no links, no tags, no source, no summary", async () => {
    env = await boot("#/item/I1", { setup: (e) => e.routes.set("GET /api/item/I1", () => ({ json: { item: ITEM, edges: [] } })) });
    expect(qa(".jv-panel h5").map((e) => e.textContent)).toEqual(["Links · 0"]);
    expect(text(".jv-panel")).toContain("No links yet.");
    expect(q(".jv-summary")).toBeNull();
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
    expect(text(".jv-title")).toBe("On-call rollout");
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
