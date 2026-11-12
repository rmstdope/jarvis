import { route, json, error, body, type ServerContext } from "../http.ts";
import { withDb } from "../core/db.ts";
import { readDocFile } from "../core/docs.ts";
import { closeInitiative, editInitiative, initiativeSuggestions, listInitiatives, reopenInitiative, showInitiative } from "../core/initiatives.ts";
import { getRouter } from "../providers/index.ts";

/** The core's "no initiative …" and "… is a task" errors are a missing page, not a server fault. */
const missing = (e: unknown): boolean => /^no initiative |is a task, not an initiative/.test((e as Error).message ?? "");
const guard = async (fn: () => Promise<Response> | Response): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    if (missing(e)) return error((e as Error).message, 404);
    throw e;
  }
};

route("GET", "/api/initiatives", (_r, url, _p, ctx) => {
  const status = url.searchParams.get("status");
  const want = status === "closed" || status === "all" ? status : "open";
  const rows = withDb(ctx.dataDir, (db) => listInitiatives(ctx.dataDir, { status: want, db })).flatMap((s) => {
    const doc = readDocFile(ctx.dataDir, s.id);
    return doc ? [{ ...s, goal: doc.body.trim(), updated_at: doc.frontmatter.updated_at ?? doc.frontmatter.created_at }] : []; // a row whose file is gone (mid-sync) is skipped
  });
  return json({ initiatives: rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)) });
});
route("GET", "/api/initiative/:id", (_r, _u, p, ctx) => guard(async () => {
  const d = await showInitiative(ctx.dataDir, p.id, { all: true });
  const fm = readDocFile(ctx.dataDir, d.initiative.id)?.frontmatter;
  return json({ ...d, initiative: { ...d.initiative, updated_at: fm?.updated_at ?? fm?.created_at } });
}));
route("GET", "/api/initiative/:id/suggest", (_r, _u, p, ctx: ServerContext) => guard(async () => {
  const router = (ctx.router as Awaited<ReturnType<typeof getRouter>> | undefined) ?? (await getRouter());
  return json(await initiativeSuggestions(ctx.dataDir, p.id, { router }));
}));
route("POST", "/api/initiative/:id/close", (req, _u, p, ctx) => guard(async () => {
  const b = await body<{ anyway?: boolean; author?: string }>(req);
  try {
    return json(await closeInitiative(ctx.dataDir, p.id, { anyway: !!b.anyway, author: b.author }));
  } catch (e) {
    if (/still has \d+ open task/.test((e as Error).message)) return error((e as Error).message, 409);
    throw e;
  }
}));
route("POST", "/api/initiative/:id/reopen", (req, _u, p, ctx) => guard(async () => json(await reopenInitiative(ctx.dataDir, p.id, (await body<{ author?: string }>(req)).author))));
route("POST", "/api/initiative/:id/edit", (req, _u, p, ctx) => guard(async () => {
  const b = await body<{ title?: string; goal?: string; owner?: string; author?: string }>(req);
  try {
    return json(await editInitiative(ctx.dataDir, p.id, { title: b.title, goal: b.goal, owner: b.owner, author: b.author }));
  } catch (e) {
    if (/^(an initiative needs|An initiative needs|usage:)/.test((e as Error).message)) return error((e as Error).message, 400);
    throw e;
  }
}));
