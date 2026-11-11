import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { isConsumer, loadTeamConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { listDocFiles } from "./docs.ts";
import { parseDoc } from "./frontmatter.ts";
import { git, gitOk, hasIdentity, hasRemote, isWorkTree, unresolvedConflicts } from "./git.ts";
import { reindex, type ReindexResult } from "./reindex.ts";
import { getRouter } from "../providers/index.ts";

export interface Collision {
  source_url: string;
  ids: string[];
}

/** Scan files (not the index) for more than one doc sharing a source_url. */
export function dedupScan(dataDir: string): Collision[] {
  const byUrl = new Map<string, string[]>();
  for (const f of listDocFiles(dataDir)) {
    try {
      const doc = parseDoc(readFileSync(join(dataDir, "docs", f), "utf8"));
      const u = doc.frontmatter.source_url;
      if (!u) continue;
      byUrl.set(u, [...(byUrl.get(u) ?? []), doc.frontmatter.id]);
    } catch {}
  }
  return [...byUrl.entries()].filter(([, ids]) => ids.length > 1).map(([source_url, ids]) => ({ source_url, ids: ids.sort() }));
}

/** A model step that ran and failed for some of its work: which step, how many units, and the first reason. */
export interface StepFailure {
  step: string;
  failed: number;
  reason: string;
  /** True when `jarvis doctor` has a fix for this reason (a refused model id, an unreachable provider). */
  doctor: boolean;
}

/** Reasons `jarvis doctor` checks and prints a fix for: copilot-model (a refused id) and models-available (unreachable). */
const DOCTOR_FIXABLE = /is not available|ECONNREFUSED|Unable to connect|Executable not found/i;

/** Build a {@link StepFailure}, marking whether doctor has its fix. */
export function stepFailure(step: string, failed: number, reason: string): StepFailure {
  return { step, failed, reason, doctor: DOCTOR_FIXABLE.test(reason) };
}

/** Pluggable authoring passes (enrich, edges, refine) registered by later modules. */
export interface ProcessContext {
  dataDir: string;
  db: Database;
  consumer: boolean;
  router?: unknown;
  counts: Record<string, unknown>;
  notes: string[];
  failures: StepFailure[];
}
export type ProcessPass = { name: string; needsRouter?: boolean; authoring?: boolean; run: (ctx: ProcessContext) => Promise<{ changedFiles?: boolean } | void> };
const passes: ProcessPass[] = [];
export function registerProcessPass(p: ProcessPass): void {
  const i = passes.findIndex((x) => x.name === p.name);
  if (i >= 0) passes[i] = p;
  else passes.push(p);
}
export function registeredPasses(): string[] {
  return passes.map((p) => p.name);
}

export interface ProcessResult {
  reindexed: ReindexResult;
  reindexedAgain?: ReindexResult;
  collisions: Collision[];
  counts: Record<string, unknown>;
  notes: string[];
  failures: StepFailure[];
  enrichedFiles: boolean;
}

/** reindex → (enrich → reindex) → edges → refine → dedup scan. Also `jarvis process`. */
export async function processContent(dataDir: string, opts: { router?: unknown; db?: Database } = {}): Promise<ProcessResult> {
  const db = opts.db ?? openDb(dataDir);
  const consumer = isConsumer(dataDir);
  const router = opts.router === undefined && !consumer ? await getRouter() : opts.router;
  const ctx: ProcessContext = { dataDir, db, consumer, router: router ?? undefined, counts: {}, notes: [], failures: [] };
  try {
    const reindexed = await reindex(dataDir, { db });
    if (reindexed.embedError) ctx.notes.push(reindexed.embedError);
    let enrichedFiles = false;
    let reindexedAgain: ReindexResult | undefined;
    for (const p of passes) {
      if (p.needsRouter && !ctx.router) continue;
      if (p.authoring && consumer) continue;
      const r = await p.run(ctx);
      if (r?.changedFiles) {
        enrichedFiles = true;
        reindexedAgain = await reindex(dataDir, { db });
      }
    }
    const collisions = dedupScan(dataDir);
    return { reindexed, reindexedAgain, collisions, counts: ctx.counts, notes: ctx.notes, failures: ctx.failures, enrichedFiles };
  } finally {
    if (!opts.db) db.close();
  }
}

export interface SyncResult {
  remote: boolean;
  committed: number;
  committedEnriched: number;
  pulled: boolean;
  pushed: boolean;
  conflicted: string[];
  reindexed?: { docsIndexed: number; chunksEmbedded: number };
  collisions: Collision[];
  notes: string[];
  /** Model steps that failed; the sync still committed, pulled and pushed around them. */
  failures: StepFailure[];
  counts: Record<string, unknown>;
}

export const AUTHORED_DIRS = ["docs", "edges", "entities", "briefings", "presentations"];
export const AUTHORED_FILES = ["filters.json", "config/team.toml", "config/confluence.json", ".gitattributes", ".gitignore"];

export function authoredPathspec(dataDir: string): string[] {
  return [...AUTHORED_DIRS, ...AUTHORED_FILES].filter((p) => existsSync(join(dataDir, p)));
}

function ensureLine(path: string, line: string): void {
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split(/\r?\n/).some((l) => l.trim() === line)) return;
  appendFileSync(path, (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
}
export function ensureRepoHygiene(dataDir: string): void {
  ensureLine(join(dataDir, ".gitignore"), ".index/");
  ensureLine(join(dataDir, ".gitattributes"), "edges/*.jsonl merge=union");
}

function commitAuthored(dataDir: string, message: (n: number) => string): number {
  const spec = authoredPathspec(dataDir);
  if (spec.length === 0) return 0;
  gitOk(dataDir, ["add", "-A", "--", ...spec]);
  const staged = git(dataDir, ["diff", "--cached", "--name-only"]).stdout.split("\n").filter(Boolean);
  if (staged.length === 0) return 0;
  if (!hasIdentity(dataDir)) throw new Error('git identity missing: run `git config user.name "…"` and `git config user.email "…"` in the content repo');
  const items = staged.filter((f) => AUTHORED_DIRS.some((d) => f.startsWith(d + "/"))).length;
  gitOk(dataDir, ["commit", "-q", "-m", message(items)]);
  return items;
}

let syncRunning = false;
export function isSyncRunning(): boolean {
  return syncRunning;
}

export async function sync(dataDir: string, opts: { push?: boolean; router?: unknown } = {}): Promise<SyncResult> {
  if (syncRunning) throw new SyncBusyError();
  syncRunning = true;
  try {
    return await syncInner(dataDir, opts);
  } finally {
    syncRunning = false;
  }
}
export class SyncBusyError extends Error {
  constructor() {
    super("a sync is already running");
  }
}

async function syncInner(dataDir: string, opts: { push?: boolean; router?: unknown }): Promise<SyncResult> {
  if (!isWorkTree(dataDir)) throw new Error(`${dataDir} is not a git work tree`);
  const remote = hasRemote(dataDir);
  const res: SyncResult = { remote, committed: 0, committedEnriched: 0, pulled: false, pushed: false, conflicted: [], collisions: [], notes: [], failures: [], counts: {} };
  ensureRepoHygiene(dataDir);

  const conflicts = unresolvedConflicts(dataDir);
  if (conflicts.length) {
    res.conflicted = conflicts;
    res.notes.push("unresolved merge conflicts; resolve them and run sync again");
    return res;
  }
  res.committed = commitAuthored(dataDir, (n) => `jarvis: capture ${n} item(s)`);

  let pullOk = !remote;
  if (remote) {
    const pull = git(dataDir, ["pull", "--no-rebase", "-q"]);
    if (pull.code === 0) {
      res.pulled = true;
      pullOk = true;
    } else {
      const c = unresolvedConflicts(dataDir);
      if (c.length) {
        res.conflicted = c;
        res.notes.push("merge conflict: resolve the listed files, commit, then sync again");
        return res;
      }
      res.notes.push(`pull failed (${pull.stderr || pull.stdout}); continuing local-only`);
    }
  }

  const p = await processContent(dataDir, { router: opts.router });
  res.reindexed = { docsIndexed: p.reindexed.docsIndexed, chunksEmbedded: p.reindexed.chunksEmbedded + (p.reindexedAgain?.chunksEmbedded ?? 0) };
  res.collisions = p.collisions;
  res.counts = p.counts;
  res.notes.push(...p.notes);
  res.failures = p.failures;
  if (p.collisions.length) res.notes.push(`${p.collisions.length} source_url collision(s): run \`jarvis dedup\``);

  if (!isConsumer(dataDir)) res.committedEnriched = commitAuthored(dataDir, (n) => `jarvis: enrich ${n} item(s)`);
  if (loadTeamConfig(dataDir).projection.mode === "published") res.notes.push("published projection mode: snapshot publish/download is not implemented yet");

  if (opts.push !== false && remote && pullOk) {
    let push = git(dataDir, ["push", "-q"]);
    if (push.code !== 0 && /non-fast-forward|fetch first|rejected/i.test(push.stderr)) {
      const pull = git(dataDir, ["pull", "--no-rebase", "-q"]);
      if (pull.code === 0) {
        await reindex(dataDir);
        push = git(dataDir, ["push", "-q"]);
      }
    }
    if (push.code === 0) res.pushed = true;
    else res.notes.push(`push failed: ${push.stderr || push.stdout}`);
  }
  return res;
}
