import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { isConsumer } from "./config.ts";
import { openDb } from "./db.ts";
import { listDocFiles, rebuildChunks, upsertDocRow } from "./docs.ts";
import { embedPending, EmbeddingUnavailableError } from "./embed.ts";
import { parseDoc } from "./frontmatter.ts";
import { sha256 } from "./util.ts";

export interface ReindexResult {
  docsIndexed: number;
  docsSkipped: number;
  docsMalformed: number;
  chunksEmbedded: number;
  edgesMirrored: number;
  rejectionsMirrored: number;
  malformedSidecarLines: number;
  entitiesMirrored: number;
  briefingsIndexed: number;
  presentationsIndexed: number;
  reaped: number;
  warnings: string[];
  embedError?: string;
}

export interface ReindexOpts {
  full?: boolean;
  embed?: boolean;
  db?: Database;
}

/** Hooks other modules register so reindex stays the single INDEX pass (briefings, presentations). */
export type ProjectionHook = (db: Database, dataDir: string, result: ReindexResult) => void;
const hooks: ProjectionHook[] = [];
export function registerProjectionHook(h: ProjectionHook): void {
  if (!hooks.includes(h)) hooks.push(h);
}

export function mirrorSidecars(db: Database, dataDir: string, result: ReindexResult): void {
  const dir = join(dataDir, "edges");
  if (!existsSync(dir)) return;
  const insEdge = db.prepare("INSERT OR REPLACE INTO edges (src, dst, relation, created_by, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insRej = db.prepare("INSERT OR IGNORE INTO edge_rejections (src, dst) VALUES (?, ?)");
  db.transaction(() => {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.kind === "edge" && o.src && o.dst && o.relation && o.created_by) {
            insEdge.run(o.src, o.dst, o.relation, o.created_by, Math.min(1, Math.max(0, Number(o.weight ?? 1))), o.created_at ?? new Date().toISOString());
            result.edgesMirrored++;
          } else if (o.kind === "rejection" && o.src && o.dst) {
            insRej.run(o.src, o.dst);
            result.rejectionsMirrored++;
          } else throw new Error("unknown line shape");
        } catch {
          result.malformedSidecarLines++;
          result.warnings.push(`malformed sidecar line in edges/${f}`);
        }
      }
    }
  })();
}

export function mirrorEntities(db: Database, dataDir: string, result: ReindexResult): void {
  const dir = join(dataDir, "entities");
  if (!existsSync(dir)) return;
  const ins = db.prepare("INSERT OR REPLACE INTO entities (id, name, kind, canonical, aliases, stub) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (!e.id || !e.name) throw new Error("bad entity");
        ins.run(e.id, e.name, e.kind ?? null, e.canonical ?? e.id, JSON.stringify(e.aliases ?? []), e.stub ? 1 : 0);
        result.entitiesMirrored++;
      } catch {
        result.warnings.push(`malformed entity file entities/${f}`);
      }
    }
  })();
}

export async function reindex(dataDir: string, opts: ReindexOpts = {}): Promise<ReindexResult> {
  const db = opts.db ?? openDb(dataDir);
  const result: ReindexResult = {
    docsIndexed: 0, docsSkipped: 0, docsMalformed: 0, chunksEmbedded: 0, edgesMirrored: 0, rejectionsMirrored: 0,
    malformedSidecarLines: 0, entitiesMirrored: 0, briefingsIndexed: 0, presentationsIndexed: 0, reaped: 0, warnings: [],
  };
  try {
    if (opts.full) {
      db.transaction(() => {
        db.run("DELETE FROM chunks_vec");
        db.run("DELETE FROM chunks");
        db.run("DELETE FROM documents");
        db.run("DELETE FROM edges");
        db.run("DELETE FROM edge_rejections");
        db.run("DELETE FROM entities");
      })();
    }
    mirrorSidecars(db, dataDir, result);
    mirrorEntities(db, dataDir, result);

    const files = listDocFiles(dataDir);
    const seen = new Set<string>();
    const hashOf = db.prepare("SELECT file_hash FROM documents WHERE id = ?");
    for (const f of files) {
      const id = f.slice(0, -3);
      seen.add(id);
      const text = readFileSync(join(dataDir, "docs", f), "utf8");
      const hash = sha256(text);
      const row = hashOf.get(id) as { file_hash: string } | null;
      if (row && row.file_hash === hash && !opts.full) {
        result.docsSkipped++;
        continue;
      }
      let doc;
      try {
        doc = parseDoc(text);
      } catch (e) {
        result.docsMalformed++;
        result.warnings.push(`docs/${f}: ${(e as Error).message}`);
        continue;
      }
      if (doc.frontmatter.id !== id) {
        result.warnings.push(`docs/${f}: frontmatter id ${doc.frontmatter.id} does not match filename`);
      }
      try {
        db.transaction(() => {
          upsertDocRow(db, doc, { fileHash: hash });
          rebuildChunks(db, doc.frontmatter.id, doc.body);
        })();
        result.docsIndexed++;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (/UNIQUE constraint failed: documents\.source_url/.test(msg)) {
          result.warnings.push(`docs/${f}: duplicate source_url ${doc.frontmatter.source_url} (run \`brain dedup\`)`);
        } else throw e;
      }
    }
    // Reap rows whose file disappeared (docs only; projections reap themselves in hooks).
    const stale = db.query("SELECT id FROM documents WHERE source NOT IN ('briefing','presentation')").all() as { id: string }[];
    const delDoc = db.prepare("DELETE FROM documents WHERE id = ?");
    const delChunks = db.prepare("DELETE FROM chunks WHERE doc_id = ?");
    const delVecs = db.prepare("DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)");
    const delEdges = db.prepare("DELETE FROM edges WHERE (src = ? OR dst = ?) AND created_by IN ('backlink','auto','embedding','entity')");
    db.transaction(() => {
      for (const s of stale) {
        if (!seen.has(s.id)) {
          delVecs.run(s.id);
          delChunks.run(s.id);
          delEdges.run(s.id, s.id);
          delDoc.run(s.id);
          result.reaped++;
        }
      }
    })();

    for (const h of hooks) h(db, dataDir, result);

    if (opts.embed !== false && !isConsumer(dataDir)) {
      try {
        result.chunksEmbedded = (await embedPending(db)).embedded;
      } catch (e) {
        if (e instanceof EmbeddingUnavailableError) result.embedError = e.message;
        else throw e;
      }
    }
    return result;
  } finally {
    if (!opts.db) db.close();
  }
}
