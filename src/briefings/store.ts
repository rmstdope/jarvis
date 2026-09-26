import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { splitBriefing, serializeBriefing, type BriefingFrontmatter, type BriefingKind, type BriefingStatus } from "./frontmatter.ts";
import { parseBriefingBody, type Node } from "./parser.ts";
import { buildToc, type TocEntry } from "./toc.ts";
import { flattenText } from "./render.ts";
import { nowIso } from "../core/util.ts";

export interface BriefingSummary {
  id: string;
  title: string;
  subtitle?: string;
  createdAt: string;
  updatedAt: string;
  kind: BriefingKind;
  trail?: string;
  status?: BriefingStatus;
  tags?: string[];
  author?: string;
}
export interface Briefing extends BriefingSummary {
  frontmatter: BriefingFrontmatter;
  body: string;
  tree: Node[];
  toc: TocEntry[] | null;
  filePath: string;
}

export function briefingsDir(dataDir: string): string {
  return join(dataDir, "briefings");
}
export function briefingPath(dataDir: string, id: string): string {
  return join(briefingsDir(dataDir), `${id}.brief.mdx`);
}
export function commentsPath(dataDir: string, id: string): string {
  return join(briefingsDir(dataDir), `${id}.comments.json`);
}
export function briefingIds(dataDir: string): string[] {
  const d = briefingsDir(dataDir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".brief.mdx")).map((f) => f.slice(0, -".brief.mdx".length)).sort();
}

function toSummary(id: string, fm: BriefingFrontmatter, path: string): BriefingSummary {
  const st = statSync(path);
  return {
    id,
    title: fm.title || id,
    subtitle: fm.subtitle,
    createdAt: fm.created_at ?? fm.date ?? st.birthtime.toISOString(),
    updatedAt: fm.updated_at ?? fm.created_at ?? st.mtime.toISOString(),
    kind: (fm.kind as BriefingKind) ?? "briefing",
    trail: fm.trail,
    status: fm.status,
    tags: fm.tags,
    author: fm.author,
  };
}

/** Parsed on demand; no derived files on disk. */
export function readBriefing(dataDir: string, id: string): Briefing | null {
  const p = briefingPath(dataDir, id);
  if (!existsSync(p)) return null;
  const { frontmatter, body } = splitBriefing(readFileSync(p, "utf8"));
  const tree = parseBriefingBody(body);
  return { ...toSummary(id, frontmatter, p), frontmatter, body, tree, toc: buildToc(tree, frontmatter.toc), filePath: `briefings/${id}.brief.mdx` };
}
export function listBriefings(dataDir: string): BriefingSummary[] {
  const out: BriefingSummary[] = [];
  for (const id of briefingIds(dataDir)) {
    try {
      const p = briefingPath(dataDir, id);
      out.push(toSummary(id, splitBriefing(readFileSync(p, "utf8")).frontmatter, p));
    } catch {}
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
export function briefingIndexText(b: Briefing): string {
  return [b.title, b.subtitle ?? "", flattenText(b.tree)].filter(Boolean).join("\n");
}

export interface CreateBriefingOpts {
  title: string;
  kind?: BriefingKind;
  trail?: string;
  author?: string;
  subtitle?: string;
  body?: string;
  status?: BriefingStatus;
  source_doc?: string;
  tags?: string[];
  id?: string;
}
export function createBriefing(dataDir: string, opts: CreateBriefingOpts): Briefing {
  if (!opts.title) throw new Error("title is required");
  if (opts.kind === "lesson" && !opts.trail) throw new Error("a lesson needs --trail <trail briefing id>");
  const id = opts.id ?? ulid();
  const now = nowIso();
  const fm: BriefingFrontmatter = { title: opts.title, subtitle: opts.subtitle, kind: opts.kind ?? "briefing", status: opts.status, author: opts.author, created_at: now, updated_at: now, tags: opts.tags, trail: opts.trail, source_doc: opts.source_doc };
  const body = opts.body ?? `<Callout title="Summary">\n\nWrite a two-sentence summary here.\n\n</Callout>\n\n## Overview\n\n…\n`;
  parseBriefingBody(body); // validate before writing
  mkdirSync(briefingsDir(dataDir), { recursive: true });
  writeFileSync(briefingPath(dataDir, id), serializeBriefing(fm, body));
  return readBriefing(dataDir, id)!;
}
/** Rewrites only the status line (plus updated_at). */
export function approveBriefing(dataDir: string, id: string): Briefing {
  const p = briefingPath(dataDir, id);
  if (!existsSync(p)) throw new Error(`briefing ${id} not found`);
  const text = readFileSync(p, "utf8");
  const lines = text.split("\n");
  let end = -1;
  if (lines[0]?.trim() === "---") for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") { end = i; break; }
  if (end < 0) throw new Error("briefing has no frontmatter");
  let found = false;
  for (let i = 1; i < end; i++) {
    if (/^status:/.test(lines[i])) { lines[i] = "status: approved"; found = true; }
    if (/^updated_at:/.test(lines[i])) lines[i] = `updated_at: ${nowIso()}`;
  }
  if (!found) lines.splice(end, 0, "status: approved");
  writeFileSync(p, lines.join("\n"));
  return readBriefing(dataDir, id)!;
}

// ---- comments sidecar ----
export type CommentStatus = "open" | "handled" | "stale" | "done";
export interface CommentAnchor {
  treeHash: string;
  nodePath: number[];
  blockIndex: number;
  textStart: number;
  textEnd: number;
  prefix: string;
  suffix: string;
}
export interface Comment {
  id: string;
  briefingId: string;
  status: CommentStatus;
  author?: string;
  selectedText: string;
  contextText: string;
  comment: string;
  anchor: CommentAnchor;
  createdAt: string;
  updatedAt: string;
  handledAt?: string;
  handledBy?: "agent";
  agentNote?: string;
  doneAt?: string;
}
const TRANSITIONS: Record<CommentStatus, CommentStatus[]> = { open: ["handled", "stale"], handled: ["done"], stale: ["handled", "done"], done: [] };
export const EMPTY_ANCHOR: CommentAnchor = { treeHash: "", nodePath: [], blockIndex: 0, textStart: 0, textEnd: 0, prefix: "", suffix: "" };

export function readComments(dataDir: string, id: string): Comment[] {
  const p = commentsPath(dataDir, id);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeComments(dataDir: string, id: string, comments: Comment[]): void {
  mkdirSync(briefingsDir(dataDir), { recursive: true });
  writeFileSync(commentsPath(dataDir, id), JSON.stringify(comments, null, 2) + "\n");
}
export function addComment(dataDir: string, briefingId: string, input: { comment: string; author?: string; selectedText?: string; contextText?: string; anchor?: Partial<CommentAnchor> }): Comment {
  if (!existsSync(briefingPath(dataDir, briefingId))) throw new Error(`briefing ${briefingId} not found`);
  if (!input.comment || !input.comment.trim()) throw new Error("comment text is required");
  const now = nowIso();
  const c: Comment = { id: ulid(), briefingId, status: "open", author: input.author, selectedText: input.selectedText ?? "", contextText: input.contextText ?? "", comment: input.comment.trim(), anchor: { ...EMPTY_ANCHOR, ...(input.anchor ?? {}) }, createdAt: now, updatedAt: now };
  writeComments(dataDir, briefingId, [...readComments(dataDir, briefingId), c]);
  return c;
}
export function transitionComment(dataDir: string, briefingId: string, commentId: string, status: CommentStatus, extra: { agentNote?: string } = {}): Comment {
  const all = readComments(dataDir, briefingId);
  const c = all.find((x) => x.id === commentId);
  if (!c) throw new Error(`comment ${commentId} not found`);
  if (!TRANSITIONS[c.status].includes(status)) throw new Error(`cannot move comment from ${c.status} to ${status}`);
  const now = nowIso();
  c.status = status;
  c.updatedAt = now;
  if (status === "handled") { c.handledAt = now; c.handledBy = "agent"; if (extra.agentNote) c.agentNote = extra.agentNote; }
  if (status === "done") c.doneAt = now;
  writeComments(dataDir, briefingId, all);
  return c;
}
