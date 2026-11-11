import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addTask, listTasks, showTask, setTaskStatus, suggestLinks, updateTask } from "../src/core/tasks.ts";
import { link, unlink } from "../src/core/links.ts";
import { ingest } from "../src/core/ingest.ts";
import { computeEdges } from "../src/core/edges.ts";
import { readDocFile } from "../src/core/docs.ts";
import { reindex } from "../src/core/reindex.ts";
import { withDb } from "../src/core/db.ts";
import { handle } from "../src/server.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { t.cleanup(); clearEmbedder(); });

describe("tasks", () => {
  test("add, list ordering, show, done/reopen rewrite only the task block", async () => {
    const doc = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "camera firmware zoom drift", author: "me" });
    const a = await addTask(t.dir, { title: "Fix zoom drift", due: "2026-10-01", author: "me", links: [doc.id] });
    const b = await addTask(t.dir, { title: "No due date", author: "me", body: "some body" });
    const c = await addTask(t.dir, { title: "Earlier due", due: "2026-09-30", author: "me", owner: "kim" });
    await expect(addTask(t.dir, { title: "bad", due: "next week" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(addTask(t.dir, { title: "bad", links: ["nope"] })).rejects.toThrow(/not found/);
    expect(a.linked).toBe(1);
    const f = readDocFile(t.dir, a.id)!;
    expect(f.frontmatter.source).toBe("task");
    expect(f.frontmatter.task).toEqual({ status: "open", owner: "me", due: "2026-10-01" });
    expect(f.body.trim()).toBe("Fix zoom drift");
    const all = listTasks(t.dir, { status: "all", owner: "all" });
    expect(all.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    expect(all.find((x) => x.id === b.id)!.links).toBe(0);
    expect(listTasks(t.dir, { owner: "kim" }).map((x) => x.id)).toEqual([c.id]);
    const d = showTask(t.dir, a.id);
    expect(d.linked).toEqual([{ id: doc.id, title: "Zoom drift", relation: "references", createdBy: "manual", direction: "out" }]);
    const before = readFileSync(join(t.dir, "docs", `${a.id}.md`), "utf8");
    const done = setTaskStatus(t.dir, a.id, "done", "kim");
    expect(done).toMatchObject({ status: "done", completed_by: "kim" });
    const after = readFileSync(join(t.dir, "docs", `${a.id}.md`), "utf8");
    expect(after).toContain("status: done");
    expect(after).toContain("completed_by: kim");
    expect(after).toContain("updated_by: kim");
    expect(after.split("---")[2]).toBe(before.split("---")[2]); // body untouched
    expect(listTasks(t.dir).map((x) => x.id)).toEqual([c.id, b.id]);
    expect(listTasks(t.dir, { status: "all" })[2].id).toBe(a.id); // done last
    setTaskStatus(t.dir, a.id, "open");
    expect(readDocFile(t.dir, a.id)!.frontmatter.task).toEqual({ status: "open", owner: "me", due: "2026-10-01" });
    // files are authoritative for status: edit file directly
    const p = join(t.dir, "docs", `${b.id}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(p, readFileSync(p, "utf8").replace("status: open", "status: done"));
    expect(listTasks(t.dir).map((x) => x.id)).toEqual([c.id, a.id]);
  });

  test("suggest: derived neighbours, then search, then keyword; excludes self, linked and tasks", async () => {
    const d1 = await ingest(t.dir, { source: "note", title: "Camera firmware notes", body: "camera firmware zoom drift fix details", author: "me" });
    const d2 = await ingest(t.dir, { source: "note", title: "Lunch", body: "pasta salad canteen", author: "me" });
    const d3 = await ingest(t.dir, { source: "note", title: "Firmware release", body: "firmware release camera", author: "me" });
    const task = await addTask(t.dir, { title: "Ship camera firmware zoom fix", author: "me", links: [d1.id] });
    const other = await addTask(t.dir, { title: "Another camera firmware task", author: "me" });
    await reindex(t.dir);
    computeEdges(t.dir);
    const s = await suggestLinks(t.dir, task.id, { limit: 5 });
    const ids = s.map((x) => x.id);
    expect(ids).not.toContain(task.id);
    expect(ids).not.toContain(d1.id);
    expect(ids).not.toContain(other.id);
    expect(ids).toContain(d3.id);
    expect(ids.indexOf(d3.id)).toBeLessThan(ids.indexOf(d2.id) < 0 ? 99 : ids.indexOf(d2.id));
    expect(s.every((x) => /edge|search match|keyword match/.test(x.reason))).toBe(true);
  });
});

describe("links", () => {
  test("manual link appends to sidecar, replaces derived edges, validates ids, idempotent", async () => {
    const a = await ingest(t.dir, { source: "note", title: "A", body: "camera firmware zoom", author: "me" });
    const b = await ingest(t.dir, { source: "note", title: "B", body: "camera firmware zoom too", author: "me" });
    computeEdges(t.dir);
    expect(withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM edges WHERE created_by='embedding'").get() as any).c)).toBeGreaterThan(0);
    expect(() => link(t.dir, a.id, [a.id])).toThrow(/itself/);
    expect(() => link(t.dir, a.id, ["01NOPE"])).toThrow(/not found/);
    expect(() => link(t.dir, a.id, [b.id], { relation: "mentions" as never })).toThrow(/relation/);
    const r = link(t.dir, a.id, [b.id], { relation: "supplements", author: "me" });
    expect(r).toEqual([{ src: a.id, dst: b.id, relation: "supplements", status: "linked" }]);
    const lines = readFileSync(join(t.dir, "edges", `${a.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([expect.objectContaining({ kind: "edge", created_by: "manual", weight: 1, relation: "supplements", author: "me" })]);
    const edges = withDb(t.dir, (db) => db.query("SELECT created_by, relation FROM edges WHERE (src=?1 AND dst=?2) OR (src=?2 AND dst=?1)").all(a.id, b.id) as any[]);
    expect(edges).toEqual([{ created_by: "manual", relation: "supplements" }]);
    expect(link(t.dir, a.id, [b.id], { relation: "supplements" })[0].status).toBe("exists");
    // survives a full reindex + edges pass (derived never overrides manual)
    await reindex(t.dir, { full: true });
    computeEdges(t.dir);
    expect(withDb(t.dir, (db) => db.query("SELECT created_by FROM edges WHERE (src=?1 AND dst=?2) OR (src=?2 AND dst=?1)").all(a.id, b.id) as any[])).toEqual([{ created_by: "manual" }]);
  });

  test("ingest update path honours the task block", async () => {
    const r = await ingest(t.dir, { source: "task", title: "T", body: "T", author: "me", source_url: "task://x", task: { status: "open", owner: "me" } });
    const u = await ingest(t.dir, { source: "task", title: "T", body: "T", author: "me", source_url: "task://x", task: { status: "done", owner: "me" } });
    expect(u.id).toBe(r.id);
    expect(readDocFile(t.dir, r.id)!.frontmatter.task).toEqual({ status: "done", owner: "me" });
    expect(readDocFile(t.dir, r.id)!.frontmatter.updated_by).toBe("me");
  });

  test("HTTP: tasks, task, link routes", async () => {
    const call = (method: string, path: string, body?: unknown) => handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), { dataDir: t.dir });
    const doc = await ingest(t.dir, { source: "note", title: "Doc", body: "doc", author: "me" });
    const made = await (await call("POST", "/api/task", { title: "Via API", link: doc.id, author: "ext" })).json();
    expect(made).toMatchObject({ status: "captured", linked: 1 });
    expect((await call("POST", "/api/task", {})).status).toBe(400);
    const list = await (await call("GET", "/api/tasks")).json();
    expect(list.tasks.map((x: { id: string }) => x.id)).toEqual([made.id]);
    const shown = await (await call("GET", `/api/task/${made.id}`)).json();
    expect(shown.linked.length).toBe(1);
    expect((await (await call("POST", `/api/task/${made.id}/done`, {})).json()).status).toBe("done");
    expect((await (await call("GET", "/api/tasks?status=done")).json()).tasks.length).toBe(1);
    const d2 = await ingest(t.dir, { source: "note", title: "Doc2", body: "doc2", author: "me" });
    const l = await (await call("POST", "/api/link", { src: doc.id, dst: [d2.id], relation: "follows_up" })).json();
    expect(l.links[0]).toMatchObject({ status: "linked", relation: "follows_up" });
    expect((await call("POST", "/api/link", { src: doc.id, dst: d2.id, relation: "mentions" })).status).toBe(400);
    expect((await call("POST", "/api/link", { src: doc.id, dst: "01NOPE" })).status).toBe(404);
    const sug = await (await call("GET", `/api/task/${made.id}/suggest`)).json();
    expect(Array.isArray(sug.suggestions)).toBe(true);
  });
});

describe("updateTask and unlink (jv-oya.4)", () => {
  test("updateTask changes only due and owner, and a null due clears it", async () => {
    const a = await addTask(t.dir, { title: "Runbook", due: "2026-11-20", author: "me" });
    const r = await updateTask(t.dir, a.id, { due: "2026-11-13", owner: "sam", author: "me" });
    expect(r).toMatchObject({ title: "Runbook", due: { from: "2026-11-20", to: "2026-11-13" }, owner: { from: "me", to: "sam" } });
    expect(readDocFile(t.dir, a.id)!.frontmatter.task).toEqual({ status: "open", owner: "sam", due: "2026-11-13" });
    await updateTask(t.dir, a.id, { due: null });
    expect(readDocFile(t.dir, a.id)!.frontmatter.task!.due).toBeUndefined();
    await expect(updateTask(t.dir, a.id, { due: "soon" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(updateTask(t.dir, "nope", { due: "2026-11-13" })).rejects.toThrow(/not found/);
  });
  test("unlink removes the manual edge from the sidecar and the index", async () => {
    const a = await ingest(t.dir, { source: "note", title: "A", body: "alpha", author: "me" });
    const b = await ingest(t.dir, { source: "note", title: "B", body: "beta", author: "me" });
    link(t.dir, a.id, [b.id], { relation: "follows_up", author: "me" });
    expect(unlink(t.dir, a.id, b.id, "follows_up")).toBe(true);
    expect(unlink(t.dir, a.id, b.id, "follows_up")).toBe(false);
    expect(readFileSync(join(t.dir, "edges", `${a.id}.jsonl`), "utf8").trim()).toBe("");
    expect(withDb(t.dir, (db) => db.query("SELECT count(*) c FROM edges WHERE src = ?").get(a.id) as { c: number }).c).toBe(0);
  });
});
