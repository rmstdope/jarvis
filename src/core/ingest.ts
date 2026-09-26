import { ulid } from "ulid";
import type { Database } from "bun:sqlite";
import { isConsumer, resolveAuthor } from "./config.ts";
import type { Source } from "./constants.ts";
import { openDb } from "./db.ts";
import { getDocRowBySourceUrl, readDocFile, rebuildChunks, rowToFrontmatter, upsertDocRow, writeDocFile } from "./docs.ts";
import { embedPending, EmbeddingUnavailableError } from "./embed.ts";
import type { Doc, TaskBlock } from "./frontmatter.ts";
import { nowIso } from "./util.ts";

export interface CapturePayload {
  source: Source;
  title: string;
  body: string;
  author?: string;
  source_url?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  starred?: boolean;
  task?: TaskBlock;
}
export interface IngestResult {
  id: string;
  status: "captured" | "updated";
  title: string;
  chunks: number;
  embedded: number;
  embedError?: string;
}
export interface IngestOpts {
  embed?: boolean;
  db?: Database;
}

function sameTags(a?: string[], b?: string[]): boolean {
  const x = [...(a ?? [])].sort().join("\u0000");
  const y = [...(b ?? [])].sort().join("\u0000");
  return x === y;
}

/** The single capture entrypoint used by every producer. */
export async function ingest(dataDir: string, payload: CapturePayload, opts: IngestOpts = {}): Promise<IngestResult> {
  if (!payload.title || typeof payload.title !== "string") throw new Error("title is required");
  if (typeof payload.body !== "string") throw new Error("body is required");
  if (!payload.source) throw new Error("source is required");
  const author = resolveAuthor(payload.author);
  const db = opts.db ?? openDb(dataDir);
  try {
    let doc: Doc;
    let status: IngestResult["status"];
    const existing = payload.source_url ? getDocRowBySourceUrl(db, payload.source_url) : null;
    if (existing) {
      const prev = readDocFile(dataDir, existing.id) ?? { frontmatter: rowToFrontmatter(existing), body: existing.body };
      const fm = { ...prev.frontmatter };
      const mergedMeta = { ...(fm.metadata ?? {}), ...(payload.metadata ?? {}) };
      const changed =
        fm.source !== payload.source ||
        fm.title !== payload.title ||
        prev.body.replace(/\n$/, "") !== payload.body.replace(/\n$/, "") ||
        (payload.metadata?.source_author !== undefined && fm.metadata?.source_author !== payload.metadata.source_author) ||
        (payload.metadata?.context !== undefined && fm.metadata?.context !== payload.metadata.context) ||
        (payload.tags !== undefined && !sameTags(fm.tags, payload.tags)) ||
        (payload.starred !== undefined && !!fm.starred !== !!payload.starred);
      fm.source = payload.source;
      fm.title = payload.title;
      fm.metadata = Object.keys(mergedMeta).length ? mergedMeta : undefined;
      if (payload.tags !== undefined) fm.tags = payload.tags;
      if (payload.starred !== undefined) fm.starred = payload.starred;
      if (payload.task !== undefined) fm.task = payload.task;
      if (changed || (payload.task !== undefined && JSON.stringify(payload.task) !== JSON.stringify(prev.frontmatter.task))) {
        fm.updated_at = nowIso();
        fm.updated_by = author;
      }
      doc = { frontmatter: fm, body: payload.body };
      status = "updated";
    } else {
      doc = {
        frontmatter: {
          id: ulid(),
          source: payload.source,
          source_url: payload.source_url,
          title: payload.title,
          author,
          created_at: nowIso(),
          starred: payload.starred ?? false,
          metadata: payload.metadata && Object.keys(payload.metadata).length ? payload.metadata : undefined,
          task: payload.task,
          tags: payload.tags,
        },
        body: payload.body,
      };
      status = "captured";
    }
    const { hash } = writeDocFile(dataDir, doc);
    upsertDocRow(db, doc, { fileHash: hash });
    const { inserted } = rebuildChunks(db, doc.frontmatter.id, doc.body);
    let embedded = 0;
    let embedError: string | undefined;
    if (opts.embed !== false && !isConsumer(dataDir)) {
      try {
        embedded = (await embedPending(db)).embedded;
      } catch (e) {
        if (e instanceof EmbeddingUnavailableError) embedError = e.message;
        else throw e;
      }
    }
    return { id: doc.frontmatter.id, status, title: doc.frontmatter.title, chunks: inserted, embedded, embedError };
  } finally {
    if (!opts.db) db.close();
  }
}
