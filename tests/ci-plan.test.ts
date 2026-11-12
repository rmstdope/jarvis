import { describe, expect, test } from "bun:test";
import { importClosure, listTests, planFromChanges } from "../scripts/ci-plan.ts";

describe("ci planner", () => {
  test("docs-only changes run nothing; agent instructions are not docs-only", () => {
    const p = planFromChanges(["docs/ARCHITECTURE.md", "IMPLEMENTATION-PLAN.md"]);
    expect(p.docsOnly).toBe(true);
    expect(p.tests).toEqual([]);
    expect(planFromChanges(["docs/AGENT-INSTRUCTIONS.md"]).tests).toContain("tests/extension.test.ts");
    expect(planFromChanges(["docs/AGENT-INSTRUCTIONS.md"]).tests).toContain("tests/cli-e2e.test.ts"); // `jarvis skill` prints it
    expect(planFromChanges([]).docsOnly).toBe(true);
    expect(planFromChanges(["README.md"]).tests).toContain("tests/cli-e2e.test.ts");
  });
  test("the fleet's own files (cerebro, beads, agent and skill links) run nothing", () => {
    const fleet = [".cerebro/project.conf", ".cerebro/cerebro", ".gitmodules", ".beads/config.yaml", ".claude/skills/write-bead", ".github/agents/producer.md", ".github/skills/write-bead", ".github/hooks/cerebro.json", "CLAUDE.md"];
    const p = planFromChanges([...fleet, "docs/ARCHITECTURE.md"]);
    expect(p.docsOnly).toBe(true);
    expect(p.full).toBe(false);
    expect(p.tests).toEqual([]);
    expect(planFromChanges([".cerebro/roster.conf", "src/core/chunk.ts"]).tests).toContain("tests/chunk.test.ts");
  });
  test("global files force the full suite", () => {
    for (const f of ["bun.lock", "package.json", "tsconfig.json", ".github/workflows/ci.yml", "tests/helpers.ts"]) {
      const p = planFromChanges([f, "README.md"]);
      expect(p.full).toBe(true);
      expect(p.tests).toEqual(listTests());
      expect(p.buildWeb && p.buildExtension && p.swift).toBe(true);
    }
    expect(planFromChanges([], { full: true }).full).toBe(true);
  });
  test("a core change selects exactly the tests whose import graph reaches it", () => {
    const p = planFromChanges(["src/core/chunk.ts"]);
    expect(p.full).toBe(false);
    expect(p.tests).toContain("tests/chunk.test.ts");
    expect(p.tests).toContain("tests/pipeline.test.ts");
    expect(p.tests).toContain("tests/cli-e2e.test.ts"); // cli imports everything
    expect(p.tests).not.toContain("tests/extension.test.ts");
    expect(p.tests).not.toContain("tests/webdom.test.ts");
    expect(p.typecheck).toEqual({ core: true, web: false, extension: false });
    expect(p.buildWeb).toBe(false);
    const q = planFromChanges(["src/briefings/parser.ts"]);
    expect(q.tests).toContain("tests/briefings.test.ts");
    expect(q.tests).toContain("tests/web.test.ts"); // web bundle imports the briefing library
    expect(q.typecheck.web).toBe(true);
    expect(q.buildWeb).toBe(true);
  });
  test("web, extension, presets, fixtures and app changes map to their consumers", () => {
    const w = planFromChanges(["web/src/main.ts", "web/src/styles.css"]);
    const only = (tests: string[]) => tests.filter((x) => x !== "tests/ci-plan.test.ts"); // the planner's own test mentions fixture names literally
    expect(only(w.tests)).toEqual(["tests/web.test.ts", "tests/webapp.test.ts", "tests/webbriefing.test.ts", "tests/webinitiative.test.ts", "tests/webinitiatives.test.ts", "tests/webpages.test.ts", "tests/webpresent.test.ts", "tests/webtabsui.test.ts"]);
    expect(only(planFromChanges(["web/src/ui.ts"]).tests)).toEqual(["tests/web.test.ts", "tests/webapp.test.ts", "tests/webbriefing.test.ts", "tests/webchat.test.ts", "tests/webdoc.test.ts", "tests/webdom.test.ts", "tests/webinitiative.test.ts", "tests/webinitiatives.test.ts", "tests/webpages.test.ts", "tests/webpresent.test.ts", "tests/webshell.test.ts", "tests/webtabsui.test.ts"]);
    expect(only(planFromChanges(["extension/src/blocklist.ts"]).tests)).toEqual(["tests/extension.test.ts"]);
    expect(w.buildWeb).toBe(true);
    expect(w.typecheck).toEqual({ core: false, web: true, extension: false });
    const e = planFromChanges(["extension/static/manifest.json"]);
    expect(only(e.tests)).toEqual(["tests/extension.test.ts"]);
    expect(e.buildExtension).toBe(true);
    const m = planFromChanges(["docs/examples/models/copilot-only.toml"]);
    expect(m.docsOnly).toBe(false);
    expect(m.tests).toContain("tests/onboarding.test.ts");
    expect(m.tests).toContain("tests/router.test.ts"); // jv-zdv: presets routed through Copilot
    expect(m.tests).not.toContain("tests/chunk.test.ts");
    const f = planFromChanges(["tests/fixtures/teams.vtt"]);
    expect(f.tests).toContain("tests/producers.test.ts");
    expect(f.tests).not.toContain("tests/router.test.ts");
    const a = planFromChanges(["jarvis-app/main.swift"]);
    expect(a.swift).toBe(true);
    expect(only(a.tests)).toEqual([]);
    const s = planFromChanges(["scripts/ci-plan.ts"]);
    expect(s.full).toBe(true);
  });
  test("a changed test file runs itself; import closure resolves .ts and index files", () => {
    expect(planFromChanges(["tests/chunk.test.ts"]).tests).toEqual(["tests/chunk.test.ts"]);
    const c = importClosure("tests/chat.test.ts");
    expect(c.has("src/chat/acp.ts")).toBe(true);
    expect(c.has("src/core/db.ts")).toBe(true);
    expect(listTests().length).toBeGreaterThan(15);
  });
});
