import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ingest } from "../src/core/ingest.ts";
import { reindex } from "../src/core/reindex.ts";
import { search } from "../src/core/search.ts";
import { withDb, vecVersion } from "../src/core/db.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => {
  t = tmpDataDir();
});
afterEach(() => {
  t.cleanup();
  clearEmbedder();
});

describe("pipeline", () => {
  test("sqlite-vec loads", () => {
    expect(withDb(t.dir, vecVersion)).toMatch(/^v/);
  });

  test("ingest writes a file and indexes + embeds it", async () => {
    const e = useFakeEmbedder();
    const r = await ingest(t.dir, { source: "note", title: "Camera firmware", body: "The camera firmware update fixes the zoom bug.", author: "tester" });
    expect(r.status).toBe("captured");
    expect(r.embedded).toBe(1);
    const files = readdirSync(join(t.dir, "docs"));
    expect(files).toEqual([`${r.id}.md`]);
    const text = readFileSync(join(t.dir, "docs", files[0]), "utf8");
    expect(text).toContain("author: tester");
    expect(text).toContain("source: note");
    const counts = withDb(t.dir, (db) => ({
      docs: (db.query("SELECT count(*) c FROM documents").get() as any).c,
      vec: (db.query("SELECT count(*) c FROM chunks_vec").get() as any).c,
    }));
    expect(counts).toEqual({ docs: 1, vec: 1 });
    expect(e.calls).toBe(1);
  });

  test("source_url dedup updates in place", async () => {
    useFakeEmbedder();
    const a = await ingest(t.dir, { source: "web", title: "Page", body: "v1", source_url: "https://x.test/p", author: "a" });
    const b = await ingest(t.dir, { source: "web", title: "Page", body: "v2", source_url: "https://x.test/p", author: "b" });
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("updated");
    const text = readFileSync(join(t.dir, "docs", `${a.id}.md`), "utf8");
    expect(text).toContain("author: a");
    expect(text).toContain("updated_by: b");
    expect(text).toContain("v2");
    const c = await ingest(t.dir, { source: "web", title: "Page", body: "v2", source_url: "https://x.test/p", author: "c" });
    expect(c.status).toBe("updated");
    expect(readFileSync(join(t.dir, "docs", `${a.id}.md`), "utf8")).toContain("updated_by: b");
  });

  test("ingest without embedding server degrades and reindex catches up", async () => {
    useFakeEmbedder(false);
    const r = await ingest(t.dir, { source: "note", title: "n", body: "some text", author: "a" });
    expect(r.embedded).toBe(0);
    expect(r.embedError).toMatch(/unreachable/);
    useFakeEmbedder(true);
    const ri = await reindex(t.dir);
    expect(ri.docsSkipped).toBe(1);
    expect(ri.chunksEmbedded).toBe(1);
  });

  test("keyword, semantic and hybrid search", async () => {
    useFakeEmbedder();
    await ingest(t.dir, { source: "note", title: "Zoom bug", body: "The camera firmware update fixes the zoom bug on the X1656.", author: "a" });
    await ingest(t.dir, { source: "note", title: "Lunch", body: "Lunch menu for Friday is pasta and salad.", author: "a" });
    const kw = await search(t.dir, "firmware zoom", { mode: "keyword" });
    expect(kw[0].title).toBe("Zoom bug");
    expect(kw[0].snippet).toContain("[firmware]");
    const sem = await search(t.dir, "camera firmware zoom", { mode: "semantic" });
    expect(sem[0].title).toBe("Zoom bug");
    const hy = await search(t.dir, "pasta salad");
    expect(hy[0].title).toBe("Lunch");
    expect(hy.length).toBeLessThanOrEqual(2);
  });

  test("semantic search throws when server unreachable, hybrid degrades", async () => {
    useFakeEmbedder();
    await ingest(t.dir, { source: "note", title: "Zoom bug", body: "The firmware fixes the zoom bug.", author: "a" });
    useFakeEmbedder(false);
    await expect(search(t.dir, "zoom", { mode: "semantic" })).rejects.toThrow(/unreachable/);
    const hy = await search(t.dir, "zoom");
    expect(hy.length).toBe(1);
  });

  test("reindex is incremental, handles malformed files, reaps deleted, and --full rebuilds", async () => {
    const e = useFakeEmbedder();
    const a = await ingest(t.dir, { source: "note", title: "A", body: "alpha text", author: "a" });
    const b = await ingest(t.dir, { source: "note", title: "B", body: "beta text", author: "a" });
    const callsAfter = e.calls;
    let r = await reindex(t.dir);
    expect(r.docsIndexed).toBe(0);
    expect(r.docsSkipped).toBe(2);
    expect(e.calls).toBe(callsAfter);
    // edit file on disk (simulating a pull)
    const p = join(t.dir, "docs", `${a.id}.md`);
    writeFileSync(p, readFileSync(p, "utf8").replace("alpha text", "alpha text changed"));
    writeFileSync(join(t.dir, "docs", "bad.md"), "not a doc");
    rmSync(join(t.dir, "docs", `${b.id}.md`));
    r = await reindex(t.dir);
    expect(r.docsIndexed).toBe(1);
    expect(r.docsMalformed).toBe(1);
    expect(r.reaped).toBe(1);
    expect(r.chunksEmbedded).toBe(1);
    const n = withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM documents").get() as any).c);
    expect(n).toBe(1);
    r = await reindex(t.dir, { full: true });
    expect(r.docsIndexed).toBe(1);
    expect(r.chunksEmbedded).toBe(1);
  });

  test("duplicate source_url from a pull stays unindexed with a warning", async () => {
    useFakeEmbedder();
    const a = await ingest(t.dir, { source: "web", title: "P", body: "x", source_url: "https://d.test", author: "a" });
    const p = join(t.dir, "docs", `${a.id}.md`);
    const dupId = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    writeFileSync(join(t.dir, "docs", `${dupId}.md`), readFileSync(p, "utf8").replace(a.id, dupId));
    const r = await reindex(t.dir);
    expect(r.warnings.some((w) => /duplicate source_url/.test(w))).toBe(true);
  });
});
