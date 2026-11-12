import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handle } from "../src/server.ts";
import { ingest } from "../src/core/ingest.ts";
import { openDb } from "../src/core/db.ts";
import { link } from "../src/core/links.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
const ctx = () => ({ dataDir: t.dir });
const call = (method: string, path: string, body?: unknown) =>
  handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx());

beforeEach(() => {
  t = tmpDataDir();
  useFakeEmbedder();
});
afterEach(() => {
  t.cleanup();
  clearEmbedder();
});

describe("http api", () => {
  test("/api/me returns the configured author and nothing when none is configured", async () => {
    const saved = { a: process.env.JARVIS_AUTHOR, h: process.env.JARVIS_HOME };
    try {
      process.env.JARVIS_HOME = t.dir; // no config.toml here: nothing configured
      delete process.env.JARVIS_AUTHOR;
      expect(await (await call("GET", "/api/me")).json()).toEqual({});
      process.env.JARVIS_AUTHOR = "Mia";
      expect(await (await call("GET", "/api/me")).json()).toEqual({ name: "Mia" });
    } finally {
      for (const [k, v] of [["JARVIS_AUTHOR", saved.a], ["JARVIS_HOME", saved.h]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test("health, capture (page-shaped), item-by-source, item, browse, recent, search", async () => {
    let r = await call("GET", "/api/health");
    expect(await r.json()).toEqual({ ok: true, docs: 0 });
    r = await call("POST", "/api/capture", { url: "https://ex.test/a", title: "Page A", content: "Readable page about firmware zoom.", byline: "Jane", capturedAt: "2026-01-01T00:00:00Z", metadata: { dwell_time_seconds: 7 } });
    const cap = await r.json();
    expect(cap.status).toBe("captured");
    r = await call("POST", "/api/capture", { url: "https://ex.test/a", title: "Page A", content: "Readable page about firmware zoom (v2)." });
    expect((await r.json()).status).toBe("updated");
    r = await call("POST", "/api/capture", { title: "no body" });
    expect(r.status).toBe(400);
    r = await call("GET", "/api/item-by-source?url=" + encodeURIComponent("https://ex.test/a"));
    expect((await r.json()).item.id).toBe(cap.id);
    r = await call("GET", `/api/item/${cap.id}`);
    const item = await r.json();
    expect(item.item.source).toBe("web");
    expect(item.item.metadata.source_author).toBe("Jane");
    expect(item.item.metadata.dwell_time_seconds).toBe(7);
    expect(item.edges).toEqual([]);
    expect((await call("GET", "/api/item/nope")).status).toBe(404);
    await ingest(t.dir, { source: "note", title: "N", body: "note body", author: "bob", tags: ["x"] });
    r = await call("GET", "/api/browse?limit=1");
    const b = await r.json();
    expect(b.added.length).toBe(1);
    expect(b.pagination.added.total).toBe(2);
    expect(b.pagination.added.hasMore).toBe(true);
    expect(b.updated.length).toBe(1);
    expect(b.facets.tags).toEqual([{ value: "x", count: 1 }]);
    r = await call("GET", "/api/browse?author=bob");
    expect((await r.json()).added.map((x: any) => x.title)).toEqual(["N"]);
    r = await call("GET", "/api/recent?limit=5");
    expect((await r.json()).items.length).toBe(2);
    r = await call("GET", "/api/search?q=firmware&mode=keyword");
    const hit = (await r.json())[0];
    expect(hit.docId).toBe(cap.id);
    expect(hit.author).toBe(item.item.author);
    expect(hit.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect((await call("GET", "/api/search")).status).toBe(400);
  });

  test("search honours the Browse filters (source, contributor, tag, time) in every mode", async () => {
    const note = await ingest(t.dir, { source: "note", title: "Note", body: "zoom drift in the note", author: "bob", tags: ["ops"] });
    await ingest(t.dir, { source: "paste", title: "Paste", body: "zoom drift in the paste", author: "mia", tags: ["ops"] });
    await ingest(t.dir, { source: "meeting", title: "Meeting", body: "zoom drift in the meeting", author: "bob", tags: ["eng"] });
    const ids = async (qs: string) => ((await (await call("GET", `/api/search?q=zoom%20drift&${qs}`)).json()) as { docId: string }[]).map((h) => h.docId);
    for (const mode of ["keyword", "semantic", "hybrid"]) {
      expect(await ids(`mode=${mode}`)).toHaveLength(3);
      expect(await ids(`mode=${mode}&source=note`)).toEqual([note.id]);
      expect(await ids(`mode=${mode}&author=bob&tag=ops`)).toEqual([note.id]);
      expect(await ids(`mode=${mode}&tag=ops`)).toHaveLength(2);
      expect(await ids(`mode=${mode}&since=2000-01-01T00:00:00Z`)).toHaveLength(3);
      expect(await ids(`mode=${mode}&since=2999-01-01T00:00:00Z`)).toEqual([]);
    }
  });

  test("a filtered search pairs each contributor with their own date, as the Recently columns do", async () => {
    const old = await ingest(t.dir, { source: "web", source_url: "https://ex.test/old", title: "Old", body: "zoom drift old", author: "bob" });
    await ingest(t.dir, { source: "web", source_url: "https://ex.test/old", title: "Old", body: "zoom drift old, edited", author: "mia" });
    const db = openDb(t.dir);
    db.query("UPDATE documents SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(old.id);
    db.close();
    const ids = async (qs: string) => ((await (await call("GET", `/api/search?q=zoom%20drift&mode=keyword&${qs}`)).json()) as { docId: string }[]).map((h) => h.docId);
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect(await ids("author=mia")).toEqual([old.id]); // the last editor counts as a contributor
    expect(await ids(`author=mia&since=${week}`)).toEqual([old.id]); // mia edited it this week
    expect(await ids(`author=bob&since=${week}`)).toEqual([]); // bob only created it, in 2020
    expect(await ids("author=bob&since=2019-01-01T00:00:00Z")).toEqual([old.id]);
  });

  test("Best match's widening along links leaves out linked items the filters exclude", async () => {
    const note = await ingest(t.dir, { source: "note", title: "Note", body: "zoom drift in the note" });
    const other = await ingest(t.dir, { source: "meeting", title: "Standup", body: "nothing about it" });
    link(t.dir, note.id, [other.id]);
    const ids = async (qs: string) => ((await (await call("GET", `/api/search?q=zoom%20drift&mode=hybrid&limit=2&${qs}`)).json()) as { docId: string }[]).map((h) => h.docId);
    expect(await ids("")).toContain(other.id);
    expect(await ids("source=note")).toEqual([note.id]);
  });

  test("tags, context and filters", async () => {
    const r = await ingest(t.dir, { source: "note", title: "N", body: "b", author: "a" });
    expect((await call("POST", `/api/item/${r.id}/tags`, { tags: ["a", "b", "a"], author: "z" })).status).toBe(200);
    expect((await call("POST", `/api/item/${r.id}/context`, { context: "why I saved this", author: "z" })).status).toBe(200);
    const item = (await (await call("GET", `/api/item/${r.id}`)).json()).item;
    expect(item.tags).toEqual(["a", "b"]);
    expect(item.metadata.context).toBe("why I saved this");
    expect(item.updated_by).toBe("z");
    expect((await (await call("GET", "/api/filters")).json()).filters).toEqual([]);
    const f = await (await call("POST", "/api/filters", { pattern: "*.example.com/*", action: "block" })).json();
    expect(f.filters).toEqual([{ pattern: "*.example.com/*", action: "block" }]);
    expect((await call("POST", "/api/filters", { pattern: "x" })).status).toBe(400);
  });
});
