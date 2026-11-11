import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { resolveAuthor } from "./config.ts";
import { RELATIONS, type Relation } from "./constants.ts";
import { openDb } from "./db.ts";
import { docPath } from "./docs.ts";
import { appendSidecar, readSidecar, sidecarPath } from "./sidecar.ts";
import { nowIso } from "./util.ts";

export const LINK_RELATIONS: Relation[] = ["references", "supplements", "same_topic", "contradicts", "follows_up", "related"];

export interface LinkResult {
  src: string;
  dst: string;
  relation: Relation;
  status: "linked" | "exists";
}

/** True when the id exists as a doc row, an entity row, or a doc file. */
export function targetExists(db: Database, dataDir: string, id: string): boolean {
  if (db.query("SELECT 1 FROM documents WHERE id = ?").get(id)) return true;
  if (db.query("SELECT 1 FROM entities WHERE id = ?").get(id)) return true;
  return existsSync(docPath(dataDir, id));
}

/** Append a manual edge to the source sidecar and upsert it in the index (derived edges for the pair are dropped). */
export function link(dataDir: string, src: string, dsts: string[], opts: { relation?: Relation; author?: string; db?: Database } = {}): LinkResult[] {
  const relation = opts.relation ?? "references";
  if (!LINK_RELATIONS.includes(relation)) throw new Error(`relation must be one of ${LINK_RELATIONS.join("|")}`);
  const db = opts.db ?? openDb(dataDir);
  try {
    if (!targetExists(db, dataDir, src)) throw new Error(`source ${src} not found`);
    const author = resolveAuthor(opts.author);
    const out: LinkResult[] = [];
    const existing = readSidecar(dataDir, src);
    for (const dst of dsts) {
      if (dst === src) throw new Error("cannot link an item to itself");
      if (!targetExists(db, dataDir, dst)) throw new Error(`target ${dst} not found`);
      if (existing.some((l) => l.kind === "edge" && l.dst === dst && l.relation === relation && l.created_by === "manual")) {
        out.push({ src, dst, relation, status: "exists" });
        continue;
      }
      const now = nowIso();
      appendSidecar(dataDir, { kind: "edge", src, dst, relation, created_by: "manual", weight: 1, author, created_at: now });
      db.transaction(() => {
        db.run("DELETE FROM edges WHERE ((src = ?1 AND dst = ?2) OR (src = ?2 AND dst = ?1)) AND created_by IN ('backlink','auto','entity','embedding')", [src, dst]);
        db.run("INSERT OR REPLACE INTO edges (src, dst, relation, created_by, weight, created_at) VALUES (?, ?, ?, 'manual', 1, ?)", [src, dst, relation, now]);
      })();
      out.push({ src, dst, relation, status: "linked" });
    }
    return out;
  } finally {
    if (!opts.db) db.close();
  }
}
export function isRelation(r: unknown): r is Relation {
  return RELATIONS.includes(r as Relation);
}

/** Remove the manual edge `src → dst` with `relation` from the source sidecar and the index; false when it was not there. */
export function unlink(dataDir: string, src: string, dst: string, relation: Relation, dbIn?: Database): boolean {
  const lines = readSidecar(dataDir, src);
  const keep = lines.filter((l) => !(l.kind === "edge" && l.dst === dst && l.relation === relation && l.created_by === "manual"));
  if (keep.length === lines.length) return false;
  writeFileSync(sidecarPath(dataDir, src), keep.map((l) => JSON.stringify(l) + "\n").join(""));
  const db = dbIn ?? openDb(dataDir);
  try {
    db.run("DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ? AND created_by = 'manual'", [src, dst, relation]);
  } finally {
    if (!dbIn) db.close();
  }
  return true;
}
