import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIMS } from "./constants.ts";

let customSqliteSet = false;

function candidateSqliteLibs(): string[] {
  const out: string[] = [];
  if (process.platform === "darwin") {
    try {
      const p = Bun.spawnSync(["brew", "--prefix", "sqlite"], { stdout: "pipe", stderr: "ignore" });
      const prefix = new TextDecoder().decode(p.stdout).trim();
      if (prefix) out.push(join(prefix, "lib", "libsqlite3.dylib"));
    } catch {}
    out.push("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib");
  }
  return out;
}

/** On macOS Bun's bundled SQLite refuses extension loading; point it at Homebrew SQLite first. */
export function ensureCustomSqlite(): void {
  if (customSqliteSet) return;
  customSqliteSet = true;
  if (process.env.JARVIS_NO_CUSTOM_SQLITE) return;
  for (const lib of candidateSqliteLibs()) {
    if (existsSync(lib)) {
      try {
        Database.setCustomSQLite(lib);
        return;
      } catch {}
    }
  }
}

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, source_url TEXT, title TEXT, body TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT, updated_by TEXT,
  metadata TEXT, starred INTEGER NOT NULL DEFAULT 0,
  summary TEXT, tags TEXT, proc_version INTEGER NOT NULL DEFAULT 0,
  file_path TEXT, file_hash TEXT NOT NULL, indexed_at TEXT NOT NULL, edged_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_url ON documents(source_url) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_documents_created ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_documents_updated ON documents(updated_at DESC) WHERE updated_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id),
  seq INTEGER NOT NULL, text TEXT NOT NULL, embedded INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_chunks_doc ON chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title, body, summary, tags, content=documents);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body, summary, tags) VALUES (new.rowid, new.title, new.body, new.summary, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body, summary, tags) VALUES ('delete', old.rowid, old.title, old.body, old.summary, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body, summary, tags) VALUES ('delete', old.rowid, old.title, old.body, old.summary, old.tags);
  INSERT INTO documents_fts(rowid, title, body, summary, tags) VALUES (new.rowid, new.title, new.body, new.summary, new.tags);
END;

CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, canonical TEXT,
  aliases TEXT, stub INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, relation TEXT NOT NULL, created_by TEXT NOT NULL,
  weight REAL, created_at TEXT NOT NULL, PRIMARY KEY (src, dst, relation));
CREATE TABLE IF NOT EXISTS edge_rejections (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst));
`;

export function indexDir(dataDir: string): string {
  return join(dataDir, ".index");
}
export function dbPath(dataDir: string): string {
  return join(indexDir(dataDir), "jarvis.db");
}

/**
 * Open the local projection. Callers own the lifecycle: open → work → close. Prepare statements
 * with `db.query()`, never `db.prepare()`: `close()` finalizes cached queries, but a prepared
 * statement nobody finalizes keeps the connection, and its file handle, alive after `close()`,
 * which Windows reports as EBUSY when the data directory is moved or removed.
 */
export function openDb(dataDir: string): Database {
  ensureCustomSqlite();
  mkdirSync(indexDir(dataDir), { recursive: true });
  const db = new Database(dbPath(dataDir), { create: true });
  sqliteVec.load(db);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = OFF");
  db.exec(DDL);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBEDDING_DIMS}])`);
  db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  return db;
}

export function withDb<T>(dataDir: string, fn: (db: Database) => T): T {
  const db = openDb(dataDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export async function withDbAsync<T>(dataDir: string, fn: (db: Database) => Promise<T>): Promise<T> {
  const db = openDb(dataDir);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export function vecVersion(db: Database): string {
  const row = db.query("SELECT vec_version() AS v").get() as { v: string };
  return row.v;
}
