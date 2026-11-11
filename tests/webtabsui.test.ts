import { afterEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { mountApp } from "../web/src/main.ts";

let env: WebEnv;
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, source: "note", title, author: "mia", created_at: "2026-01-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: `Body of ${title}`, proc_version: 1, file_path: null, ...over });
const EMPTY_BROWSE = { added: [], updated: [], pagination: { added: { offset: 0, limit: 20, total: 0, hasMore: false }, updated: { offset: 0, limit: 20, total: 0, hasMore: false } }, facets: { sources: [], authors: [], tags: [] } };
async function boot(o: { hash?: string; width?: number; available?: boolean; store?: Record<string,string>; answer?: (p: (l: unknown) => void) => Promise<void>; keep?: boolean; settle?: boolean } = {}) {
  if (!o.keep) { env = installWebEnv(o.width ?? 1280); }
  for (const [id, t] of [["A", "Alpha"], ["B", "Bravo"], ["C", "Charlie"]]) env.routes.set(`GET /api/item/${id}`, () => ({ json: { item: item(id, t), edges: [] } }));
  env.routes.set("GET /api/me", () => ({ json: { name: "Mia" } }));
  env.routes.set("GET /api/chat/status", () => ({ json: { available: o.available ?? true } }));
  env.routes.set("GET /api/tasks", () => ({ json: { tasks: [] } }));
  env.routes.set("GET /api/browse", () => ({ json: EMPTY_BROWSE }));
  env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
  env.routes.set("DELETE /api/chat/sessions/S1", () => ({ json: {} }));
  env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: o.answer ?? (async (p) => { p({ type: "message", text: "Hi" }); p({ type: "done" }); }) }));
  document.body.innerHTML = '<div id="app"></div>';
  for (const [k, v] of Object.entries(o.store ?? {})) localStorage.setItem(k, v);
  if (o.hash) location.hash = o.hash;
  if (o.settle) await env.tick(30); // a real browser fires no hashchange for a cold load
  mountApp(document.getElementById("app")!);
  await env.tick(40);
}
afterEach(() => env.restore());
const go = async (hash: string) => { location.hash = hash; await env.tick(40); };
const key = (k: string, mods: Record<string, boolean> = {}, target: Element | Document = document) => target.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }) as unknown as Event);
const tabs = () => qa(".jv-tabstrip .jv-tab").map((t) => t.querySelector(".jv-tab-t")!.textContent);

describe("the strip", () => {
  test("with only the chat there is no strip; the first document brings it, closing the last takes it away", async () => {
    await boot();
    expect(q(".jv-tabstrip").hidden).toBe(true);
    await go("#/item/A");
    expect(q(".jv-tabstrip").hidden).toBe(false);
    expect(tabs()).toEqual(["Chat", "Alpha"]);
    expect(q(".jv-doc h1").textContent).toBe("Alpha");
    expect(q(".jv-chat").hidden).toBe(true);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Alpha");
    expect(q('.jv-tab[data-key="chat"] .jv-tab-x')).toBeNull(); // Chat cannot be closed
    q('.jv-tab[data-key="item:A"] .jv-tab-x').click();
    await env.tick(20);
    expect(q(".jv-tabstrip").hidden).toBe(true);
    expect(q(".jv-chat").hidden).toBe(false);
  });
  test("a click shows the tab, an open document is shown instead of opened twice, Chat tab restores the chat", async () => {
    await boot();
    await go("#/item/A");
    await go("#/item/B");
    await go("#/item/A");
    expect(tabs()).toEqual(["Chat", "Alpha", "Bravo"]);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Alpha");
    expect(location.hash).not.toContain("item"); // the address reverts, Back is not a tab history
    qa(".jv-tab")[0].click();
    await env.tick(40);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(document.activeElement).toBe(q(".jv-input"));
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Chat");
  });
  test("closing the shown tab shows the one on its left", async () => {
    await boot();
    for (const id of ["A", "B", "C"]) await go(`#/item/${id}`);
    q('.jv-tab[data-key="item:C"] .jv-tab-x').click();
    await env.tick(20);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Bravo");
  });
  test("a sidebar page shows under the strip with no tab selected", async () => {
    await boot();
    await go("#/item/A");
    await go("#/browse");
    expect(q(".jv-tabstrip").hidden).toBe(false);
    expect(q(".jv-page").hidden).toBe(false);
    expect(q(".jv-doc-host").hidden).toBe(true);
    expect(qa('.jv-tab[aria-selected="true"]').length).toBe(0);
  });
  test("works with no agent; Ask about this switches to the chat with the notice", async () => {
    await boot({ available: false });
    await go("#/item/A");
    expect(q(".jv-doc h1").textContent).toBe("Alpha");
    qa("button").find((b) => b.textContent === "Ask about this")!.click();
    await env.tick(40);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(q(".jv-notice h3").textContent).toBe("The agent isn't available right now.");
    expect(tabs()).toEqual(["Chat", "Alpha"]);
  });
  test("tabs and the shown one survive a reload and New chat", async () => {
    await boot();
    await go("#/item/A");
    await go("#/item/B");
    const saved = localStorage.getItem("jv.tabs");
    expect(saved).toContain("Bravo");
    env.restore();
    await boot({ store: { "jv.tabs": saved! } });
    expect(tabs()).toEqual(["Chat", "Alpha", "Bravo"]);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Bravo");
    key("O", { ctrlKey: true, shiftKey: true });
    await env.tick(20);
    expect(tabs()).toEqual(["Chat", "Alpha", "Bravo"]);
  });
  test("hover words: full title and the shortcuts, Close tab, tab strip focus keys", async () => {
    await boot();
    await go("#/item/A");
    await go("#/item/B");
    const t = q('.jv-tab[data-key="item:A"]');
    expect(t.getAttribute("title")).toBe("Alpha\nCtrl+Tab or Ctrl+Alt+→ next tab · Ctrl+Shift+Tab or Ctrl+Alt+← previous tab");
    expect(t.querySelector(".jv-tab-x")!.getAttribute("title")).toBe("Close tab");
    t.focus();
    key("ArrowRight", {}, t);
    expect(document.activeElement).toBe(q('.jv-tab[data-key="item:B"]'));
    key("Delete", {}, q('.jv-tab[data-key="item:B"]'));
    await env.tick(20);
    expect(tabs()).toEqual(["Chat", "Alpha"]);
  });
});

describe("a real browser fires no hashchange for replaceState", () => {
  test("Ask about this from a tab opened at #/chat switches to the chat; so does New chat", async () => {
    await boot({ hash: "#/chat" });
    await go("#/item/A");
    expect(q(".jv-doc-host").hidden).toBe(false);
    qa("button").find((b) => b.textContent === "Ask about this")!.click();
    await env.tick(80);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(q(".jv-doc-host").hidden).toBe(true);
    expect(q(".jv-attach").textContent).toContain("Alpha");
    await go("#/item/B");
    key("O", { ctrlKey: true, shiftKey: true });
    await env.tick(80);
    expect(q(".jv-chat").hidden).toBe(false);
  });
});

describe("a cold load at a document link", () => {
  test("opens the tab, and the first Ask about this still switches to the chat", async () => {
    await boot({ hash: "#/item/A", settle: true });
    expect(q(".jv-doc h1").textContent).toBe("Alpha");
    qa("button").find((b) => b.textContent === "Ask about this")!.click();
    await env.tick(80);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(q(".jv-doc-host").hidden).toBe(true);
  });
});

describe("source chips", () => {
  test("a chip of a presentation or briefing opens that kind of tab, not an item", async () => {
    await boot({ answer: async (p) => { p({ type: "source", docId: "deck-one", title: "Deck one", source: "presentation" }); p({ type: "source", docId: "B9", title: "Plan", source: "briefing" }); p({ type: "message", text: "ok" }); p({ type: "done" }); } });
    q(".jv-sg").click();
    await env.tick(80);
    expect(qa(".jv-chip").map((c) => c.getAttribute("href"))).toEqual(["#/presentation/deck-one", "#/briefing/B9"]);
  });
});

describe("keyboard", () => {
  test("/ brings the chat back from a tab and focuses the typing box", async () => {
    await boot();
    await go("#/item/A");
    key("/");
    await env.tick(40);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(document.activeElement).toBe(q(".jv-input"));
  });
  test("Ctrl+Alt+→ works while focus is in the typing box", async () => {
    await boot();
    await go("#/item/A");
    qa(".jv-tab")[0].click();
    await env.tick(30);
    q(".jv-input").focus();
    key("ArrowRight", { ctrlKey: true, altKey: true }, q(".jv-input"));
    await env.tick(30);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Alpha");
  });
  test("Tab can reach the strip while a sidebar page shows (Chat is the fallback stop)", async () => {
    await boot();
    await go("#/item/A");
    await go("#/browse");
    expect(q('.jv-tab[data-key="chat"]').getAttribute("tabindex")).toBe("0");
  });
  test("Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+Alt+→/← move between Chat and the tabs", async () => {
    await boot();
    await go("#/item/A");
    await go("#/item/B");
    const sel = () => q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent;
    key("Tab", { ctrlKey: true });
    await env.tick(30);
    expect(sel()).toBe("Chat");
    key("Tab", { ctrlKey: true, shiftKey: true });
    await env.tick(30);
    expect(sel()).toBe("Bravo");
    key("ArrowLeft", { ctrlKey: true, altKey: true });
    await env.tick(30);
    expect(sel()).toBe("Alpha");
    key("ArrowRight", { ctrlKey: true, altKey: true });
    await env.tick(30);
    expect(sel()).toBe("Bravo");
  });
  test("a click-opened document puts focus on its heading", async () => {
    await boot();
    await go("#/item/A");
    expect(document.activeElement).toBe(q(".jv-doc h1"));
  });
});

describe("many tabs", () => {
  test("tabs beyond what fits move into '⌄ n more', each with ✕ and choosing one shows it", async () => {
    await boot();
    (window as unknown as { __JV_TAB_CAPACITY__?: number }).__JV_TAB_CAPACITY__ = 1;
    for (const id of ["A", "B", "C"]) await go(`#/item/${id}`);
    expect(tabs()).toEqual(["Chat", "Charlie"]);
    const more = q(".jv-more-btn");
    expect(more.textContent).toBe("⌄ 2 more");
    more.click();
    expect(qa(".jv-more-list .jv-more-item").map((e) => e.querySelector(".jv-more-t")!.textContent)).toEqual(["Alpha", "Bravo"]);
    qa(".jv-more-list .jv-more-x")[0].click();
    await env.tick(20);
    expect(q(".jv-more-btn").textContent).toBe("⌄ 1 more");
    q(".jv-more-btn").click();
    q(".jv-more-list .jv-more-t").click();
    await env.tick(30);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Bravo");
  });
});

describe("phone", () => {
  test("no strip; a '▤ n' button counts Chat and documents, opens a list; Esc closes and focus returns", async () => {
    await boot({ width: 400 });
    expect(q(".jv-tabsbtn").hidden).toBe(true);
    await go("#/item/A");
    await go("#/item/B");
    const b = q(".jv-tabsbtn");
    expect(b.hidden).toBe(false);
    expect(b.textContent).toBe("▤ 3");
    expect(b.getAttribute("title")).toBe("Open tabs");
    b.click();
    expect(qa(".jv-tablist .jv-tablist-item .jv-tablist-t").map((e) => e.textContent)).toEqual(["Chat", "Alpha", "Bravo"]);
    key("Escape");
    expect(q(".jv-tablist").hidden).toBe(true);
    expect(document.activeElement).toBe(b);
    b.click();
    qa(".jv-tablist-x")[0].click();
    await env.tick(20);
    expect(q(".jv-tabsbtn").textContent).toBe("▤ 2");
    q(".jv-tablist-t").click();
    await env.tick(30);
    expect(q(".jv-tablist").hidden).toBe(true);
    expect(document.activeElement).toBe(q(".jv-tabsbtn"));
    q(".jv-tabsbtn").click();
    document.body.click(); // a tap outside
    expect(q(".jv-tablist").hidden).toBe(true);
    expect(document.activeElement).toBe(q(".jv-tabsbtn"));
  });
});

describe("leaving phone width", () => {
  test("widening from phone re-fits the strip into '⌄ n more' without a second resize (jv-xsn)", async () => {
    await boot({ width: 400 });
    for (const id of ["A", "B", "C"]) await go(`#/item/${id}`);
    // happy-dom has no layout: the strip measures 300 px, and 0 while the phone hides it (display:none).
    Object.defineProperty(q(".jv-tabstrip"), "clientWidth", { configurable: true, get: () => (q(".jv-tabstrip").closest(".jv-phone") ? 0 : 300) });
    // A real browser runs the resize steps before it reports media query changes.
    window.dispatchEvent(new env.win.Event("resize") as unknown as Event);
    env.setWidth(900);
    await env.tick(20);
    expect(q(".jv-more-btn")?.textContent).toBe("⌄ 2 more");
    expect(tabs()).toEqual(["Chat", "Charlie"]);
  });
});

describe("the agent opens a document", () => {
  test("quietly: a dot on the tab, a card in the answer, the chat stays shown; clicking the card shows it", async () => {
    await boot({ answer: async (p) => { p({ type: "message", text: "I opened it." }); p({ type: "open", docId: "A", title: "Alpha", source: "note" }); p({ type: "done" }); } });
    q(".jv-sg").click();
    await env.tick(80);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(tabs()).toEqual(["Chat", "Alpha"]);
    const dot = q('.jv-tab[data-key="item:A"] .jv-tab-dot');
    expect(dot.getAttribute("title")).toBe("Opened by the agent");
    const card = q(".jv-docard");
    expect(card.querySelector(".jv-docard-t")!.textContent).toBe("Alpha");
    expect(card.querySelector(".jv-docard-s")!.textContent).toBe("Note · opened in a tab");
    expect(card.classList.contains("jv-on")).toBe(false);
    card.click();
    await env.tick(40);
    expect(q(".jv-doc h1").textContent).toBe("Alpha");
    expect(q('.jv-tab[data-key="item:A"] .jv-tab-dot')).toBeNull();
    expect(q(".jv-docard").classList.contains("jv-on")).toBe(true);
    qa(".jv-tab")[0].click();
    await env.tick(40);
    expect(q(".jv-docard").classList.contains("jv-on")).toBe(false);
    q('.jv-tab[data-key="item:A"] .jv-tab-x').click();
    await env.tick(20);
    q(".jv-docard").click(); // re-opens a closed tab
    await env.tick(40);
    expect(tabs()).toEqual(["Chat", "Alpha"]);
    expect(q(".jv-docard").classList.contains("jv-on")).toBe(true);
  });
  test("the dot survives a reload until the tab is shown", async () => {
    await boot({ answer: async (p) => { p({ type: "open", docId: "A", title: "Alpha", source: "note" }); p({ type: "done" }); } });
    q(".jv-sg").click();
    await env.tick(80);
    const saved = localStorage.getItem("jv.tabs")!;
    env.restore();
    await boot({ store: { "jv.tabs": saved } });
    expect(q('.jv-tab[data-key="item:A"] .jv-tab-dot')).not.toBeNull();
  });
  test("the card is outlined while its document is the tab shown", async () => {
    await boot({ answer: async (p) => { p({ type: "open", docId: "A", title: "Alpha", source: "note" }); p({ type: "done" }); } });
    q(".jv-sg").click();
    await env.tick(80);
    expect(q(".jv-docard").classList.contains("jv-on")).toBe(false);
    q('.jv-tab[data-key="item:A"]').click();
    await env.tick(40);
    expect(q(".jv-docard").classList.contains("jv-on")).toBe(true);
    expect(q(".jv-doc-host").hidden).toBe(false);
  });
});
