import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handle } from "../src/server.ts";
import { addInitiative } from "../src/core/initiatives.ts";
import { addTask, setTaskStatus } from "../src/core/tasks.ts";
import { link } from "../src/core/links.ts";
import { ingest } from "../src/core/ingest.ts";
import { readDocFile } from "../src/core/docs.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";
import { fakeRouter, noRouter } from "./fakeRouter.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { t.cleanup(); clearEmbedder(); });
const call = (method: string, path: string, body?: unknown, router: unknown = noRouter) =>
  handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), { dataDir: t.dir, router });

describe("initiative routes", () => {
  test("list: status filter, goal and updated_at on each, most recently updated first", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "goal A", author: "anna" });
    const b = await addInitiative(t.dir, { title: "Beta", goal: "goal B", author: "bo" });
    await addTask(t.dir, { title: "one", initiative: a.id });
    await call("POST", `/api/initiative/${b.id}/close`, { anyway: true });
    const open = (await (await call("GET", "/api/initiatives")).json()).initiatives;
    expect(open.map((i: { title: string }) => i.title)).toEqual(["Alpha"]);
    expect(open[0]).toMatchObject({ goal: "goal A", owner: "anna", done: 0, total: 1, status: "open" });
    expect(open[0].updated_at).toBeTruthy();
    const all = (await (await call("GET", "/api/initiatives?status=all")).json()).initiatives;
    expect(all.map((i: { title: string }) => i.title)).toEqual(["Beta", "Alpha"]); // Beta was closed, so updated, last
    const closed = (await (await call("GET", "/api/initiatives?status=closed")).json()).initiatives;
    expect(closed.map((i: { title: string }) => i.title)).toEqual(["Beta"]);
  });

  test("show returns every task and every tied capture, and 404s for an unknown id or a task id", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "the goal", author: "anna" });
    for (let i = 0; i < 12; i++) await addTask(t.dir, { title: `task ${i}`, initiative: a.id });
    const note = await ingest(t.dir, { source: "note", title: "Note", body: "n", author: "me" });
    link(t.dir, a.id, [note.id]);
    const d = await (await call("GET", `/api/initiative/${a.id}`)).json();
    expect(d.initiative).toMatchObject({ title: "Alpha", goal: "the goal" });
    expect(d.tasks.length).toBe(12);
    expect(d.direct.items.map((i: { id: string }) => i.id)).toEqual([note.id]);
    expect((await call("GET", "/api/initiative/NOPE")).status).toBe(404);
    expect((await call("GET", `/api/initiative/${d.tasks[0].id}`)).status).toBe(404);
  });

  test("close asks first (409) while tasks are open, closes with anyway, reopens", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "g", author: "anna" });
    await addTask(t.dir, { title: "one", initiative: a.id });
    const refused = await call("POST", `/api/initiative/${a.id}/close`, {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/still has 1 open task/);
    expect((await (await call("POST", `/api/initiative/${a.id}/close`, { anyway: true })).json())).toMatchObject({ title: "Alpha", left: 1 });
    expect(readDocFile(t.dir, a.id)!.frontmatter.initiative!.status).toBe("closed");
    expect(await (await call("POST", `/api/initiative/${a.id}/reopen`, {})).json()).toEqual({ title: "Alpha" });
    expect(readDocFile(t.dir, a.id)!.frontmatter.initiative!.status).toBe("open");
    expect((await call("POST", "/api/initiative/NOPE/close", {})).status).toBe(404);
  });

  test("suggest: no model says so; a model gives suggestions that Accept (POST /api/link) moves to linked directly", async () => {
    const a = await addInitiative(t.dir, { title: "Ledger", goal: "all on the new ledger", author: "anna" });
    await addTask(t.dir, { title: "Dry-run ledger invoices", initiative: a.id });
    const m = await ingest(t.dir, { source: "meeting", title: "Finance weekly", body: "ledger cutover date billing", author: "me" });
    expect(await (await call("GET", `/api/initiative/${a.id}/suggest`)).json()).toEqual({ model: false, suggestions: [] });
    const router = fakeRouter(() => JSON.stringify({ results: [{ id: m.id, keep: true, reason: "mentions the cut-over date" }] }));
    const s = await (await call("GET", `/api/initiative/${a.id}/suggest`, undefined, router)).json();
    expect(s.suggestions).toEqual([{ id: m.id, title: "Finance weekly", source: "meeting", reason: "mentions the cut-over date" }]);
    expect((await call("POST", "/api/link", { src: a.id, dst: m.id })).status).toBe(200);
    expect((await (await call("GET", `/api/initiative/${a.id}`)).json()).direct.items.map((i: { id: string }) => i.id)).toEqual([m.id]);
  });
});

describe("which initiative a task or card belongs to", () => {
  test("browse, search and the item page carry the initiative of a task and the progress of an initiative", async () => {
    const a = await addInitiative(t.dir, { title: "Alpha", goal: "launch alpha", author: "anna" });
    const t1 = await addTask(t.dir, { title: "alpha task one", initiative: a.id });
    await addTask(t.dir, { title: "alpha task two", initiative: a.id });
    const solo = await addTask(t.dir, { title: "alpha solo" });
    setTaskStatus(t.dir, t1.id, "done");
    const b = await (await call("GET", "/api/browse?limit=20")).json();
    const rows = [...b.added, ...b.updated];
    expect(rows.find((i: { id: string }) => i.id === t1.id).initiative).toEqual({ id: a.id, title: "Alpha" });
    expect(rows.find((i: { id: string }) => i.id === solo.id).initiative).toBeUndefined();
    expect(rows.find((i: { id: string }) => i.id === a.id).progress).toMatchObject({ done: 1, total: 2, owner: "anna", status: "open", goal: "launch alpha" });
    const hits = await (await call("GET", "/api/search?q=alpha&mode=keyword")).json();
    expect(hits.find((h: { docId: string }) => h.docId === t1.id).initiative).toEqual({ id: a.id, title: "Alpha" });
    expect(hits.find((h: { docId: string }) => h.docId === a.id).progress).toMatchObject({ done: 1, total: 2 });
    const item = await (await call("GET", `/api/item/${t1.id}`)).json();
    expect(item.initiative).toEqual({ id: a.id, title: "Alpha", done: 1, total: 2 });
    expect((await (await call("GET", `/api/item/${solo.id}`)).json()).initiative).toBeUndefined();
  });
});
