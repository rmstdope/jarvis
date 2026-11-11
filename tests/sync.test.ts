import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ingest } from "../src/core/ingest.ts";
import { git, gitOk } from "../src/core/git.ts";
import { dedupScan, isSyncRunning, sync } from "../src/core/sync.ts";
import { withDb } from "../src/core/db.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";
import { fakeRouter } from "./fakeRouter.ts";
import { startServer } from "../src/server.ts";

let root: ReturnType<typeof tmpDataDir>;
let a: string, b: string, origin: string;

function clone(name: string): string {
  const d = join(root.dir, name);
  gitOk(root.dir, ["clone", "-q", origin, d]);
  gitOk(d, ["config", "user.name", name]);
  gitOk(d, ["config", "user.email", `${name}@test`]);
  return d;
}

beforeEach(() => {
  root = tmpDataDir();
  useFakeEmbedder();
  origin = join(root.dir, "origin.git");
  gitOk(root.dir, ["init", "-q", "--bare", "-b", "main", origin]);
  // seed main with a README so upstream tracking exists
  const seed = join(root.dir, "seed");
  gitOk(root.dir, ["clone", "-q", origin, seed]);
  gitOk(seed, ["config", "user.name", "seed"]);
  gitOk(seed, ["config", "user.email", "seed@test"]);
  writeFileSync(join(seed, "README.md"), "# content\n");
  gitOk(seed, ["add", "README.md"]);
  gitOk(seed, ["commit", "-q", "-m", "init"]);
  gitOk(seed, ["push", "-q", "-u", "origin", "main"]);
  a = clone("a");
  b = clone("b");
});
afterEach(() => {
  root.cleanup();
  clearEmbedder();
});

describe("sync across two clones", () => {
  test("captures converge, .index never tracked, hygiene files maintained", async () => {
    const ra = await ingest(a, { source: "note", title: "From A", body: "alpha", author: "a" });
    const rb = await ingest(b, { source: "note", title: "From B", body: "beta", author: "b" });
    let s = await sync(a);
    expect(s.committed).toBe(1);
    expect(s.pushed).toBe(true);
    s = await sync(b);
    expect(s.pulled).toBe(true);
    expect(s.pushed).toBe(true);
    s = await sync(a);
    expect(s.pulled).toBe(true);
    expect(existsSync(join(a, "docs", `${rb.id}.md`))).toBe(true);
    expect(existsSync(join(b, "docs", `${ra.id}.md`))).toBe(true);
    const docsA = withDb(a, (db) => (db.query("SELECT count(*) c FROM documents").get() as any).c);
    expect(docsA).toBe(2);
    expect(git(a, ["ls-files", ".index"]).stdout).toBe("");
    expect(readFileSync(join(a, ".gitignore"), "utf8")).toContain(".index/");
    expect(readFileSync(join(a, ".gitattributes"), "utf8")).toContain("edges/*.jsonl merge=union");
  });

  test("same URL captured offline on both sides: merges clean, collision reported on both", async () => {
    await ingest(a, { source: "web", title: "P", body: "x", source_url: "https://same.test", author: "a" });
    await ingest(b, { source: "web", title: "P", body: "y", source_url: "https://same.test", author: "b" });
    await sync(a);
    const sb = await sync(b);
    expect(sb.conflicted).toEqual([]);
    expect(sb.collisions.length).toBe(1);
    expect(sb.collisions[0].ids.length).toBe(2);
    const sa = await sync(a);
    expect(sa.collisions.length).toBe(1);
    expect(dedupScan(a).length).toBe(1);
  });

  test("same-doc edit conflict leaves MERGE_HEAD and reports files", async () => {
    const r = await ingest(a, { source: "note", title: "Shared", body: "line", author: "a" });
    await sync(a);
    await sync(b);
    const pa = join(a, "docs", `${r.id}.md`);
    const pb = join(b, "docs", `${r.id}.md`);
    writeFileSync(pa, readFileSync(pa, "utf8").replace("title: Shared", "title: Shared by A"));
    writeFileSync(pb, readFileSync(pb, "utf8").replace("title: Shared", "title: Shared by B"));
    await sync(a);
    const sb = await sync(b);
    expect(sb.conflicted).toEqual([`docs/${r.id}.md`]);
    expect(existsSync(join(b, ".git", "MERGE_HEAD"))).toBe(true);
    const again = await sync(b);
    expect(again.conflicted.length).toBe(1);
  });

  test("union merge of a shared sidecar keeps both lines", async () => {
    const r = await ingest(a, { source: "note", title: "S", body: "s", author: "a" });
    await sync(a);
    await sync(b);
    for (const [d, who] of [[a, "a"], [b, "b"]] as const) {
      mkdirSync(join(d, "edges"), { recursive: true });
      writeFileSync(join(d, "edges", `${r.id}.jsonl`), JSON.stringify({ kind: "edge", src: r.id, dst: `dst-${who}`, relation: "references", created_by: "manual", weight: 1, author: who, created_at: "2026-01-01T00:00:00Z" }) + "\n");
    }
    await sync(a);
    const sb = await sync(b);
    expect(sb.conflicted).toEqual([]);
    const lines = readFileSync(join(b, "edges", `${r.id}.jsonl`), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const edges = withDb(b, (db) => (db.query("SELECT count(*) c FROM edges").get() as any).c);
    expect(edges).toBe(2);
  });

  test("no remote: local-only sync commits and reports", async () => {
    const d = join(root.dir, "solo");
    mkdirSync(d);
    gitOk(d, ["init", "-q", "-b", "main"]);
    gitOk(d, ["config", "user.name", "s"]);
    gitOk(d, ["config", "user.email", "s@test"]);
    await ingest(d, { source: "note", title: "n", body: "n", author: "s" });
    const s = await sync(d);
    expect(s.remote).toBe(false);
    expect(s.committed).toBe(1);
    expect(s.pushed).toBe(false);
  });

  test("a sync whose model step fails still pushes, and says which step failed and why", async () => {
    await ingest(a, { source: "note", title: "Zoom drift", body: "alpha", author: "a" });
    const refused = fakeRouter(() => { throw new Error('Model "gpt-4.1" from --model flag is not available.'); });
    const s = await sync(a, { router: refused });
    expect(s.pushed).toBe(true);
    expect(s.failures).toEqual([{ step: "enrich", failed: 1, reason: 'Model "gpt-4.1" from --model flag is not available.' }]);
  });
});

describe("POST /api/sync through the running service", () => {
  // jv-m9l: Bun.serve closes a request idle for 10 s by default, so a sync slower than that lost its answer:
  // the server committed and pushed while the browser saw a dropped socket and said "Sync failed".
  test("a sync slower than ten seconds still answers with what it did", async () => {
    await ingest(a, { source: "note", title: "Slow", body: "alpha", author: "a" });
    const slow = fakeRouter(async () => { await Bun.sleep(14_000); throw new Error("refused"); });
    const server = startServer({ dataDir: a, router: slow }, 0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/sync`, { method: "POST" });
      const body = (await r.json()) as { pushed: boolean; failures: unknown[] };
      expect(body.pushed).toBe(true);
      expect(body.failures).toEqual([{ step: "enrich", failed: 1, reason: "refused" }]);
    } finally {
      while (isSyncRunning()) await Bun.sleep(100); // the server goes on when the socket drops; let it finish
      server.stop(true);
    }
  }, 30_000);
});
