import type { Database } from "bun:sqlite";
import { RRF_K, SEARCH_DEFAULT_LIMIT, SEMANTIC_OVERFETCH } from "./constants.ts";
import { openDb } from "./db.ts";
import { embedQuery, getEmbedder, EmbeddingUnavailableError } from "./embed.ts";
import { vecToJson } from "./util.ts";

export type SearchMode = "hybrid" | "semantic" | "keyword";
export interface SearchHit {
  docId: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
}
/** The Browse filters a search can be narrowed by; an item matches when it matches every one given. */
export interface SearchFilter {
  source?: string;
  /** Matches the item's author or its last editor, as either "Recently" column on Browse would. */
  author?: string;
  tag?: string;
  /** ISO time: matches an item created or updated at or after it. */
  since?: string;
}
export interface SearchOpts {
  limit?: number;
  mode?: SearchMode;
  db?: Database;
  filter?: SearchFilter;
}

/** The SQL condition (over `documents d`) and its parameters for a filter; null when nothing is filtered. */
function filterSql(f: SearchFilter = {}): { sql: string; params: string[] } | null {
  const where: string[] = [];
  const params: string[] = [];
  if (f.source) { where.push("d.source = ?"); params.push(f.source); }
  if (f.author) { where.push("(d.author = ? OR d.updated_by = ?)"); params.push(f.author, f.author); }
  if (f.tag) { where.push("EXISTS (SELECT 1 FROM json_each(d.tags) WHERE json_each.value = ?)"); params.push(f.tag); }
  if (f.since) { where.push("(d.created_at >= ? OR d.updated_at >= ?)"); params.push(f.since, f.since); }
  return where.length ? { sql: where.join(" AND "), params } : null;
}

export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export function keywordSearch(db: Database, query: string, limit: number, filter?: SearchFilter): SearchHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  return keywordSearchRaw(db, match, limit, filter);
}
/** Run a prepared FTS5 MATCH expression (e.g. `"a" OR "b"`), keeping only items that match `filter`. */
export function keywordSearchRaw(db: Database, match: string, limit: number, filter?: SearchFilter): SearchHit[] {
  const f = filterSql(filter);
  const rows = db
    .query(
      `SELECT d.id AS docId, d.title, d.source, snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet, rank
       FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
       WHERE documents_fts MATCH ?${f ? ` AND ${f.sql}` : ""} ORDER BY rank LIMIT ?`,
    )
    .all(match, ...(f?.params ?? []), limit) as { docId: string; title: string; source: string; snippet: string; rank: number }[];
  return rows.map((r) => ({ docId: r.docId, title: r.title, source: r.source, snippet: r.snippet, score: -r.rank }));
}

/** The title, source and snippet text of one item, or null when it is gone or does not match `filter`. */
function docForHit(db: Database, filter?: SearchFilter): (id: string) => { title: string; source: string; summary: string | null; head: string } | null {
  const f = filterSql(filter);
  const q = db.query(`SELECT d.title, d.source, d.summary, substr(d.body, 1, 200) AS head FROM documents d WHERE d.id = ?${f ? ` AND ${f.sql}` : ""}`);
  return (id) => q.get(id, ...(f?.params ?? [])) as { title: string; source: string; summary: string | null; head: string } | null;
}

export async function semanticSearch(db: Database, query: string, limit: number, filter?: SearchFilter): Promise<SearchHit[]> {
  const embedder = getEmbedder();
  if (!(await embedder.available())) throw new EmbeddingUnavailableError(`embedding server (${embedder.name}) is unreachable`);
  const qv = await embedQuery(query);
  const k = limit * SEMANTIC_OVERFETCH;
  const rows = db
    .query(
      `SELECT c.doc_id AS docId, MIN(v.distance) AS distance
       FROM (SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance) v
       JOIN chunks c ON c.id = v.chunk_id GROUP BY c.doc_id ORDER BY distance`,
    )
    .all(vecToJson(qv), k) as { docId: string; distance: number }[];
  const doc = docForHit(db, filter);
  const out: SearchHit[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const d = doc(r.docId);
    if (!d) continue;
    out.push({ docId: r.docId, title: d.title, source: d.source, snippet: d.summary ?? d.head, score: 1 / (1 + r.distance) });
  }
  return out;
}

function rrf(lists: SearchHit[][]): Map<string, { hit: SearchHit; score: number }> {
  const fused = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const cur = fused.get(hit.docId);
      const add = 1 / (RRF_K + i + 1);
      if (cur) cur.score += add;
      else fused.set(hit.docId, { hit, score: add });
    });
  }
  return fused;
}
function topN(m: Map<string, { hit: SearchHit; score: number }>, n: number): SearchHit[] {
  return [...m.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => ({ ...x.hit, score: x.score }));
}

export function graphExpand(db: Database, hits: SearchHit[], limit: number, filter?: SearchFilter): SearchHit[] {
  const inResults = new Set(hits.map((h) => h.docId));
  const neighbours = new Map<string, number>();
  const q = db.query("SELECT src, dst, weight FROM edges WHERE src = ? OR dst = ?");
  for (const h of hits) {
    for (const e of q.all(h.docId, h.docId) as { src: string; dst: string; weight: number | null }[]) {
      const other = e.src === h.docId ? e.dst : e.src;
      if (inResults.has(other)) continue;
      neighbours.set(other, (neighbours.get(other) ?? 0) + h.score * (e.weight ?? 0));
    }
  }
  const doc = docForHit(db, filter);
  const out: SearchHit[] = [];
  for (const [id, score] of [...neighbours.entries()].sort((a, b) => b[1] - a[1])) {
    if (out.length >= limit) break;
    const d = doc(id);
    if (!d) continue;
    out.push({ docId: id, title: d.title, source: d.source, snippet: d.summary ?? d.head, score });
  }
  return out;
}

/** Search the library by keyword, meaning or both (fused, then widened along edges), keeping only items that match `opts.filter`. */
export async function search(dataDir: string, query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
  const limit = Math.max(1, opts.limit ?? SEARCH_DEFAULT_LIMIT);
  const mode = opts.mode ?? "hybrid";
  const db = opts.db ?? openDb(dataDir);
  try {
    const filter = opts.filter;
    if (mode === "keyword") return keywordSearch(db, query, limit, filter);
    if (mode === "semantic") return await semanticSearch(db, query, limit, filter);
    const kw = keywordSearch(db, query, limit, filter);
    let sem: SearchHit[] = [];
    try {
      sem = await semanticSearch(db, query, limit, filter);
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) return kw; // documented silent degradation
      throw e;
    }
    const fused = topN(rrf([kw, sem]), limit);
    const neighbours = graphExpand(db, fused, limit, filter);
    if (neighbours.length === 0) return fused;
    return topN(rrf([fused, neighbours]), limit);
  } finally {
    if (!opts.db) db.close();
  }
}
