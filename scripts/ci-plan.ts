/**
 * Change-aware CI planner. Given the list of changed paths, decides what CI must run:
 *   - docs-only changes, and changes to the Cerebro fleet's own files, run nothing,
 *   - otherwise only the test files whose transitive import graph touches a changed file,
 *     plus builds/typechecks for the trees that changed.
 * Global files (lockfile, tsconfig, workflow, test helpers) force the full suite.
 *
 *   git diff --name-only <base>..<head> | bun run scripts/ci-plan.ts            → JSON plan
 *   bun run scripts/ci-plan.ts --full                                             → everything
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

export interface Plan {
  docsOnly: boolean;
  full: boolean;
  tests: string[]; // relative test file paths; empty when docsOnly, all when full
  typecheck: { core: boolean; web: boolean; extension: boolean };
  buildWeb: boolean;
  buildExtension: boolean;
  swift: boolean;
  reasons: string[];
}

const ROOT = resolve(import.meta.dir, "..");
const DOC_RE = /\.(md|txt)$/i;
// The Cerebro fleet's declarations, its submodule, the bead board and the agent/skill/hook links
// the fleet syncs: none of them is read by the code or the tests.
const FLEET_RE = /^(\.cerebro\/|\.beads\/|\.claude\/|\.gitmodules$|\.github\/(agents|skills|hooks)\/)/;
const GLOBAL = ["package.json", "bun.lock", "tsconfig.json", "bunfig.toml", ".github/workflows/ci.yml", "tests/helpers.ts", "tests/fakeRouter.ts", "scripts/ci-plan.ts"];

export function listTests(root = ROOT): string[] {
  return readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`).sort();
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']\s*\)?/g;
/** Transitive relative imports of a file, as root-relative paths (only files that exist). */
export function importClosure(file: string, root = ROOT, seen = new Set<string>()): Set<string> {
  const rel = normalize(file).replace(/\\/g, "/");
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const abs = join(root, rel);
  if (!existsSync(abs)) return seen;
  const src = readFileSync(abs, "utf8");
  for (const m of src.matchAll(IMPORT_RE)) {
    let target = resolve(dirname(abs), m[1]);
    if (!existsSync(target)) {
      const cands = [`${target}.ts`, join(target, "index.ts")].find((c) => existsSync(c));
      if (!cands) continue;
      target = cands;
    }
    importClosure(relative(root, target).replace(/\\/g, "/"), root, seen);
  }
  return seen;
}

const WEB_ENTRIES = ["web/src/main.ts"];
const EXTENSION_ENTRIES = ["extension/src/background.ts", "extension/src/content.ts", "extension/src/popup.ts", "extension/src/options.ts"];

/** A test's full dependency set: its import closure plus the sources of any bundle it builds. */
export function testClosure(test: string, root = ROOT): Set<string> {
  const closure = importClosure(test, root);
  if (closure.has("scripts/build-web.ts")) for (const e of WEB_ENTRIES) importClosure(e, root, closure);
  if (closure.has("scripts/build-extension.ts")) for (const e of EXTENSION_ENTRIES) importClosure(e, root, closure);
  return closure;
}

/** Non-TypeScript inputs a test depends on (data it reads at runtime). */
function dataDeps(test: string, closure: Set<string>, root: string): ((changed: string) => boolean)[] {
  const deps: ((c: string) => boolean)[] = [];
  const src = readFileSync(join(root, test), "utf8");
  if (closure.has("src/core/presets.ts")) deps.push((c) => c.startsWith("docs/examples/models/"));
  if (closure.has("scripts/build-web.ts")) deps.push((c) => c.startsWith("web/"));
  if (closure.has("scripts/build-extension.ts")) deps.push((c) => c.startsWith("extension/"));
  if (/fixtures/.test(src)) deps.push((c) => c.startsWith("tests/fixtures/"));
  // Any non-TypeScript file whose name the test mentions literally (AGENT-INSTRUCTIONS.md, a fixture, a preset…).
  deps.push((c) => !c.endsWith(".ts") && src.includes(c.split("/").pop()!));
  return deps;
}

export function planFromChanges(changed: string[], opts: { full?: boolean; root?: string } = {}): Plan {
  const root = opts.root ?? ROOT;
  const files = [...new Set(changed.map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean))];
  const allTests = listTests(root);
  const plan: Plan = { docsOnly: false, full: false, tests: [], typecheck: { core: false, web: false, extension: false }, buildWeb: false, buildExtension: false, swift: false, reasons: [] };
  if (opts.full) {
    plan.full = true;
    plan.tests = allTests;
    plan.typecheck = { core: true, web: true, extension: true };
    plan.buildWeb = plan.buildExtension = plan.swift = true;
    plan.reasons.push("full run requested");
    return plan;
  }
  if (files.length === 0) {
    plan.docsOnly = true;
    plan.reasons.push("no changed files");
    return plan;
  }
  // Documentation and fleet files never affect tests, except the agent instructions which a test reads.
  const isFleet = (f: string) => FLEET_RE.test(f);
  const isDoc = (f: string) => isFleet(f) || (DOC_RE.test(f) && !f.startsWith("tests/fixtures/") && f !== "docs/AGENT-INSTRUCTIONS.md");
  if (files.every(isDoc)) {
    plan.docsOnly = true;
    plan.reasons.push("documentation-only change");
    return plan;
  }
  const globalHit = files.find((f) => GLOBAL.includes(f) || f.startsWith(".github/workflows/"));
  if (globalHit) {
    plan.full = true;
    plan.tests = allTests;
    plan.typecheck = { core: true, web: true, extension: true };
    plan.buildWeb = plan.buildExtension = plan.swift = true;
    plan.reasons.push(`global file changed: ${globalHit}`);
    return plan;
  }
  const changedSet = new Set(files);
  const code = files.filter((f) => !isFleet(f));
  for (const t of allTests) {
    const closure = testClosure(t, root);
    const viaImport = code.find((f) => closure.has(f));
    const viaData = viaImport ? undefined : dataDeps(t, closure, root).some((dep) => code.some(dep)) ? "data dependency" : undefined;
    if (viaImport || viaData) {
      plan.tests.push(t);
      plan.reasons.push(`${t}: ${viaImport ?? viaData}`);
    }
  }
  plan.typecheck.core = files.some((f) => f.startsWith("src/") || f.startsWith("tests/") || f.startsWith("scripts/"));
  plan.typecheck.web = files.some((f) => f.startsWith("web/") || f.startsWith("src/briefings/"));
  plan.typecheck.extension = files.some((f) => f.startsWith("extension/"));
  plan.buildWeb = plan.typecheck.web || files.some((f) => f.startsWith("scripts/build-web"));
  plan.buildExtension = plan.typecheck.extension || files.some((f) => f.startsWith("scripts/build-extension"));
  plan.swift = files.some((f) => f.startsWith("second-brain-app/"));
  if (plan.tests.length === 0 && !plan.typecheck.core && !plan.typecheck.web && !plan.typecheck.extension && !plan.swift) plan.reasons.push("no test depends on the changed files");
  void changedSet;
  return plan;
}

if (import.meta.main) {
  const full = process.argv.includes("--full");
  const input = full ? "" : await Bun.stdin.text();
  const plan = planFromChanges(input.split("\n"), { full });
  console.log(JSON.stringify(plan, null, 2));
}
