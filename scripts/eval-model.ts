/**
 * Runs the production ENRICH, CLEANUP, EDGE-REFINE and a synthesis fixture against a chosen model
 * with an instrumented provider that records latency, then scores weighted objective checks.
 *
 *   bun run scripts/eval-model.ts [--model copilot:gpt-4.1] [--effort high|xhigh] [--data <tmp>]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, flagStr } from "../src/core/args.ts";
import { ingest } from "../src/core/ingest.ts";
import { enrich } from "../src/core/enrich.ts";
import { cleanup } from "../src/core/cleanup.ts";
import { computeEdges } from "../src/core/edges.ts";
import { refine } from "../src/core/refine.ts";
import { ask } from "../src/core/ask.ts";
import { readDocFile } from "../src/core/docs.ts";
import { createRouter, type Router } from "../src/providers/router.ts";
import { loadModelsConfig } from "../src/providers/models.ts";
import type { CompleteOpts, ReasoningEffort } from "../src/providers/types.ts";
import { withDb } from "../src/core/db.ts";

interface Check { name: string; weight: number; pass: boolean; detail?: string }
const { flags } = parseArgs(process.argv.slice(2));
const wanted = flagStr(flags, "model");
const effort = flagStr(flags, "effort") as ReasoningEffort | undefined;
const dataDir = flagStr(flags, "data") ?? mkdtempSync(join(tmpdir(), "sb-eval-"));

const base = await createRouter({ config: await loadModelsConfig() });
const calls: { kind: string; ms: number; chars: number }[] = [];
const router: Router = {
  ...base,
  resolve(task) {
    const m = base.entries.find((e) => e.available && (!wanted || `${e.entry.provider}:${e.entry.id}` === wanted));
    if (!m) return null;
    return {
      id: `${m.entry.provider}:${m.entry.id}`, provider: m.entry.provider, model: m.entry.id,
      async complete(prompt: string, opts: CompleteOpts = {}) {
        const t0 = performance.now();
        const out = await m.provider.complete(m.entry.id, prompt, { ...opts, reasoningEffort: effort ?? opts.reasoningEffort ?? m.entry.reasoningEffort });
        calls.push({ kind: task.kind, ms: Math.round(performance.now() - t0), chars: out.length });
        return out;
      },
    };
  },
};
if (!router.resolve({ kind: "summary" })) {
  console.error("no available model matches; see `brain models`");
  process.exit(1);
}

mkdirSync(join(dataDir, "config"), { recursive: true });
writeFileSync(join(dataDir, "config", "glossary.toml"), '[products]\n# Misheard as: "a corn", "ay corn"\nAcorn = "Acorn Application Platform"\n[abbreviations]\n# Misheard as: "a r b"\nARB = "Architecture Review Board"\n');
const a = await ingest(dataDir, { source: "web", title: "Acorn application platform overview", body: "Acorn (Acorn Application Platform) lets developers build applications that run on Acorn cameras. Mia Berg from the ARB architects presented the roadmap. Streamlite reduces bandwidth by up to 50 %.", author: "eval", source_url: "https://eval.test/a" });
const b = await ingest(dataDir, { source: "note", title: "Acorn roadmap notes", body: "Notes from the Acorn roadmap session: the platform team plans SDK 5 with container support on Acorn cameras next quarter.", author: "eval" });
const m = await ingest(dataDir, { source: "meeting", title: "ARB weekly", body: "Anna: Vi hade inte tittat på a corn ännu.\n\nBob: We hadn't looked at the ay corn SDK either, and we won't before the a s p review.", author: "eval" });

const checks: Check[] = [];
const en = await enrich(dataDir, router);
const da = readDocFile(dataDir, a.id)!.frontmatter;
checks.push({ name: "summary present", weight: 3, pass: !!da.summary && da.summary.length > 20, detail: da.summary });
checks.push({ name: "tags in range 3–8", weight: 2, pass: (da.tags?.length ?? 0) >= 3 && (da.tags?.length ?? 0) <= 8, detail: da.tags?.join(", ") });
checks.push({ name: "expected mention Acorn", weight: 3, pass: !!da.mentions?.some((x) => /acorn/i.test(x.name)), detail: da.mentions?.map((x) => `${x.name}/${x.kind}`).join(", ") });
checks.push({ name: "no enrich failures", weight: 2, pass: en.failed === 0, detail: en.details.filter((d) => d.status === "failed").map((d) => d.reason).join("; ") });

const cl = await cleanup(dataDir, router, { llm: true });
const body = readDocFile(dataDir, m.id)!.body;
checks.push({ name: "glossary term fixed", weight: 3, pass: /Acorn/.test(body) && !/a corn|ay corn/i.test(body), detail: body.slice(0, 160) });
checks.push({ name: "negation preserved", weight: 5, pass: /hadn't looked/.test(body) && /inte tittat/.test(body) && /won't/.test(body), detail: body.slice(0, 200) });
checks.push({ name: "cleanup stamped", weight: 1, pass: cl.cleaned === 1 });

computeEdges(dataDir);
const cands = withDb(dataDir, (db) => (db.query("SELECT count(*) c FROM edges WHERE created_by='embedding'").get() as { c: number }).c);
const rf = await refine(dataDir, router);
checks.push({ name: "complete batch judged", weight: 4, pass: cands > 0 && rf.malformedBatches === 0 && rf.kept + rf.dropped === cands, detail: `${cands} candidates, kept ${rf.kept}, dropped ${rf.dropped}, malformed ${rf.malformedBatches}, hallucinated ${rf.hallucinated}` });
checks.push({ name: "a↔b kept as related", weight: 2, pass: rf.kept >= 1 });

const ans = await ask(dataDir, router, "What does Streamlite do?");
checks.push({ name: "synthesis cites source", weight: 3, pass: ans.answer.includes(a.id) && /bandwidth/i.test(ans.answer), detail: ans.answer.slice(0, 200) });

const total = checks.reduce((s, c) => s + c.weight, 0);
const got = checks.filter((c) => c.pass).reduce((s, c) => s + c.weight, 0);
console.log(`model: ${router.resolve({ kind: "summary" })!.id}${effort ? ` (effort ${effort})` : ""}\n`);
for (const c of checks) console.log(`${c.pass ? "✓" : "✗"} ${c.name} (${c.weight})${c.detail ? `\n    ${c.detail.replace(/\n/g, " ")}` : ""}`);
console.log(`\nscore ${got}/${total} (${Math.round((100 * got) / total)} %)`);
const byKind = new Map<string, { n: number; ms: number }>();
for (const c of calls) { const k = byKind.get(c.kind) ?? { n: 0, ms: 0 }; k.n++; k.ms += c.ms; byKind.set(c.kind, k); }
for (const [k, v] of byKind) console.log(`  ${k}: ${v.n} call(s), avg ${Math.round(v.ms / v.n)} ms`);
if (!flagStr(flags, "data")) rmSync(dataDir, { recursive: true, force: true });
