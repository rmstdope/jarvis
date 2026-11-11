import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { parseDoc, serializeDoc, type Doc, type DocFrontmatter } from "./frontmatter.ts";
import { chunkDoc } from "./chunk.ts";
import { nowIso, sha256 } from "./util.ts";

export function docsDir(dataDir: string): string {
  return join(dataDir, "docs");
}
export function docPath(dataDir: string, id: string): string {
  return join(docsDir(dataDir), `${id}.md`);
}
export function readDocFile(dataDir: string, id: string): Doc | null {
  const p = docPath(dataDir, id);
  if (!existsSync(p)) return null;
  return parseDoc(readFileSync(p, "utf8"));
}
export function writeDocFile(dataDir: string, doc: Doc): { text: string; hash: string } {
  mkdirSync(docsDir(dataDir), { recursive: true });
  const text = serializeDoc(doc);
  writeFileSync(docPath(dataDir, doc.frontmatter.id), text);
  return { text, hash: sha256(text) };
}
export function listDocFiles(dataDir: string): string[] {
  const d = docsDir(dataDir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".md")).sort();
}

export interface DocRow {
  id: string;
  source: string;
  source_url: string | null;
  title: string;
  body: string;
  author: string;
  created_at: string;
  updated_at: string | null;
  updated_by: string | null;
  metadata: string | null;
  starred: number;
  summary: string | null;
  tags: string | null;
  proc_version: number;
  file_path: string | null;
  file_hash: string;
  indexed_at: string;
  edged_at: string | null;
}

export interface UpsertOpts {
  filePath?: string;
  fileHash: string;
  /** For briefing/presentation projections that carry no ENRICH fields. */
  summary?: string | null;
  tags?: string[] | null;
  metadataOverride?: Record<string, unknown>;
}

/** Upsert a documents row from a parsed doc; edged_at reset to NULL so EDGES revisits it. */
export function upsertDocRow(db: Database, doc: Doc, opts: UpsertOpts): void {
  const fm = doc.frontmatter;
  const metadata = opts.metadataOverride ?? fm.metadata ?? null;
  db.run(
    `INSERT INTO documents (id, source, source_url, title, body, author, created_at, updated_at, updated_by, metadata, starred, summary, tags, proc_version, file_path, file_hash, indexed_at, edged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET source=excluded.source, source_url=excluded.source_url, title=excluded.title, body=excluded.body,
       author=excluded.author, created_at=excluded.created_at, updated_at=excluded.updated_at, updated_by=excluded.updated_by,
       metadata=excluded.metadata, starred=excluded.starred, summary=excluded.summary, tags=excluded.tags, proc_version=excluded.proc_version,
       file_path=excluded.file_path, file_hash=excluded.file_hash, indexed_at=excluded.indexed_at, edged_at=NULL`,
    [
      fm.id, fm.source, fm.source_url ?? null, fm.title, doc.body, fm.author, fm.created_at, fm.updated_at ?? null, fm.updated_by ?? null,
      metadata ? JSON.stringify(metadata) : null, fm.starred ? 1 : 0,
      opts.summary !== undefined ? opts.summary : fm.summary ?? null,
      opts.tags !== undefined ? (opts.tags ? JSON.stringify(opts.tags) : null) : fm.tags ? JSON.stringify(fm.tags) : null,
      fm.proc_version ?? 0, opts.filePath ?? `docs/${fm.id}.md`, opts.fileHash, nowIso(),
    ],
  );
}

/** Rebuild chunks by id diff: insert missing, delete stale plus their vectors. Returns number inserted. */
export function rebuildChunks(db: Database, docId: string, body: string): { inserted: number; deleted: number } {
  const wanted = chunkDoc(docId, body);
  const wantedIds = new Set(wanted.map((c) => c.id));
  const existing = db.query("SELECT id FROM chunks WHERE doc_id = ?").all(docId) as { id: string }[];
  const existingIds = new Set(existing.map((e) => e.id));
  const delChunk = db.query("DELETE FROM chunks WHERE id = ?");
  const delVec = db.query("DELETE FROM chunks_vec WHERE chunk_id = ?");
  const ins = db.query("INSERT INTO chunks (id, doc_id, seq, text, embedded) VALUES (?, ?, ?, ?, 0)");
  const upd = db.query("UPDATE chunks SET seq = ? WHERE id = ?");
  let inserted = 0;
  let deleted = 0;
  db.transaction(() => {
    for (const e of existing) {
      if (!wantedIds.has(e.id)) {
        delChunk.run(e.id);
        delVec.run(e.id);
        deleted++;
      }
    }
    for (const c of wanted) {
      if (existingIds.has(c.id)) upd.run(c.seq, c.id);
      else {
        ins.run(c.id, c.docId, c.seq, c.text);
        inserted++;
      }
    }
  })();
  return { inserted, deleted };
}

export function getDocRow(db: Database, id: string): DocRow | null {
  return (db.query("SELECT * FROM documents WHERE id = ?").get(id) as DocRow | null) ?? null;
}
export function getDocRowBySourceUrl(db: Database, url: string): DocRow | null {
  return (db.query("SELECT * FROM documents WHERE source_url = ?").get(url) as DocRow | null) ?? null;
}
export function rowToFrontmatter(row: DocRow): DocFrontmatter {
  return {
    id: row.id,
    source: row.source as DocFrontmatter["source"],
    source_url: row.source_url ?? undefined,
    title: row.title,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    updated_by: row.updated_by ?? undefined,
    starred: !!row.starred,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    summary: row.summary ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    proc_version: row.proc_version || undefined,
  };
}
