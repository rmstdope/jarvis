import type { Database } from "bun:sqlite";
import { REFINE_BATCH, REFINE_BLURB_CHARS, REFINE_MAX_TOKENS, type Relation } from "./constants.ts";
import { resolveAuthor } from "./config.ts";
import { openDb } from "./db.ts";
import { refinePrompt, type RefineCandidate } from "./prompts.ts";
import { appendSidecar, sidecarKeys } from "./sidecar.ts";
import { nowIso } from "./util.ts";
import type { Router } from "../providers/router.ts";
import { parseJsonObject } from "../providers/types.ts";

export interface RefineResult {
  candidates: number;
  kept: number;
  dropped: number;
  malformedBatches: number;
  hallucinated: number;
  model: string | null;
  skipped?: string;
}
const KEEP_RELATIONS: Relation[] = ["same_topic", "supplements", "references"];

export async function refine(dataDir: string, router: Router | null, opts: { limit?: number; dryRun?: boolean; db?: Database; author?: string } = {}): Promise<RefineResult> {
  const db = opts.db ?? openDb(dataDir);
  const res: RefineResult = { candidates: 0, kept: 0, dropped: 0, malformedBatches: 0, hallucinated: 0, model: null };
  try {
    const keys = sidecarKeys(dataDir);
    const rows = db
      .query(
        `SELECT e.src, e.dst, e.weight, s.title AS st, s.summary AS ss, substr(s.body,1,?1) AS sb, d.title AS dt, d.summary AS ds, substr(d.body,1,?1) AS db
         FROM edges e JOIN documents s ON s.id = e.src JOIN documents d ON d.id = e.dst WHERE e.created_by = 'embedding' ORDER BY e.src, e.dst`,
      )
      .all(REFINE_BLURB_CHARS) as { src: string; dst: string; weight: number; st: string; ss: string | null; sb: string; dt: string; ds: string | null; db: string }[];
    let pending = rows.filter((r) => !keys.has(`${r.src}\t${r.dst}`));
    if (opts.limit !== undefined) pending = pending.slice(0, opts.limit);
    res.candidates = pending.length;
    if (pending.length === 0) return res;
    const model = router?.resolve({ kind: "edge-judge", minQuality: "standard" }) ?? null;
    if (!model) {
      res.skipped = "no edge-judge model; candidates stay related";
      return res;
    }
    res.model = model.id;
    if (opts.dryRun) return res;
    const author = resolveAuthor(opts.author);
    const delEmb = db.prepare("DELETE FROM edges WHERE src = ? AND dst = ? AND created_by = 'embedding'");
    const insLlm = db.prepare("INSERT OR REPLACE INTO edges (src, dst, relation, created_by, weight, created_at) VALUES (?, ?, ?, 'llm', ?, ?)");
    const insRej = db.prepare("INSERT OR IGNORE INTO edge_rejections (src, dst) VALUES (?, ?)");
    for (let i = 0; i < pending.length; i += REFINE_BATCH) {
      const batch = pending.slice(i, i + REFINE_BATCH);
      const cands: RefineCandidate[] = batch.map((r) => ({ src: r.src, srcTitle: r.st, srcBlurb: (r.ss ?? r.sb).replace(/\s+/g, " "), dst: r.dst, dstTitle: r.dt, dstBlurb: (r.ds ?? r.db).replace(/\s+/g, " ") }));
      let results: { src: string; dst: string; keep: boolean; relation?: string }[];
      try {
        const out = await model.complete(refinePrompt(cands), { json: true, maxTokens: REFINE_MAX_TOKENS });
        const j = parseJsonObject(out) as { results?: unknown };
        if (!Array.isArray(j.results)) throw new Error("no results array");
        results = (j.results as Record<string, unknown>[]).filter((r) => r && typeof r.src === "string" && typeof r.dst === "string").map((r) => ({ src: r.src as string, dst: r.dst as string, keep: !!r.keep, relation: typeof r.relation === "string" ? r.relation : undefined }));
      } catch {
        res.malformedBatches++;
        continue;
      }
      const byKey = new Map(batch.map((b) => [`${b.src}\t${b.dst}`, b]));
      const now = nowIso();
      db.transaction(() => {
        for (const r of results) {
          const cand = byKey.get(`${r.src}\t${r.dst}`);
          if (!cand) {
            res.hallucinated++;
            continue;
          }
          byKey.delete(`${r.src}\t${r.dst}`);
          if (r.keep) {
            const relation = KEEP_RELATIONS.includes(r.relation as Relation) ? (r.relation as Relation) : "same_topic";
            appendSidecar(dataDir, { kind: "edge", src: r.src, dst: r.dst, relation, created_by: "llm", weight: cand.weight, author, created_at: now, model: model.id });
            delEmb.run(r.src, r.dst);
            insLlm.run(r.src, r.dst, relation, cand.weight, now);
            res.kept++;
          } else {
            appendSidecar(dataDir, { kind: "rejection", src: r.src, dst: r.dst, judged_by: "llm", author, created_at: now, model: model.id });
            delEmb.run(r.src, r.dst);
            insRej.run(r.src, r.dst);
            res.dropped++;
          }
        }
      })();
    }
    return res;
  } finally {
    if (!opts.db) db.close();
  }
}
