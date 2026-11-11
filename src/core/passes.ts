/** Registers the authoring/derived passes into the process pipeline (import for side effects). */
import { cleanup } from "./cleanup.ts";
import { computeEdges } from "./edges.ts";
import { enrich } from "./enrich.ts";
import { refine } from "./refine.ts";
import { registerProcessPass, stepFailure } from "./sync.ts";
import type { Router } from "../providers/router.ts";

registerProcessPass({
  name: "enrich",
  needsRouter: true,
  authoring: true,
  async run(ctx) {
    const r = await enrich(ctx.dataDir, ctx.router as Router, { db: ctx.db });
    ctx.counts.enrich = { enriched: r.enriched, skipped: r.skipped, failed: r.failed, model: r.model, stubsCreated: r.stubsCreated };
    if (r.failed) ctx.failures.push(stepFailure("enrich", r.failed, r.details.find((d) => d.status === "failed")?.reason ?? ""));
    return { changedFiles: r.enriched > 0 };
  },
});
registerProcessPass({
  name: "cleanup",
  needsRouter: false,
  authoring: true,
  async run(ctx) {
    const r = await cleanup(ctx.dataDir, (ctx.router as Router | undefined) ?? null, { db: ctx.db, llm: false });
    if (r.cleaned || r.failed) ctx.counts.cleanup = { cleaned: r.cleaned, failed: r.failed };
    return { changedFiles: r.cleaned > 0 };
  },
});
registerProcessPass({
  name: "edges",
  async run(ctx) {
    const r = computeEdges(ctx.dataDir, { db: ctx.db });
    ctx.counts.edges = r;
  },
});
registerProcessPass({
  name: "refine",
  needsRouter: true,
  authoring: true,
  async run(ctx) {
    const r = await refine(ctx.dataDir, ctx.router as Router, { db: ctx.db });
    ctx.counts.refine = { candidates: r.candidates, kept: r.kept, dropped: r.dropped, malformedBatches: r.malformedBatches, hallucinated: r.hallucinated, model: r.model };
    if (r.malformedBatches) ctx.failures.push(stepFailure("refine", r.malformedBatches, r.firstError ?? ""));
    return { changedFiles: r.kept + r.dropped > 0 };
  },
});
