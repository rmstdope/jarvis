import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openaiCompatProvider } from "../src/providers/openaiCompat.ts";
import { localProvider, ollamaModels, resetOllamaCache } from "../src/providers/local.ts";
import { copilotProvider } from "../src/providers/copilot.ts";
import { TruncationError } from "../src/providers/types.ts";
import { ollamaEmbedder, omlxEmbedder, embedPending, EmbeddingUnavailableError, setEmbedderForTests } from "../src/core/embed.ts";
import { withDb, withDbAsync } from "../src/core/db.ts";
import { rebuildChunks, upsertDocRow } from "../src/core/docs.ts";
import { tmpDataDir } from "./helpers.ts";

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let responder: (url: string, init?: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  responder = () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as typeof fetch;
  resetOllamaCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setEmbedderForTests(null);
});
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body));

describe("openai-compatible provider", () => {
  test("json mode uses response_format and never reasoning_effort; length → TruncationError; extraBody merged", async () => {
    responder = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }] }));
    const p = openaiCompatProvider("openai-compat", { baseUrl: "http://127.0.0.1:8000/v1/", apiKeyEnv: "SB_TEST_KEY", extraBody: { chat_template_kwargs: { enable_thinking: false } } });
    process.env.SB_TEST_KEY = "k";
    const p2 = openaiCompatProvider("openai-compat", { baseUrl: "http://127.0.0.1:8000/v1/", apiKeyEnv: "SB_TEST_KEY", extraBody: { chat_template_kwargs: { enable_thinking: false } } });
    expect(await p2.complete("m", "hi", { json: true, maxTokens: 50, reasoningEffort: "high" })).toBe('{"a":1}');
    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    const b = bodyOf(calls[0]);
    expect(b).toMatchObject({ model: "m", stream: false, max_tokens: 50, response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } });
    expect(b.reasoning_effort).toBeUndefined();
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    await p2.complete("m", "hi", { reasoningEffort: "low" });
    expect(bodyOf(calls[1]).reasoning_effort).toBe("low");
    expect(bodyOf(calls[1]).response_format).toBeUndefined();
    responder = () => new Response(JSON.stringify({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }));
    await expect(p2.complete("m", "hi")).rejects.toThrow(TruncationError);
    responder = () => new Response("boom", { status: 500 });
    await expect(p2.complete("m", "hi")).rejects.toThrow(/500/);
    void p;
    delete process.env.SB_TEST_KEY;
  });
  test("availability: models probe; a named key env var must be set; no baseUrl → unavailable", async () => {
    responder = () => new Response("{}", { status: 200 });
    delete process.env.OPENAI_API_KEY;
    const oa = { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" };
    expect(await openaiCompatProvider("openai-compat", oa).available("x")).toBe(false);
    process.env.OPENAI_API_KEY = "secret";
    expect(await openaiCompatProvider("openai-compat", oa).available("x")).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://api.openai.com/v1/models");
    expect((calls.at(-1)!.init!.headers as Record<string, string>).authorization).toBe("Bearer secret");
    delete process.env.OPENAI_API_KEY;
    expect(await openaiCompatProvider("openai-compat", { baseUrl: "http://127.0.0.1:8000/v1" }).available("x")).toBe(true); // keyless local server
    expect(await openaiCompatProvider("openai-compat", {}).available("x")).toBe(false);
    responder = () => { throw new Error("refused"); };
    expect(await openaiCompatProvider("openai-compat", { baseUrl: "http://127.0.0.1:1" }).available("x")).toBe(false);
    await expect(openaiCompatProvider("openai-compat", {}).complete("m", "p")).rejects.toThrow(/baseUrl/);
  });
  test("a 4xx with a JSON error body is reported as its error.message, not the raw body", async () => {
    const p = openaiCompatProvider("openai-compat", { baseUrl: "http://127.0.0.1:8000/v1" });
    responder = () => new Response(JSON.stringify({ error: { message: 'Model "gpt-9" is not available' } }), { status: 400 });
    const err = await p.complete("gpt-9", "hi").then(() => null, (e: Error) => e);
    expect(err?.message).toBe('openai-compat chat failed (400): Model "gpt-9" is not available');
    responder = () => new Response("<html>bad gateway</html>", { status: 502 });
    const raw = await p.complete("m", "hi").then(() => null, (e: Error) => e);
    expect(raw?.message).toBe("openai-compat chat failed (502): <html>bad gateway</html>"); // a non-JSON body is kept as text
    responder = () => new Response(JSON.stringify({ error: "model 'x' not found" }), { status: 404 });
    const str = await p.complete("x", "hi").then(() => null, (e: Error) => e);
    expect(str?.message).toBe("openai-compat chat failed (404): model 'x' not found"); // a string error, as LM Studio sends
    responder = () => new Response("", { status: 500, statusText: "Internal Server Error" });
    const empty = await p.complete("m", "hi").then(() => null, (e: Error) => e);
    expect(empty?.message).toBe("openai-compat chat failed (500): Internal Server Error"); // an empty body reads as the status text
  });
});

describe("local (Ollama) provider", () => {
  test("chat body: think:false always, format json on request, num_predict; length → TruncationError", async () => {
    responder = () => new Response(JSON.stringify({ message: { content: "ok" }, done_reason: "stop" }));
    const p = localProvider("http://ollama.test");
    expect(await p.complete("qwen3:8b", "hi", { json: true, maxTokens: 12 })).toBe("ok");
    expect(calls[0].url).toBe("http://ollama.test/api/chat");
    expect(bodyOf(calls[0])).toEqual({ model: "qwen3:8b", messages: [{ role: "user", content: "hi" }], stream: false, think: false, format: "json", options: { num_predict: 12 } });
    await p.complete("qwen3:8b", "hi");
    expect(bodyOf(calls[1]).format).toBeUndefined();
    responder = () => new Response(JSON.stringify({ message: { content: "cut" }, done_reason: "length" }));
    await expect(p.complete("qwen3:8b", "hi")).rejects.toThrow(TruncationError);
    responder = () => new Response("nope", { status: 404 });
    await expect(p.complete("qwen3:8b", "hi")).rejects.toThrow(/404/);
  });
  test("availability from /api/tags with :latest tolerance and a 10 s cache; unreachable → empty", async () => {
    let n = 0;
    responder = () => { n++; return new Response(JSON.stringify({ models: [{ name: "gemma4:26b" }, { name: "qwen3:8b:latest" }] })); };
    const p = localProvider("http://ollama.test");
    expect(await p.available("gemma4:26b")).toBe(true);
    expect(await p.available("qwen3:8b")).toBe(true);
    expect(await p.available("missing")).toBe(false);
    expect(n).toBe(1); // cached
    resetOllamaCache();
    responder = () => { throw new Error("down"); };
    expect(await ollamaModels("http://ollama.test")).toEqual([]);
  });
});

describe("copilot provider", () => {
  test("non-zero exit surfaces stderr; PATH-only availability", async () => {
    const p = copilotProvider(async () => ({ code: 2, stdout: "", stderr: "not logged in" }), () => null);
    expect(await p.available("x")).toBe(false);
    await expect(p.complete("gpt", "p")).rejects.toThrow(/not logged in/);
  });
});

describe("embedders over HTTP", () => {
  test("ollama: /api/embed with truncate, count check, 1024 → 512 normalized", async () => {
    const vec = new Array(1024).fill(0); vec[0] = 3; vec[1] = 4; vec[600] = 99; // dims ≥ 512 are dropped
    responder = () => new Response(JSON.stringify({ embeddings: [vec] }));
    const e = ollamaEmbedder("http://ollama.test", "qwen3-embedding:0.6b");
    const [v] = await e.embed(["hello"]);
    expect(calls[0].url).toBe("http://ollama.test/api/embed");
    expect(bodyOf(calls[0])).toEqual({ model: "qwen3-embedding:0.6b", input: ["hello"], truncate: true });
    expect(v.length).toBe(512);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
    responder = () => new Response(JSON.stringify({ embeddings: [] }));
    await expect(e.embed(["a"])).rejects.toThrow(/count mismatch/);
    responder = () => new Response("x", { status: 503 });
    await expect(e.embed(["a"])).rejects.toThrow(EmbeddingUnavailableError);
    responder = () => new Response("{}", { status: 200 });
    expect(await e.available()).toBe(true);
    expect(calls.at(-1)!.url).toBe("http://ollama.test/api/tags");
  });
  test("omlx: sorts data by index, bearer from env, zero vector normalizes to zero", async () => {
    process.env.OMLX_API_KEY = "tok";
    const unit = (i: number) => { const a = new Array(1024).fill(0); a[i] = 1; return a; };
    responder = () => new Response(JSON.stringify({ data: [{ index: 1, embedding: unit(1) }, { index: 0, embedding: unit(0) }] }));
    const e = omlxEmbedder("http://omlx.test/v1", "Qwen3-Embedding-0.6B-8bit");
    const [a, b] = await e.embed(["x", "y"]);
    expect(a[0]).toBe(1);
    expect(b[1]).toBe(1);
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(bodyOf(calls[0])).toEqual({ model: "Qwen3-Embedding-0.6B-8bit", input: ["x", "y"] });
    responder = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0) }] }));
    const [z] = await e.embed(["zero"]);
    expect(Array.from(z).every((x) => x === 0)).toBe(true);
    delete process.env.OMLX_API_KEY;
  });
  test("embedPending: batches, one transaction per batch, marks embedded, throws when unreachable", async () => {
    const t = tmpDataDir();
    try {
      const seen: number[] = [];
      let available = true;
      setEmbedderForTests({
        name: "batchy", model: "m",
        async available() { return available; },
        async embed(texts) { seen.push(texts.length); return texts.map(() => Float32Array.from(new Array(512).fill(0).map((_, i) => (i === 0 ? 1 : 0)))); },
      });
      const body = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ${"w ".repeat(600)}`).join("\n\n");
      const r = withDb(t.dir, (db) => {
        upsertDocRow(db, { frontmatter: { id: "01D", source: "note", title: "t", author: "a", created_at: "2026-01-01T00:00:00Z" }, body }, { fileHash: "h" });
        rebuildChunks(db, "01D", body);
        return (db.query("SELECT count(*) c FROM chunks").get() as { c: number }).c;
      });
      expect(r).toBeGreaterThan(8);
      const res = await withDbAsync(t.dir, (db) => embedPending(db, { batchSize: 5, concurrency: 2 }));
      expect(res.embedded).toBe(r);
      expect(seen.every((n) => n <= 5)).toBe(true);
      expect(withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM chunks WHERE embedded = 0").get() as { c: number }).c)).toBe(0);
      expect(withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM chunks_vec").get() as { c: number }).c)).toBe(r);
      expect((await withDbAsync(t.dir, (db) => embedPending(db))).embedded).toBe(0); // nothing pending → no availability probe needed
      withDb(t.dir, (db) => db.run("UPDATE chunks SET embedded = 0"));
      available = false;
      await expect(withDbAsync(t.dir, (db) => embedPending(db))).rejects.toThrow(EmbeddingUnavailableError);
    } finally {
      t.cleanup();
    }
  });
});
