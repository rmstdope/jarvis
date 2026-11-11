import { afterEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { mountApp } from "../web/src/main.ts";
import { timing } from "../web/src/pages/initiative.ts";

let env: WebEnv;
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (sel: string) => q(sel)?.textContent ?? "";
const click = (e: Element) => (e as HTMLElement).click();
const btn = (label: string) => qa("button").find((b) => b.textContent === label) as HTMLButtonElement;
const box = (name: string) => qa(".jv-ibox").find((b) => b.querySelector("h4")!.textContent!.startsWith(name))!;
const vis = (sel: string) => ([...document.querySelectorAll(".jv-doc")] as HTMLElement[]).find((d) => !d.hidden)?.querySelector(sel)?.textContent ?? "";
const go = async (hash: string) => { location.hash = hash; await env.tick(60); };
const change = (el: Element) => el.dispatchEvent(new env.win.Event("change", { bubbles: true }) as unknown as Event);

const task = (n: number, o: Record<string, unknown> = {}) => ({ id: `T${n}`, title: `task ${n}`, status: "open", owner: "jonas", created_at: "2026-03-01T00:00:00Z", author: "me", links: 0, ...o });
const tied = (n: number, via: string[] = []) => ({ id: `N${n}`, title: `note ${n}`, source: "note", created_at: "2026-03-0" + (n % 9 + 1) + "T00:00:00Z", via });
const base = (o: Record<string, unknown> = {}) => ({
  initiative: { id: "IA", title: "Move billing", owner: "anna", status: "open", done: 1, total: 2, created_at: "2026-02-02T00:00:00Z", goal: "All billing on the new ledger", updated_at: "2026-03-05T10:00:00Z" },
  tasks: [task(1, { status: "done" }), task(2, { due: "2026-11-20" })],
  through: { total: 1, items: [tied(1, ["task 2"])] }, direct: { total: 1, items: [tied(2)] }, ...o,
});
interface Opts { detail?: ReturnType<typeof base> | (() => ReturnType<typeof base>); suggest?: unknown | (() => Promise<unknown>); chat?: boolean }
async function boot(hash: string, o: Opts = {}) {
  env = installWebEnv(1280);
  timing.undoMs = 40;
  env.routes.set("GET /api/me", () => ({ json: { name: "Mia" } }));
  env.routes.set("GET /api/chat/status", () => ({ json: { available: o.chat ?? true } }));
  env.routes.set("GET /api/tasks", () => ({ json: { tasks: [] } }));
  env.routes.set("GET /api/initiative/IA", () => ({ json: typeof o.detail === "function" ? o.detail() : o.detail ?? base() }));
  env.routes.set("GET /api/initiative/IA/suggest", async () => ({ json: typeof o.suggest === "function" ? await (o.suggest as () => Promise<unknown>)() : o.suggest ?? { model: true, suggestions: [] } }));
  env.routes.set("POST /api/task/T2/done", () => ({ json: {} }));
  env.routes.set("POST /api/task/T2/reopen", () => ({ json: {} }));
  env.routes.set("POST /api/link", () => ({ json: {} }));
  env.routes.set("POST /api/initiative/IA/close", () => ({ json: {} }));
  env.routes.set("POST /api/initiative/IA/reopen", () => ({ json: {} }));
  document.body.innerHTML = '<div id="app"></div>';
  location.hash = hash;
  mountApp(document.getElementById("app")!);
  await env.tick(80);
}
afterEach(() => env.restore());

describe("an initiative's page", () => {
  test("header, meta line, goal, progress and the four boxes in order; no trail and no panel", async () => {
    await boot("#/initiative/IA");
    expect(q('.jv-tab[data-key="initiative:IA"] .jv-tab-k').textContent).toBe("◎");
    expect(text(".jv-dkind")).toBe("Initiative");
    expect(text(".jv-dtitle")).toBe("Move billing");
    expect(text(".jv-dhead .jv-status")).toBe("open");
    expect(qa(".jv-dhead button").map((b) => b.textContent)).toEqual(["Close initiative", "Ask about this"]);
    expect(text(".jv-meta")).toBe("Initiative · anna · started 2026-02-02 · updated 2026-03-05");
    expect(text(".jv-goal")).toBe("All billing on the new ledger");
    expect(text(".jv-ihead .jv-progress")).toBe("1 of 2 done");
    expect(qa(".jv-ibox h4").map((h) => h.textContent)).toEqual(["Tasks · 2", "Through its tasks · 1", "Linked directly · 1", "Suggested · 0 — not part of it until you accept"]);
    expect(q(".jv-trail")).toBeNull();
    expect(q(".jv-panel")).toBeNull();
  });
  test("tasks are never cut, done ones stay ticked and struck, rows show due date and owner", async () => {
    const tasks = Array.from({ length: 14 }, (_, i) => task(i + 1, i === 0 ? { status: "done" } : {}));
    await boot("#/initiative/IA", { detail: base({ tasks }) });
    const rows = qa(".jv-ibox:first-of-type .jv-irow, .jv-irowlist .jv-irow");
    expect(rows.length).toBe(14);
    expect(rows[0].classList.contains("jv-irow-done")).toBe(true);
    expect((rows[0].querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(rows[1].querySelector("a")!.getAttribute("href")).toBe("#/item/T2");
  });
  test("tied boxes: via line, kind and date, empty sentences", async () => {
    await boot("#/initiative/IA");
    expect(box("Through").textContent).toContain("note 1");
    expect(box("Through").textContent).toContain("← task 2");
    expect(box("Linked").textContent).toContain("note · 2026-03-03");
    await boot("#/initiative/IA", { detail: base({ tasks: [], through: { total: 0, items: [] }, direct: { total: 0, items: [] } }) });
    expect(box("Tasks").textContent).toContain("No tasks yet.");
    expect(box("Tasks").textContent).toContain("Add one with jarvis task add “<title>” --initiative IA");
    expect(text(".jv-ihead .jv-progress")).toBe("No tasks yet");
    expect(box("Through").textContent).toContain("Nothing is tied to it through its tasks yet.");
    expect(box("Linked").textContent).toContain("Nothing is linked to it directly yet.");
  });
  test("too many: the newest ten, then Show all <n> and Show fewer", async () => {
    const items = Array.from({ length: 13 }, (_, i) => tied(i + 1));
    await boot("#/initiative/IA", { detail: base({ direct: { total: 13, items } }) });
    expect(box("Linked").querySelectorAll(".jv-trow").length).toBe(10);
    click(btn("Show all 13"));
    expect(box("Linked").querySelectorAll(".jv-trow").length).toBe(13);
    click(btn("Show fewer"));
    expect(box("Linked").querySelectorAll(".jv-trow").length).toBe(10);
  });
  test("a task opened from the initiative's tab opens right after it; closing it returns to the initiative", async () => {
    await boot("#/initiative/IA");
    env.routes.set("GET /api/item/T2", () => ({ json: { item: { id: "T2", source: "task", title: "task 2", author: "me", created_at: "2026-03-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "b", proc_version: 1, file_path: null }, edges: [], initiative: { id: "IA", title: "Move billing", done: 1, total: 2 } } }));
    env.routes.set("GET /api/item/Z", () => ({ json: { item: { id: "Z", source: "note", title: "Zed", author: "me", created_at: "2026-03-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "b", proc_version: 1, file_path: null }, edges: [] } }));
    await go("#/item/Z");
    qa(".jv-tabstrip .jv-tab")[1].click(); await env.tick(40); // back to the initiative
    (qa(".jv-irow a")[1] as HTMLElement).click(); await env.tick(60);
    const names = () => qa(".jv-tabstrip .jv-tab .jv-tab-t").map((t) => t.textContent);
    expect(names()).toEqual(["Chat", "Move billing", "task 2", "Zed"]);
    qa('.jv-tab[aria-selected="true"] .jv-tab-x')[0].click(); await env.tick(40);
    expect(q('.jv-tab[aria-selected="true"] .jv-tab-t').textContent).toBe("Move billing");
  });
  test("a missing initiative and a failed load", async () => {
    await boot("#/initiative/NOPE");
    expect(text(".jv-docstate h2")).toBe("This document isn't here any more.");
    expect(text(".jv-docstate")).toContain("It may have been removed, or renamed by a sync.");
    expect(text(".jv-docstate")).toContain("Close tab");
    env.routes.set("GET /api/initiative/IA", () => ({ status: 500, json: { error: "boom" } }));
    await go("#/initiative/IA");
    expect(vis(".jv-docstate h2")).toBe("Couldn't open this document.");
  });
});

describe("ticking tasks", () => {
  test("tick shows Done · Undo, the row stays struck through, progress updates at once; Undo reopens", async () => {
    await boot("#/initiative/IA");
    const cb = qa(".jv-irow input")[1] as HTMLInputElement;
    cb.checked = true; change(cb);
    await env.tick(5);
    expect(text(".jv-ihead .jv-progress")).toBe("2 of 2 done");
    expect(qa(".jv-irow")[1].classList.contains("jv-irow-done")).toBe(true);
    expect(qa(".jv-irow")[1].textContent).toContain("Done · Undo");
    expect(env.calls.some((c) => c.path === "/api/task/T2/done")).toBe(true);
    expect(text(".jv-allnote")).toBe("✓ All tasks are done. It stays open until someone closes it, since more tasks may come.");
    await env.tick(80);
    expect(qa(".jv-irow")[1].textContent).not.toContain("Done · Undo");
    expect(qa(".jv-irow")[1].classList.contains("jv-irow-done")).toBe(true);
    // unticking a done task reopens it
    const again = qa(".jv-irow input")[1] as HTMLInputElement;
    again.checked = false; change(again);
    await env.tick(5);
    expect(env.calls.some((c) => c.path === "/api/task/T2/reopen")).toBe(true);
    expect(text(".jv-ihead .jv-progress")).toBe("1 of 2 done");
    expect(q(".jv-allnote")).toBeNull();
  });
  test("Undo right after ticking reopens; a failed tick unticks and says so", async () => {
    await boot("#/initiative/IA");
    let cb = qa(".jv-irow input")[1] as HTMLInputElement;
    cb.checked = true; change(cb);
    await env.tick(5);
    click(btn("Undo"));
    await env.tick(5);
    expect(env.calls.filter((c) => c.path === "/api/task/T2/reopen").length).toBe(1);
    expect(text(".jv-ihead .jv-progress")).toBe("1 of 2 done");
    env.routes.set("POST /api/task/T2/done", () => ({ status: 500, json: { error: "x" } }));
    cb = qa(".jv-irow input")[1] as HTMLInputElement;
    cb.checked = true; change(cb);
    await env.tick(20);
    expect((qa(".jv-irow input")[1] as HTMLInputElement).checked).toBe(false);
    expect(text(".toast")).toBe("Couldn't mark the task done.");
  });
});

describe("suggestions", () => {
  const sug = { model: true, suggestions: [{ id: "S1", title: "Finance weekly", source: "meeting", reason: "mentions the cut-over date" }, { id: "S2", title: "Ledger FAQ", source: "note", reason: "same topic" }] };
  test("load after the page, show title, reason and Accept; no model and nothing-fits say so", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await boot("#/initiative/IA", { suggest: async () => { await gate; return sug; } });
    expect(box("Suggested").textContent).toContain("Looking for captures that belong…");
    expect(qa(".jv-ibox h4")[0].textContent).toBe("Tasks · 2"); // the page did not wait for the model
    release();
    await env.tick(30);
    expect(box("Suggested").querySelector("h4")!.textContent).toBe("Suggested · 2 — not part of it until you accept");
    expect(box("Suggested").textContent).toContain("mentions the cut-over date");
    expect(box("Suggested").querySelectorAll("button").length).toBe(2);
    await boot("#/initiative/IA", { suggest: { model: false, suggestions: [] } });
    expect(box("Suggested").textContent).toContain("No model is available, so nothing is suggested.");
    await boot("#/initiative/IA", { suggest: { model: true, suggestions: [] } });
    expect(box("Suggested").textContent).toContain("Nothing else seems to belong yet.");
  });
  test("Accept: Accepting…, moves to Linked directly, says Linked to <title>, focus goes to the next one then the heading", async () => {
    await boot("#/initiative/IA", { suggest: sug });
    let release!: () => void;
    env.routes.set("POST /api/link", async () => { await new Promise<void>((r) => (release = r)); return { json: {} }; });
    const first = box("Suggested").querySelector("button") as HTMLButtonElement;
    click(first);
    await env.tick(5);
    expect(box("Suggested").querySelector("button")!.textContent).toBe("Accepting…");
    expect((box("Suggested").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    release();
    await env.tick(20);
    expect(env.calls.find((c) => c.path === "/api/link")!.body).toEqual({ src: "IA", dst: "S1" });
    expect(box("Linked").textContent).toContain("Finance weekly");
    expect(box("Linked").querySelector("h4")!.textContent).toBe("Linked directly · 2");
    expect(box("Suggested").textContent).not.toContain("Finance weekly");
    expect(text(".toast")).toBe("Linked to Move billing");
    expect(document.activeElement).toBe(box("Suggested").querySelector("button"));
    env.routes.set("POST /api/link", () => ({ json: {} }));
    click(box("Suggested").querySelector("button")!);
    await env.tick(20);
    expect(document.activeElement).toBe(box("Suggested").querySelector("h4"));
  });
  test("a failed Accept keeps the suggestion and says so", async () => {
    await boot("#/initiative/IA", { suggest: sug });
    env.routes.set("POST /api/link", () => ({ status: 500, json: { error: "x" } }));
    click(box("Suggested").querySelector("button")!);
    await env.tick(20);
    expect(box("Suggested").querySelector("button")!.textContent).toBe("Accept");
    expect(text(".toast")).toBe("Couldn't accept this suggestion.");
    expect(box("Suggested").textContent).toContain("Finance weekly");
  });
});

describe("closing and reopening", () => {
  test("with tasks open it asks first, focus on Cancel; Cancel and Esc return focus", async () => {
    await boot("#/initiative/IA");
    btn("Close initiative").focus();
    click(btn("Close initiative"));
    expect(text(".modal h3")).toBe("Close “Move billing”?");
    expect(text(".modal")).toContain("1 of its 2 tasks are still open. They stay open and stay in the initiative.");
    expect(document.activeElement!.textContent).toBe("Cancel");
    click(qa(".modal button")[0]);
    expect(document.activeElement!.textContent).toBe("Close initiative");
    expect(env.calls.some((c) => c.path === "/api/initiative/IA/close")).toBe(false);
  });
  test("Close anyway closes; the page shows closed, Reopen has focus, and Reopen acts at once", async () => {
    let closed = false;
    await boot("#/initiative/IA", { detail: () => base(closed ? { initiative: { id: "IA", title: "Move billing", owner: "anna", status: "closed", done: 1, total: 2, created_at: "2026-02-02T00:00:00Z", closed_at: "2026-03-30T00:00:00Z", closed_by: "mira", goal: "All billing on the new ledger" } } : {}) });
    click(btn("Close initiative"));
    click(btn("Close anyway"));
    closed = true;
    await env.tick(30);
    expect(env.calls.find((c) => c.path === "/api/initiative/IA/close")!.body).toEqual({ anyway: true });
    expect(text(".toast")).toBe("Closed: Move billing");
    expect(text(".jv-meta")).toBe("Initiative · anna · closed 2026-03-30 by mira");
    expect(text(".jv-ihead")).toContain("Closed 2026-03-30 by mira.");
    expect(text(".jv-dhead")).toContain("closed");
    expect(document.activeElement).toBe(btn("Reopen"));
    closed = false;
    click(btn("Reopen"));
    await env.tick(30);
    expect(text(".toast")).toBe("Reopened: Move billing");
    expect(document.activeElement).toBe(btn("Close initiative"));
  });
  test("with every task done it closes at once, with no question; failures say so", async () => {
    const done = base({ tasks: [task(1, { status: "done" })] });
    await boot("#/initiative/IA", { detail: done });
    expect(text(".jv-allnote")).toContain("✓ All tasks are done.");
    click(btn("Close initiative"));
    await env.tick(20);
    expect(q(".modal")).toBeNull();
    expect(env.calls.find((c) => c.path === "/api/initiative/IA/close")!.body).toEqual({ anyway: false });
    env.routes.set("POST /api/initiative/IA/close", () => ({ status: 500, json: { error: "x" } }));
    await boot("#/initiative/IA", { detail: done });
    env.routes.set("POST /api/initiative/IA/close", () => ({ status: 500, json: { error: "x" } }));
    click(btn("Close initiative"));
    await env.tick(20);
    expect(text(".toast")).toBe("Couldn't close this initiative.");
    expect(btn("Close initiative")).toBeDefined();
  });
  test("a failed reopen says so and changes nothing", async () => {
    const closed = base({ initiative: { id: "IA", title: "Move billing", owner: "anna", status: "closed", done: 1, total: 2, created_at: "2026-02-02T00:00:00Z", closed_at: "2026-03-30T00:00:00Z", closed_by: "mira", goal: "g" } });
    await boot("#/initiative/IA", { detail: closed });
    env.routes.set("POST /api/initiative/IA/reopen", () => ({ status: 500, json: { error: "x" } }));
    click(btn("Reopen"));
    await env.tick(20);
    expect(text(".toast")).toBe("Couldn't reopen this initiative.");
    expect(btn("Reopen")).toBeDefined();
  });
});

describe("tabs", () => {
  test("the tab opens with focus on its heading", async () => {
    await boot("#/chat");
    await go("#/initiative/IA");
    expect(document.activeElement).toBe(q(".jv-dtitle"));
  });
  test("ticking a task on the initiative's tab updates the initiative line on an open task tab at once", async () => {
    await boot("#/initiative/IA");
    const item = { id: "T2", source: "task", title: "task 2", author: "me", created_at: "2026-03-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "b", proc_version: 1, file_path: null };
    env.routes.set("GET /api/item/T2", () => ({ json: { item, edges: [], initiative: { id: "IA", title: "Move billing", done: 1, total: 2 } } }));
    (qa(".jv-irow a")[1] as HTMLElement).click(); await env.tick(60);
    expect(vis(".jv-iline")).toContain("1 of 2 done");
    qa(".jv-tabstrip .jv-tab")[1].click(); await env.tick(40); // back to the initiative
    const cb = qa(".jv-irow input")[1] as HTMLInputElement;
    cb.checked = true; change(cb); await env.tick(5);
    qa(".jv-tabstrip .jv-tab")[2].click(); await env.tick(40);
    expect(vis(".jv-iline")).toContain("2 of 2 done");
  });
});

describe("review fixes", () => {
  test("layout: the header, then the body with the goal and the four stacked boxes", async () => {
    await boot("#/initiative/IA");
    expect([...q(".jv-iread").children].map((c) => c.className.split(" ")[0])).toEqual(["jv-dhead", "jv-dbody"]);
    expect([...q(".jv-dbody").children].map((c) => c.className.split(" ")[0])).toEqual(["jv-ihead", "jv-iboxes"]);
  });
  test("the page shows grey placeholders while it loads, with no Loading… text", async () => {
    env = installWebEnv(1280);
    let release!: () => void;
    env.routes.set("GET /api/initiative/IA", async () => { await new Promise<void>((r) => (release = r)); return { json: base() }; });
    env.routes.set("GET /api/initiative/IA/suggest", () => ({ json: { model: true, suggestions: [] } }));
    env.routes.set("GET /api/me", () => ({ json: {} }));
    env.routes.set("GET /api/chat/status", () => ({ json: { available: true } }));
    env.routes.set("GET /api/tasks", () => ({ json: { tasks: [] } }));
    document.body.innerHTML = '<div id="app"></div>';
    location.hash = "#/initiative/IA";
    mountApp(document.getElementById("app")!);
    await env.tick(40);
    expect(q(".jv-skel")).not.toBeNull();
    expect(q(".jv-page").textContent).not.toContain("Loading");
    release();
    await env.tick(40);
    expect(q(".jv-skel")).toBeNull();
  });
  test("Esc closes the close question and focus returns to Close initiative", async () => {
    await boot("#/initiative/IA");
    btn("Close initiative").focus();
    click(btn("Close initiative"));
    document.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    expect(q(".modal")).toBeNull();
    expect(document.activeElement!.textContent).toBe("Close initiative");
  });
  test("a failed tick leaves no stray timer: a later successful tick keeps its Undo for the whole window", async () => {
    timing.undoMs = 120;
    await boot("#/initiative/IA");
    timing.undoMs = 120;
    env.routes.set("POST /api/task/T2/done", () => ({ status: 500, json: { error: "x" } }));
    let cb = qa(".jv-irow input")[1] as HTMLInputElement;
    cb.checked = true; change(cb);
    await env.tick(20);
    env.routes.set("POST /api/task/T2/done", () => ({ json: {} }));
    cb = qa(".jv-irow input")[1] as HTMLInputElement;
    cb.checked = true; change(cb);
    await env.tick(60); // the first (failed) tick's window would have ended by 120 - 20 = 100 ms from its start
    await env.tick(50);
    expect(qa(".jv-irow")[1].textContent).toContain("Done · Undo");
  });
  test("a close that worked is not reported as failed when only the re-read fails", async () => {
    await boot("#/initiative/IA", { detail: base({ tasks: [task(1, { status: "done" })] }) });
    env.routes.set("GET /api/initiative/IA", () => ({ status: 500, json: { error: "x" } }));
    click(btn("Close initiative"));
    await env.tick(30);
    expect(text(".toast")).toBe("Closed: Move billing");
    expect(btn("Reopen")).toBeDefined();
  });
});
