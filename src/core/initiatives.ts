import type { Database } from "bun:sqlite";
import { isConsumer, resolveAuthor } from "./config.ts";
import { INITIATIVE_SECTION_LIMIT, INITIATIVE_SUGGEST_LIMIT, INITIATIVE_SUGGEST_MAX_TOKENS, REFINE_BLURB_CHARS } from "./constants.ts";
import { openDb } from "./db.ts";
import { getDocRow, readDocFile, rebuildChunks, upsertDocRow, writeDocFile } from "./docs.ts";
import { embedPending, EmbeddingUnavailableError } from "./embed.ts";
import type { Doc } from "./frontmatter.ts";
import { requireInitiative, requireOpenInitiative } from "./initiativeRef.ts";
import { ingest } from "./ingest.ts";
import { initiativeSuggestPrompt } from "./prompts.ts";
import { search } from "./search.ts";
import { listTasks, type Suggestion, type TaskItem } from "./tasks.ts";
import { nowIso } from "./util.ts";
import type { Router } from "../providers/router.ts";
import { parseJsonObject } from "../providers/types.ts";

export interface InitiativeSummary {
  id: string;
  title: string;
  owner: string;
  status: "open" | "closed";
  done: number;
  total: number;
  created_at: string;
  closed_at?: string;
  closed_by?: string;
}
/** A capture tied to an initiative; `via` names the tasks it came through. */
export interface TiedItem {
  id: string;
  title: string;
  source: string | null;
  /** Who added it; null for an entity or a capture missing from the index. */
  author: string | null;
  created_at: string;
  via: string[];
}
export interface TiedSection {
  total: number;
  items: TiedItem[];
}
export interface InitiativeDetail {
  initiative: InitiativeSummary & { goal: string };
  tasks: TaskItem[];
  through: TiedSection;
  direct: TiedSection;
}

const MISSING_GOAL = 'An initiative needs a goal. Say what done looks like:\n  jarvis initiative add "<title>" --goal "<what done looks like>"';

/** Writes an edited initiative/task doc back to the file and the index; re-chunks only when the body changed. */
async function rewrite(dataDir: string, db: Database, doc: Doc, bodyChanged: boolean): Promise<void> {
  const { hash } = writeDocFile(dataDir, doc);
  const row = getDocRow(db, doc.frontmatter.id);
  upsertDocRow(db, doc, { fileHash: hash });
  if (row) db.run("UPDATE documents SET edged_at = ? WHERE id = ?", [row.edged_at, doc.frontmatter.id]);
  if (!bodyChanged) return;
  rebuildChunks(db, doc.frontmatter.id, doc.body);
  if (isConsumer(dataDir)) return;
  try {
    await embedPending(db);
  } catch (e) {
    if (!(e instanceof EmbeddingUnavailableError)) throw e;
  }
}

function summarize(dataDir: string, doc: Doc, tasks: TaskItem[]): InitiativeSummary {
  const b = doc.frontmatter.initiative!;
  const mine = tasks.filter((t) => t.initiative?.id === doc.frontmatter.id);
  return { id: doc.frontmatter.id, title: doc.frontmatter.title, owner: b.owner, status: b.status, done: mine.filter((t) => t.status === "done").length, total: mine.length, created_at: doc.frontmatter.created_at, closed_at: b.closed_at, closed_by: b.closed_by };
}

/** Creates an initiative: a doc with source "initiative" whose body is the goal. */
export async function addInitiative(dataDir: string, opts: { title: string; goal: string; owner?: string; author?: string; db?: Database }): Promise<{ id: string; title: string; owner: string }> {
  if (!opts.title?.trim()) throw new Error('usage: jarvis initiative add "<title>" --goal "<what done looks like>"');
  if (!opts.goal?.trim()) throw new Error(MISSING_GOAL);
  const author = resolveAuthor(opts.author);
  const owner = opts.owner ?? author;
  const r = await ingest(dataDir, { source: "initiative", title: opts.title.trim(), body: opts.goal.trim(), author }, { db: opts.db });
  const db = opts.db ?? openDb(dataDir);
  try {
    const doc = readDocFile(dataDir, r.id)!;
    doc.frontmatter.initiative = { status: "open", owner };
    await rewrite(dataDir, db, doc, false);
  } finally {
    if (!opts.db) db.close();
  }
  return { id: r.id, title: opts.title.trim(), owner };
}

/** Changes title, goal and/or owner; `changes` is the summary in the order title, owner, goal. */
export async function editInitiative(dataDir: string, id: string, opts: { title?: string; goal?: string; owner?: string; author?: string }): Promise<{ title: string; changes: string[] }> {
  if (opts.title === undefined && opts.goal === undefined && opts.owner === undefined) throw new Error("usage: jarvis initiative edit <id> [--title] [--goal] [--owner]");
  if (opts.goal !== undefined && !opts.goal.trim()) throw new Error(MISSING_GOAL);
  if (opts.title !== undefined && !opts.title.trim()) throw new Error("an initiative needs a title");
  if (opts.owner !== undefined && !opts.owner.trim()) throw new Error("an initiative needs an owner");
  const { doc, block } = requireInitiative(dataDir, id);
  const changes: string[] = [];
  let bodyChanged = false;
  if (opts.title !== undefined && opts.title.trim() !== doc.frontmatter.title) {
    doc.frontmatter.title = opts.title.trim();
    changes.push("title changed");
  }
  if (opts.owner !== undefined && opts.owner.trim() !== block.owner) {
    changes.push(`owner ${block.owner} → ${opts.owner.trim()}`);
    block.owner = opts.owner.trim();
  }
  if (opts.goal !== undefined && opts.goal.trim() !== doc.body.trim()) {
    doc.body = opts.goal.trim();
    bodyChanged = true;
    changes.push("goal changed");
  }
  if (changes.length) {
    doc.frontmatter.updated_at = nowIso();
    doc.frontmatter.updated_by = resolveAuthor(opts.author);
    const db = openDb(dataDir);
    try {
      await rewrite(dataDir, db, doc, bodyChanged);
    } finally {
      db.close();
    }
  }
  return { title: doc.frontmatter.title, changes };
}

/** Initiatives with progress worked out from their tasks. Open: newest first; closed: most recently closed first. */
export function listInitiatives(dataDir: string, opts: { status?: "open" | "closed" | "all"; db?: Database } = {}): InitiativeSummary[] {
  const db = opts.db ?? openDb(dataDir);
  try {
    const ids = (db.query("SELECT id FROM documents WHERE source = 'initiative'").all() as { id: string }[]).map((r) => r.id);
    const tasks = listTasks(dataDir, { status: "all", owner: "all", db });
    const want = opts.status ?? "open";
    const out: InitiativeSummary[] = [];
    for (const id of ids) {
      const doc = readDocFile(dataDir, id);
      if (!doc?.frontmatter.initiative) continue;
      const s = summarize(dataDir, doc, tasks);
      if (want === "all" || s.status === want) out.push(s);
    }
    const key = (s: InitiativeSummary) => (s.status === "closed" ? s.closed_at ?? "" : s.created_at);
    return out.sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) || key(b).localeCompare(key(a)));
  } finally {
    if (!opts.db) db.close();
  }
}

type EdgeRow = { src: string; dst: string; title: string | null; source: string | null; author: string | null; created_at: string | null };
function section(items: TiedItem[], all: boolean): TiedSection {
  const sorted = [...items].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  return { total: sorted.length, items: all ? sorted : sorted.slice(0, INITIATIVE_SECTION_LIMIT) };
}

/** The initiative, its tasks and everything tied to it by manual/LLM links, through its tasks and directly. */
export async function showInitiative(dataDir: string, id: string, opts: { all?: boolean; db?: Database } = {}): Promise<InitiativeDetail> {
  return readInitiative(dataDir, id, opts);
}

/** {@link showInitiative} without the promise, for callers that cannot wait (the chat prompt builder). */
export function readInitiative(dataDir: string, id: string, opts: { all?: boolean; db?: Database } = {}): InitiativeDetail {
  const { doc } = requireInitiative(dataDir, id);
  const db = opts.db ?? openDb(dataDir);
  try {
    const tasks = listTasks(dataDir, { status: "all", owner: "all", db });
    const mine = tasks.filter((t) => t.initiative?.id === id);
    const mineIds = new Set(mine.map((t) => t.id));
    const titleOf = new Map(mine.map((t) => [t.id, t.title]));
    const edgesOf = (node: string, viaTask: boolean): EdgeRow[] =>
      db.query(`SELECT e.src, e.dst, COALESCE(d.title, en.name) AS title, d.source AS source, d.author AS author, d.created_at AS created_at FROM edges e LEFT JOIN documents d ON d.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END LEFT JOIN entities en ON en.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END WHERE (e.src = ?1 OR e.dst = ?1) AND e.created_by IN (${viaTask ? "'manual','llm'" : "'manual'"})`).all(node) as EdgeRow[];
    const collect = (nodes: string[], viaTask: boolean): TiedItem[] => {
      const byId = new Map<string, TiedItem>();
      for (const n of nodes)
        for (const e of edgesOf(n, viaTask)) {
          const other = e.src === n ? e.dst : e.src;
          if (other === id || mineIds.has(other)) continue;
          const item = byId.get(other) ?? { id: other, title: e.title ?? other, source: e.source, author: e.author, created_at: e.created_at ?? "", via: [] };
          if (viaTask && !item.via.includes(titleOf.get(n)!)) item.via.push(titleOf.get(n)!);
          byId.set(other, item);
        }
      return [...byId.values()];
    };
    const all = !!opts.all;
    return { initiative: { ...summarize(dataDir, doc, tasks), goal: doc.body.trim() }, tasks: mine, through: section(collect([...mineIds], true), all), direct: section(collect([id], false), all) };
  } finally {
    if (!opts.db) db.close();
  }
}

/** Closes by hand; refuses while tasks are open unless `anyway` (open tasks stay open and stay in it). */
export async function closeInitiative(dataDir: string, id: string, opts: { anyway?: boolean; author?: string } = {}): Promise<{ title: string; done: number; total: number; left: number }> {
  const { doc, block } = requireInitiative(dataDir, id);
  if (block.status === "closed") throw new Error(`${doc.frontmatter.title} is already closed. Reopen it with:\n  jarvis initiative reopen ${id}`);
  const db = openDb(dataDir);
  try {
    const s = summarize(dataDir, doc, listTasks(dataDir, { status: "all", owner: "all", db }));
    const left = s.total - s.done;
    if (left > 0 && !opts.anyway) throw new Error(`${s.title} still has ${left} open ${left === 1 ? "task" : "tasks"}.\nFinish or move them first, or close it anyway:\n  jarvis initiative close ${id} --anyway`);
    const who = resolveAuthor(opts.author);
    block.status = "closed";
    block.closed_at = nowIso();
    block.closed_by = who;
    doc.frontmatter.updated_at = block.closed_at;
    doc.frontmatter.updated_by = who;
    await rewrite(dataDir, db, doc, false);
    return { title: s.title, done: s.done, total: s.total, left };
  } finally {
    db.close();
  }
}

/** Reopens a closed initiative. */
export async function reopenInitiative(dataDir: string, id: string, author?: string): Promise<{ title: string }> {
  const { doc, block } = requireInitiative(dataDir, id);
  if (block.status === "open") return { title: doc.frontmatter.title };
  block.status = "open";
  delete block.closed_at;
  delete block.closed_by;
  doc.frontmatter.updated_at = nowIso();
  doc.frontmatter.updated_by = resolveAuthor(author);
  const db = openDb(dataDir);
  try {
    await rewrite(dataDir, db, doc, false);
  } finally {
    db.close();
  }
  return { title: doc.frontmatter.title };
}

export interface MoveResult {
  status: "moved" | "unchanged";
  title: string;
  from?: string;
  to?: string;
}
/** Puts a task in an initiative, moves it between initiatives, or (`null`) takes it out. Titles, not ids, in the result. */
export async function moveTask(dataDir: string, taskId: string, initiativeId: string | null, author?: string): Promise<MoveResult> {
  const doc = readDocFile(dataDir, taskId);
  if (!doc || doc.frontmatter.source !== "task" || !doc.frontmatter.task) throw new Error(`task ${taskId} not found`);
  const task = doc.frontmatter.task;
  const target = initiativeId ? requireOpenInitiative(dataDir, initiativeId).doc.frontmatter.title : undefined;
  const from = task.initiative ? readDocFile(dataDir, task.initiative)?.frontmatter.title ?? task.initiative : undefined;
  const title = doc.frontmatter.title;
  if (!task.initiative && initiativeId === null) return { status: "unchanged", title };
  if ((task.initiative ?? null) === initiativeId) return { status: "unchanged", title, to: target ?? from };
  if (initiativeId) task.initiative = initiativeId;
  else delete task.initiative;
  doc.frontmatter.updated_at = nowIso();
  doc.frontmatter.updated_by = resolveAuthor(author);
  const db = openDb(dataDir);
  try {
    await rewrite(dataDir, db, doc, false);
  } finally {
    db.close();
  }
  return { status: "moved", title, from, to: target };
}

/** A capture the model thinks belongs, with who added it so an accepted one reads like any linked row. */
export type InitiativeSuggestion = Suggestion & { author: string };

/** Model-judged captures that seem to belong. Without a model: `{model:false}`, never an error. */
export async function initiativeSuggestions(dataDir: string, id: string, opts: { router: Router | null; limit?: number; db?: Database }): Promise<{ model: boolean; suggestions: InitiativeSuggestion[] }> {
  const { doc } = requireInitiative(dataDir, id);
  const model = opts.router?.resolve({ kind: "edge-judge", minQuality: "standard" }) ?? null;
  if (!model) return { model: false, suggestions: [] };
  const db = opts.db ?? openDb(dataDir);
  try {
    const detail = await showInitiative(dataDir, id, { all: true, db });
    const tied = new Set([id, ...detail.tasks.map((t) => t.id), ...detail.through.items.map((i) => i.id), ...detail.direct.items.map((i) => i.id)]);
    const query = `${doc.frontmatter.title}\n${doc.body}\n${detail.tasks.map((t) => t.title).join("\n")}`.slice(0, 600);
    const limit = opts.limit ?? INITIATIVE_SUGGEST_LIMIT;
    const hits = await search(dataDir, query, { limit: limit * 4, db });
    const cands = new Map<string, { id: string; title: string; source: string; author: string; blurb: string }>();
    for (const h of hits) {
      if (tied.has(h.docId) || cands.has(h.docId) || h.source === "task" || h.source === "initiative") continue;
      const row = getDocRow(db, h.docId);
      if (!row) continue;
      cands.set(h.docId, { id: h.docId, title: h.title, source: h.source, author: row.author, blurb: (row.summary ?? row.body.slice(0, REFINE_BLURB_CHARS)).replace(/\s+/g, " ") });
    }
    if (cands.size === 0) return { model: true, suggestions: [] };
    let results: { id: string; keep: boolean; reason: string }[];
    try {
      const out = await model.complete(initiativeSuggestPrompt(doc.frontmatter.title, doc.body.trim(), detail.tasks.map((t) => t.title), [...cands.values()]), { json: true, maxTokens: INITIATIVE_SUGGEST_MAX_TOKENS });
      const j = parseJsonObject(out) as { results?: unknown };
      if (!Array.isArray(j.results)) throw new Error("no results array");
      results = (j.results as Record<string, unknown>[]).filter((r) => r && typeof r.id === "string").map((r) => ({ id: r.id as string, keep: !!r.keep, reason: typeof r.reason === "string" ? r.reason : "" }));
    } catch {
      return { model: true, suggestions: [] };
    }
    const out: InitiativeSuggestion[] = [];
    for (const r of results) {
      const c = cands.get(r.id);
      if (!c || !r.keep || out.some((s) => s.id === c.id) || out.length >= limit) continue;
      out.push({ id: c.id, title: c.title, source: c.source, author: c.author, reason: r.reason || "seems related" });
    }
    return { model: true, suggestions: out };
  } finally {
    if (!opts.db) db.close();
  }
}
