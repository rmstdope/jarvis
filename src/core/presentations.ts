import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ulid } from "ulid";
import type { Database } from "bun:sqlite";
import { parseDoc, serializeDoc, type Doc, type DocFrontmatter } from "./frontmatter.ts";
import { docPath, rebuildChunks, readDocFile, upsertDocRow } from "./docs.ts";
import { registerProjectionHook, type ReindexResult } from "./reindex.ts";
import { nowIso, sha256 } from "./util.ts";
import { PROBE_TIMEOUT_MS } from "./constants.ts";
import { resolveAuthor } from "./config.ts";

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function presentationsDir(dataDir: string): string {
  return join(dataDir, "presentations");
}
export function bundlePath(dataDir: string, slug: string): string {
  return join(presentationsDir(dataDir), slug, "index.mdx");
}

export interface PresentationFrontmatter extends DocFrontmatter {
  source: "presentation";
  provenance?: { imported_from?: string; promoted_from?: string; original_source?: string };
}
export interface Presentation {
  id: string;
  slug: string;
  title: string;
  author: string;
  created_at: string;
  updated_at?: string;
  frontmatter: PresentationFrontmatter;
  body: string;
  filePath: string;
}

/** Parse a bundle's index.mdx: real YAML frontmatter; body must contain `<Presentation`. */
export function parsePresentation(text: string, slug: string): Presentation {
  const doc = parseDoc(text);
  const fm = doc.frontmatter as PresentationFrontmatter;
  if (fm.source !== "presentation") throw new Error(`presentations/${slug}/index.mdx: source must be "presentation"`);
  if (!doc.body.includes("<Presentation")) throw new Error(`presentations/${slug}/index.mdx: body must contain <Presentation`);
  return { id: fm.id, slug, title: fm.title, author: fm.author, created_at: fm.created_at, updated_at: fm.updated_at, frontmatter: fm, body: doc.body, filePath: `presentations/${slug}/index.mdx` };
}
export function listPresentations(dataDir: string): Presentation[] {
  const dir = presentationsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: Presentation[] = [];
  for (const slug of readdirSync(dir).sort()) {
    const p = bundlePath(dataDir, slug);
    if (!existsSync(p)) continue;
    try {
      out.push(parsePresentation(readFileSync(p, "utf8"), slug));
    } catch {}
  }
  return out;
}
export function readPresentation(dataDir: string, slugOrId: string): Presentation | null {
  const all = listPresentations(dataDir);
  return all.find((p) => p.slug === slugOrId) ?? all.find((p) => p.id === slugOrId) ?? null;
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+?)\s*$/m)?.[1];
}
function assertRegular(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`refusing symlink ${path}`);
  if (!st.isFile() && !st.isDirectory()) throw new Error(`refusing special file ${path}`);
}

export interface ShareOpts {
  slug: string;
  title?: string;
  author?: string;
}
/** Copy a deck (file, or directory with index.mdx / exactly one root .mdx) into presentations/<slug>, injecting missing frontmatter. */
export function sharePresentation(dataDir: string, source: string, opts: ShareOpts): Presentation {
  if (!SLUG_RE.test(opts.slug)) throw new Error(`invalid slug "${opts.slug}" (use lowercase letters, digits and single dashes)`);
  const dest = join(presentationsDir(dataDir), opts.slug);
  if (existsSync(dest)) throw new Error(`presentations/${opts.slug} already exists`);
  const src = resolve(source);
  if (!existsSync(src)) throw new Error(`${source} does not exist`);
  assertRegular(src);
  let root: string;
  let mdx: string;
  if (statSync(src).isDirectory()) {
    root = src;
    if (existsSync(join(src, "index.mdx"))) mdx = join(src, "index.mdx");
    else {
      const cands = readdirSync(src).filter((f) => f.endsWith(".mdx"));
      if (cands.length !== 1) throw new Error(`${source} must contain index.mdx or exactly one .mdx file (found ${cands.length})`);
      mdx = join(src, cands[0]);
    }
  } else {
    root = dirname(src);
    mdx = src;
  }
  const text = readFileSync(mdx, "utf8");
  let fm: Record<string, unknown> = {};
  let body = text;
  if (/^---\r?\n/.test(text)) {
    try {
      const d = parseDoc(text);
      fm = d.frontmatter as unknown as Record<string, unknown>;
      body = d.body;
    } catch {
      // frontmatter present but incomplete: keep keys we can read
      const end = text.indexOf("\n---", 4);
      const YAML = require("yaml");
      try { fm = YAML.parse(text.slice(4, end)) ?? {}; } catch { fm = {}; }
      body = text.slice(end + 4).replace(/^\r?\n/, "");
    }
  }
  if (!body.includes("<Presentation")) throw new Error(`${mdx} does not look like an MDX deck (no <Presentation)`);
  const author = opts.author ?? (typeof fm.author === "string" ? fm.author : undefined) ?? resolveAuthor();
  const id = typeof fm.id === "string" && fm.id ? fm.id : ulid();
  for (const p of listPresentations(dataDir)) if (p.id === id) throw new Error(`id ${id} is already used by presentations/${p.slug}`);
  const full: PresentationFrontmatter = {
    ...(fm as object),
    id, source: "presentation",
    title: opts.title ?? (typeof fm.title === "string" && fm.title ? fm.title : undefined) ?? firstHeading(body) ?? basename(mdx, ".mdx"),
    author,
    created_at: typeof fm.created_at === "string" ? fm.created_at : nowIso(),
    starred: typeof fm.starred === "boolean" ? fm.starred : false,
    provenance: { ...((fm.provenance as object) ?? {}), imported_from: src },
  } as PresentationFrontmatter;
  // stage, copy regular files (assets must not escape the source root), then atomic rename
  mkdirSync(presentationsDir(dataDir), { recursive: true });
  const staging = mkdtempSync(join(presentationsDir(dataDir), `.staging-${opts.slug}-`));
  try {
    if (statSync(src).isDirectory()) {
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (f.startsWith(".")) continue;
          assertRegular(p);
          const real = realpathSync(p);
          if (relative(realpathSync(root), real).startsWith("..")) throw new Error(`${p} escapes the source root`);
          const target = join(staging, relative(root, p));
          if (statSync(p).isDirectory()) {
            mkdirSync(target, { recursive: true });
            walk(p);
          } else if (p !== mdx) cpSync(p, target);
        }
      };
      walk(root);
    }
    writeFileSync(join(staging, "index.mdx"), serializeDoc({ frontmatter: full, body }));
    renameSync(staging, dest);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return parsePresentation(readFileSync(bundlePath(dataDir, opts.slug), "utf8"), opts.slug);
}

/** Turn a captured doc whose body is a deck into a bundle with the same ULID, then delete the doc. */
export function promotePresentation(dataDir: string, docId: string, slug: string, db?: Database): Presentation {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug "${slug}"`);
  const doc = readDocFile(dataDir, docId);
  if (!doc) throw new Error(`doc ${docId} not found`);
  if (!doc.body.includes("<Presentation")) throw new Error(`doc ${docId} is not a deck (no <Presentation in the body)`);
  const dest = join(presentationsDir(dataDir), slug);
  if (existsSync(dest)) throw new Error(`presentations/${slug} already exists`);
  for (const p of listPresentations(dataDir)) if (p.id === docId) throw new Error(`id ${docId} is already used by presentations/${p.slug}`);
  const fm: PresentationFrontmatter = { ...doc.frontmatter, source: "presentation", source_url: undefined, provenance: { promoted_from: `docs/${docId}.md`, original_source: doc.frontmatter.source } } as PresentationFrontmatter;
  const text = serializeDoc({ frontmatter: fm, body: doc.body });
  parsePresentation(text, slug); // validate before deleting the doc
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "index.mdx"), text);
  rmSync(docPath(dataDir, docId));
  if (db) {
    db.run("DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)", [docId]);
    db.run("DELETE FROM chunks WHERE doc_id = ?", [docId]);
    db.run("DELETE FROM documents WHERE id = ?", [docId]);
  }
  return parsePresentation(text, slug);
}

/** Index projection: each bundle → a documents row with source "presentation"; duplicate ids across slugs throw. */
export function indexPresentations(db: Database, dataDir: string, result: ReindexResult): void {
  const seen = new Map<string, string>();
  const ids = new Set<string>();
  db.transaction(() => {
    for (const p of listPresentations(dataDir)) {
      const prev = seen.get(p.id);
      if (prev) throw new Error(`presentation id ${p.id} is used by both presentations/${prev} and presentations/${p.slug}`);
      seen.set(p.id, p.slug);
      ids.add(p.id);
      const text = readFileSync(bundlePath(dataDir, p.slug), "utf8");
      const hash = sha256(text);
      const row = db.query("SELECT file_hash FROM documents WHERE id = ?").get(p.id) as { file_hash: string } | null;
      if (row && row.file_hash === hash) continue;
      const doc: Doc = { frontmatter: { ...p.frontmatter, metadata: { ...(p.frontmatter.metadata ?? {}), slug: p.slug, provenance: p.frontmatter.provenance } }, body: p.body };
      upsertDocRow(db, doc, { fileHash: hash, filePath: p.filePath });
      rebuildChunks(db, p.id, p.body);
      result.presentationsIndexed++;
    }
    for (const r of db.query("SELECT id FROM documents WHERE source = 'presentation'").all() as { id: string }[]) {
      if (!ids.has(r.id)) {
        db.run("DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)", [r.id]);
        db.run("DELETE FROM chunks WHERE doc_id = ?", [r.id]);
        db.run("DELETE FROM documents WHERE id = ?", [r.id]);
        result.reaped++;
      }
    }
  })();
}
registerProjectionHook(indexPresentations);

// ---- deck-viewer discovery ----
export type DeckViewerStatus = { status: "ready"; base: string; sourceId: string } | { status: "not-running" } | { status: "content-not-mounted"; base: string };
/**
 * Optional deck-viewer integration. Any local app that serves the content repo's presentations can be
 * used: set JARVIS_DECK_VIEWER_URL to its base URL. It must answer `GET /api/health` with JSON
 * whose `app` field equals JARVIS_DECK_VIEWER_APP (default "deck-viewer") and `GET /api/contents`
 * with `{sources:[{id, path}]}` listing the mounted directories.
 */
export const DECK_VIEWER_CANDIDATES = () => [process.env.JARVIS_DECK_VIEWER_URL].filter((x): x is string => !!x);
export const DECK_VIEWER_APP = () => process.env.JARVIS_DECK_VIEWER_APP ?? "deck-viewer";

export async function discoverDeckViewer(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<DeckViewerStatus> {
  let real: string;
  try { real = realpathSync(dataDir); } catch { real = resolve(dataDir); }
  for (const base of DECK_VIEWER_CANDIDATES()) {
    try {
      const h = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!h.ok) continue;
      const hj = (await h.json()) as { app?: string };
      if (hj.app !== DECK_VIEWER_APP()) continue;
      const c = await fetchImpl(`${base}/api/contents`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const cj = c.ok ? ((await c.json()) as { sources?: { id: string; path: string }[] }) : { sources: [] };
      const hit = (cj.sources ?? []).find((s) => { try { return realpathSync(s.path) === real; } catch { return resolve(s.path) === real; } });
      return hit ? { status: "ready", base, sourceId: hit.id } : { status: "content-not-mounted", base };
    } catch {}
  }
  return { status: "not-running" };
}
export function launchUrl(l: DeckViewerStatus, slug: string): string | undefined {
  return l.status === "ready" ? `${l.base}/${slug}?source=${encodeURIComponent(l.sourceId)}&path=${encodeURIComponent(`presentations/${slug}`)}` : undefined;
}
