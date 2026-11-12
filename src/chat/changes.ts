/**
 * The change log of a chat conversation: every change the agent made, in order, each undoable.
 * Machine-local state (`.index/chat/<conversation>.json`, never committed); the changes themselves
 * are ordinary files in the content repo, so they survive `jarvis reindex --full` and `jarvis sync`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import type { TaskBlock } from "../core/frontmatter.ts";
import { openDb } from "../core/db.ts";
import { readDocFile } from "../core/docs.ts";
import { unlink } from "../core/links.ts";
import { requireInitiative } from "../core/initiativeRef.ts";
import { editInitiative } from "../core/initiatives.ts";
import { reindex } from "../core/reindex.ts";
import { readSidecar } from "../core/sidecar.ts";
import { restoreTaskBlock } from "../core/tasks.ts";
import { sha256 } from "../core/util.ts";
import type { Relation } from "../core/constants.ts";
import type { ChangeAsk } from "./choice.ts";

export type ChangeKind =
  | "capture.note" | "capture.link" | "capture.file" | "capture.meeting"
  | "task.create" | "task.done" | "task.reopen" | "task.due" | "task.owner" | "task.move"
  | "initiative.create" | "initiative.title" | "initiative.goal" | "initiative.owner" | "link" | "draft.briefing" | "draft.presentation";

/** An item a change row names; `kind` decides where its title links to. */
export interface ChangeItem { id: string; title: string; kind: "doc" | "task" | "initiative" | "briefing" | "presentation" }

/** One row of the change card, as the web UI receives it. */
export interface Change {
  id: string;
  /** The answer (one prompt) the change was made in. */
  turn: string;
  kind: ChangeKind;
  ok: boolean;
  items: ChangeItem[];
  detail?: { from?: string; to?: string; relation?: string };
  /** Preview data of a drafted briefing or presentation. */
  draft?: { kind: "briefing" | "presentation"; sections: string[]; sources: number };
  /** Why a change failed, as a sentence fragment ("the meeting note was not found"). */
  error?: string;
  /** For a failed row: the verb after "Couldn't" ("link", "create task"). */
  verb?: string;
  /** For a row that waits: what the user is asked to choose between (jv-bt4). It is not a failure. */
  ask?: ChangeAsk;
  undone: boolean;
  undoable: boolean;
}

/** What to reverse; each op is verified against the current files before anything is touched. */
export type Op =
  | { op: "created"; files: string[]; docs: { id: string; fp: string }[]; raw: Record<string, string> }
  | { op: "task"; id: string; before: TaskBlock; after: TaskBlock }
  | { op: "initiative"; id: string; field: "title" | "goal" | "owner"; before: string; after: string }
  | { op: "edge"; src: string; dst: string; relation: Relation };
interface Stored extends Change { ops: Op[] }

/** Undo was refused because the item changed after the agent changed it. */
export class UndoConflict extends Error {
  constructor(public title: string) {
    super(`Couldn't undo — ${title} was changed after the agent changed it.`);
  }
}

/** What a doc's author wrote: enrichment (summary, tags, mentions) is ignored so a sync does not block Undo. */
function fingerprint(dataDir: string, id: string): string | null {
  const d = readDocFile(dataDir, id);
  return d ? sha256(JSON.stringify([d.frontmatter.title, d.body, d.frontmatter.task ?? null, d.frontmatter.initiative ?? null])) : null;
}
/** The current value of one editable field of an initiative, or null when it is gone. */
function initiativeField(dataDir: string, id: string, field: "title" | "goal" | "owner"): string | null {
  try {
    const { doc, block } = requireInitiative(dataDir, id);
    return field === "title" ? doc.frontmatter.title : field === "goal" ? doc.body.trim() : block.owner;
  } catch {
    return null;
  }
}
const rawHash = (dataDir: string, rel: string): string | null => (existsSync(join(dataDir, rel)) ? sha256(readFileSync(join(dataDir, rel))) : null);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The `created` op for files a tool just wrote (directories are expanded); null when none of them exist. */
export function createdOp(dataDir: string, paths: string[]): Op | null {
  const files: string[] = [];
  const walk = (rel: string) => {
    const abs = join(dataDir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const e of readdirSync(abs)) walk(`${rel}/${e}`);
    else files.push(rel);
  };
  for (const p of paths) walk(p);
  if (!files.length) return null;
  const docs = files.filter((f) => /^docs\/[^/]+\.md$/.test(f)).map((f) => f.slice(5, -3)).map((id) => ({ id, fp: fingerprint(dataDir, id) ?? "" }));
  const raw: Record<string, string> = {};
  for (const f of files) if (!f.startsWith("docs/") && !f.startsWith("edges/")) raw[f] = rawHash(dataDir, f) ?? "";
  return { op: "created", files, docs, raw };
}

/** The change log of one conversation. */
export class ChangeLog {
  private path: string;
  constructor(private dataDir: string, readonly conversationId: string) {
    if (!/^[\w-]{1,64}$/.test(conversationId)) throw new Error("invalid conversation id");
    this.path = join(dataDir, ".index", "chat", `${conversationId}.json`);
  }
  private load(): Stored[] {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Stored[];
    } catch {
      return [];
    }
  }
  private save(all: Stored[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(all));
  }
  /** The changes in the order they were made. */
  list(): Change[] {
    return this.load().map(({ ops: _ops, ...c }) => c);
  }
  /** Record a change (`ops` empty or `undoable: false` when it cannot be reversed). */
  record(c: Omit<Change, "id" | "undone" | "undoable"> & { undoable?: boolean }, ops: Op[]): Change {
    const all = this.load();
    const s: Stored = { ...c, id: ulid(), undone: false, undoable: c.ok && c.undoable !== false && ops.length > 0, ops };
    all.push(s);
    this.save(all);
    const { ops: _ops, ...out } = s;
    return out;
  }
  /** Undo one change, and settle as undone any row it took with it; throws UndoConflict (nothing touched) when the item changed since. */
  async undo(id: string): Promise<Change> {
    const all = this.load();
    const s = all.find((c) => c.id === id);
    if (!s) throw new Error("change not found");
    if (!s.undoable || s.undone) return this.strip(s);
    const title = s.items[0]?.title ?? "the item";
    const pending = s.ops.filter((op) => !this.alreadyGone(op));
    for (const op of pending) if (!this.verify(op)) throw new UndoConflict(title);
    for (const op of [...pending].reverse()) await this.revert(op);
    const fresh = this.load(); // a change recorded while we were reverting must not be lost
    const mine = fresh.find((c) => c.id === id)!;
    mine.undone = true;
    // A row whose every op is a link to an item this undo removed (the links of a new task) went with it.
    const removed = new Set(s.ops.flatMap((op) => (op.op === "created" ? op.docs.map((x) => x.id) : [])));
    const tookWith = (op: Op) => op.op === "edge" && (removed.has(op.src) || removed.has(op.dst)) && this.alreadyGone(op);
    if (removed.size) for (const c of fresh) if (c.undoable && !c.undone && c.ops.every(tookWith)) c.undone = true;
    this.save(fresh);
    return this.strip(mine);
  }
  /** Undo every change not yet undone (of one answer when `turn` is given), newest first; stops at (and reports) the first conflict. */
  async undoAll(turn?: string): Promise<{ changes: Change[]; error?: string }> {
    for (const c of [...this.load()].reverse()) {
      if (!c.undoable || c.undone || (turn && c.turn !== turn)) continue;
      try {
        await this.undo(c.id);
      } catch (e) {
        if (e instanceof UndoConflict) return { changes: this.list(), error: e.message };
        throw e;
      }
    }
    return { changes: this.list() };
  }
  private strip(s: Stored): Change {
    const { ops: _ops, ...c } = s;
    return c;
  }
  /** An edge whose source or target was deleted (by undoing the change that created it) is already undone. */
  private alreadyGone(op: Op): boolean {
    return op.op === "edge" && !this.verify(op) && (!readDocFile(this.dataDir, op.src) || !readDocFile(this.dataDir, op.dst));
  }
  private verify(op: Op): boolean {
    const d = this.dataDir;
    if (op.op === "created") {
      for (const x of op.docs) if (fingerprint(d, x.id) !== x.fp) return false;
      for (const [f, h] of Object.entries(op.raw)) if (rawHash(d, f) !== h) return false;
      return true;
    }
    if (op.op === "task") return sameJson(readDocFile(d, op.id)?.frontmatter.task, op.after);
    if (op.op === "initiative") return initiativeField(d, op.id, op.field) === op.after;
    return readSidecar(d, op.src).some((l) => l.kind === "edge" && l.dst === op.dst && l.relation === op.relation && l.created_by === "manual");
  }
  private async revert(op: Op): Promise<void> {
    const d = this.dataDir;
    if (op.op === "task") return restoreTaskBlock(d, op.id, op.before);
    if (op.op === "initiative") {
      await editInitiative(d, op.id, { [op.field]: op.before });
      return;
    }
    if (op.op === "edge") {
      unlink(d, op.src, op.dst, op.relation);
      return;
    }
    for (const f of op.files) rmSync(join(d, f), { force: true });
    for (const f of op.files) {
      const dir = dirname(join(d, f));
      if (f.startsWith("presentations/")) try { rmdirSync(dir); } catch { /* not empty */ }
    }
    const db = openDb(d);
    try {
      for (const x of op.docs) {
        rmSync(join(d, "edges", `${x.id}.jsonl`), { force: true });
        db.run("DELETE FROM edges WHERE src = ?1 OR dst = ?1", [x.id]);
      }
      await reindex(d, { db, embed: false });
    } finally {
      db.close();
    }
  }
}
