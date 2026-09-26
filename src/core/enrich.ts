import type { Database } from "bun:sqlite";
import { ENRICH_MAX_TOKENS, ENRICH_PIECE_CHARS, ENRICH_TAG_CAP, ENRICH_TARGET_VERSION } from "./constants.ts";
import { resolveAuthor } from "./config.ts";
import { openDb } from "./db.ts";
import { readDocFile, rebuildChunks, upsertDocRow, writeDocFile } from "./docs.ts";
import { getEmbedder } from "./embed.ts";
import { EntityResolver, isEntityKind } from "./entities.ts";
import type { Mention } from "./frontmatter.ts";
import { loadGlossary } from "./glossary.ts";
import { enrichPrompt, enrichSummaryOnlyPrompt } from "./prompts.ts";
import type { Router } from "../providers/router.ts";
import { parseJsonObject, TruncationError, type ResolvedModel } from "../providers/types.ts";

export interface EnrichResult {
  enriched: number;
  skipped: number;
  failed: number;
  model: string | null;
  stubsCreated: number;
  details: { id: string; status: "enriched" | "skipped" | "failed" | "empty"; reason?: string }[];
}
interface Extracted {
  summary: string;
  tags: string[];
  mentions: { name: string; kind: string }[];
  truncated: boolean;
}

function parseExtraction(text: string): Omit<Extracted, "truncated"> {
  const j = parseJsonObject(text) as Record<string, unknown>;
  const item = (Array.isArray(j.items) ? j.items[0] : j) as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw new Error("no item in model output");
  const summary = typeof item.summary === "string" ? item.summary.trim() : "";
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const mentions = Array.isArray(item.mentions)
    ? (item.mentions as Record<string, unknown>[]).filter((m) => m && typeof m.name === "string" && isEntityKind(m.kind)).map((m) => ({ name: String(m.name).trim(), kind: String(m.kind) }))
    : [];
  return { summary, tags, mentions };
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out.slice(0, ENRICH_TAG_CAP);
}

/** Split at ~piece boundaries preferring a newline in the last 10 % of the window. */
export function splitPieces(body: string, size = ENRICH_PIECE_CHARS): string[] {
  const out: string[] = [];
  let rest = body;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const nl = window.lastIndexOf("\n");
    const cut = nl >= size * 0.9 ? nl + 1 : size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

async function extractOne(model: ResolvedModel, title: string, body: string, summaryOnly: boolean): Promise<Extracted> {
  const opts = { json: true, maxTokens: ENRICH_MAX_TOKENS };
  if (!summaryOnly) {
    try {
      return { ...parseExtraction(await model.complete(enrichPrompt(title, body), opts)), truncated: false };
    } catch (e) {
      if (!(e instanceof TruncationError)) throw e;
      // do not retry; fall back once to summary-only
    }
  }
  const r = parseExtraction(await model.complete(enrichSummaryOnlyPrompt(title, body), opts));
  return { summary: r.summary, tags: r.tags, mentions: [], truncated: true };
}

export async function extract(model: ResolvedModel, title: string, body: string): Promise<Omit<Extracted, "truncated">> {
  if (body.length <= ENRICH_PIECE_CHARS) return extractOne(model, title, body, false);
  const pieces = splitPieces(body);
  let sticky = false;
  const tags: string[] = [];
  const mentions = new Map<string, { name: string; kind: string }>();
  const partials: string[] = [];
  for (const p of pieces) {
    const r = await extractOne(model, title, p, sticky);
    if (r.truncated) sticky = true;
    tags.push(...r.tags);
    for (const m of r.mentions) mentions.set(`${m.kind}\u0000${m.name.toLowerCase()}`, m);
    if (r.summary) partials.push(r.summary);
  }
  const reduced = parseExtraction(await model.complete(enrichSummaryOnlyPrompt(title, partials.join("\n\n")), { json: true, maxTokens: ENRICH_MAX_TOKENS }));
  return { summary: reduced.summary, tags: [...tags, ...reduced.tags], mentions: [...mentions.values()] };
}

export interface EnrichOpts {
  limit?: number;
  dryRun?: boolean;
  db?: Database;
  author?: string;
  /** Only docs authored by this identity (ownership-aware, §24.2.6). Default: all pending. */
  onlyAuthor?: string;
}

export async function enrich(dataDir: string, router: Router | null, opts: EnrichOpts = {}): Promise<EnrichResult> {
  const db = opts.db ?? openDb(dataDir);
  const result: EnrichResult = { enriched: 0, skipped: 0, failed: 0, model: null, stubsCreated: 0, details: [] };
  try {
    let sql = "SELECT id FROM documents WHERE source NOT IN ('briefing','presentation') AND (summary IS NULL OR summary = '' OR proc_version < ?)";
    const params: (string | number)[] = [ENRICH_TARGET_VERSION];
    if (opts.onlyAuthor) {
      sql += " AND author = ?";
      params.push(opts.onlyAuthor);
    }
    sql += " ORDER BY id";
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const pending = (db.query(sql).all(...params) as { id: string }[]).map((r) => r.id);
    if (pending.length === 0) return result;
    const model = router?.resolve({ kind: "summary", minQuality: "standard" }) ?? null;
    if (!model) {
      result.skipped = pending.length;
      result.details = pending.map((id) => ({ id, status: "skipped" as const, reason: "no summary model (Tier 0)" }));
      return result;
    }
    result.model = model.id;
    if (opts.dryRun) {
      result.details = pending.map((id) => ({ id, status: "skipped" as const, reason: "dry-run" }));
      result.skipped = pending.length;
      return result;
    }
    const author = resolveAuthor(opts.author);
    const embedder = getEmbedder();
    const resolver = new EntityResolver(dataDir, loadGlossary(dataDir), author, (await embedder.available()) ? embedder : null, db);
    let changed = false;
    for (const id of pending) {
      const doc = readDocFile(dataDir, id);
      if (!doc) {
        result.details.push({ id, status: "failed", reason: "file missing" });
        result.failed++;
        continue;
      }
      try {
        if (!doc.body.trim()) {
          doc.frontmatter.proc_version = ENRICH_TARGET_VERSION;
          const { hash } = writeDocFile(dataDir, doc);
          upsertDocRow(db, doc, { fileHash: hash });
          result.details.push({ id, status: "empty" });
          result.enriched++;
          changed = true;
          continue;
        }
        const ex = await extract(model, doc.frontmatter.title, doc.body);
        const mentions: Mention[] = [];
        for (const m of ex.mentions) {
          if (!isEntityKind(m.kind)) continue;
          const e = await resolver.resolve(m.name, m.kind, doc.frontmatter.author);
          mentions.push({ name: m.name, kind: m.kind, entity: e.id });
        }
        doc.frontmatter.summary = ex.summary;
        doc.frontmatter.tags = dedupeTags(ex.tags);
        doc.frontmatter.mentions = mentions;
        doc.frontmatter.proc_version = ENRICH_TARGET_VERSION; // written last in key order
        const { hash } = writeDocFile(dataDir, doc);
        upsertDocRow(db, doc, { fileHash: hash });
        rebuildChunks(db, id, doc.body);
        result.enriched++;
        result.details.push({ id, status: "enriched" });
        changed = true;
      } catch (e) {
        result.failed++;
        result.details.push({ id, status: "failed", reason: (e as Error).message });
      }
    }
    result.stubsCreated = resolver.created.length;
    void changed;
    return result;
  } finally {
    if (!opts.db) db.close();
  }
}
