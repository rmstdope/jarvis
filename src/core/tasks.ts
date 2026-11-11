import type { Database } from "bun:sqlite";
import { resolveAuthor } from "./config.ts";
import { TASK_SUGGEST_LIMIT, TASK_SUGGEST_MIN_TERM, TASK_SUGGEST_QUERY_CHARS, type Relation } from "./constants.ts";
import { openDb } from "./db.ts";
import { getDocRow, readDocFile, upsertDocRow, writeDocFile } from "./docs.ts";
import type { DocFrontmatter, TaskBlock } from "./frontmatter.ts";
import { initiativeTitle, requireOpenInitiative } from "./initiativeRef.ts";
import { ingest } from "./ingest.ts";
import { link, targetExists } from "./links.ts";
import { ftsQuery, search } from "./search.ts";
import { readSidecar } from "./sidecar.ts";
import { nowIso } from "./util.ts";

export interface TaskItem {
  id: string;
  title: string;
  status: "open" | "done";
  owner: string;
  due?: string;
  created_at: string;
  completed_at?: string;
  completed_by?: string;
  author: string;
  links: number;
  /** The initiative the task belongs to, if any. */
  initiative?: { id: string; title: string };
}

/** Builds a TaskItem from a task doc (files are authoritative). */
function toItem(dataDir: string, doc: { frontmatter: DocFrontmatter }, links: number): TaskItem {
  const t = doc.frontmatter.task!;
  const item: TaskItem = { id: doc.frontmatter.id, title: doc.frontmatter.title, status: t.status === "done" ? "done" : "open", owner: t.owner, due: t.due, created_at: doc.frontmatter.created_at, completed_at: t.completed_at, completed_by: t.completed_by, author: doc.frontmatter.author, links };
  if (t.initiative) item.initiative = { id: t.initiative, title: initiativeTitle(dataDir, t.initiative) ?? t.initiative };
  return item;
}

export function isValidDue(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
}

export async function addTask(dataDir: string, opts: { title: string; body?: string; due?: string; owner?: string; author?: string; links?: string[]; relation?: Relation; initiative?: string; db?: Database }): Promise<{ id: string; linked: number }> {
  if (!opts.title?.trim()) throw new Error("task title is required");
  if (opts.due && !isValidDue(opts.due)) throw new Error("--due must be YYYY-MM-DD");
  const db = opts.db ?? openDb(dataDir);
  try {
    for (const l of opts.links ?? []) if (!targetExists(db, dataDir, l)) throw new Error(`link target ${l} not found`);
    if (opts.initiative) requireOpenInitiative(dataDir, opts.initiative);
    const author = resolveAuthor(opts.author);
    const task: TaskBlock = { status: "open", owner: opts.owner ?? author, due: opts.due };
    if (opts.initiative) task.initiative = opts.initiative;
    const r = await ingest(dataDir, { source: "task", title: opts.title.trim(), body: opts.body?.trim() || opts.title.trim(), author, task }, { db });
    let linked = 0;
    if (opts.links?.length) linked = link(dataDir, r.id, opts.links, { relation: opts.relation, author, db }).filter((x) => x.status === "linked").length;
    return { id: r.id, linked };
  } finally {
    if (!opts.db) db.close();
  }
}

/** Ids from the index; status read from files (files are authoritative). Order: open first, then due (undefined last), then created. */
export function listTasks(dataDir: string, opts: { status?: "open" | "done" | "all"; owner?: string; initiative?: string; db?: Database } = {}): TaskItem[] {
  const db = opts.db ?? openDb(dataDir);
  try {
    const ids = (db.query("SELECT id FROM documents WHERE source = 'task'").all() as { id: string }[]).map((r) => r.id);
    const out: TaskItem[] = [];
    for (const id of ids) {
      const doc = readDocFile(dataDir, id);
      const t = doc?.frontmatter.task;
      if (!doc || !t) continue;
      const status = t.status === "done" ? "done" : "open";
      if ((opts.status ?? "open") !== "all" && status !== (opts.status ?? "open")) continue;
      if (opts.owner && opts.owner !== "all" && t.owner !== opts.owner) continue;
      if (opts.initiative && t.initiative !== opts.initiative) continue;
      out.push(toItem(dataDir, doc, readSidecar(dataDir, id).filter((l) => l.kind === "edge").length));
    }
    return out.sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) || (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0) || a.created_at.localeCompare(b.created_at));
  } finally {
    if (!opts.db) db.close();
  }
}

export interface TaskDetail {
  task: TaskItem;
  body: string;
  linked: { id: string; title: string | null; relation: string; createdBy: string; direction: "out" | "in" }[];
  derived: { id: string; title: string | null; relation: string; createdBy: string; direction: "out" | "in" }[];
}
export function showTask(dataDir: string, id: string, dbIn?: Database): TaskDetail {
  const db = dbIn ?? openDb(dataDir);
  try {
    const doc = readDocFile(dataDir, id);
    if (!doc || doc.frontmatter.source !== "task" || !doc.frontmatter.task) throw new Error(`task ${id} not found`);
    const t = doc.frontmatter.task;
    const rows = db.query("SELECT e.src, e.dst, e.relation, e.created_by, COALESCE(d.title, en.name) AS title FROM edges e LEFT JOIN documents d ON d.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END LEFT JOIN entities en ON en.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END WHERE e.src = ?1 OR e.dst = ?1").all(id) as { src: string; dst: string; relation: string; created_by: string; title: string | null }[];
    const map = (r: (typeof rows)[number]) => ({ id: r.src === id ? r.dst : r.src, title: r.title, relation: r.relation, createdBy: r.created_by, direction: (r.src === id ? "out" : "in") as "out" | "in" });
    return {
      task: toItem(dataDir, doc, rows.filter((r) => r.created_by === "manual" || r.created_by === "llm").length),
      body: doc.body,
      linked: rows.filter((r) => r.created_by === "manual" || r.created_by === "llm").map(map),
      derived: rows.filter((r) => ["backlink", "auto", "entity", "embedding"].includes(r.created_by)).map(map),
    };
  } finally {
    if (!dbIn) db.close();
  }
}

/** Rewrites only the task block and updated_*; re-indexes the row without re-chunking. */
export function setTaskStatus(dataDir: string, id: string, status: "open" | "done", author?: string, dbIn?: Database): TaskItem & { initiativeCompleted?: { id: string; title: string; done: number; total: number } } {
  const db = dbIn ?? openDb(dataDir);
  try {
    const doc = readDocFile(dataDir, id);
    if (!doc || doc.frontmatter.source !== "task" || !doc.frontmatter.task) throw new Error(`task ${id} not found`);
    const who = resolveAuthor(author);
    const now = nowIso();
    const t = doc.frontmatter.task;
    if (status === "done") {
      t.status = "done";
      t.completed_at = now;
      t.completed_by = who;
    } else {
      t.status = "open";
      delete t.completed_at;
      delete t.completed_by;
    }
    doc.frontmatter.updated_at = now;
    doc.frontmatter.updated_by = who;
    const { hash } = writeDocFile(dataDir, doc);
    const row = getDocRow(db, id);
    upsertDocRow(db, doc, { fileHash: hash });
    if (row) db.run("UPDATE documents SET edged_at = ? WHERE id = ?", [row.edged_at, id]); // status change needs no re-edging
    const item = toItem(dataDir, doc, readSidecar(dataDir, id).filter((l) => l.kind === "edge").length);
    if (status !== "done" || !item.initiative) return item;
    const mates = listTasks(dataDir, { status: "all", initiative: item.initiative.id, db });
    const done = mates.filter((m) => m.status === "done").length;
    return done === mates.length ? { ...item, initiativeCompleted: { ...item.initiative, done, total: mates.length } } : item;
  } finally {
    if (!dbIn) db.close();
  }
}

export interface Suggestion {
  id: string;
  title: string;
  source: string;
  reason: string;
}
/** Candidates: derived neighbours → hybrid search over the first 300 chars → FTS OR-query over unique terms ≥ 4 chars. */
export async function suggestLinks(dataDir: string, id: string, opts: { limit?: number; db?: Database } = {}): Promise<Suggestion[]> {
  const db = opts.db ?? openDb(dataDir);
  try {
    const doc = readDocFile(dataDir, id);
    if (!doc || doc.frontmatter.source !== "task") throw new Error(`task ${id} not found`);
    const limit = opts.limit ?? TASK_SUGGEST_LIMIT;
    const linked = new Set(readSidecar(dataDir, id).filter((l) => l.kind === "edge").map((l) => l.dst));
    const tasks = new Set((db.query("SELECT id FROM documents WHERE source = 'task'").all() as { id: string }[]).map((r) => r.id));
    const out: Suggestion[] = [];
    const seen = new Set<string>([id]);
    const push = (cand: { id: string; title: string; source: string }, reason: string) => {
      if (seen.has(cand.id) || linked.has(cand.id) || tasks.has(cand.id) || out.length >= limit) return;
      seen.add(cand.id);
      out.push({ id: cand.id, title: cand.title, source: cand.source, reason });
    };
    const derived = db.query("SELECT e.src, e.dst, e.relation, e.created_by, d.title, d.source FROM edges e JOIN documents d ON d.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END WHERE (e.src = ?1 OR e.dst = ?1) AND e.created_by IN ('backlink','auto','entity','embedding') ORDER BY e.weight DESC").all(id) as { src: string; dst: string; relation: string; created_by: string; title: string; source: string }[];
    for (const e of derived) push({ id: e.src === id ? e.dst : e.src, title: e.title, source: e.source }, `${e.created_by} edge (${e.relation})`);
    if (out.length < limit) {
      const q = `${doc.frontmatter.title}\n${doc.body}`.slice(0, TASK_SUGGEST_QUERY_CHARS);
      for (const h of await search(dataDir, q, { limit: limit * 2, db })) push({ id: h.docId, title: h.title, source: h.source }, "search match");
    }
    if (out.length < limit) {
      const terms = [...new Set(`${doc.frontmatter.title} ${doc.body}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length >= TASK_SUGGEST_MIN_TERM).slice(0, 20);
      if (terms.length) {
        const match = terms.map((t) => ftsQuery(t)).join(" OR ");
        const rows = db.query("SELECT d.id, d.title, d.source FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?").all(match, limit * 3) as { id: string; title: string; source: string }[];
        for (const r of rows) push(r, "keyword match");
      }
    }
    return out;
  } finally {
    if (!opts.db) db.close();
  }
}
