/** Projects briefings into the local index (documents rows + part_of/references edges). */
import type { Database } from "bun:sqlite";
import { registerProjectionHook, type ReindexResult } from "../core/reindex.ts";
import { rebuildChunks, upsertDocRow } from "../core/docs.ts";
import { nowIso, sha256 } from "../core/util.ts";
import { briefingIds, briefingIndexText, readBriefing } from "./store.ts";

export function indexBriefings(db: Database, dataDir: string, result: ReindexResult): void {
  db.transaction(() => {
    db.run("DELETE FROM edges WHERE created_by = 'briefing'");
    const seen = new Set<string>();
    for (const id of briefingIds(dataDir)) {
      let b;
      try {
        b = readBriefing(dataDir, id);
      } catch (e) {
        result.warnings.push(`briefings/${id}.brief.mdx: ${(e as Error).message}`);
        continue;
      }
      if (!b) continue;
      seen.add(id);
      const body = briefingIndexText(b);
      const metadata: Record<string, unknown> = { kind: b.kind, source_path: b.filePath };
      if (b.trail) metadata.trail = b.trail;
      if (b.frontmatter.source_doc) metadata.source_doc = b.frontmatter.source_doc;
      upsertDocRow(db, { frontmatter: { id, source: "briefing", title: b.title, author: b.author ?? "unknown", created_at: b.createdAt, updated_at: b.updatedAt !== b.createdAt ? b.updatedAt : undefined, updated_by: b.updatedAt !== b.createdAt ? b.author : undefined, tags: b.tags, starred: false }, body }, { fileHash: sha256(body), filePath: b.filePath, summary: b.subtitle ?? null, metadataOverride: metadata });
      rebuildChunks(db, id, body);
      const now = nowIso();
      if (b.kind === "lesson" && b.trail) db.run("INSERT OR REPLACE INTO edges (src, dst, relation, created_by, weight, created_at) VALUES (?, ?, 'part_of', 'briefing', 1, ?)", [id, b.trail, now]);
      if (b.frontmatter.source_doc) db.run("INSERT OR REPLACE INTO edges (src, dst, relation, created_by, weight, created_at) VALUES (?, ?, 'references', 'briefing', 1, ?)", [id, b.frontmatter.source_doc, now]);
      result.briefingsIndexed++;
    }
    for (const r of db.query("SELECT id FROM documents WHERE source = 'briefing'").all() as { id: string }[]) {
      if (!seen.has(r.id)) {
        db.run("DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)", [r.id]);
        db.run("DELETE FROM chunks WHERE doc_id = ?", [r.id]);
        db.run("DELETE FROM documents WHERE id = ?", [r.id]);
        result.reaped++;
      }
    }
  })();
}
registerProjectionHook(indexBriefings);
