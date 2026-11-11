import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addTask, listTasks, setTaskStatus, showTask } from "../src/core/tasks.ts";
import { addInitiative, closeInitiative, editInitiative, initiativeSuggestions, listInitiatives, moveTask, reopenInitiative, showInitiative } from "../src/core/initiatives.ts";
import { link } from "../src/core/links.ts";
import { ingest } from "../src/core/ingest.ts";
import { readDocFile } from "../src/core/docs.ts";
import { parseDoc, serializeDoc } from "../src/core/frontmatter.ts";
import { reindex } from "../src/core/reindex.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";
import { fakeRouter, noRouter } from "./fakeRouter.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { t.cleanup(); clearEmbedder(); });

describe("frontmatter", () => {
  test("task.initiative and the initiative block round-trip", () => {
    const text = serializeDoc({ frontmatter: { id: "A", source: "initiative", title: "T", author: "me", created_at: "2026-01-01T00:00:00Z", initiative: { status: "open", owner: "anna" } }, body: "goal" });
    expect(parseDoc(text).frontmatter.initiative).toEqual({ status: "open", owner: "anna" });
    const tt = serializeDoc({ frontmatter: { id: "B", source: "task", title: "T", author: "me", created_at: "2026-01-01T00:00:00Z", task: { status: "open", owner: "me", initiative: "A" } }, body: "x" });
    expect(parseDoc(tt).frontmatter.task?.initiative).toBe("A");
  });
});

describe("initiatives", () => {
  test("add requires a goal, defaults owner, and is a plain file; edit reports changes", async () => {
    await expect(addInitiative(t.dir, { title: "X", goal: " " })).rejects.toThrow(/An initiative needs a goal\. Say what done looks like:\n  jarvis initiative add "<title>" --goal "<what done looks like>"/);
    const a = await addInitiative(t.dir, { title: "Move billing", goal: "all on the new ledger", author: "anna" });
    expect(a).toMatchObject({ title: "Move billing", owner: "anna" });
    const f = readDocFile(t.dir, a.id)!;
    expect(f.frontmatter.source).toBe("initiative");
    expect(f.frontmatter.initiative).toEqual({ status: "open", owner: "anna" });
    expect(f.body.trim()).toBe("all on the new ledger");
    const e = await editInitiative(t.dir, a.id, { owner: "jonas", goal: "new goal" });
    expect(e.title).toBe("Move billing");
    expect(e.changes).toEqual(["owner anna → jonas", "goal changed"]);
    expect(readDocFile(t.dir, a.id)!.body.trim()).toBe("new goal");
    await expect(editInitiative(t.dir, a.id, {})).rejects.toThrow(/usage: jarvis initiative edit/);
  });

  test("unknown id and task id get the agreed errors", async () => {
    const task = await addTask(t.dir, { title: "A task", author: "me" });
    await expect(showInitiative(t.dir, "01ZZZZZZ")).rejects.toThrow("no initiative 01ZZZZZZ — see them all: jarvis initiative list");
    await expect(showInitiative(t.dir, task.id)).rejects.toThrow(`${task.id} is a task, not an initiative — jarvis task show ${task.id}`);
  });

  test("tasks join from the task side, move, leave, and survive reindex --full", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "g", author: "me" });
    const b = await addInitiative(t.dir, { title: "Beta", goal: "g", author: "me" });
    const t1 = await addTask(t.dir, { title: "Freeze API", author: "me", initiative: a.id });
    expect(readDocFile(t.dir, t1.id)!.frontmatter.task?.initiative).toBe(a.id);
    await expect(addTask(t.dir, { title: "x", initiative: "nope" })).rejects.toThrow(/no initiative nope/);
    expect(await moveTask(t.dir, t1.id, a.id)).toEqual({ status: "unchanged", title: "Freeze API", to: "Alpha" });
    expect(await moveTask(t.dir, t1.id, b.id)).toEqual({ status: "moved", title: "Freeze API", from: "Alpha", to: "Beta" });
    expect(listTasks(t.dir, { initiative: b.id }).map((x) => x.id)).toEqual([t1.id]);
    expect(listTasks(t.dir)[0].initiative).toEqual({ id: b.id, title: "Beta" });
    expect(showTask(t.dir, t1.id).task.initiative).toEqual({ id: b.id, title: "Beta" });
    await reindex(t.dir, { full: true, embed: false });
    expect((await showInitiative(t.dir, b.id)).tasks.map((x) => x.id)).toEqual([t1.id]);
    expect(await moveTask(t.dir, t1.id, null)).toEqual({ status: "moved", title: "Freeze API", from: "Beta", to: undefined });
    expect(listTasks(t.dir)[0].initiative).toBeUndefined();
    expect(readDocFile(t.dir, t1.id)!.frontmatter.task).not.toHaveProperty("initiative");
  });

  test("list shows progress, states and status filter", async () => {
    expect(listInitiatives(t.dir)).toEqual([]);
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "g", author: "me" });
    const e = await addInitiative(t.dir, { title: "Empty", goal: "g", author: "me" });
    const x = await addTask(t.dir, { title: "one", initiative: a.id });
    await addTask(t.dir, { title: "two", initiative: a.id });
    setTaskStatus(t.dir, x.id, "done");
    const l = listInitiatives(t.dir);
    expect(l.find((i) => i.id === a.id)).toMatchObject({ done: 1, total: 2, status: "open" });
    expect(l.find((i) => i.id === e.id)).toMatchObject({ done: 0, total: 0 });
    await closeInitiative(t.dir, e.id, {});
    expect(listInitiatives(t.dir).map((i) => i.id)).toEqual([a.id]);
    expect(listInitiatives(t.dir, { status: "closed" }).map((i) => i.id)).toEqual([e.id]);
    expect(listInitiatives(t.dir, { status: "all" })).toHaveLength(2);
    expect(listInitiatives(t.dir, { status: "closed" })[0].closed_at).toBeTruthy();
  });

  test("show: tied items appear once, with the tasks they came through; sections capped unless all", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "g", author: "me" });
    const t1 = await addTask(t.dir, { title: "Dry-run", initiative: a.id });
    const t2 = await addTask(t.dir, { title: "Reconcile", initiative: a.id });
    const shared = await ingest(t.dir, { source: "note", title: "Checklist", body: "dry-run checklist", author: "me" });
    link(t.dir, t1.id, [shared.id]);
    link(t.dir, t2.id, [shared.id]);
    const direct = await ingest(t.dir, { source: "note", title: "Direct", body: "direct note", author: "me" });
    link(t.dir, a.id, [direct.id]);
    const d = await showInitiative(t.dir, a.id);
    expect(d.tasks.map((x) => x.title).sort()).toEqual(["Dry-run", "Reconcile"]);
    expect(d.through.total).toBe(1);
    expect(d.through.items[0]).toMatchObject({ id: shared.id, title: "Checklist" });
    expect(d.through.items[0].via.sort()).toEqual(["Dry-run", "Reconcile"]);
    expect(d.direct.items.map((x) => x.id)).toEqual([direct.id]);
    for (let i = 0; i < 12; i++) link(t.dir, a.id, [(await ingest(t.dir, { source: "note", title: `N${i}`, body: `body ${i}`, author: "me" })).id]);
    const capped = await showInitiative(t.dir, a.id);
    expect(capped.direct.total).toBe(13);
    expect(capped.direct.items).toHaveLength(10);
    expect((await showInitiative(t.dir, a.id, { all: true })).direct.items).toHaveLength(13);
  });

  test("close refuses with open tasks unless anyway; reopen; closed refuses new tasks", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "g", author: "me" });
    const t1 = await addTask(t.dir, { title: "one", initiative: a.id });
    await addTask(t.dir, { title: "two", initiative: a.id });
    setTaskStatus(t.dir, t1.id, "done");
    await expect(closeInitiative(t.dir, a.id, {})).rejects.toThrow(`Alpha still has 1 open tasks.\nFinish or move them first, or close it anyway:\n  jarvis initiative close ${a.id} --anyway`);
    expect(await closeInitiative(t.dir, a.id, { anyway: true, author: "mira" })).toEqual({ title: "Alpha", done: 1, total: 2, left: 1 });
    expect(readDocFile(t.dir, a.id)!.frontmatter.initiative).toMatchObject({ status: "closed", closed_by: "mira" });
    expect(listTasks(t.dir, { initiative: a.id })).toHaveLength(1); // open task stays in it
    await expect(addTask(t.dir, { title: "late", initiative: a.id })).rejects.toThrow(`Alpha is closed. Reopen it first:\n  jarvis initiative reopen ${a.id}`);
    const other = await addTask(t.dir, { title: "free" });
    await expect(moveTask(t.dir, other.id, a.id)).rejects.toThrow(/is closed\. Reopen it first/);
    await reopenInitiative(t.dir, a.id);
    expect(readDocFile(t.dir, a.id)!.frontmatter.initiative).toEqual({ status: "open", owner: "me" });
  });

  test("finishing the last open task reports it; never auto-closes", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "g", author: "me" });
    const t1 = await addTask(t.dir, { title: "one", initiative: a.id });
    const t2 = await addTask(t.dir, { title: "two", initiative: a.id });
    expect(setTaskStatus(t.dir, t1.id, "done").initiativeCompleted).toBeUndefined();
    expect(setTaskStatus(t.dir, t2.id, "done").initiativeCompleted).toEqual({ id: a.id, title: "Alpha", done: 2, total: 2 });
    expect(readDocFile(t.dir, a.id)!.frontmatter.initiative?.status).toBe("open");
    const solo = await addTask(t.dir, { title: "solo" });
    expect(setTaskStatus(t.dir, solo.id, "done").initiativeCompleted).toBeUndefined();
  });

  test("suggestions: none without a model; judged candidates with one; garbage output is harmless", async () => {
    const a = await addInitiative(t.dir, { title: "Ledger cutover", goal: "move billing ledger", author: "me" });
    await addTask(t.dir, { title: "Dry-run ledger invoices", initiative: a.id });
    const m = await ingest(t.dir, { source: "meeting", title: "Finance weekly", body: "ledger cutover date billing", author: "me" });
    await ingest(t.dir, { source: "note", title: "Lunch", body: "pasta salad", author: "me" });
    expect(await initiativeSuggestions(t.dir, a.id, { router: noRouter })).toEqual({ model: false, suggestions: [] });
    const ok = fakeRouter((prompt) => JSON.stringify({ results: [{ id: m.id, keep: true, reason: "mentions the cut-over date" }, { id: "made-up", keep: true, reason: "x" }] }));
    const r = await initiativeSuggestions(t.dir, a.id, { router: ok });
    expect(r.model).toBe(true);
    expect(r.suggestions).toEqual([{ id: m.id, title: "Finance weekly", source: "meeting", reason: "mentions the cut-over date" }]);
    const none = await initiativeSuggestions(t.dir, a.id, { router: fakeRouter(() => JSON.stringify({ results: [] })) });
    expect(none).toEqual({ model: true, suggestions: [] });
    const bad = await initiativeSuggestions(t.dir, a.id, { router: fakeRouter(() => "not json") });
    expect(bad).toEqual({ model: true, suggestions: [] });
    link(t.dir, a.id, [m.id]);
    expect((await initiativeSuggestions(t.dir, a.id, { router: ok })).suggestions).toEqual([]); // already tied
  });
});
