import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/cli.ts";
import { listRoutes } from "../src/http.ts";
import "../src/server.ts";
import { tmpDataDir } from "./helpers.ts";

/**
 * Regression net for the CLI as a real subprocess: every command must be registered (the entrypoint
 * ordering bug), and the everyday flows must work end to end with a fake embedder and no models.
 */
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let t: ReturnType<typeof tmpDataDir>;
let home: string;
let data: string;
function brain(...args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args, "--data", data], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SECOND_BRAIN_HOME: home, SECOND_BRAIN_MODELS: join(home, "models.toml"), SECOND_BRAIN_EMBED_FAKE: "1", SECOND_BRAIN_AUTHOR: "cli-tester", SECOND_BRAIN_INBOX: join(home, "inbox") },
  });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}
beforeAll(() => {
  t = tmpDataDir();
  home = join(t.dir, "home");
  data = join(t.dir, "content");
  mkdirSync(home);
  mkdirSync(data);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: data });
  Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: data });
  Bun.spawnSync(["git", "config", "user.email", "t@test"], { cwd: data });
  Bun.write(join(home, "models.toml"), 'preference = ["local"]\n'); // Tier 0: no models, hermetic
});
afterAll(() => t.cleanup());

const EXPECTED_COMMANDS = ["note", "ingest", "reindex", "search", "serve", "sync", "process", "pipeline", "dedup", "youtube", "meeting", "enrich", "edges", "refine", "cleanup", "entities", "ask", "models", "config", "briefing", "init", "doctor", "task", "tasks", "link", "presentation", "scan-inbox", "summarize", "skill"];
const EXPECTED_ROUTES = ["/api/health", "/api/capture", "/api/search", "/api/sync", "/api/browse", "/api/recent", "/api/item-by-source", "/api/item/", "/api/filters", "/api/ask", "/api/briefings", "/api/briefing/", "/api/tasks", "/api/task", "/api/link", "/api/presentations", "/api/presentation/", "/api/chat/sessions"];

describe("cli registry", () => {
  test("every command is registered (guards the entrypoint-must-be-last rule)", () => {
    for (const c of EXPECTED_COMMANDS) expect(Object.keys(commands)).toContain(c);
  });
  test("every route group is registered (guards import cycles dropping registrations)", () => {
    const routes = listRoutes().join("\n");
    for (const r of EXPECTED_ROUTES) expect(routes).toContain(r.replace(/\//g, "\\/"));
  });
});

describe("cli end to end (subprocess)", () => {
  test("help lists commands; unknown command exits 1", () => {
    const h = brain("help");
    expect(h.code).toBe(0);
    for (const c of ["note", "search", "sync", "briefing", "doctor"]) expect(h.out).toContain(`  ${c}`);
    const u = brain("nope");
    expect(u.code).toBe(1);
    expect(u.out).toContain("unknown command");
  });
  test("note → search → reindex → task → link → tasks", () => {
    const n = brain("note", "The X1656 firmware fixes zoom drift", "--title", "Zoom");
    expect(n.code).toBe(0);
    expect(n.out).toMatch(/^captured [0-9A-Z]{26}  Zoom/);
    const id = n.out.match(/captured ([0-9A-Z]{26})/)![1];
    expect(readFileSync(join(data, "docs", `${id}.md`), "utf8")).toContain("author: cli-tester");
    const s = brain("search", "zoom drift", "--mode", "keyword");
    expect(s.code).toBe(0);
    expect(s.out).toContain(id);
    expect(brain("search", "nothing-matches-this", "--mode", "keyword").out).toContain("no results");
    const r = brain("reindex");
    expect(r.out).toMatch(/indexed 0 doc\(s\), skipped 1/);
    const ta = brain("task", "add", "Ship the fix", "--due", "2026-12-01", "--link", id);
    expect(ta.code).toBe(0);
    const taskId = ta.out.match(/task ([0-9A-Z]{26})/)![1];
    expect(brain("task", "add", "bad", "--due", "soon").code).toBe(1);
    const tl = brain("tasks");
    expect(tl.out).toContain("Ship the fix");
    expect(tl.out).not.toContain("no links");
    const n2 = brain("note", "follow-up note", "--task", taskId);
    expect(n2.out).toContain(`linked task ${taskId}`);
    const show = brain("task", "show", taskId);
    expect(show.out).toContain("linked (2)");
    expect(brain("task", "done", taskId).out).toContain("✓ done");
    expect(brain("tasks").out).toContain("no tasks");
    const l = brain("link", id, taskId, "--relation", "follows_up");
    expect(l.out).toContain("linked:");
    expect(brain("link", id, id).code).toBe(1);
  });
  test("passes without models skip cleanly; process and sync run local-only", () => {
    expect(brain("enrich").out).toMatch(/skipped \d+/);
    expect(brain("edges").code).toBe(0);
    expect(brain("refine").out).toMatch(/no edge-judge model|0 candidate\(s\)/);
    expect(brain("models").out).toContain("no models configured");
    const p = brain("process");
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/indexed \d+ doc/);
    const sy = brain("sync", "--no-push");
    expect(sy.code).toBe(0);
    expect(sy.out).toContain("remote=false");
    expect(Bun.spawnSync(["git", "log", "--oneline"], { cwd: data }).stdout.toString()).toContain("brain: capture");
    expect(brain("dedup").out).toContain("no source_url collisions");
  });
  test("briefing create/list/show/comment/approve; config show; doctor --json", () => {
    const c = brain("briefing", "create", "--title", "My brief");
    expect(c.code).toBe(0);
    const bid = c.out.match(/created ([0-9A-Z]{26})/)![1];
    expect(brain("briefing", "list").out).toContain("My brief");
    expect(brain("briefing", "comment", bid, "nice work").out).toContain("added");
    expect(brain("briefing", "approve", bid).out).toContain("approved");
    const show = brain("briefing", "show", bid);
    expect(show.out).toContain("status: approved");
    expect(show.out).toContain("nice work");
    expect(brain("briefing", "components", "--search", "timeline").out).toContain("Timeline");
    expect(brain("briefing", "publish", bid, "--dry-run").out).toContain("<h2>Overview</h2>");
    expect(brain("config", "show").out).toContain("config.toml");
    const d = brain("doctor", "--json", "--core-only");
    const rep = JSON.parse(d.out.slice(d.out.indexOf("{")));
    expect(rep.checks.find((c: { name: string }) => c.name === "data-dir").status).toBe("ok");
    expect(brain("skill").out).toContain("brain tasks");
  });
  test("ingest from stdin-less file and a PDF; meeting from vtt", () => {
    const f = join(t.dir, "notes.md");
    Bun.write(f, "# Notes\n\nsome notes about pasta");
    Bun.spawnSync(["sleep", "0.05"]);
    expect(brain("ingest", "--file", f, "--source", "paste").out).toMatch(/^captured/);
    expect(brain("ingest", "--file", join(import.meta.dir, "fixtures", "hello.pdf")).out).toContain("Fixture Title");
    expect(brain("meeting", join(import.meta.dir, "fixtures", "teams.vtt"), "--title", "Sync").out).toContain("Sync");
    expect(brain("search", "pasta", "--mode", "keyword").out).toContain("notes.md");
  });
});
