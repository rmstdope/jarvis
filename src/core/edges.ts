import type { Database } from "bun:sqlite";
import { AUTO_EDGE_TOPK, AUTO_EDGE_WINDOW, BACKLINK_MIN_TITLE, EMBEDDING_EDGE_KNN, EMBEDDING_EDGE_THRESHOLD, EMBEDDING_EDGE_TOPK, type CreatedBy, type Relation } from "./constants.ts";
import { openDb } from "./db.ts";
import { readDocFile } from "./docs.ts";
import { escapeRegExp, nowIso, vecToJson } from "./util.ts";

export interface EdgesResult {
  docs: number;
  backlink: number;
  auto: number;
  entity: number;
  embedding: number;
}

/** Shared write rule for every derived producer. Returns true when written. */
export function writeDerivedEdge(db: Database, src: string, dst: string, relation: Relation, createdBy: CreatedBy, weight: number): boolean {
  if (src === dst) return false;
  const rej = db.query("SELECT 1 FROM edge_rejections WHERE (src = ?1 AND dst = ?2) OR (src = ?2 AND dst = ?1)").get(src, dst);
  if (rej) return false;
  const existing = db.query("SELECT 1 FROM edges WHERE (src = ?1 AND dst = ?2) OR (src = ?2 AND dst = ?1)").get(src, dst);
  if (existing) return false;
  db.run("INSERT OR REPLACE INTO edges (src, dst, relation, created_by, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)", [src, dst, relation, createdBy, Math.min(1, Math.max(0, weight)), nowIso()]);
  return true;
}

function meanVector(vecs: number[][]): number[] | null {
  if (vecs.length === 0) return null;
  const out = new Array(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return out.map((x) => x / vecs.length);
}

export function computeEdges(dataDir: string, opts: { db?: Database; ids?: string[] } = {}): EdgesResult {
  const db = opts.db ?? openDb(dataDir);
  const res: EdgesResult = { docs: 0, backlink: 0, auto: 0, entity: 0, embedding: 0 };
  try {
    const pending = opts.ids
      ? opts.ids
      : (db.query("SELECT id FROM documents WHERE edged_at IS NULL OR edged_at < indexed_at ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    if (pending.length === 0) return res;
    // Purge stale derived edges of pending docs (they are recomputed below).
    const purge = db.query("DELETE FROM edges WHERE src = ? AND created_by IN ('backlink','auto','entity','embedding')");
    const titles = db.query("SELECT id, title FROM documents WHERE length(trim(title)) >= ?").all(BACKLINK_MIN_TITLE) as { id: string; title: string }[];
    const titleRegex = titles.map((t) => ({ id: t.id, words: t.title.trim().split(/\s+/).length, re: new RegExp(`\\b${escapeRegExp(t.title.trim())}\\b`, "i") }));
    const chunkText = db.query("SELECT text FROM chunks WHERE doc_id = ? ORDER BY seq");
    const docRow = db.query("SELECT id, created_at, tags FROM documents WHERE id = ?");
    const nearest = db.query(
      "SELECT id, tags, abs(julianday(created_at) - julianday(?1)) AS dt FROM documents WHERE id != ?2 AND tags IS NOT NULL ORDER BY dt LIMIT ?3",
    );
    const chunkVecs = db.query("SELECT v.embedding AS e FROM chunks c JOIN chunks_vec v ON v.chunk_id = c.id WHERE c.doc_id = ?");
    const knn = db.query(
      `SELECT c.doc_id AS docId, MIN(v.distance) AS distance FROM (SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ?1 AND k = ?2) v JOIN chunks c ON c.id = v.chunk_id GROUP BY c.doc_id ORDER BY distance`,
    );
    const hasVec = (() => {
      try {
        db.query("SELECT vec_to_json(embedding) FROM chunks_vec LIMIT 0").all();
        return true;
      } catch {
        return false;
      }
    })();
    const stamp = db.query("UPDATE documents SET edged_at = ? WHERE id = ?");

    interface Pend { id: string; created_at: string; tags: string[]; texts: string[] }
    const rows: Pend[] = [];
    for (const id of pending) {
      const row = docRow.get(id) as { id: string; created_at: string; tags: string | null } | null;
      if (!row) continue;
      rows.push({ id, created_at: row.created_at, tags: row.tags ? JSON.parse(row.tags) : [], texts: (chunkText.all(id) as { text: string }[]).map((c) => c.text) });
    }
    // Producers run in priority order across all pending docs, so a backlink is never pre-empted
    // by a weaker embedding edge written for an earlier doc.
    db.transaction(() => {
      for (const r of rows) {
        res.docs++;
        purge.run(r.id);
      }
      // 1. backlink → references
      for (const r of rows) {
        for (const t of titleRegex) {
          if (t.id === r.id) continue;
          if (r.texts.some((x) => t.re.test(x))) {
            if (writeDerivedEdge(db, r.id, t.id, "references", "backlink", Math.min(0.4 + 0.1 * t.words, 0.9))) res.backlink++;
          }
        }
      }
      // 2. auto → same_topic
      for (const r of rows) {
        if (!r.tags.length) continue;
        const mine = new Set(r.tags.map((t) => t.toLowerCase()));
        const cands: { id: string; score: number }[] = [];
        for (const n of nearest.all(r.created_at, r.id, AUTO_EDGE_WINDOW) as { id: string; tags: string; dt: number }[]) {
          const theirs: string[] = JSON.parse(n.tags);
          const shared = theirs.filter((t) => mine.has(t.toLowerCase())).length;
          const within3h = n.dt <= 3 / 24;
          if (shared >= 2 || (shared >= 1 && within3h)) cands.push({ id: n.id, score: Math.min(shared * 0.2 + (within3h ? 0.15 : 0), 1) });
        }
        cands.sort((a, b) => b.score - a.score);
        for (const c of cands.slice(0, AUTO_EDGE_TOPK)) if (writeDerivedEdge(db, r.id, c.id, "same_topic", "auto", c.score)) res.auto++;
      }
      // 3. entity → mentions (from the doc file)
      for (const r of rows) {
        const doc = readDocFile(dataDir, r.id);
        for (const m of doc?.frontmatter.mentions ?? []) {
          if (m.entity && writeDerivedEdge(db, r.id, m.entity, "mentions", "entity", 1)) res.entity++;
        }
      }
      // 4. embedding → related (candidates for EDGE-REFINE)
      if (hasVec) {
        for (const r of rows) {
          const vecs = (chunkVecs.all(r.id) as { e: unknown }[]).map((x) => {
            const e = x.e;
            if (typeof e === "string") return JSON.parse(e) as number[];
            const buf = e as Uint8Array;
            return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
          });
          const q = meanVector(vecs);
          if (!q) continue;
          const hits = knn.all(vecToJson(Float32Array.from(q)), EMBEDDING_EDGE_KNN) as { docId: string; distance: number }[];
          const scored = hits.filter((h) => h.docId !== r.id).map((h) => ({ id: h.docId, sim: 1 / (1 + h.distance) })).filter((h) => h.sim >= EMBEDDING_EDGE_THRESHOLD);
          for (const h of scored.slice(0, EMBEDDING_EDGE_TOPK)) if (writeDerivedEdge(db, r.id, h.id, "related", "embedding", h.sim)) res.embedding++;
        }
      }
      const now = nowIso();
      for (const r of rows) stamp.run(now, r.id);
    })();
    return res;
  } finally {
    if (!opts.db) db.close();
  }
}
