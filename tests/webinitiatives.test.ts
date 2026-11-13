import { afterEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { mountApp } from "../web/src/main.ts";

let env: WebEnv;
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (sel: string) => q(sel)?.textContent ?? "";
const go = async (hash: string) => { location.hash = hash; await env.tick(60); };

const INI = (o: Record<string, unknown> = {}) => ({ id: "IA", title: "Move billing", owner: "anna", status: "open", done: 2, total: 4, created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-05T10:00:00Z", goal: "All billing on the new ledger", ...o });
interface Opts { list?: unknown[]; tasks?: unknown[]; chat?: string }
async function boot(hash: string, o: Opts = {}) {
  env = installWebEnv(1280);
  if (o.chat) localStorage.setItem("jv.chat", o.chat); // a reload over the same browser storage
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
    expect(cards[1].querySelector(".jv-ct")!.getAttribute("href")).toBe("#/initiative/IA");
    expect(cards[1].querySelector(".jv-m")!.textContent).toContain("initiative · anna");
    expect(cards[1].textContent).toContain("1 of 4 done");
  });
  test("search hits use the same card for initiatives", async () => {
    await boot("#/browse");
    env.routes.set("GET /api/search", () => ({ json: [{ docId: "IA", source: "initiative", title: "Move billing", snippet: "All [billing] on the new ledger", score: 1, progress: { done: 4, total: 4, owner: "anna", status: "open", goal: "All billing on the new ledger", updated_at: "2026-03-05T10:00:00Z" } }] }));
    localStorage.setItem("jv.browse", JSON.stringify({ q: "billing", mode: "hybrid", source: "", author: "", tag: "", days: "", addedOffset: 0, updatedOffset: 0 }));
    await go("#/search"); await go("#/browse");
    expect(q(".jv-card .jv-ct").getAttribute("href")).toBe("#/initiative/IA");
    expect(q(".jv-card").textContent).toContain("✓ All tasks done — close it?");
    expect(q(".jv-card .jv-m").textContent).toContain("initiative · anna · updated 2026-03-05");
    expect(qa(".jv-card .jv-s").map((s) => s.textContent)).toEqual(["All billing on the new ledger"]); // the goal once, not again as a snippet
  });
  test("a task's tab: the initiative line sits above the title, with progress; it opens the initiative's tab; a standalone task has no line", async () => {
    await boot("#/chat");
    const item = { id: "T1", source: "task", title: "Dry-run", author: "jonas", created_at: "2026-03-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "b", proc_version: 1, file_path: null };
    env.routes.set("GET /api/item/T1", () => ({ json: { item, edges: [], initiative: { ...INIREF, done: 4, total: 9 } } }));
    env.routes.set("GET /api/item/T2", () => ({ json: { item: { ...item, id: "T2", title: "Alone" }, edges: [] } }));
    await go("#/item/T1");
    const line = q(".jv-doc .jv-iline");
    expect(line.textContent).toContain("◎ Move billing");
    expect(line.textContent).toContain("4 of 9 done");
    expect(line.nextElementSibling!.classList.contains("jv-dhead")).toBe(true); // above the title
    expect(line.querySelector("a")!.getAttribute("href")).toBe("#/initiative/IA");
    await go("#/item/T2");
    expect(qa(".jv-doc").find((d) => !d.hidden)!.querySelector(".jv-iline")).toBeNull();
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

describe("a chat that renames its initiative (jv-maq)", () => {
  /** An initiative-scoped chat on "Software Principles" whose tab is open, and whose answer renames it to "Mjukvaruprinciper". */
  async function renamed() {
    await boot("#/chat");
    let title = "Software Principles";
    env.routes.set("GET /api/initiative/IA", () => ({ json: { initiative: { id: "IA", title, owner: "anna", status: "open", done: 0, total: 0, created_at: "2026-02-02T00:00:00Z", goal: "g" }, tasks: [], through: { total: 0, items: [] }, direct: { total: 0, items: [] } } }));
    env.routes.set("GET /api/initiative/IA/suggest", () => ({ json: { model: true, suggestions: [] } }));
    env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
    const change = (o: Record<string, unknown> = {}) => ({ id: "ch1", turn: "t1", kind: "initiative.title", ok: true, items: [{ id: "IA", title: "Mjukvaruprinciper", kind: "initiative" }], detail: { from: "Software Principles", to: "Mjukvaruprinciper" }, undone: false, undoable: true, ...o });
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p: (l: unknown) => void) => { title = "Mjukvaruprinciper"; p({ type: "change", change: change() }); p({ type: "message", text: "Renamed." }); p({ type: "done" }); } }));
    await go("#/initiative/IA");
    (qa("button").find((b) => b.textContent === "Ask about this") as HTMLElement).click();
    await env.tick(60);
    expect(text(".jv-attach-t")).toBe("◎ Software Principles");
    const input = q(".jv-input") as HTMLTextAreaElement;
    input.value = "Byt namn på den till Mjukvaruprinciper.";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    await env.tick(80);
    return { setTitle: (t: string) => { title = t; }, change };
  }
  const tabTitle = () => q('.jv-tab[data-key="initiative:IA"] .jv-tab-t')?.textContent;
  test("the scope chip and the initiative's tab read the new title without a reload", async () => {
    await renamed();
    expect(text(".jv-attach-t")).toBe("◎ Mjukvaruprinciper");
    expect(tabTitle()).toBe("Mjukvaruprinciper");
    q('.jv-tab[data-key="initiative:IA"]').click();
    await env.tick(60);
    expect(qa(".jv-doc").find((d) => !d.hidden)!.querySelector(".jv-dtitle")!.textContent).toBe("Mjukvaruprinciper");
  });
  test("undoing the rename puts the old title back on the chip and the tab", async () => {
    const r = await renamed();
    expect(text(".jv-attach-t")).toBe("◎ Mjukvaruprinciper");
    const cid = JSON.parse(localStorage.getItem("jv.chat")!).conversationId as string;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/ch1/undo`, () => { r.setTitle("Software Principles"); return { json: { change: r.change({ undone: true }) } }; });
    q('[data-undo="ch1"]').click();
    await env.tick(80);
    expect(text(".jv-attach-t")).toBe("◎ Software Principles");
    expect(tabTitle()).toBe("Software Principles");
    q('.jv-tab[data-key="initiative:IA"]').click();
    await env.tick(60);
    expect(qa(".jv-doc").find((d) => !d.hidden)!.querySelector(".jv-dtitle")!.textContent).toBe("Software Principles");
  });
});

describe("a chat's rename of its initiative retitles the source pills of its answers (jv-9oe)", () => {
  /** An initiative chat on "Software Principles": the first answer cites it, the second cites it, opens it as a card and renames it. */
  async function twoTurns() {
    await boot("#/chat");
    let title = "Software Principles";
    env.routes.set("GET /api/initiative/IA", () => ({ json: { initiative: { id: "IA", title, owner: "anna", status: "open", done: 0, total: 0, created_at: "2026-02-02T00:00:00Z", goal: "g" }, tasks: [], through: { total: 0, items: [] }, direct: { total: 0, items: [] } } }));
    env.routes.set("GET /api/initiative/IA/suggest", () => ({ json: { model: true, suggestions: [] } }));
    env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
    const change = (o: Record<string, unknown> = {}) => ({ id: "ch1", turn: "t2", kind: "initiative.title", ok: true, items: [{ id: "IA", title: "Mjukvaruprinciper", kind: "initiative" }], detail: { from: "Software Principles", to: "Mjukvaruprinciper" }, undone: false, undoable: true, ...o });
    const source = () => ({ type: "source", docId: "IA", title, source: "initiative" });
    const turns = [
      (p: (l: unknown) => void) => { p(source()); p({ type: "source", docId: "N1", title: "Software Principles notes", source: "note" }); p({ type: "message", text: "It is about principles." }); },
      (p: (l: unknown) => void) => { p(source()); p({ type: "open", docId: "IA", title, source: "initiative" }); title = "Mjukvaruprinciper"; p({ type: "change", change: change() }); p({ type: "message", text: "Renamed." }); },
    ];
    let n = 0;
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p: (l: unknown) => void) => { turns[n++](p); p({ type: "done" }); } }));
    await go("#/initiative/IA");
    (qa("button").find((b) => b.textContent === "Ask about this") as HTMLElement).click();
    await env.tick(60);
    for (const q1 of ["What is it about?", "Byt namn på den till Mjukvaruprinciper."]) {
      const input = q(".jv-input") as HTMLTextAreaElement;
      input.value = q1;
      input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
      await env.tick(80);
    }
    return { setTitle: (t: string) => { title = t; }, change };
  }
  const pills = () => qa('.jv-chips a[href="#/initiative/IA"]').map((a) => a.textContent);
  const card = () => text(".jv-docard-t");
  test("every answer's pill and card for the initiative read the new title; another document's pill is untouched", async () => {
    await twoTurns();
    expect(pills()).toEqual(["Mjukvaruprinciper", "Mjukvaruprinciper"]);
    expect(card()).toBe("Mjukvaruprinciper");
    expect(q('.jv-chips a[href="#/item/N1"]').textContent).toBe("Software Principles notes");
    const saved = JSON.parse(localStorage.getItem("jv.chat")!) as { messages: { sources?: { docId: string; title: string }[] }[] };
    expect(saved.messages.flatMap((m) => m.sources ?? []).filter((s) => s.docId === "IA").map((s) => s.title)).toEqual(["Mjukvaruprinciper", "Mjukvaruprinciper"]);
  });
  test("undoing the rename puts the old title back on the pills and the card", async () => {
    const r = await twoTurns();
    const cid = JSON.parse(localStorage.getItem("jv.chat")!).conversationId as string;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/ch1/undo`, () => { r.setTitle("Software Principles"); return { json: { change: r.change({ undone: true }) } }; });
    q('[data-undo="ch1"]').click();
    await env.tick(80);
    expect(pills()).toEqual(["Software Principles", "Software Principles"]);
    expect(card()).toBe("Software Principles");
  });
});

describe("Undo after a chat renamed its initiative more than once (jv-maq review)", () => {
  type Row = { id: string; turn: string; kind: string; ok: boolean; items: { id: string; title: string; kind: string }[]; detail?: { from: string; to: string }; undone: boolean; undoable: boolean };
  const rename = (id: string, turn: string, from: string, to: string): Row => ({ id, turn, kind: "initiative.title", ok: true, items: [{ id: "IA", title: to, kind: "initiative" }], detail: { from, to }, undone: false, undoable: true });
  const taskRow = (id: string, turn: string): Row => ({ id, turn, kind: "task.create", ok: true, items: [{ id: "T9", title: "Draft", kind: "task" }], undone: false, undoable: true });
  /** A fake server holding the conversation's change log, as the routes do: each Undo answers with the whole log. */
  async function chat(turns: Row[][]) {
    await boot("#/chat");
    const srv = { title: "A", log: [] as Row[] };
    env.routes.set("GET /api/initiative/IA", () => ({ json: { initiative: { id: "IA", title: srv.title, owner: "anna", status: "open", done: 0, total: 0, created_at: "2026-02-02T00:00:00Z", goal: "g" }, tasks: [], through: { total: 0, items: [] }, direct: { total: 0, items: [] } } }));
    env.routes.set("GET /api/initiative/IA/suggest", () => ({ json: { model: true, suggestions: [] } }));
    env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
    let n = 0;
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p: (l: unknown) => void) => {
      for (const c of turns[n++]) { srv.log.push(c); if (c.detail) srv.title = c.detail.to; p({ type: "change", change: { ...c } }); }
      p({ type: "message", text: "Done." }); p({ type: "done" });
    } }));
    await go("#/initiative/IA");
    (qa("button").find((b) => b.textContent === "Ask about this") as HTMLElement).click();
    await env.tick(60);
    const cid = JSON.parse(localStorage.getItem("jv.chat")!).conversationId as string;
    const base = `POST /api/chat/conversations/${cid}/changes`;
    const settle = (c: Row) => { c.undone = true; if (c.detail) srv.title = c.detail.from; };
    for (const c of turns.flat()) env.routes.set(`${base}/${c.id}/undo`, () => { settle(c); return { json: { change: { ...c }, changes: srv.log.map((x) => ({ ...x })) } }; });
    env.routes.set(`${base}/undo-all`, (b) => { for (const c of [...srv.log].reverse()) if (c.turn === (b as { turn: string }).turn && !c.undone) settle(c); return { json: { changes: srv.log.map((x) => ({ ...x })) } }; });
    for (const _ of turns) {
      const input = q(".jv-input") as HTMLTextAreaElement;
      input.value = "Rename it.";
      input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
      await env.tick(80);
    }
    return srv;
  }
  const labels = () => [text(".jv-attach-t"), q('.jv-tab[data-key="initiative:IA"] .jv-tab-t')?.textContent];
  const undo = async (sel: string) => { q(sel).click(); await env.tick(80); };
  test("two renames undone one by one: the labels step back to B, then to A", async () => {
    await chat([[rename("ch1", "t1", "A", "B")], [rename("ch2", "t2", "B", "C")]]);
    expect(labels()).toEqual(["◎ C", "C"]);
    await undo('[data-undo="ch2"]');
    expect(labels()).toEqual(["◎ B", "B"]);
    await undo('[data-undo="ch1"]');
    expect(labels()).toEqual(["◎ A", "A"]);
  });
  test("Undo all on a turn that renamed twice puts the first title back", async () => {
    await chat([[rename("ch1", "t1", "A", "B"), rename("ch2", "t1", "B", "C")]]);
    expect(labels()).toEqual(["◎ C", "C"]);
    await undo('[data-undoall="1"]');
    expect(labels()).toEqual(["◎ A", "A"]);
  });
  test("undoing an unrelated row leaves the labels and the tab's page alone", async () => {
    const srv = await chat([[rename("ch1", "t1", "A", "B")], [taskRow("ch3", "t2")]]);
    srv.title = "D"; // renamed outside the chat; the tab learns it when it is next drawn
    await undo('.jv-tab[data-key="initiative:IA"]');
    await undo('.jv-tab[data-key="chat"]');
    expect(labels()).toEqual(["◎ B", "D"]);
    const fetches = () => env.calls.filter((c) => c.method === "GET" && c.path === "/api/initiative/IA").length;
    const before = fetches();
    await undo('[data-undo="ch3"]');
    expect(labels()).toEqual(["◎ B", "D"]);
    expect(fetches()).toBe(before); // the tab was not drawn again
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
  test("the two-line clamp is for initiative cards only, not other cards' summaries or search snippets", async () => {
    const css = (await import("node:fs")).readFileSync("web/src/styles.css", "utf8");
    expect(css).toContain(".jv-icard .jv-s:not(.jv-snip) { display:-webkit-box;");
    expect(css).not.toMatch(/^\.jv-s \{ display:-webkit-box/m);
  });
});

describe("a chat's rename of its initiative rewrites earlier answers' inline mentions of it (jv-4u9)", () => {
  const link = (t: string, id = "IA") => `[${t}](jarvis://initiative/${id})`;
  type Row = { id: string; turn: string; kind: string; ok: boolean; items: { id: string; title: string; kind: string }[]; detail: { from: string; to: string }; undone: boolean; undoable: boolean };
  const row = (id: string, from: string, to: string, o: Partial<Row> = {}): Row => ({ id, turn: `t-${id}`, kind: "initiative.title", ok: true, items: [{ id: "IA", title: to, kind: "initiative" }], detail: { from, to }, undone: false, undoable: true, ...o });
  /** A chat on "Software Principles" whose turns are scripted: each is the answer text plus the rename (if any) it makes. */
  async function chat(turns: { text: string; rename?: Row; first?: string }[]) {
    await boot("#/chat");
    const srv = { title: "Software Principles", log: [] as Row[] };
    env.routes.set("GET /api/initiative/IA", () => ({ json: { initiative: { id: "IA", title: srv.title, owner: "anna", status: "open", done: 0, total: 0, created_at: "2026-02-02T00:00:00Z", goal: "g" }, tasks: [], through: { total: 0, items: [] }, direct: { total: 0, items: [] } } }));
    env.routes.set("GET /api/initiative/IA/suggest", () => ({ json: { model: true, suggestions: [] } }));
    env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
    let n = 0;
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p: (l: unknown) => void) => {
      const t = turns[n++];
      p({ type: "source", docId: "IA", title: srv.title, source: "initiative" });
      if (t.first) p({ type: "message", text: t.first }); // text said before the rename
      if (t.rename) { srv.log.push(t.rename); srv.title = t.rename.detail.to; p({ type: "change", change: { ...t.rename } }); }
      p({ type: "message", text: t.text }); p({ type: "done" });
    } }));
    await go("#/initiative/IA");
    (qa("button").find((b) => b.textContent === "Ask about this") as HTMLElement).click();
    await env.tick(60);
    for (let i = 0; i < turns.length; i++) {
      const input = q(".jv-input") as HTMLTextAreaElement;
      input.value = `q${i}`;
      input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
      await env.tick(80);
    }
    const cid = JSON.parse(localStorage.getItem("jv.chat")!).conversationId as string;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/undo`, () => ({ json: {} }));
    const undo = (id: string) => {
      env.routes.set(`POST /api/chat/conversations/${cid}/changes/${id}/undo`, () => {
        srv.log = srv.log.map((r) => (r.id === id ? { ...r, undone: true } : r));
        const r = srv.log.find((x) => x.id === id)!;
        srv.title = r.detail.from;
        return { json: { change: r, changes: srv.log } };
      });
      q(`[data-undo="${id}"]`).click();
      return env.tick(80);
    };
    return { undo };
  }
  const mentions = () => qa(".jv-answer a").map((a) => a.textContent);
  const saved = () => (JSON.parse(localStorage.getItem("jv.chat")!) as { messages: { role: string; text: string }[] }).messages.filter((m) => m.role === "assistant").map((m) => m.text);
  const R1 = row("ch1", "Software Principles", "Mjukvaruprinciper");

  test("an earlier answer's mention of the old name reads the new one; the renaming answer keeps its own words", async () => {
    await chat([{ text: `See ${link("Software Principles")}.` }, { text: `Renamed ${link("Software Principles")}.`, rename: R1 }]);
    expect(saved()).toEqual([`See ${link("Mjukvaruprinciper")}.`, `Renamed ${link("Software Principles")}.`]);
    expect(mentions()).toEqual(["Mjukvaruprinciper", "Software Principles"]);
  });
  test("the renaming answer (text said before the rename) and a later answer keep their words, through the rename and its Undo", async () => {
    const c = await chat([{ text: "", first: `Before ${link("Software Principles")}. `, rename: R1 }, { text: `Later ${link("Mjukvaruprinciper")}.` }]);
    expect(saved()).toEqual([`Before ${link("Software Principles")}. `, `Later ${link("Mjukvaruprinciper")}.`]);
    await c.undo("ch1");
    expect(saved()).toEqual([`Before ${link("Software Principles")}. `, `Later ${link("Mjukvaruprinciper")}.`]);
  });
  test("a new title containing ] leaves the mentions alone", async () => {
    await chat([{ text: `See ${link("Software Principles")}.` }, { text: "Renamed.", rename: row("ch1", "Software Principles", "Principles [v2]") }]);
    expect(saved()[0]).toBe(`See ${link("Software Principles")}.`);
  });
  test("the match ignores capitals and spaces; own-words mentions, other initiatives and plain text stay", async () => {
    await chat([{ text: `${link(" software principles ")}, ${link("the principles initiative")}, ${link("Software Principles", "IB")}, Software Principles` }, { text: "Renamed.", rename: R1 }]);
    expect(saved()[0]).toBe(`${link("Mjukvaruprinciper")}, ${link("the principles initiative")}, ${link("Software Principles", "IB")}, Software Principles`);
  });
  test("Undo puts the old name back in those mentions", async () => {
    const c = await chat([{ text: `See ${link("Software Principles")}.` }, { text: "Renamed.", rename: R1 }]);
    expect(saved()[0]).toBe(`See ${link("Mjukvaruprinciper")}.`);
    await c.undo("ch1");
    expect(saved()[0]).toBe(`See ${link("Software Principles")}.`);
    expect(mentions()).toEqual(["Software Principles"]);
  });
  test("two renames then one Undo: the mentions read the first rename's name", async () => {
    const c = await chat([{ text: `See ${link("Software Principles")}.` }, { text: "One.", rename: R1 }, { text: "Two.", rename: row("ch2", "Mjukvaruprinciper", "Principer") }]);
    expect(saved()[0]).toBe(`See ${link("Principer")}.`);
    await c.undo("ch2");
    expect(saved()[0]).toBe(`See ${link("Mjukvaruprinciper")}.`);
  });
  test("a reopened chat shows the current name in the mention and the pill", async () => {
    await chat([{ text: `See ${link("Software Principles")}.` }, { text: "Renamed.", rename: R1 }]);
    const stored = localStorage.getItem("jv.chat")!;
    env.restore();
    await boot("#/chat", { chat: stored });
    expect(mentions()[0]).toBe("Mjukvaruprinciper");
    expect(qa(".jv-chips a")[0].textContent).toBe("Mjukvaruprinciper");
  });
});
