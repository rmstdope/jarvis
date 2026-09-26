import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handle } from "../src/server.ts";
import { ingest } from "../src/core/ingest.ts";
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
    expect((await r.json())[0].docId).toBe(cap.id);
    expect((await call("GET", "/api/search")).status).toBe(400);
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
