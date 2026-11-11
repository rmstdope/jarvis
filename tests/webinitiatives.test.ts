import { afterEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { mountApp } from "../web/src/main.ts";

let env: WebEnv;
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (sel: string) => q(sel)?.textContent ?? "";
const go = async (hash: string) => { location.hash = hash; await env.tick(60); };

const INI = (o: Record<string, unknown> = {}) => ({ id: "IA", title: "Move billing", owner: "anna", status: "open", done: 2, total: 4, created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-05T10:00:00Z", goal: "All billing on the new ledger", ...o });
interface Opts { list?: unknown[]; tasks?: unknown[] }
async function boot(hash: string, o: Opts = {}) {
  env = installWebEnv(1280);
  env.routes.set("GET /api/me", () => ({ json: { name: "Mia" } }));
  env.routes.set("GET /api/chat/status", () => ({ json: { available: true } }));
  env.routes.set("GET /api/tasks", () => ({ json: { tasks: o.tasks ?? [] } }));
  env.routes.set("GET /api/initiatives", (_b, r) => {
    const status = new URL("http://x" + r.path).searchParams.get("status") ?? "open";
    const all = (o.list ?? []) as { status: string }[];
    return { json: { initiatives: status === "all" ? all : all.filter((i) => i.status === status) } };
  });
  document.body.innerHTML = '<div id="app"></div>';
  location.hash = hash;
  mountApp(document.getElementById("app")!);
  await env.tick(60);
}
afterEach(() => env.restore());

describe("the Initiatives entry and list", () => {
  test("the sidebar has Initiatives between Browse & search and Capture, and the page lights it", async () => {
    await boot("#/initiatives", { list: [INI()] });
    expect(qa(".jv-nav .lbl").map((e) => e.textContent)).toEqual(["Chat", "Browse & search", "Initiatives", "Capture", "Briefings", "Presentations"]);
    expect(qa(".jv-nav .rl").map((e) => e.textContent)).toContain("Initiatives");
    expect(qa(".jv-nav .ic").map((e) => e.textContent)).toContain("◎");
    expect(q(".jv-nav.active").getAttribute("data-route")).toBe("initiatives");
  });
  test("cards: title, details line, goal, progress; most recent first; a done card offers closing; an empty one says no tasks", async () => {
    await boot("#/initiatives", { list: [INI(), INI({ id: "IB", title: "Ship v2", done: 3, total: 3, updated_at: "2026-03-09T10:00:00Z", owner: "bo" }), INI({ id: "IC", title: "Plan", done: 0, total: 0, updated_at: "2026-03-01T00:00:00Z" })] });
    expect(text(".jv-pt")).toBe("Initiatives");
    const cards = qa(".jv-card");
    expect(cards.map((c) => c.querySelector(".jv-ct")!.textContent)).toEqual(["Ship v2", "Move billing", "Plan"]);
    expect(cards[1].querySelector(".jv-m")!.textContent).toBe("initiative · anna · updated 2026-03-05");
    expect(cards[1].querySelector(".jv-s")!.textContent).toBe("All billing on the new ledger");
    expect(cards[1].textContent).toContain("2 of 4 done");
    expect(cards[0].textContent).toContain("✓ All tasks done — close it?");
    expect(cards[2].textContent).toContain("No tasks yet");
    expect(cards[1].querySelector(".jv-ct")!.getAttribute("href")).toBe("#/initiative/IA");
  });
  test("filters: Open by default, Closed dims and says closed <date>, owners narrow, and they survive a reload", async () => {
    const list = [INI(), INI({ id: "IB", title: "Old", status: "closed", closed_at: "2026-02-01T00:00:00Z", owner: "bo", done: 1, total: 1 })];
    await boot("#/initiatives", { list });
    expect(qa(".jv-fp").map((s) => (s as HTMLSelectElement).value)).toEqual(["open", ""]);
    expect([...q('select[aria-label="Status"]').querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Open", "Closed", "All"]);
    expect([...q('select[aria-label="Owner"]').querySelectorAll("option")].map((o) => o.textContent)).toEqual(["All owners", "anna", "bo"]);
    const status = q('select[aria-label="Status"]') as HTMLSelectElement;
    status.value = "closed"; status.dispatchEvent(new env.win.Event("change") as unknown as Event);
    await env.tick(40);
    expect(qa(".jv-card").length).toBe(1);
    expect(q(".jv-card").classList.contains("jv-dim")).toBe(true);
    expect(q(".jv-card .jv-m").textContent).toBe("initiative · bo · closed 2026-02-01");
    expect(localStorage.getItem("jv.initiatives")).toContain("closed");
    await go("#/browse"); await go("#/initiatives");
    expect((q('select[aria-label="Status"]') as HTMLSelectElement).value).toBe("closed");
  });
  test("empty states: none at all, none closed, owner matches nothing", async () => {
    await boot("#/initiatives", { list: [] });
    expect(text(".jv-empty")).toContain("No initiatives yet.");
    expect(text(".jv-empty")).toContain("Start one with jarvis initiative add “<title>” --goal “<what done looks like>”");
    expect(q(".jv-empty code")).not.toBeNull();
    const status = q('select[aria-label="Status"]') as HTMLSelectElement;
    status.value = "closed"; status.dispatchEvent(new env.win.Event("change") as unknown as Event);
    await env.tick(40);
    expect(text(".jv-empty")).toBe("No closed initiatives.");
  });
  test("owner filter that matches nothing, and a failed load", async () => {
    await boot("#/initiatives", { list: [INI()] });
    localStorage.setItem("jv.initiatives", JSON.stringify({ status: "open", owner: "ghost" }));
    await go("#/browse"); await go("#/initiatives");
    expect(text(".jv-empty")).toBe("No initiatives match these filters.");
    env.routes.set("GET /api/initiatives", () => ({ status: 500, json: { error: "disk on fire" } }));
    await go("#/browse"); await go("#/initiatives");
    expect(text(".jv-errbox")).toContain("Couldn't load this page.");
    expect(text(".jv-errbox")).toContain("disk on fire");
    expect(text(".jv-errbox")).toContain("Try again");
  });
});

describe("which initiative a task belongs to, and initiatives in Browse & search", () => {
  const INIREF = { id: "IA", title: "Move billing" };
  const page = (total: number) => ({ offset: 0, limit: 20, total, hasMore: false });
  const row = (o: Record<string, unknown>) => ({ id: "X", source: "note", title: "T", author: "me", created_at: "2026-03-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, ...o });
  const browseWith = (rows: unknown[]) => ({ json: { added: rows, updated: [], pagination: { added: page(rows.length), updated: page(0) }, facets: { sources: [], authors: [], tags: [] } } });

  test("the first screen's open-tasks box labels tasks in an initiative; standalone ones have none; the label opens it", async () => {
    await boot("#/chat", { tasks: [{ id: "T1", title: "Dry-run", status: "open", owner: "me", initiative: INIREF }, { id: "T2", title: "Offsite", status: "open", owner: "me" }] });
    const rows = qa(".jv-tasks .jv-task");
    expect(rows[0].querySelector(".jv-ilabel")!.textContent).toBe("◎ Move billing");
    expect(rows[0].querySelector(".jv-ilabel")!.getAttribute("href")).toBe("#/initiative/IA");
    expect(rows[0].querySelector(".jv-ilabel")!.getAttribute("title")).toBe("Move billing");
    expect(rows[1].querySelector(".jv-ilabel")).toBeNull();
  });
  test("Browse: a task card carries the label, an initiative card the same card with progress and the Browse trail link", async () => {
    await boot("#/browse");
    env.routes.set("GET /api/browse", () => browseWith([
      row({ id: "T1", source: "task", title: "Dry-run", author: "jonas", initiative: INIREF }),
      row({ id: "IA", source: "initiative", title: "Move billing", author: "anna", summary: "Everything on the new ledger", progress: { done: 1, total: 4, owner: "anna", status: "open" } })]));
    await go("#/search"); await go("#/browse");
    const cards = qa(".jv-card");
    expect(cards[0].querySelector(".jv-m .jv-ilabel")!.textContent).toBe("◎ Move billing");
    expect(cards[1].querySelector(".jv-ct")!.getAttribute("href")).toBe("#/initiative/IA?from=browse");
    expect(cards[1].querySelector(".jv-m")!.textContent).toContain("initiative · anna");
    expect(cards[1].textContent).toContain("1 of 4 done");
  });
  test("search hits use the same card for initiatives", async () => {
    await boot("#/browse");
    env.routes.set("GET /api/search", () => ({ json: [{ docId: "IA", source: "initiative", title: "Move billing", snippet: "[billing] ledger", score: 1, progress: { done: 4, total: 4, owner: "anna", status: "open" } }] }));
    localStorage.setItem("jv.browse", JSON.stringify({ q: "billing", mode: "hybrid", source: "", author: "", tag: "", days: "", addedOffset: 0, updatedOffset: 0 }));
    await go("#/search"); await go("#/browse");
    expect(q(".jv-card .jv-ct").getAttribute("href")).toBe("#/initiative/IA?from=browse");
    expect(q(".jv-card").textContent).toContain("✓ All tasks done — close it?");
  });
  test("a task's page: Initiative block under Ask about this with progress; the trail leads back when opened from the initiative", async () => {
    await boot("#/chat");
    const item = { id: "T1", source: "task", title: "Dry-run", author: "jonas", created_at: "2026-03-01T00:00:00Z", updated_at: null, updated_by: null, source_url: "https://x.test", starred: false, summary: null, tags: ["a"], metadata: null, body: "b", proc_version: 1, file_path: null };
    env.routes.set("GET /api/item/T1", () => ({ json: { item, edges: [], initiative: { ...INIREF, done: 4, total: 9 } } }));
    await go("#/item/T1?from=IA");
    expect(text(".jv-trail")).toBe("Move billing › Dry-run");
    expect(q(".jv-trail a").getAttribute("href")).toBe("#/initiative/IA");
    const blocks = qa(".jv-panel .jv-blk, .jv-panel > button");
    expect(blocks[0].textContent).toBe("Ask about this");
    expect(blocks[1].querySelector("h5")!.textContent).toBe("Initiative");
    expect(blocks[1].textContent).toContain("Move billing");
    expect(blocks[1].textContent).toContain("4 of 9 done");
    expect(blocks[1].querySelector("a")!.getAttribute("href")).toBe("#/initiative/IA");
    await go("#/item/T1");
    expect(text(".jv-trail")).toBe("Browse & search › Dry-run");
  });
  test("Ask about this on an initiative: chip, heading, typing box and the three suggestions", async () => {
    await boot("#/chat");
    env.routes.set("GET /api/initiative/IA", () => ({ json: { initiative: { id: "IA", title: "Move billing", owner: "anna", status: "open", done: 0, total: 0, created_at: "2026-02-02T00:00:00Z", goal: "g" }, tasks: [], through: { total: 0, items: [] }, direct: { total: 0, items: [] } } }));
    env.routes.set("GET /api/initiative/IA/suggest", () => ({ json: { model: true, suggestions: [] } }));
    await go("#/initiative/IA");
    (qa("button").find((b) => b.textContent === "Ask about this") as HTMLElement).click();
    await env.tick(60);
    expect(q(".jv-chat").hidden).toBe(false);
    expect(text(".jv-attach-t")).toBe("◎ Move billing");
    expect(text(".jv-hello")).toBe("Ask about “Move billing”.");
    expect((q(".jv-input") as HTMLTextAreaElement).placeholder).toBe("Ask about this initiative…");
    expect(qa(".jv-sg").map((b) => b.textContent)).toEqual(["What's left before we can close it?", "What's blocking it right now?", "Write a status update I can share"]);
  });
});

describe("initiative cards in Browse carry the goal, not the enrichment summary", () => {
  test("goal comes from progress.goal; summary is ignored", async () => {
    await boot("#/browse");
    const page = (n: number) => ({ offset: 0, limit: 20, total: n, hasMore: false });
    env.routes.set("GET /api/browse", () => ({ json: { added: [{ id: "IA", source: "initiative", title: "Move billing", author: "anna", created_at: "2026-03-01T00:00:00Z", updated_at: null, summary: "a model summary", tags: [], progress: { done: 1, total: 4, owner: "anna", status: "open", goal: "The real goal" } }], updated: [], pagination: { added: page(1), updated: page(0) }, facets: { sources: [], authors: [], tags: [] } } }));
    await go("#/search"); await go("#/browse");
    expect(q(".jv-card .jv-s").textContent).toBe("The real goal");
  });
  test("a done initiative's green pill sits in the details line", async () => {
    await boot("#/initiatives", { list: [INI({ done: 3, total: 3 })] });
    expect(q(".jv-card .jv-m .jv-status").textContent).toBe("✓ All tasks done — close it?");
  });
});
