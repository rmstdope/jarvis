import type { Database } from "bun:sqlite";
import { CLEANUP_GLOSSARY_LINES, CLEANUP_MIN_OUTPUT_RATIO, CLEANUP_PIECE_CHARS, CLEANUP_MAX_TOKENS, CLEANUP_TARGET_VERSION } from "./constants.ts";
import { openDb } from "./db.ts";
import { readDocFile, rebuildChunks, upsertDocRow, writeDocFile } from "./docs.ts";
import { loadGlossary, type Glossary } from "./glossary.ts";
import { cleanupPrompt } from "./prompts.ts";
import { escapeRegExp } from "./util.ts";
import type { Router } from "../providers/router.ts";
import { TruncationError } from "../providers/types.ts";

export interface CleanupResult {
  cleaned: number;
  skipped: number;
  failed: number;
  model: string | null;
  details: { id: string; fixes: string[]; llm: boolean; reason?: string }[];
}

/** Deterministic layer: every variant ≠ canonical with length ≥ 3, longest first, Unicode word boundaries. */
export function deterministicCleanup(body: string, g: Glossary): { text: string; fixes: string[] } {
  const pairs: { v: string; c: string }[] = [];
  for (const e of g.entries) for (const v of e.variants) if (v.length >= 3 && v.toLowerCase() !== e.term.toLowerCase()) pairs.push({ v, c: e.term });
  pairs.sort((a, b) => b.v.length - a.v.length);
  const fixes: string[] = [];
  let text = body;
  for (const { v, c } of pairs) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, "giu");
    let n = 0;
    text = text.replace(re, () => {
      n++;
      return c;
    });
    if (n) fixes.push(`${v} → ${c} (${n})`);
  }
  return { text, fixes };
}

export function packPieces(body: string, size = CLEANUP_PIECE_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of body.split(/\n\s*\n/)) {
    if (cur && cur.length + p.length + 2 > size) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export function glossarySubset(g: Glossary, body: string): string[] {
  const lower = body.toLowerCase();
  const lines: string[] = [];
  for (const e of g.entries) {
    const hit = lower.includes(e.term.toLowerCase()) || e.variants.some((v) => lower.includes(v.toLowerCase()));
    if (!hit) continue;
    lines.push(e.variants.length ? `- ${e.term} (misheard as: ${e.variants.map((v) => `"${v}"`).join(", ")})` : `- ${e.term}`);
    if (lines.length >= CLEANUP_GLOSSARY_LINES) break;
  }
  return lines;
}

export interface CleanupOpts {
  docIds?: string[];
  limit?: number;
  llm?: boolean;
  dryRun?: boolean;
  db?: Database;
}

export async function cleanup(dataDir: string, router: Router | null, opts: CleanupOpts = {}): Promise<CleanupResult> {
  const db = opts.db ?? openDb(dataDir);
  const res: CleanupResult = { cleaned: 0, skipped: 0, failed: 0, model: null, details: [] };
  try {
    const g = loadGlossary(dataDir);
    if (g.entries.length === 0) return res; // no glossary → skipped, nothing stamped
    let ids: string[];
    if (opts.docIds) ids = opts.docIds;
    else ids = (db.query("SELECT id FROM documents WHERE source = 'meeting' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    const pending: string[] = [];
    for (const id of ids) {
      const doc = readDocFile(dataDir, id);
      if (!doc || doc.frontmatter.source !== "meeting") continue;
      const v = Number(doc.frontmatter.metadata?.cleanup_version ?? 0);
      if (v < CLEANUP_TARGET_VERSION) pending.push(id);
    }
    const todo = opts.limit !== undefined ? pending.slice(0, opts.limit) : pending;
    const model = opts.llm ? (router?.resolve({ kind: "cleanup", minQuality: "high" }) ?? null) : null;
    res.model = model?.id ?? null;
    for (const id of todo) {
      const doc = readDocFile(dataDir, id)!;
      try {
        const det = deterministicCleanup(doc.body, g);
        let text = det.text;
        let usedLlm = false;
        if (model) {
          const lines = glossarySubset(g, text);
          const pieces = packPieces(text);
          const out: string[] = [];
          for (const piece of pieces) {
            try {
              const r = (await model.complete(cleanupPrompt(lines, piece), { maxTokens: CLEANUP_MAX_TOKENS })).trim();
              out.push(!r || r.length < piece.length * CLEANUP_MIN_OUTPUT_RATIO ? piece : r);
              usedLlm = true;
            } catch (e) {
              if (e instanceof TruncationError) out.push(piece);
              else throw e;
            }
          }
          text = out.join("\n\n");
        }
        if (opts.dryRun) {
          res.details.push({ id, fixes: det.fixes, llm: usedLlm, reason: "dry-run" });
          res.skipped++;
          continue;
        }
        doc.body = text;
        doc.frontmatter.metadata = { ...(doc.frontmatter.metadata ?? {}), cleanup_version: CLEANUP_TARGET_VERSION, cleanup: { version: CLEANUP_TARGET_VERSION, deterministic_fixes: det.fixes, llm_model: model?.id ?? null } };
        const { hash } = writeDocFile(dataDir, doc);
        upsertDocRow(db, doc, { fileHash: hash });
        rebuildChunks(db, id, doc.body);
        res.cleaned++;
        res.details.push({ id, fixes: det.fixes, llm: usedLlm });
      } catch (e) {
        res.failed++;
        res.details.push({ id, fixes: [], llm: false, reason: (e as Error).message });
      }
    }
    return res;
  } finally {
    if (!opts.db) db.close();
  }
}
