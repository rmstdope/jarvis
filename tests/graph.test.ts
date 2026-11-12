import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ingest } from "../src/core/ingest.ts";
import { enrich, dedupeTags, splitPieces } from "../src/core/enrich.ts";
import { computeEdges } from "../src/core/edges.ts";
import { refine } from "../src/core/refine.ts";
import { cleanup, deterministicCleanup } from "../src/core/cleanup.ts";
import { dedupEntities, readEntities, writeEntity } from "../src/core/entities.ts";
import { ask, NO_CONTEXT_ANSWER } from "../src/core/ask.ts";
import { reindex } from "../src/core/reindex.ts";
import { processContent } from "../src/core/sync.ts";
import { readDocFile } from "../src/core/docs.ts";
import { withDb } from "../src/core/db.ts";
import { TruncationError } from "../src/providers/types.ts";
import { fakeRouter, noRouter } from "./fakeRouter.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";
import "../src/core/passes.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => {
  t = tmpDataDir();
  useFakeEmbedder();
});
afterEach(() => {
  t.cleanup();
  clearEmbedder();
});

const enrichRouter = (mentions = true) =>
  fakeRouter((prompt) => {
    const title = prompt.match(/Title: (.*)/)?.[1] ?? "x";
    const item: Record<string, unknown> = { summary: `Summary of ${title}.`, tags: ["Firmware", "firmware", "zoom", "camera", "a", "b", "c", "d", "e", "f"] };
    if (mentions && prompt.includes('"mentions"')) item.mentions = [{ name: "Acorn", kind: "product" }, { name: "Bob", kind: "person" }, { name: "junk", kind: "nope" }];
    return JSON.stringify({ items: [item] });
  });

describe("enrich", () => {
  test("writes summary/tags/mentions, creates stubs, reuses them, proc_version last", async () => {
    const a = await ingest(t.dir, { source: "note", title: "Doc A", body: "Acorn is great says Bob.", author: "me" });
    const b = await ingest(t.dir, { source: "note", title: "Doc B", body: "More about Acorn.", author: "me" });
    const r = await enrich(t.dir, enrichRouter());
    expect(r.enriched).toBe(2);
    expect(r.stubsCreated).toBe(2);
    const doc = readDocFile(t.dir, a.id)!;
    expect(doc.frontmatter.summary).toBe("Summary of Doc A.");
    expect(doc.frontmatter.tags).toEqual(["Firmware", "zoom", "camera", "a", "b", "c", "d", "e"]);
    expect(doc.frontmatter.mentions!.map((m) => m.name)).toEqual(["Acorn", "Bob"]);
    expect(doc.frontmatter.proc_version).toBe(1);
    const text = readFileSync(join(t.dir, "docs", `${a.id}.md`), "utf8");
    expect(text.indexOf("proc_version")).toBeGreaterThan(text.indexOf("mentions"));
    const docB = readDocFile(t.dir, b.id)!;
    expect(docB.frontmatter.mentions![0].entity).toBe(doc.frontmatter.mentions![0].entity);
    expect(readdirSync(join(t.dir, "entities")).length).toBe(2);
    const ent = readEntities(t.dir).find((e) => e.name === "Acorn")!;
    expect(ent).toMatchObject({ kind: "product", stub: true, created_by: "me" });
    // second run: nothing pending
    expect((await enrich(t.dir, enrichRouter())).enriched).toBe(0);
    // index row carries summary
    const row = withDb(t.dir, (db) => db.query("SELECT summary, proc_version FROM documents WHERE id = ?").get(a.id) as any);
    expect(row).toEqual({ summary: "Summary of Doc A.", proc_version: 1 });
  });
  test("no model → skipped; empty body → stamped; truncation → summary-only fallback without retry", async () => {
    await ingest(t.dir, { source: "note", title: "Doc", body: "text", author: "me" });
    const skipped = await enrich(t.dir, noRouter);
    expect(skipped.skipped).toBe(1);
    const empty = await ingest(t.dir, { source: "pdf", title: "Empty", body: "", author: "me" });
    let calls = 0;
    const r = await enrich(t.dir, fakeRouter((prompt) => {
      calls++;
      if (prompt.includes('"mentions"')) throw new TruncationError();
      return JSON.stringify({ items: [{ summary: "s", tags: ["t"] }] });
    }));
    expect(r.enriched).toBe(2);
    expect(calls).toBe(2); // one truncated full call + one summary-only; the empty doc calls nothing
    expect(readDocFile(t.dir, empty.id)!.frontmatter.proc_version).toBe(1);
    expect(readDocFile(t.dir, empty.id)!.frontmatter.summary).toBeUndefined();
  });
  test("helpers", () => {
    expect(dedupeTags(["A", "a", "b"])).toEqual(["A", "b"]);
    const pieces = splitPieces("x".repeat(95) + "\n" + "y".repeat(50), 100);
    expect(pieces[0].length).toBe(96);
    expect(pieces.length).toBe(2);
  });
});

describe("edges", () => {
  test("backlink, auto, entity and embedding producers with the shared write rule", async () => {
    const a = await ingest(t.dir, { source: "note", title: "Zoom Drift Fix", body: "The camera firmware update fixes zoom drift.", author: "me", tags: ["firmware", "zoom"] });
    const b = await ingest(t.dir, { source: "note", title: "Release notes", body: "See Zoom Drift Fix for details. camera firmware update zoom", author: "me", tags: ["firmware", "zoom", "release"] });
    const c = await ingest(t.dir, { source: "note", title: "Lunch", body: "pasta salad", author: "me", tags: ["food"] });
    await ingest(t.dir, { source: "note", title: "Patch notes", body: "unrelated wording entirely", author: "me", tags: ["firmware", "zoom"] });
    await ingest(t.dir, { source: "note", title: "Untagged twin", body: "The camera firmware update fixes zoom drift.", author: "me" });
    mkdirSync(join(t.dir, "entities"), { recursive: true });
    writeEntity(t.dir, { id: "01ENTITY000000000000000000", name: "Acorn", kind: "product", canonical: "01ENTITY000000000000000000", aliases: [], stub: false, created_by: "me", created_at: "" });
    const pb = join(t.dir, "docs", `${b.id}.md`);
    writeFileSync(pb, readFileSync(pb, "utf8").replace("tags:", "mentions:\n  - name: Acorn\n    kind: product\n    entity: 01ENTITY000000000000000000\ntags:"));
    await reindex(t.dir);
    const r = computeEdges(t.dir);
    expect(r.docs).toBe(5);
    expect(r.backlink).toBe(1);
    expect(r.entity).toBe(1);
    expect(r.auto).toBeGreaterThanOrEqual(1);
    expect(r.embedding).toBeGreaterThanOrEqual(1);
    const rows = withDb(t.dir, (db) => db.query("SELECT src, dst, relation, created_by FROM edges ORDER BY created_by, src").all() as any[]);
    expect(rows.find((e) => e.created_by === "backlink")).toMatchObject({ src: b.id, dst: a.id, relation: "references" });
    expect(rows.find((e) => e.created_by === "entity")).toMatchObject({ src: b.id, dst: "01ENTITY000000000000000000", relation: "mentions" });
    // no self edges, no duplicate pair in both directions
    for (const e of rows) expect(e.src).not.toBe(e.dst);
    const pairs = rows.map((e) => [e.src, e.dst].sort().join());
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(computeEdges(t.dir).docs).toBe(0); // idempotent: stamped
    // a rejection blocks resurrection
    withDb(t.dir, (db) => {
      db.run("INSERT INTO edge_rejections VALUES (?, ?)", [a.id, b.id]);
      db.run("DELETE FROM edges");
    });
    computeEdges(t.dir, { ids: [b.id] });
    const after = withDb(t.dir, (db) => db.query("SELECT count(*) c FROM edges WHERE (src=? AND dst=?) OR (src=? AND dst=?)").get(a.id, b.id, b.id, a.id) as any);
    expect(after.c).toBe(0);
    void c;
  });
});

describe("refine", () => {
  test("keeps and drops embedding candidates into the sidecar; hallucinated and malformed counted", async () => {
    const a = await ingest(t.dir, { source: "note", title: "A", body: "camera firmware zoom drift fix", author: "me" });
    const b = await ingest(t.dir, { source: "note", title: "B", body: "camera firmware zoom drift notes", author: "me" });
    const c = await ingest(t.dir, { source: "note", title: "C", body: "camera firmware zoom drift again", author: "me" });
    computeEdges(t.dir);
    const before = withDb(t.dir, (db) => db.query("SELECT src, dst FROM edges WHERE created_by='embedding' ORDER BY src, dst").all() as { src: string; dst: string }[]);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const r0 = await refine(t.dir, noRouter);
    expect(r0.skipped).toMatch(/no edge-judge/);
    const [p1, p2] = before;
    const r = await refine(t.dir, fakeRouter(() => JSON.stringify({ results: [
      { reasoning: "same", src: p1.src, dst: p1.dst, keep: true, relation: "bogus" },
      { reasoning: "no", src: p2.src, dst: p2.dst, keep: false },
      { reasoning: "made up", src: "nope", dst: "nope2", keep: true, relation: "same_topic" },
    ] })));
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(1);
    expect(r.hallucinated).toBe(1);
    const side = readFileSync(join(t.dir, "edges", `${p1.src}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(side.find((l) => l.dst === p1.dst)).toMatchObject({ kind: "edge", created_by: "llm", relation: "same_topic", model: "fake:model" });
    const idx = withDb(t.dir, (db) => ({
      llm: (db.query("SELECT count(*) c FROM edges WHERE created_by='llm'").get() as any).c,
      rej: (db.query("SELECT count(*) c FROM edge_rejections").get() as any).c,
      embForKept: (db.query("SELECT count(*) c FROM edges WHERE created_by='embedding' AND src=? AND dst=?").get(p1.src, p1.dst) as any).c,
    }));
    expect(idx).toMatchObject({ llm: 1, rej: 1, embForKept: 0 });
    // malformed batch: pending pairs untouched
    const r2 = await refine(t.dir, fakeRouter(() => "not json"));
    expect(r2.malformedBatches).toBe(r2.candidates > 0 ? 1 : 0);
    // judged pairs are not re-judged
    const r3 = await refine(t.dir, fakeRouter(() => JSON.stringify({ results: [] })));
    expect(r3.candidates).toBe(before.length - 2);
    // after a full reindex the sidecar is mirrored back
    await reindex(t.dir, { full: true });
    const mirrored = withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM edges WHERE created_by='llm'").get() as any).c);
    expect(mirrored).toBe(1);
    void a; void b; void c;
  });
});

describe("cleanup", () => {
  test("deterministic glossary fixes and stamping", async () => {
    mkdirSync(join(t.dir, "config"));
    writeFileSync(join(t.dir, "config", "glossary.toml"), '[products]\n# Misheard as: "a corn", "ay corn"\nAcorn = "platform"\n# Misheard as: "stream lite"\nStreamlite = "compression"\n');
    const m = await ingest(t.dir, { source: "meeting", title: "T", body: "Anna: we use a corn and Stream Lite. A CORN! scrap is fine.", author: "me" });
    const d = deterministicCleanup("a corn, ay corn; scrap", { entries: [{ term: "Acorn", description: "", section: "p", variants: ["a corn", "ay corn"] }] });
    expect(d.text).toBe("Acorn, Acorn; scrap");
    expect(d.fixes).toEqual(["ay corn → Acorn (1)", "a corn → Acorn (1)"]);
    const r = await cleanup(t.dir, noRouter);
    expect(r.cleaned).toBe(1);
    const doc = readDocFile(t.dir, m.id)!;
    expect(doc.body.trim()).toBe("Anna: we use Acorn and Streamlite. Acorn! scrap is fine.");
    expect(doc.frontmatter.metadata!.cleanup_version).toBe(1);
    expect((await cleanup(t.dir, noRouter)).cleaned).toBe(0);
  });
  test("llm layer guards short/empty output", async () => {
    mkdirSync(join(t.dir, "config"));
    writeFileSync(join(t.dir, "config", "glossary.toml"), '[products]\n# Misheard as: "a corn"\nAcorn = "platform"\n');
    const m = await ingest(t.dir, { source: "meeting", title: "T", body: "Anna: a corn is nice and we hadn't looked at it yet.", author: "me" });
    const r = await cleanup(t.dir, fakeRouter(() => "short"), { llm: true });
    expect(r.cleaned).toBe(1);
    expect(readDocFile(t.dir, m.id)!.body.trim()).toBe("Anna: Acorn is nice and we hadn't looked at it yet.");
    expect(readDocFile(t.dir, m.id)!.frontmatter.metadata!.cleanup).toMatchObject({ llm_model: "fake:model" });
  });
});

describe("entities dedup", () => {
  test("union-find on (kind, term); survivor is smallest ULID; kinds never merge", () => {
    const e = (id: string, name: string, kind: "product" | "person", aliases: string[] = []) => writeEntity(t.dir, { id, name, kind, canonical: id, aliases, stub: true, created_by: "x", created_at: "" });
    e("01B", "acorn", "product");
    e("01A", "Acorn", "product", ["Acorn Application Platform"]);
    e("01C", "Camera platform", "product", ["acorn application platform"]);
    e("01D", "Acorn", "person");
    const dry = dedupEntities(t.dir, { dryRun: true });
    expect(dry.merged).toEqual([{ survivor: "01A", into: ["01B", "01C"] }]);
    expect(readEntities(t.dir).find((x) => x.id === "01B")!.canonical).toBe("01B");
    dedupEntities(t.dir);
    const all = readEntities(t.dir);
    expect(all.find((x) => x.id === "01B")!.canonical).toBe("01A");
    expect(all.find((x) => x.id === "01C")!.canonical).toBe("01A");
    expect(all.find((x) => x.id === "01D")!.canonical).toBe("01D");
    expect(dedupEntities(t.dir).merged).toEqual([]);
  });
});

describe("ask", () => {
  test("grounded answer with citations; canned answer without context", async () => {
    const r0 = await ask(t.dir, noRouter, "anything?");
    expect(r0).toEqual({ answer: NO_CONTEXT_ANSWER, model: "none", citations: [] });
    const a = await ingest(t.dir, { source: "note", title: "Zoom", body: "Firmware 11.8 fixes zoom drift.", author: "me" });
    let seen = "";
    const r = await ask(t.dir, fakeRouter((p) => { seen = p; return `Fixed in 11.8 [${a.id}]`; }), "what fixes zoom drift?");
    expect(r.model).toBe("fake:model");
    expect(r.citations[0].docId).toBe(a.id);
    expect(seen).toContain(`[${a.id}] Zoom`);
    expect(seen).toContain("Question: what fixes zoom drift?");
    expect(r.skipped).toBeUndefined();
  });

  test("no chat model skips synthesis: the matching items and a fix line naming the models file in use (jv-leu)", async () => {
    const a = await ingest(t.dir, { source: "note", title: "Zoom", body: "Firmware 11.8 fixes zoom drift.", author: "me" });
    const prev = process.env.JARVIS_MODELS;
    process.env.JARVIS_MODELS = join(t.dir, "elsewhere", "models.toml");
    try {
      const r = await ask(t.dir, noRouter, "zoom drift?");
      expect(r.model).toBe("none");
      expect(r.citations.map((c) => c.docId)).toEqual([a.id]);
      expect(r.skipped).toContain(join(t.dir, "elsewhere", "models.toml"));
      expect(r.skipped).not.toContain("~/.jarvis");
    } finally {
      if (prev === undefined) delete process.env.JARVIS_MODELS;
      else process.env.JARVIS_MODELS = prev;
    }
  });
});

describe("process pipeline with passes", () => {
  test("enrich → reindex → edges → refine, with counts", async () => {
    await ingest(t.dir, { source: "note", title: "Doc A", body: "Acorn is great says Bob.", author: "me" });
    await ingest(t.dir, { source: "note", title: "Doc B", body: "Acorn is great says Bob again.", author: "me" });
    const router = fakeRouter((prompt, _o, task) => {
      if (task.kind === "edge-judge") return JSON.stringify({ results: [] });
      return enrichRouter().resolve({ kind: "summary" })!.complete(prompt);
    });
    const r = await processContent(t.dir, { router });
    expect((r.counts.enrich as any).enriched).toBe(2);
    expect(r.enrichedFiles).toBe(true);
    expect(r.reindexedAgain).toBeDefined();
    expect((r.counts.edges as any).entity).toBe(4);
    expect((r.counts.edges as any).auto).toBeGreaterThanOrEqual(1);
    expect(r.counts.refine).toBeDefined();
    expect(existsSync(join(t.dir, "entities"))).toBe(true);
    // consumer machines skip authoring passes
    mkdirSync(join(t.dir, "config"), { recursive: true });
    writeFileSync(join(t.dir, "config", "team.toml"), '[projection]\nmode = "published"\n');
    const r2 = await processContent(t.dir, { router });
    expect(r2.counts.enrich).toBeUndefined();
  });

  test("a refused edge-judge is reported as a refine failure with doctor's fix; a garbled answer without it (jv-m9l)", async () => {
    for (const w of ["fix", "notes", "again"]) await ingest(t.dir, { source: "note", title: w, body: `camera firmware zoom drift ${w}`, author: "me" });
    const refusal = 'Model "gpt-4.1" from --model flag is not available.';
    const r = await processContent(t.dir, { router: fakeRouter(() => { throw new Error(refusal); }, ["edge-judge"]) });
    expect(r.failures).toEqual([{ step: "refine", failed: 1, reason: refusal, doctor: true }]);
    const r2 = await processContent(t.dir, { router: fakeRouter(() => "not json", ["edge-judge"]) });
    expect(r2.failures).toEqual([{ step: "refine", failed: 1, reason: expect.any(String), doctor: false }]);
  });
});
