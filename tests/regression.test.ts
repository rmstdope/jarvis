import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDoc, serializeDoc, FrontmatterError } from "../src/core/frontmatter.ts";
import { ingest } from "../src/core/ingest.ts";
import { enrich } from "../src/core/enrich.ts";
import { writeEntity, readEntities } from "../src/core/entities.ts";
import { readDocFile } from "../src/core/docs.ts";
import { search } from "../src/core/search.ts";
import { link } from "../src/core/links.ts";
import { sync } from "../src/core/sync.ts";
import { gitOk } from "../src/core/git.ts";
import { browse } from "../src/core/browse.ts";
import { resolveAuthor, resolveDataDir, resolvePort, loadTeamConfig, isConsumer, resetConfigCache, saveConfig } from "../src/core/config.ts";
import { readFilters } from "../src/core/filters.ts";
import { ask } from "../src/core/ask.ts";
import { reindex } from "../src/core/reindex.ts";
import { doctor } from "../src/core/doctor.ts";
import { AcpClient } from "../src/chat/acp.ts";
import { parseArgs, flagInt } from "../src/core/args.ts";
import { withDb } from "../src/core/db.ts";
import { TruncationError } from "../src/providers/types.ts";
import { fakeRouter } from "./fakeRouter.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { t.cleanup(); clearEmbedder(); });

describe("frontmatter edge cases", () => {
  test("unquoted dates become ISO strings, task dates normalize, extra keys survive, malformed YAML is explicit", () => {
    const d = parseDoc("---\nid: 01A\nsource: task\ntitle: T\nauthor: a\ncreated_at: 2026-01-02T03:04:05Z\ntask:\n  status: open\n  owner: a\n  due: 2026-10-01\nprovenance:\n  imported_from: x\n---\nbody");
    expect(d.frontmatter.created_at).toBe("2026-01-02T03:04:05Z"); // yaml 2.x core schema keeps timestamps as strings
    expect(d.frontmatter.task!.due).toBe("2026-10-01");
    expect((d.frontmatter as { provenance?: unknown }).provenance).toEqual({ imported_from: "x" });
    const out = serializeDoc(d);
    expect(out.indexOf("provenance")).toBeGreaterThan(out.indexOf("task:"));
    expect(parseDoc(out).frontmatter).toEqual(d.frontmatter);
    expect(() => parseDoc("---\nid: [unclosed\n---\n")).toThrow(FrontmatterError);
    expect(() => parseDoc("---\n- a list\n---\n")).toThrow(/mapping/);
    expect(() => parseDoc("no frontmatter")).toThrow(/opening/);
    expect(() => parseDoc("---\nid: x\n")).toThrow(/closing/);
    expect(parseDoc("---\nid: 1\nsource: note\ntitle: 2\nauthor: 3\ncreated_at: 2026-01-01\n---\n").frontmatter.id).toBe("1");
  });
});

describe("enrich: map-reduce and mention resolution", () => {
  test("bodies over 80k are extracted per piece, truncation is sticky, then reduced", async () => {
    const body = Array.from({ length: 1900 }, (_, i) => `Line ${i} of a long document about zoom drift.`).join("\n");
    expect(body.length).toBeGreaterThan(80_000);
    const doc = await ingest(t.dir, { source: "note", title: "Long", body, author: "me" });
    const prompts: string[] = [];
    const r = await enrich(t.dir, fakeRouter((p) => {
      prompts.push(p);
      if (prompts.length === 1 && p.includes('"mentions"')) throw new TruncationError();
      return JSON.stringify({ items: [{ summary: `part ${prompts.length}`, tags: [`t${prompts.length}`], mentions: [{ name: "Zoom", kind: "concept" }] }] });
    }));
    expect(r.enriched).toBe(1);
    // piece 1 full (truncated) → piece 1 summary-only → piece 2 summary-only (sticky) → reduce
    expect(prompts.length).toBe(4);
    expect(prompts[2]).not.toContain('"mentions"');
    expect(prompts[3]).toContain("part 2");
    const fm = readDocFile(t.dir, doc.id)!.frontmatter;
    expect(fm.summary).toBe("part 4");
    expect(fm.tags).toEqual(["t2", "t3", "t4"]);
    expect(fm.mentions).toEqual([]); // both pieces ran summary-only
  });
  test("resolution steps: glossary variant, alias, cosine, single owner across kinds, homonym → stub", async () => {
    mkdirSync(join(t.dir, "config"));
    writeFileSync(join(t.dir, "config", "glossary.toml"), '[products]\n# Misheard as: "a corn"\nAcorn = "platform"\n');
    const e = (id: string, name: string, kind: "product" | "person" | "team" | "concept", aliases: string[] = []) => writeEntity(t.dir, { id, name, kind, canonical: id, aliases, stub: false, created_by: "x", created_at: "" });
    e("01ACORN000000000000000000A", "Acorn", "product");
    e("01ZIP00000000000000000000A", "Streamlite", "product", ["Acorn Streamlite"]);
    e("01FW000000000000000000000A", "camera firmware", "concept");
    e("01HOMO0000000000000000000A", "Mercury", "product");
    e("01HOMO0000000000000000000B", "Mercury", "team");
    await ingest(t.dir, { source: "note", title: "N", body: "b", author: "me" });
    const r = await enrich(t.dir, fakeRouter(() => JSON.stringify({ items: [{ summary: "s", tags: ["x"], mentions: [
      { name: "a corn", kind: "product" },          // glossary variant → Acorn
      { name: "acorn streamlite", kind: "product" }, // alias
      { name: "firmware camera", kind: "concept" }, // cosine (same bag of words) ≥ 0.85
      { name: "streamlite", kind: "concept" },      // single owner of the term, different kind
      { name: "Mercury", kind: "person" },         // homonym across kinds → stub
    ] }] })));
    expect(r.enriched).toBe(1);
    const docId = withDb(t.dir, (db) => (db.query("SELECT id FROM documents").get() as { id: string }).id);
    const m = readDocFile(t.dir, docId)!.frontmatter.mentions!;
    expect(m.map((x) => x.entity)).toEqual(["01ACORN000000000000000000A", "01ZIP00000000000000000000A", "01FW000000000000000000000A", "01ZIP00000000000000000000A", expect.stringMatching(/^[0-9A-Z]{26}$/)]);
    expect(r.stubsCreated).toBe(1);
    const stub = readEntities(t.dir).find((x) => x.name === "Mercury" && x.kind === "person")!;
    expect(stub.stub).toBe(true);
    expect(stub.created_by).toBe("me");
  });
});

describe("search: fusion and graph expansion", () => {
  test("hybrid folds in graph neighbours of keyword hits and ranks the direct hit first", async () => {
    const a = await ingest(t.dir, { source: "note", title: "Zoom drift report", body: "zoom drift report firmware", author: "me" });
    const c = await ingest(t.dir, { source: "note", title: "Canteen menu", body: "pasta salad soup", author: "me" });
    await ingest(t.dir, { source: "note", title: "Unrelated", body: "quarterly budget spreadsheet", author: "me" });
    link(t.dir, a.id, [c.id], { relation: "references" });
    const hits = await search(t.dir, "zoom drift report", { limit: 5 });
    expect(hits[0].docId).toBe(a.id);
    expect(hits.map((h) => h.docId)).toContain(c.id);
    const kw = await search(t.dir, "zoom drift report", { mode: "keyword" });
    expect(kw.map((h) => h.docId)).not.toContain(c.id);
    expect((await search(t.dir, 'he said "hello"', { mode: "keyword" })).length).toBe(0); // embedded quotes are escaped, not a syntax error
  });
});

describe("sync edge cases", () => {
  function twoClones() {
    const origin = join(t.dir, "origin.git");
    gitOk(t.dir, ["init", "-q", "--bare", "-b", "main", origin]);
    const mk = (n: string) => {
      const d = join(t.dir, n);
      gitOk(t.dir, ["clone", "-q", origin, d]);
      gitOk(d, ["config", "user.name", n]);
      gitOk(d, ["config", "user.email", `${n}@test`]);
      return d;
    };
    const seed = mk("seed");
    writeFileSync(join(seed, "README.md"), "x");
    gitOk(seed, ["add", "README.md"]);
    gitOk(seed, ["commit", "-q", "-m", "init"]);
    gitOk(seed, ["push", "-q", "-u", "origin", "main"]);
    return { a: mk("a"), b: mk("b") };
  }
  test("non-fast-forward push is retried after a second pull; commit messages count items", async () => {
    const { a, b } = twoClones();
    await ingest(a, { source: "note", title: "A", body: "a", author: "a" });
    // A pre-push hook that, once, lets B push first so A's push is rejected as non-fast-forward.
    const hook = join(a, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${a}/.git/once" ]; then touch "${a}/.git/once"; cd "${b}" && git commit -q --allow-empty -m "b moved" && git push -q; fi\nexit 0\n`);
    chmodSync(hook, 0o755);
    const s = await sync(a);
    expect(s.pushed).toBe(true);
    expect(s.committed).toBe(1);
    const log = gitOk(a, ["log", "--oneline"]);
    expect(log).toContain("jarvis: capture 1 item(s)");
    expect(log).toContain("b moved");
    gitOk(b, ["pull", "-q", "--no-rebase"]);
    expect(existsSync(join(b, "docs"))).toBe(true);
  });
  test("missing git identity is an actionable error; unresolved conflicts stop before committing", async () => {
    const d = join(t.dir, "solo");
    mkdirSync(d);
    gitOk(d, ["init", "-q", "-b", "main"]);
    await ingest(d, { source: "note", title: "n", body: "n", author: "s" });
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = join(t.dir, "empty-gitconfig");
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      await expect(sync(d)).rejects.toThrow(/git identity missing/);
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.n;
    }
    await expect(sync(join(t.dir, "not-a-repo-at-all"))).rejects.toThrow(/not a git work tree/);
  });
});

describe("browse filters and config precedence", () => {
  test("tag, since and updated_by filters; facets", async () => {
    const x = await ingest(t.dir, { source: "web", title: "X", body: "x", author: "ann", tags: ["alpha", "beta"], source_url: "https://x.test" });
    await ingest(t.dir, { source: "note", title: "Y", body: "y", author: "bob", tags: ["beta"] });
    await ingest(t.dir, { source: "web", title: "X2", body: "x changed", author: "kim", source_url: "https://x.test" });
    expect(browse(t.dir, { tag: "alpha" }).added.map((i) => i.id)).toEqual([x.id]);
    expect(browse(t.dir, { tag: "beta" }).added.length).toBe(2);
    expect(browse(t.dir, { source: "note" }).added.map((i) => i.title)).toEqual(["Y"]);
    expect(browse(t.dir, { author: "kim" }).updated.map((i) => i.id)).toEqual([x.id]);
    expect(browse(t.dir, { author: "kim" }).added.length).toBe(0);
    expect(browse(t.dir, { since: "2999-01-01T00:00:00Z" }).added.length).toBe(0);
    const f = browse(t.dir).facets;
    expect(f.sources.map((s) => s.value).sort()).toEqual(["note", "web"]);
    expect(f.tags.find((g) => g.value === "beta")!.count).toBe(2);
    expect(browse(t.dir, { limit: 1000 }).pagination.added.limit).toBe(100);
  });
  test("author/data/port precedence and team policy", () => {
    const saved = { h: process.env.JARVIS_HOME, a: process.env.JARVIS_AUTHOR, d: process.env.JARVIS_DATA };
    process.env.JARVIS_HOME = join(t.dir, "home");
    delete process.env.JARVIS_AUTHOR;
    delete process.env.JARVIS_DATA;
    resetConfigCache();
    try {
      expect(() => resolveDataDir()).toThrow(/jarvis init/);
      saveConfig({ author: "cfg", dataDir: "/cfg/data", port: 9000 });
      expect(resolveAuthor()).toBe("cfg");
      expect(resolveDataDir()).toBe("/cfg/data");
      expect(resolvePort()).toBe(9000);
      process.env.JARVIS_AUTHOR = "env";
      process.env.JARVIS_DATA = "/env/data";
      expect(resolveAuthor()).toBe("env");
      expect(resolveDataDir()).toBe("/env/data");
      expect(resolveAuthor("explicit")).toBe("explicit");
      expect(resolveDataDir("/explicit")).toBe("/explicit");
      expect(resolvePort("abc")).toBe(7281);
      expect(loadTeamConfig(t.dir).projection.mode).toBe("local");
      mkdirSync(join(t.dir, "config"), { recursive: true });
      writeFileSync(join(t.dir, "config", "team.toml"), '[projection]\nmode = "published"\n');
      expect(loadTeamConfig(t.dir).projection.mode).toBe("published");
      expect(isConsumer(t.dir)).toBe(true);
      saveConfig({ projectionRole: "publisher" });
      expect(isConsumer(t.dir)).toBe(false);
      writeFileSync(join(t.dir, "config", "team.toml"), "not toml [[[");
      expect(loadTeamConfig(t.dir).projection.mode).toBe("local");
    } finally {
      for (const [k, v] of [["JARVIS_HOME", saved.h], ["JARVIS_AUTHOR", saved.a], ["JARVIS_DATA", saved.d]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      resetConfigCache();
    }
  });
  test("malformed filters.json is treated as empty", () => {
    writeFileSync(join(t.dir, "filters.json"), "{not json");
    expect(readFilters(t.dir)).toEqual([]);
    writeFileSync(join(t.dir, "filters.json"), JSON.stringify([{ pattern: "x", action: "block" }, { pattern: 1 }, { pattern: "y", action: "maybe" }]));
    expect(readFilters(t.dir)).toEqual([{ pattern: "x", action: "block" }]);
  });
});

describe("ask context budget, reindex warnings, doctor optional checks", () => {
  test("ask caps context at the budget and still cites", async () => {
    const big = await ingest(t.dir, { source: "note", title: "Big", body: "zoom ".repeat(6000), author: "me" });
    let prompt = "";
    const r = await ask(t.dir, fakeRouter((p) => { prompt = p; return "ok"; }), "zoom?", { contextChars: 5000 });
    expect(r.citations[0].docId).toBe(big.id);
    expect(prompt.length).toBeLessThan(5000 + 400);
  });
  test("reindex counts malformed sidecar lines and warns on bad entities and id mismatches", async () => {
    await ingest(t.dir, { source: "note", title: "n", body: "n", author: "me" });
    mkdirSync(join(t.dir, "edges"));
    writeFileSync(join(t.dir, "edges", "x.jsonl"), '{"kind":"edge","src":"a","dst":"b","relation":"references","created_by":"manual","weight":3}\nnot json\n{"kind":"what"}\n{"kind":"rejection","src":"a","dst":"c"}\n');
    mkdirSync(join(t.dir, "entities"));
    writeFileSync(join(t.dir, "entities", "bad.json"), "{");
    writeFileSync(join(t.dir, "docs", "01WRONGIDWRONGIDWRONGIDWR.md"), "---\nid: 01OTHER\nsource: note\ntitle: t\nauthor: a\ncreated_at: 2026-01-01T00:00:00Z\n---\nbody\n");
    const r = await reindex(t.dir);
    expect(r.edgesMirrored).toBe(1);
    expect(r.rejectionsMirrored).toBe(1);
    expect(r.malformedSidecarLines).toBe(2);
    expect(r.warnings.some((w) => /malformed entity/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /does not match filename/.test(w))).toBe(true);
    expect(withDb(t.dir, (db) => (db.query("SELECT weight FROM edges WHERE src='a' AND dst='b'").get() as { weight: number }).weight)).toBe(1); // clamped
  });
  test("doctor flags a busy port and an inbox inside the content repo", async () => {
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const saved = process.env.JARVIS_INBOX;
    process.env.JARVIS_INBOX = join(t.dir, "inbox");
    try {
      const r = await doctor({ port: srv.port, dataDir: t.dir, which: (b) => `/bin/${b}` });
      const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
      expect(by.port.status).toBe("warn");
      expect(by.inbox.status).toBe("warn");
      expect(by.inbox.fix).toContain("set-inbox");
    } finally {
      srv.stop(true);
      if (saved === undefined) delete process.env.JARVIS_INBOX; else process.env.JARVIS_INBOX = saved;
    }
  });
});

describe("acp client edge cases and arg parsing", () => {
  test("non-JSON lines are ignored; unknown agent→client requests get a JSON-RPC error; agent exit rejects pending", async () => {
    const written: string[] = [];
    let push!: (s: string) => void;
    let close!: () => void;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); close = () => c.close(); } });
    let exited!: () => void;
    const client = new AcpClient({ stdin: { write: (s: string) => written.push(s) }, stdout, kill() {}, exited: new Promise<number>((r) => (exited = () => r(0))) });
    const req = client.request("initialize", {});
    push("garbage line\n");
    push(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "fs/read_text_file", params: {} }) + "\n");
    push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
    expect(await req).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    const reply = JSON.parse(written.find((w) => w.includes('"id":77'))!);
    expect(reply.error.code).toBe(-32601);
    const pending = client.request("session/prompt", {});
    exited();
    close();
    await expect(pending).rejects.toThrow(/exited|closed/);
    expect(client.isClosed).toBe(true);
  });
  test("args: --flag=value, bare flags, --limit validation, values that look like flags", () => {
    const p = parseArgs(["cmd", "--limit=7", "--dry-run", "--title", "--weird", "pos"]);
    expect(p.flags.limit).toBe("7");
    expect(p.flags["dry-run"]).toBe(true);
    expect(p.flags.title).toBe(true); // a value starting with -- is not consumed (documented)
    expect(p.flags.weird).toBe("pos");
    expect(flagInt(p.flags, "limit")).toBe(7);
    expect(flagInt(p.flags, "missing", 3)).toBe(3);
    expect(() => flagInt({ limit: "-1" }, "limit")).toThrow();
    expect(() => flagInt({ limit: "1.5" }, "limit")).toThrow();
  });
});
