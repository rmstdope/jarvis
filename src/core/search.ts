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
export interface SearchOpts {
  limit?: number;
  mode?: SearchMode;
  db?: Database;
}

export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export function keywordSearch(db: Database, query: string, limit: number): SearchHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  return keywordSearchRaw(db, match, limit);
}
/** Run a prepared FTS5 MATCH expression (e.g. `"a" OR "b"`). */
export function keywordSearchRaw(db: Database, match: string, limit: number): SearchHit[] {
  const rows = db
    .query(
      `SELECT d.id AS docId, d.title, d.source, snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet, rank
       FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
       WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(match, limit) as { docId: string; title: string; source: string; snippet: string; rank: number }[];
  return rows.map((r) => ({ docId: r.docId, title: r.title, source: r.source, snippet: r.snippet, score: -r.rank }));
}

export async function semanticSearch(db: Database, query: string, limit: number): Promise<SearchHit[]> {
  const embedder = getEmbedder();
  if (!(await embedder.available())) throw new EmbeddingUnavailableError(`embedding server (${embedder.name}) is unreachable`);
  const qv = await embedQuery(query);
  const k = limit * SEMANTIC_OVERFETCH;
  const rows = db
    .query(
      `SELECT c.doc_id AS docId, MIN(v.distance) AS distance
       FROM (SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance) v
       JOIN chunks c ON c.id = v.chunk_id GROUP BY c.doc_id ORDER BY distance LIMIT ?`,
    )
    .all(vecToJson(qv), k, limit) as { docId: string; distance: number }[];
  const docQ = db.prepare("SELECT title, source, summary, substr(body, 1, 200) AS head FROM documents WHERE id = ?");
  const out: SearchHit[] = [];
  for (const r of rows) {
    const d = docQ.get(r.docId) as { title: string; source: string; summary: string | null; head: string } | null;
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

export function graphExpand(db: Database, hits: SearchHit[], limit: number): SearchHit[] {
  const inResults = new Set(hits.map((h) => h.docId));
  const neighbours = new Map<string, number>();
  const q = db.prepare("SELECT src, dst, weight FROM edges WHERE src = ? OR dst = ?");
  for (const h of hits) {
    for (const e of q.all(h.docId, h.docId) as { src: string; dst: string; weight: number | null }[]) {
      const other = e.src === h.docId ? e.dst : e.src;
      if (inResults.has(other)) continue;
      neighbours.set(other, (neighbours.get(other) ?? 0) + h.score * (e.weight ?? 0));
    }
  }
  const docQ = db.prepare("SELECT title, source, summary, substr(body, 1, 200) AS head FROM documents WHERE id = ?");
  const out: SearchHit[] = [];
  for (const [id, score] of [...neighbours.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    const d = docQ.get(id) as { title: string; source: string; summary: string | null; head: string } | null;
    if (!d) continue;
    out.push({ docId: id, title: d.title, source: d.source, snippet: d.summary ?? d.head, score });
  }
  return out;
}

export async function search(dataDir: string, query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
  const limit = Math.max(1, opts.limit ?? SEARCH_DEFAULT_LIMIT);
  const mode = opts.mode ?? "hybrid";
  const db = opts.db ?? openDb(dataDir);
  try {
    if (mode === "keyword") return keywordSearch(db, query, limit);
    if (mode === "semantic") return await semanticSearch(db, query, limit);
    const kw = keywordSearch(db, query, limit);
    let sem: SearchHit[] = [];
    try {
      sem = await semanticSearch(db, query, limit);
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) return kw; // documented silent degradation
      throw e;
    }
    const fused = topN(rrf([kw, sem]), limit);
    const neighbours = graphExpand(db, fused, limit);
    if (neighbours.length === 0) return fused;
    return topN(rrf([fused, neighbours]), limit);
  } finally {
    if (!opts.db) db.close();
  }
}
