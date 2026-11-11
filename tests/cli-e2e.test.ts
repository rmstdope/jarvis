import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
function jarvis(...args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args, "--data", data], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, JARVIS_HOME: home, JARVIS_MODELS: join(home, "models.toml"), JARVIS_EMBED_FAKE: "1", JARVIS_AUTHOR: "cli-tester", JARVIS_INBOX: join(home, "inbox") },
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
  writeFileSync(join(home, "models.toml"), 'preference = ["local"]\n'); // Tier 0: no models, hermetic
});
afterAll(() => t.cleanup());

const EXPECTED_COMMANDS = ["note", "ingest", "reindex", "search", "serve", "sync", "process", "pipeline", "dedup", "youtube", "meeting", "enrich", "edges", "refine", "cleanup", "entities", "ask", "models", "config", "briefing", "init", "doctor", "task", "tasks", "initiative", "link", "presentation", "scan-inbox", "summarize", "skill"];
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
    const h = jarvis("help");
    expect(h.code).toBe(0);
    for (const c of ["note", "search", "sync", "briefing", "doctor"]) expect(h.out).toContain(`  ${c}`);
    const u = jarvis("nope");
    expect(u.code).toBe(1);
    expect(u.out).toContain("unknown command");
  });
  test("note → search → reindex → task → link → tasks", () => {
    const n = jarvis("note", "The X1656 firmware fixes zoom drift", "--title", "Zoom");
    expect(n.code).toBe(0);
    expect(n.out).toMatch(/^captured [0-9A-Z]{26}  Zoom/);
    const id = n.out.match(/captured ([0-9A-Z]{26})/)![1];
    expect(readFileSync(join(data, "docs", `${id}.md`), "utf8")).toContain("author: cli-tester");
    const s = jarvis("search", "zoom drift", "--mode", "keyword");
    expect(s.code).toBe(0);
    expect(s.out).toContain(id);
    expect(jarvis("search", "nothing-matches-this", "--mode", "keyword").out).toContain("no results");
    const r = jarvis("reindex");
    expect(r.out).toMatch(/indexed 0 doc\(s\), skipped 1/);
    const ta = jarvis("task", "add", "Ship the fix", "--due", "2026-12-01", "--link", id);
    expect(ta.code).toBe(0);
    const taskId = ta.out.match(/task ([0-9A-Z]{26})/)![1];
    expect(jarvis("task", "add", "bad", "--due", "soon").code).toBe(1);
    const tl = jarvis("tasks");
    expect(tl.out).toContain("Ship the fix");
    expect(tl.out).not.toContain("no links");
    const n2 = jarvis("note", "follow-up note", "--task", taskId);
    expect(n2.out).toContain(`linked task ${taskId}`);
    const show = jarvis("task", "show", taskId);
    expect(show.out).toContain("linked (2)");
    expect(jarvis("task", "done", taskId).out).toContain("✓ done");
    expect(jarvis("tasks").out).toContain("no tasks");
    const l = jarvis("link", id, taskId, "--relation", "follows_up");
    expect(l.out).toContain("linked:");
    expect(jarvis("link", id, id).code).toBe(1);
  });
  test("initiatives: add, file tasks from the task side, list, show, last-task notice, close, reopen (no model)", () => {
    expect(jarvis("initiative", "list").out.trim()).toBe('no open initiatives — start one: jarvis initiative add "<title>" --goal "<what done looks like>"');
    const noGoal = jarvis("initiative", "add", "Billing");
    expect(noGoal.code).toBe(1);
    expect(noGoal.out).toContain('An initiative needs a goal. Say what done looks like:\n  jarvis initiative add "<title>" --goal "<what done looks like>"');
    const a = jarvis("initiative", "add", "Move billing", "--goal", "all on the new ledger");
    expect(a.out).toMatch(/^initiative [0-9A-Z]{26}  Move billing  \(owner cli-tester\)/);
    const id = a.out.match(/initiative ([0-9A-Z]{26})/)![1];
    expect(jarvis("initiative", "list").out).toMatch(new RegExp(`${id}  ░{9}  0/0 {3}Move billing  \\(cli-tester\\)  no tasks yet`));
    expect(jarvis("initiative", "show", id).out).toContain(`tasks — none yet: jarvis task add "<title>" --initiative ${id}`);
    const t1 = jarvis("task", "add", "Freeze API", "--initiative", id).out.match(/task ([0-9A-Z]{26})/)![1];
    const lone = jarvis("task", "add", "Standalone").out.match(/task ([0-9A-Z]{26})/)![1];
    expect(jarvis("task", "list").out).toContain("Freeze API  (cli-tester)  ⚠ no links  · Move billing");
    expect(jarvis("task", "list", "--initiative", id).out).not.toContain("Standalone");
    expect(jarvis("task", "show", t1).out).toContain(`initiative: ${id}  Move billing`);
    const sh = jarvis("initiative", "show", id).out;
    expect(sh).toContain(`open  owner: cli-tester  progress: ░░░░░░░░░ 0 of 1 done\n\nall on the new ledger\n\ntasks (1)\n`);
    expect(sh).toContain("through its tasks — none\n\nlinked directly — none\n\nsuggested — none: no model is available, so nothing is suggested (jarvis doctor shows why)");
    expect(jarvis("initiative", "suggest", id).out.trim()).toBe("no suggestions: no model is available (jarvis doctor shows why)");
    expect(jarvis("task", "move", lone, "--initiative", id).out).toContain("Standalone  → Move billing");
    expect(jarvis("task", "move", lone, "--initiative", id).out).toContain("is already in Move billing");
    expect(jarvis("task", "move", lone, "--none").out).toContain("Standalone  → no initiative (was Move billing)");
    expect(jarvis("task", "move", lone).out).toContain("usage: jarvis task move <task> --initiative <id> | --none");
    expect(jarvis("initiative", "show", lone).out).toContain(`${lone} is a task, not an initiative — jarvis task show ${lone}`);
    expect(jarvis("initiative", "show", "01ZZZZZZ").out).toContain("no initiative 01ZZZZZZ — see them all: jarvis initiative list");
    expect(jarvis("initiative", "close", id).out).toContain(`Move billing still has 1 open task.\nFinish or move them first, or close it anyway:\n  jarvis initiative close ${id} --anyway`);
    const done = jarvis("task", "done", t1).out;
    expect(done).toContain(`✓ done: Freeze API\n  That was the last open task in Move billing (1 of 1 done).\n  It stays open until someone closes it:\n    jarvis initiative close ${id}`);
    expect(jarvis("initiative", "list").out).toContain("✓ all tasks done — close it?");
    expect(jarvis("initiative", "show", id).out).toContain(`✓ all tasks done — close it with: jarvis initiative close ${id}`);
    expect(jarvis("initiative", "edit", id, "--owner", "jonas", "--goal", "new").out.trim()).toBe("updated: Move billing  owner cli-tester → jonas, goal changed");
    expect(jarvis("initiative", "close", id).out.trim()).toBe("closed: Move billing  1 of 1 done");
    expect(jarvis("task", "add", "Late", "--initiative", id).out).toContain(`Move billing is closed. Reopen it first:\n  jarvis initiative reopen ${id}`);
    expect(jarvis("initiative", "list", "--status", "closed").out).toMatch(/closed \d{4}-\d{2}-\d{2}$/m);
    expect(jarvis("initiative", "reopen", id).out.trim()).toBe("○ reopened: Move billing");
    expect(jarvis("reindex", "--full").code).toBe(0);
    expect(jarvis("initiative", "show", id).out).toContain("tasks (1)");
    const filed = jarvis("task", "add", "Move billing checklist", "--initiative", id).out;
    expect(filed).not.toContain(`jarvis link ${filed.match(/task ([0-9A-Z]{26})/)![1]} ${id}`); // already in its initiative
    expect(filed).toContain("link suggestions:"); // the other candidates are still offered
  });
  test("passes without models skip cleanly; process and sync run local-only", () => {
    expect(jarvis("enrich").out).toMatch(/skipped \d+/);
    expect(jarvis("edges").code).toBe(0);
    expect(jarvis("refine").out).toMatch(/no edge-judge model|0 candidate\(s\)/);
    expect(jarvis("models").out).toContain("no models configured");
    const p = jarvis("process");
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/indexed \d+ doc/);
    const sy = jarvis("sync", "--no-push");
    expect(sy.code).toBe(0);
    expect(sy.out).toContain("remote=false");
    expect(Bun.spawnSync(["git", "log", "--oneline"], { cwd: data }).stdout.toString()).toContain("jarvis: capture");
    expect(jarvis("dedup").out).toContain("no source_url collisions");
  });
  test("briefing create/list/show/comment/approve; config show; doctor --json", () => {
    const c = jarvis("briefing", "create", "--title", "My brief");
    expect(c.code).toBe(0);
    const bid = c.out.match(/created ([0-9A-Z]{26})/)![1];
    expect(jarvis("briefing", "list").out).toContain("My brief");
    expect(jarvis("briefing", "comment", bid, "nice work").out).toContain("added");
    expect(jarvis("briefing", "approve", bid).out).toContain("approved");
    const show = jarvis("briefing", "show", bid);
    expect(show.out).toContain("status: approved");
    expect(show.out).toContain("nice work");
    expect(jarvis("briefing", "components", "--search", "timeline").out).toContain("Timeline");
    expect(jarvis("briefing", "publish", bid, "--dry-run").out).toContain("<h2>Overview</h2>");
    expect(jarvis("config", "show").out).toContain("config.toml");
    const d = jarvis("doctor", "--json", "--core-only");
    const rep = JSON.parse(d.out.slice(d.out.indexOf("{")));
    expect(rep.checks.find((c: { name: string }) => c.name === "data-dir").status).toBe("ok");
    expect(jarvis("skill").out).toContain("jarvis tasks");
  });
  test("skill uses the plain command and names this code repo for the fallback", () => {
    const out = jarvis("skill").out.replace(/\s+/g, " ");
    const repo = join(import.meta.dir, "..");
    expect(out).toContain("driven through the `jarvis` CLI and the local HTTP service on");
    expect(out).toContain(`run \`bun "${repo}/src/cli.ts" …\` instead, and tell the user to run \`bun link\` in \`${repo}\` so the plain command works`);
    expect(out).not.toContain("<code repo>");
    expect(out).not.toMatch(/bun run jarvis [a-z]/);
  });
  test("skill teaches initiatives: when to create, filing tasks, linking captures, reporting", () => {
    const out = jarvis("skill").out.replace(/\s+/g, " ");
    for (const s of [
      "jarvis initiative list",
      'jarvis initiative add "<title>" --goal "<what done looks like>"',
      "weeks or months",
      'jarvis task add "<title>" --initiative <id>',
      "jarvis task move <task> --initiative <id>",
      "jarvis initiative show <id>",
      "jarvis initiative suggest <id>",
      "jarvis link <task> <doc>",
      "never close an initiative yourself",
      "Report every initiative, task and link you create **by id and title**",
    ]) expect(out).toContain(s);
  });
  test("every jarvis command (and task/initiative subcommand) the skill quotes is registered", () => {
    const skill = jarvis("skill").out;
    const usage = jarvis().out;
    for (const m of skill.matchAll(/`jarvis ([a-z-]+)(?: ([a-z]+))?/g)) {
      const [, cmd, sub] = m;
      expect(EXPECTED_COMMANDS).toContain(cmd!);
      if ((cmd === "task" || cmd === "initiative") && sub && /^[a-z]+$/.test(sub)) {
        const line = usage.split("\n").find((l) => l.trim().startsWith(`${cmd} `))!;
        expect(line, `${cmd} ${sub}`).toMatch(new RegExp(`(^|\\| |${cmd} )${sub}( |$)`));
      }
    }
  });
  test("the skill's fallback command, run from the content repo, runs the search", () => {
    const out = jarvis("skill").out.replace(/\s+/g, " ");
    const [, script] = out.match(/If `jarvis` is not found, run `bun "(.+?)" …` instead/)!;
    const p = Bun.spawnSync([process.execPath, script!, "search", "zqxjvnomatch", "--mode", "keyword", "--data", data], {
      cwd: data, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, JARVIS_HOME: home, JARVIS_MODELS: join(home, "models.toml"), JARVIS_EMBED_FAKE: "1" },
    });
    const res = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    expect(res).not.toContain("Usage: bun run");
    expect(res).toContain("no results");
    expect(p.exitCode).toBe(0);
  });
  test("the skill's fallback, run from the content repo, captures a relative file even when the code repo path has a space", () => {
    // A copy of the code repo at a path with a space (Bun resolves symlinks, so a link would not do).
    const code = join(t.dir, "code repo");
    const root = join(import.meta.dir, "..");
    mkdirSync(join(code, "docs"), { recursive: true });
    cpSync(join(root, "src"), join(code, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(code, "package.json"));
    cpSync(join(root, "docs", "AGENT-INSTRUCTIONS.md"), join(code, "docs", "AGENT-INSTRUCTIONS.md"));
    symlinkSync(join(root, "node_modules"), join(code, "node_modules"));
    const env = { ...process.env, JARVIS_HOME: home, JARVIS_MODELS: join(home, "models.toml"), JARVIS_EMBED_FAKE: "1", JARVIS_AUTHOR: "cli-tester" };
    const skill = new TextDecoder().decode(Bun.spawnSync([process.execPath, join(code, "src", "cli.ts"), "skill"], { env, stdout: "pipe" }).stdout).replace(/\s+/g, " ");
    const fallback = skill.match(/If `jarvis` is not found, run `(bun [^`]+?) …` instead/)![1]!;
    writeFileSync(join(data, "rel-note.md"), "# Relative\n\nquokka relative capture");
    const p = Bun.spawnSync(["sh", "-c", `${fallback} ingest --file ./rel-note.md --data "${data}"`], { cwd: data, env, stdout: "pipe", stderr: "pipe" });
    const res = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    expect(res).toMatch(/^captured \S+  rel-note\.md  /);
    expect(p.exitCode).toBe(0);
  });
  test("package.json bin and README setup use the plain jarvis command", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(pkg.bin.jarvis).toBe("src/cli.ts");
    expect(pkg.scripts.jarvis).toBe("bun run src/cli.ts");
    expect(readFileSync(join(import.meta.dir, "..", pkg.bin.jarvis), "utf8").startsWith("#!/usr/bin/env bun")).toBe(true);
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8").replace(/\r\n/g, "\n");
    expect(readme).toMatch(/bun install\nbun link +# installs the jarvis command, so it works from any folder\njarvis init/);
    expect(readme).not.toContain("multi-root");
    expect(readme).not.toMatch(/bun run jarvis/);
    expect(readme).toContain("bun run web:build");
  });
  test("ingest from stdin-less file and a PDF; meeting from vtt", () => {
    const f = join(t.dir, "notes.md");
    writeFileSync(f, "# Notes\n\nsome notes about pasta");
    expect(jarvis("ingest", "--file", f, "--source", "paste").out).toMatch(/^captured \S+  notes\.md  /);
    expect(jarvis("ingest", "--file", join(import.meta.dir, "fixtures", "hello.pdf")).out).toContain("Fixture Title");
    expect(jarvis("meeting", join(import.meta.dir, "fixtures", "teams.vtt"), "--title", "Sync").out).toContain("Sync");
    expect(jarvis("search", "pasta", "--mode", "keyword").out).toContain("notes.md");
  });
});
