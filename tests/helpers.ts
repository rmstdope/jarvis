import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCustomSqlite } from "../src/core/db.ts";
import { setEmbedderForTests, type Embedder } from "../src/core/embed.ts";
import { EMBEDDING_DIMS } from "../src/core/constants.ts";
import { normalizeVector } from "../src/core/util.ts";
import { setRouterForTests } from "../src/providers/index.ts";

// Keep every test hermetic: no live provider detection unless a test opts in.
setRouterForTests(null);
// …and no live Slidecraft (a developer's running one would leak in): a port nothing listens on.
process.env.JARVIS_SLIDECRAFT_URL = "http://127.0.0.1:1";

/** Every index database under `dir` (one per data dir, at any depth: clones, home, content). */
function indexDbsUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.name === ".index" && existsSync(join(p, "jarvis.db"))) out.push(join(p, "jarvis.db"));
      else walk(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * The databases under `dir` that some connection still holds open. A connection left alive (an
 * unfinalized statement keeps `close()` from closing it) locks the file, which Windows refuses to
 * delete (EBUSY); switching the journal mode needs every other connection gone, so it detects the
 * same leak on every platform.
 */
export function heldDatabases(dir: string): string[] {
  ensureCustomSqlite(); // the first in-process database decides which SQLite library Bun loads
  return indexDbsUnder(dir).filter((f) => {
    const db = new Database(f);
    try {
      db.query("PRAGMA journal_mode = DELETE").get();
      return false;
    } catch {
      return true;
    } finally {
      db.close();
    }
  });
}

/** A temporary data directory; `cleanup` fails the test if an index database was left open. */
export function tmpDataDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  return {
    dir,
    cleanup: () => {
      const held = heldDatabases(dir);
      if (held.length) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {} // Windows: EBUSY, by definition
        throw new Error(`database still open at cleanup: ${held.join(", ")}`);
      }
      // Retries ride out a child process (an ACP agent, git) that Windows still counts in the
      // directory for a moment after it was killed; a leaked database never frees itself.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Deterministic bag-of-words hashing embedder so semantic tests need no server. */
export function fakeEmbedder(available = true): Embedder & { calls: number } {
  const e = {
    name: "fake",
    model: "fake",
    calls: 0,
    async available() {
      return available;
    },
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const v = new Array(1024).fill(0);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % 512] += 1;
        }
        return normalizeVector(v, EMBEDDING_DIMS);
      });
    },
  };
  return e;
}
export function useFakeEmbedder(available = true) {
  const e = fakeEmbedder(available);
  setEmbedderForTests(e);
  return e;
}
export function clearEmbedder() {
  setEmbedderForTests(null);
}
