import type { Database } from "bun:sqlite";
import { BROWSE_LIMIT, RECENT_LIMIT } from "./constants.ts";
import { openDb } from "./db.ts";
import { getDocRow, readDocFile, rebuildChunks, upsertDocRow, writeDocFile, type DocRow } from "./docs.ts";
import { resolveAuthor } from "./config.ts";
import { nowIso } from "./util.ts";

export interface ItemSummary {
  id: string;
  source: string;
  title: string;
  author: string;
  created_at: string;
  updated_at: string | null;
  updated_by: string | null;
  source_url: string | null;
  starred: boolean;
  summary: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
}
export interface Item extends ItemSummary {
  body: string;
  proc_version: number;
  file_path: string | null;
}
export interface ItemEdge {
  otherId: string;
  otherTitle: string | null;
  relation: string;
  createdBy: string;
  weight: number | null;
  direction: "out" | "in";
}

export function rowToSummary(r: DocRow): ItemSummary {
  return {
    id: r.id, source: r.source, title: r.title, author: r.author, created_at: r.created_at, updated_at: r.updated_at, updated_by: r.updated_by,
    source_url: r.source_url, starred: !!r.starred, summary: r.summary, tags: r.tags ? JSON.parse(r.tags) : [], metadata: r.metadata ? JSON.parse(r.metadata) : null,
  };
}
export function rowToItem(r: DocRow): Item {
  return { ...rowToSummary(r), body: r.body, proc_version: r.proc_version, file_path: r.file_path };
}

export interface BrowseOpts {
  limit?: number;
  addedOffset?: number;
  updatedOffset?: number;
  source?: string;
  author?: string;
  tag?: string;
  since?: string;
}
export interface BrowseResult {
  added: ItemSummary[];
  updated: ItemSummary[];
  pagination: { added: Page; updated: Page };
  facets: { sources: Facet[]; authors: Facet[]; tags: Facet[] };
}
interface Page {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}
interface Facet {
  value: string;
  count: number;
}

export function browse(dataDir: string, opts: BrowseOpts = {}, dbIn?: Database): BrowseResult {
  const db = dbIn ?? openDb(dataDir);
  try {
    const limit = Math.min(100, Math.max(1, opts.limit ?? BROWSE_LIMIT));
    const addedOffset = Math.max(0, opts.addedOffset ?? 0);
    const updatedOffset = Math.max(0, opts.updatedOffset ?? 0);
    const build = (mode: "added" | "updated") => {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (opts.source) {
        where.push("source = ?");
        params.push(opts.source);
      }
      if (opts.author) {
        where.push(mode === "added" ? "author = ?" : "updated_by = ?");
        params.push(opts.author);
      }
      if (opts.tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(documents.tags) WHERE json_each.value = ?)");
        params.push(opts.tag);
      }
      if (opts.since) {
        where.push(mode === "added" ? "created_at >= ?" : "updated_at >= ?");
        params.push(opts.since);
      }
      if (mode === "updated") where.push("updated_at IS NOT NULL");
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const order = mode === "added" ? "created_at DESC" : "updated_at DESC";
      const offset = mode === "added" ? addedOffset : updatedOffset;
      const total = (db.query(`SELECT count(*) c FROM documents ${w}`).get(...params) as { c: number }).c;
      const rows = db.query(`SELECT * FROM documents ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as DocRow[];
      return { items: rows.map(rowToSummary), page: { offset, limit, total, hasMore: offset + rows.length < total } };
    };
    const added = build("added");
    const updated = build("updated");
    const facet = (sql: string) => (db.query(sql).all() as { value: string; count: number }[]).filter((f) => f.value);
    return {
      added: added.items,
      updated: updated.items,
      pagination: { added: added.page, updated: updated.page },
      facets: {
        sources: facet("SELECT source AS value, count(*) AS count FROM documents GROUP BY source ORDER BY count DESC"),
        authors: facet("SELECT author AS value, count(*) AS count FROM documents GROUP BY author ORDER BY count DESC"),
        tags: facet("SELECT json_each.value AS value, count(*) AS count FROM documents, json_each(documents.tags) WHERE documents.tags IS NOT NULL GROUP BY json_each.value ORDER BY count DESC LIMIT 100"),
      },
    };
  } finally {
    if (!dbIn) db.close();
  }
}

export function recent(dataDir: string, limit = RECENT_LIMIT, dbIn?: Database): ItemSummary[] {
  const db = dbIn ?? openDb(dataDir);
  try {
    return (db.query("SELECT * FROM documents ORDER BY created_at DESC LIMIT ?").all(Math.max(1, limit)) as DocRow[]).map(rowToSummary);
  } finally {
    if (!dbIn) db.close();
  }
}

export function itemBySource(dataDir: string, url: string, dbIn?: Database): ItemSummary | null {
  const db = dbIn ?? openDb(dataDir);
  try {
    const r = db.query("SELECT * FROM documents WHERE source_url = ?").get(url) as DocRow | null;
    return r ? rowToSummary(r) : null;
  } finally {
    if (!dbIn) db.close();
  }
}

export function getItem(dataDir: string, id: string, dbIn?: Database): { item: Item; edges: ItemEdge[] } | null {
  const db = dbIn ?? openDb(dataDir);
  try {
    const r = getDocRow(db, id);
    if (!r) return null;
    const rows = db
      .query(
        `SELECT e.src, e.dst, e.relation, e.created_by, e.weight, d.title AS other_title, en.name AS other_name
         FROM edges e
         LEFT JOIN documents d ON d.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END
         LEFT JOIN entities en ON en.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END
         WHERE e.src = ?1 OR e.dst = ?1 ORDER BY e.weight DESC`,
      )
      .all(id) as { src: string; dst: string; relation: string; created_by: string; weight: number | null; other_title: string | null; other_name: string | null }[];
    const edges: ItemEdge[] = rows.map((e) => ({
      otherId: e.src === id ? e.dst : e.src,
      otherTitle: e.other_title ?? e.other_name,
      relation: e.relation,
      createdBy: e.created_by,
      weight: e.weight,
      direction: e.src === id ? "out" : "in",
    }));
    return { item: rowToItem(r), edges };
  } finally {
    if (!dbIn) db.close();
  }
}

/** Rewrite one authored field group of a doc file and re-index the row (no re-chunk unless body changed). */
function updateDocFile(dataDir: string, id: string, author: string | undefined, mutate: (fm: Record<string, unknown>) => void, dbIn?: Database): void {
  const db = dbIn ?? openDb(dataDir);
  try {
    const doc = readDocFile(dataDir, id);
    if (!doc) throw new Error(`doc ${id} not found`);
    mutate(doc.frontmatter as unknown as Record<string, unknown>);
    doc.frontmatter.updated_at = nowIso();
    doc.frontmatter.updated_by = resolveAuthor(author);
    const { hash } = writeDocFile(dataDir, doc);
    upsertDocRow(db, doc, { fileHash: hash });
    rebuildChunks(db, id, doc.body);
  } finally {
    if (!dbIn) db.close();
  }
}
export function setTags(dataDir: string, id: string, tags: string[], author?: string, db?: Database): void {
  if (!Array.isArray(tags)) throw new Error("tags must be an array");
  const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
  updateDocFile(dataDir, id, author, (fm) => (fm.tags = clean), db);
}
export function setContext(dataDir: string, id: string, context: string, author?: string, db?: Database): void {
  if (typeof context !== "string") throw new Error("context must be a string");
  updateDocFile(dataDir, id, author, (fm) => (fm.metadata = { ...((fm.metadata as object) ?? {}), context }), db);
}
export function setStarred(dataDir: string, id: string, starred: boolean, author?: string, db?: Database): void {
  updateDocFile(dataDir, id, author, (fm) => (fm.starred = !!starred), db);
}
