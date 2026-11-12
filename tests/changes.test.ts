import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangeLog, UndoConflict, type Change } from "../src/chat/changes.ts";
import { runTool } from "../src/chat/actions.ts";
import { readDocFile } from "../src/core/docs.ts";
import { reindex } from "../src/core/reindex.ts";
import { listTasks } from "../src/core/tasks.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
let log: ChangeLog;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); log = new ChangeLog(t.dir, "c1"); });
afterEach(() => { t.cleanup(); clearEmbedder(); });
const runAny = (tool: string, args: Record<string, unknown>, attachments: Record<string, string> = {}) => runTool(log, "turn1", tool, args, { dataDir: t.dir, attachments });
/** `runAny` for tools that always record a row. */
const run = async (tool: string, args: Record<string, unknown>, attachments: Record<string, string> = {}): Promise<{ change: Change; text: string }> => {
  const r = await runAny(tool, args, attachments);
  if (!r.change) throw new Error("expected a change row");
  return { change: r.change, text: r.text };
};

describe("change log (jv-oya.4)", () => {
  test("a created task is recorded and undone, and the files and index agree", async () => {
    const { change } = await run("jarvis_create_task", { title: "Write runbook", due: "2026-11-20" });
    expect(change).toMatchObject({ kind: "task.create", ok: true, undoable: true, undone: false, items: [{ title: "Write runbook", kind: "task" }] });
    const id = change.items[0].id;
    expect(readDocFile(t.dir, id)!.frontmatter.task!.due).toBe("2026-11-20");
    await log.undo(change.id);
    expect(existsSync(join(t.dir, "docs", `${id}.md`))).toBe(false);
    expect(listTasks(t.dir)).toEqual([]);
    expect(log.list()[0].undone).toBe(true);
  });
  test("done, reopen, due, owner changes undo to the previous task block", async () => {
    const id = (await run("jarvis_create_task", { title: "T", due: "2026-11-20", owner: "me" })).change.items[0].id;
    const done = (await run("jarvis_set_task_status", { task: id, status: "done" })).change;
    expect(done.kind).toBe("task.done");
    const due = (await run("jarvis_update_task", { task: id, due: "2026-11-13" })).change;
    expect(due).toMatchObject({ kind: "task.due", detail: { from: "2026-11-20", to: "2026-11-13" } });
    const own = (await run("jarvis_update_task", { task: id, owner: "sam" })).change;
    expect(own).toMatchObject({ kind: "task.owner", detail: { from: "me", to: "sam" } });
    await log.undo(own.id); await log.undo(due.id);
    expect(readDocFile(t.dir, id)!.frontmatter.task).toMatchObject({ status: "done", owner: "me", due: "2026-11-20" });
    await log.undo(done.id);
    expect(readDocFile(t.dir, id)!.frontmatter.task).toEqual({ status: "open", owner: "me", due: "2026-11-20" });
    const reopen = (await run("jarvis_set_task_status", { task: id, status: "done" })).change;
    expect((await run("jarvis_set_task_status", { task: id, status: "open" })).change.kind).toBe("task.reopen");
    expect(reopen.kind).toBe("task.done");
  });
  test("link and its undo; a repeated link fails as a row", async () => {
    const a = (await run("jarvis_capture_note", { text: "alpha note", title: "Alpha" })).change;
    const b = (await run("jarvis_capture_note", { text: "beta note", title: "Beta" })).change;
    expect(a.kind).toBe("capture.note");
    const l = (await run("jarvis_link", { src: a.items[0].id, dst: b.items[0].id, relation: "related" })).change;
    expect(l).toMatchObject({ kind: "link", detail: { relation: "related" }, items: [{ title: "Alpha" }, { title: "Beta" }] });
    const again = (await run("jarvis_link", { src: a.items[0].id, dst: b.items[0].id, relation: "related" })).change;
    expect(again).toMatchObject({ ok: false, undoable: false, verb: "link", error: "they are already linked" });
    await log.undo(l.id);
    expect(existsSync(join(t.dir, "edges", `${a.items[0].id}.jsonl`))).toBe(false);
  });
  test("a task created with a link shows a Created task row and a Linked row, each undoable on its own (jv-eit)", async () => {
    const zoom = (await run("jarvis_capture_note", { text: "zoom drift", title: "Zoom drift" })).change.items[0].id;
    const r = await run("jarvis_create_task", { title: "Order spare Zoom cameras", link: [zoom] });
    expect(r.change).toMatchObject({ kind: "task.create", undoable: true });
    const task = r.change.items[0].id;
    const rows = log.list().slice(1);
    expect(rows.map((c) => c.kind)).toEqual(["task.create", "link"]);
    expect(rows[1]).toMatchObject({ ok: true, undoable: true, detail: { relation: "references" }, items: [{ id: task, title: "Order spare Zoom cameras", kind: "task" }, { id: zoom, title: "Zoom drift" }] });
    await log.undo(rows[1].id);
    expect(existsSync(join(t.dir, "edges", `${task}.jsonl`))).toBe(false);
    expect(readDocFile(t.dir, task)).not.toBeNull();
    await log.undo(rows[0].id);
    expect(existsSync(join(t.dir, "docs", `${task}.md`))).toBe(false);
  });
  test("undoing a linked task first leaves its Linked row undone, not a conflict (jv-eit)", async () => {
    const zoom = (await run("jarvis_capture_note", { text: "zoom drift", title: "Zoom drift" })).change.items[0].id;
    await run("jarvis_create_task", { title: "Order spare Zoom cameras", link: [zoom] });
    const [, task, linked] = log.list();
    await log.undo(task.id);
    expect((await log.undo(linked.id)).undone).toBe(true);
    expect(readDocFile(t.dir, zoom)).not.toBeNull();
  });
  test("a status that is neither done nor open is a failed row, not a reopen", async () => {
    const id = (await run("jarvis_create_task", { title: "S" })).change.items[0].id;
    const r = await runAny("jarvis_set_task_status", { task: id, status: "complete" });
    expect(r.change).toMatchObject({ ok: false, error: 'status must be "done" or "open", not "complete"' });
    expect(readDocFile(t.dir, id)!.frontmatter.task!.status).toBe("open");
  });
  test("linking an initiative to its own task is a failed row, nothing is written", async () => {
    const ini = (await run("jarvis_create_initiative", { title: "Move billing", goal: "g" })).change;
    const task = (await run("jarvis_create_task", { title: "Export invoices", initiative: ini.items[0].id })).change;
    const before = log.list().length;
    const { change, text } = await runAny("jarvis_link", { src: ini.items[0].id, dst: task.items[0].id });
    expect(change).toMatchObject({ ok: false, error: "Export invoices is already a task in Move billing" });
    expect(text).toContain("Export invoices is already a task in Move billing");
    expect(log.list().length).toBe(before + 1);
    expect(existsSync(join(t.dir, "edges", `${ini.items[0].id}.jsonl`))).toBe(false);
  });
  test("a link to a missing item fails with the reason and has no undo", async () => {
    const a = (await run("jarvis_capture_note", { text: "alpha", title: "Alpha" })).change;
    const { change, text } = await run("jarvis_link", { src: a.items[0].id, dst: "nope" });
    expect(change).toMatchObject({ ok: false, undoable: false, error: "target nope not found" });
    expect(text).toContain("Failed");
    expect(log.list().length).toBe(2);
  });
  test("initiative, task filed under it, and moving a task", async () => {
    const ini = (await run("jarvis_create_initiative", { title: "On-call rollout", goal: "everyone on the new rota" })).change;
    expect(ini).toMatchObject({ kind: "initiative.create", items: [{ kind: "initiative" }] });
    const task = (await run("jarvis_create_task", { title: "Rota", initiative: ini.items[0].id })).change;
    expect(readDocFile(t.dir, task.items[0].id)!.frontmatter.task!.initiative).toBe(ini.items[0].id);
    const other = (await run("jarvis_create_task", { title: "Loose" })).change;
    const mv = (await run("jarvis_move_task", { task: other.items[0].id, initiative: ini.items[0].id })).change;
    expect(mv.kind).toBe("task.move");
    await log.undo(mv.id);
    expect(readDocFile(t.dir, other.items[0].id)!.frontmatter.task!.initiative).toBeUndefined();
  });
  test("editing an initiative's title, goal and owner is one row per field and each undoes (jv-smd.1)", async () => {
    const ini = (await run("jarvis_create_initiative", { title: "Rollout", goal: "old goal", owner: "me" })).change;
    const id = ini.items[0].id;
    const r = await runAny("jarvis_edit_initiative", { initiative: "Rollout", title: "Rollout 2", goal: "new goal", owner: "sam" });
    const rows = [r.change!, ...r.more];
    expect(rows.map((c) => [c.kind, c.ok, c.undoable])).toEqual([["initiative.title", true, true], ["initiative.goal", true, true], ["initiative.owner", true, true]]);
    expect(rows[0]).toMatchObject({ detail: { from: "Rollout", to: "Rollout 2" }, items: [{ id, kind: "initiative" }] });
    expect(rows[2]).toMatchObject({ detail: { from: "me", to: "sam" } });
    const doc = readDocFile(t.dir, id)!;
    expect([doc.frontmatter.title, doc.body.trim(), doc.frontmatter.initiative!.owner]).toEqual(["Rollout 2", "new goal", "sam"]);
    await log.undo(rows[1].id);
    expect(readDocFile(t.dir, id)!.body.trim()).toBe("old goal");
    await log.undo(rows[0].id); await log.undo(rows[2].id);
    const back = readDocFile(t.dir, id)!;
    expect([back.frontmatter.title, back.body.trim(), back.frontmatter.initiative!.owner]).toEqual(["Rollout", "old goal", "me"]);
  });
  test("undoing an initiative edit is refused once the field changed again; nothing to change fails as a row", async () => {
    const id = (await run("jarvis_create_initiative", { title: "Rollout", goal: "g", owner: "me" })).change.items[0].id;
    const edit = (await run("jarvis_edit_initiative", { initiative: id, goal: "g2" })).change;
    await run("jarvis_edit_initiative", { initiative: id, goal: "g3" });
    await expect(log.undo(edit.id)).rejects.toBeInstanceOf(UndoConflict);
    expect(readDocFile(t.dir, id)!.body.trim()).toBe("g3");
    const same = await runAny("jarvis_edit_initiative", { initiative: id, goal: "g3" });
    expect(same.change).toMatchObject({ ok: false, undoable: false, verb: "change initiative", error: "nothing to change" });
    const empty = await runAny("jarvis_edit_initiative", { initiative: id, goal: " " });
    expect(empty.change).toMatchObject({ ok: false, error: "nothing to change" });
    const missing = await runAny("jarvis_edit_initiative", { initiative: "nope", goal: "x" });
    expect(missing.change).toMatchObject({ ok: false });
  });
  test("draft briefing and draft presentation carry a preview and undo", async () => {
    const b = (await run("jarvis_draft_briefing", { title: "Status", body: "## Where we are\n\nok\n\n## Risks\n\nnone\n", sources: ["a", "b"] })).change;
    expect(b).toMatchObject({ kind: "draft.briefing", draft: { kind: "briefing", sections: ["Where we are", "Risks"], sources: 2 } });
    expect(existsSync(join(t.dir, "briefings", `${b.items[0].id}.brief.mdx`))).toBe(true);
    const p = (await run("jarvis_draft_presentation", { title: "Launch deck", mdx: "<Presentation>\n<Slide>\n# One\n</Slide>\n<Slide>\n# Two\n</Slide>\n</Presentation>\n" })).change;
    expect(p).toMatchObject({ kind: "draft.presentation", items: [{ id: "launch-deck", kind: "presentation" }], draft: { slides: 2 } });
    await log.undo(p.id); await log.undo(b.id);
    expect(existsSync(join(t.dir, "presentations", "launch-deck"))).toBe(false);
    expect(existsSync(join(t.dir, "briefings", `${b.items[0].id}.brief.mdx`))).toBe(false);
  });
  test("capture a file, a pdf-less meeting transcript, and an unknown attachment", async () => {
    const f = join(t.dir, "notes.md"); writeFileSync(f, "# Notes\n\nhello");
    const v = join(t.dir, "sync.vtt"); writeFileSync(v, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Sam>We decided to ship.\n");
    const c1 = (await run("jarvis_capture_file", { attachment: "notes.md" }, { "notes.md": f })).change;
    const c2 = (await run("jarvis_capture_file", { attachment: "sync.vtt" }, { "sync.vtt": v })).change;
    expect([c1.kind, c2.kind]).toEqual(["capture.file", "capture.meeting"]);
    expect((await run("jarvis_capture_file", { attachment: "x.md" })).change).toMatchObject({ ok: false, error: "there is no attached file called x.md" });
  });
  test("undo refuses after the item was changed; undo all skips undone and stops at a conflict", async () => {
    const a = (await run("jarvis_create_task", { title: "A" })).change;
    const b = (await run("jarvis_create_task", { title: "B" })).change;
    const p = join(t.dir, "docs", `${a.items[0].id}.md`);
    writeFileSync(p, readFileSync(p, "utf8").replace("A\n", "A edited\n").replace("title: A", "title: A edited"));
    await expect(log.undo(a.id)).rejects.toBeInstanceOf(UndoConflict);
    await expect(log.undo(a.id)).rejects.toThrow("Couldn't undo — A was changed after the agent changed it.");
    expect(existsSync(p)).toBe(true);
    const r = await log.undoAll();
    expect(r.error).toContain("was changed after the agent changed it");
    expect(r.changes.map((c) => c.undone)).toEqual([false, true]);
    expect(b.undone).toBe(false);
  });
  test("two tool calls at once each own only their own files, so Undo of one keeps the other", async () => {
    const [x, y] = await Promise.all([run("jarvis_create_task", { title: "First" }), run("jarvis_create_task", { title: "Second" })]);
    expect(x.change.items[0].id).not.toBe(y.change.items[0].id);
    await log.undo(x.change.id);
    expect(listTasks(t.dir).map((k) => k.title)).toEqual(["Second"]);
  });
  test("Undo all with a turn undoes that answer only", async () => {
    const one = await runTool(log, "turnA", "jarvis_create_task", { title: "A" }, { dataDir: t.dir, attachments: {} });
    const two = await runTool(log, "turnB", "jarvis_create_task", { title: "B" }, { dataDir: t.dir, attachments: {} });
    await log.undoAll("turnB");
    expect(log.list().map((c) => [c.id === one.change?.id, c.undone])).toEqual([[true, false], [false, true]]);
    expect(listTasks(t.dir).map((k) => k.title)).toEqual(["A"]);
  });
  test("an owner change names the user as you; a full reindex after Undo leaves no trace", async () => {
    const id = (await run("jarvis_create_task", { title: "T", owner: "sam" })).change.items[0].id;
    const { resolveAuthor } = await import("../src/core/config.ts");
    const c = (await run("jarvis_update_task", { task: id, owner: resolveAuthor() })).change;
    expect(c.detail).toEqual({ from: "sam", to: "you" });
    await log.undoAll();
    await reindex(t.dir, { full: true, embed: false });
    expect(listTasks(t.dir)).toEqual([]);
  });
  test("a deck's own frontmatter is not trusted and its provenance is not a temp path", async () => {
    const p = (await run("jarvis_draft_presentation", { title: "Deck", mdx: "---\nid: EVIL\nauthor: someone\n---\n<Presentation>\n<Slide>\n# One\n</Slide>\n</Presentation>\n" })).change;
    const text = readFileSync(join(t.dir, "presentations", "deck", "index.mdx"), "utf8");
    expect(text).not.toContain("EVIL");
    expect(text).toContain("imported_from: chat");
    expect(p.ok).toBe(true);
  });
  test("the log survives a new instance and a full reindex keeps agent files", async () => {
    const c = (await run("jarvis_create_task", { title: "Persist me" })).change;
    expect(new ChangeLog(t.dir, "c1").list().map((x) => x.id)).toEqual([c.id]);
    await reindex(t.dir, { full: true, embed: false });
    expect(listTasks(t.dir).map((x) => x.title)).toEqual(["Persist me"]);
    expect(() => new ChangeLog(t.dir, "../x")).toThrow();
  });
  test("a sync-style enrichment of a created doc does not block Undo", async () => {
    const c = (await run("jarvis_capture_note", { text: "alpha", title: "Alpha" })).change;
    const p = join(t.dir, "docs", `${c.items[0].id}.md`);
    writeFileSync(p, readFileSync(p, "utf8").replace(/^---\n/, "---\nsummary: enriched\n"));
    await log.undo(c.id);
    expect(existsSync(p)).toBe(false);
  });
});
