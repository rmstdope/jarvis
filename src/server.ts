import { loadConfig, resolveAuthor } from "./core/config.ts";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { addFilter, readFilters } from "./core/filters.ts";
import { browse, getItem, itemBySource, recent, setContext, setTags } from "./core/browse.ts";
import { ingest, type CapturePayload } from "./core/ingest.ts";
import { search, type SearchMode } from "./core/search.ts";
import { sync, SyncBusyError } from "./core/sync.ts";
import { withDb, withDbAsync } from "./core/db.ts";
import type { Source } from "./core/constants.ts";
import { ASK_MAX_LIMIT } from "./core/constants.ts";
import { ask } from "./core/ask.ts";
import { getRouter } from "./providers/index.ts";
import "./core/passes.ts";
import { decorateItems, initiativeOfTask } from "./core/initiativeDecor.ts";

import { route, json, error, body, HttpError, listRoutes, matchRoute, type RouteHandler, type ServerContext } from "./http.ts";
export { route, json, error, body, HttpError, listRoutes, type RouteHandler, type ServerContext };

route("GET", "/api/health", (_r, _u, _p, ctx) => json({ ok: true, docs: withDb(ctx.dataDir, (db) => (db.query("SELECT count(*) c FROM documents").get() as { c: number }).c) }));

/** The configured name for the greeting: `JARVIS_AUTHOR` or config `author`, never the OS user. */
route("GET", "/api/me", () => {
  const name = process.env.JARVIS_AUTHOR || loadConfig().author;
  return json(name ? { name } : {});
});

route("POST", "/api/capture", async (req, _u, _p, ctx) => {
  const b = await body<Record<string, unknown>>(req);
  const url = (b.source_url ?? b.url) as string | undefined;
  const content = (b.body ?? b.content) as string | undefined;
  if (!b.title || typeof b.title !== "string") return error("title is required");
  if (typeof content !== "string") return error("body (or content) is required");
  const metadata: Record<string, unknown> = { ...((b.metadata as Record<string, unknown>) ?? {}) };
  if (b.capturedAt) metadata.capturedAt = b.capturedAt;
  const byline = b.source_author ?? b.byline;
  if (byline) metadata.source_author = byline;
  const payload: CapturePayload = {
    source: ((b.source as Source) ?? (url ? "web" : "paste")) as Source,
    title: b.title,
    body: content,
    author: b.author as string | undefined,
    source_url: url,
    metadata: Object.keys(metadata).length ? metadata : undefined,
    tags: Array.isArray(b.tags) ? (b.tags as string[]) : undefined,
    starred: typeof b.starred === "boolean" ? b.starred : undefined,
  };
  const r = await ingest(ctx.dataDir, payload);
  return json({ id: r.id, status: r.status, title: r.title });
});

route("GET", "/api/search", async (_r, url, _p, ctx) => {
  const q = url.searchParams.get("q");
  if (!q) return error("q is required");
  const mode = (url.searchParams.get("mode") ?? "hybrid") as SearchMode;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
  const sp = url.searchParams;
  const filter = { source: sp.get("source") ?? undefined, author: sp.get("author") ?? undefined, tag: sp.get("tag") ?? undefined, since: sp.get("since") ?? undefined };
  // The web's result cards show "kind · who · when": add the author and capture time to each hit.
  return json(await withDbAsync(ctx.dataDir, async (db) => {
    const hits = await search(ctx.dataDir, q, { mode, limit, db, filter });
    const row = db.query("SELECT author, created_at AS createdAt FROM documents WHERE id = ?");
    return decorateItems(ctx.dataDir, hits.map((h) => ({ ...h, ...((row.get(h.docId) as { author: string; createdAt: string } | null) ?? {}) })), (h) => h.docId);
  }));
});

route("POST", "/api/sync", async (_r, _u, _p, ctx) => {
  try {
    return json(await sync(ctx.dataDir, { router: ctx.router ?? (await getRouter()) ?? undefined }));
  } catch (e) {
    if (e instanceof SyncBusyError) return error(e.message, 409);
    throw e;
  }
});

route("GET", "/api/browse", (_r, url, _p, ctx) => {
  const sp = url.searchParams;
  const num = (k: string) => (sp.get(k) === null ? undefined : Number(sp.get(k)) || 0);
  const r = browse(ctx.dataDir, {
    limit: num("limit"), addedOffset: num("addedOffset"), updatedOffset: num("updatedOffset"),
    source: sp.get("source") ?? undefined, author: sp.get("author") ?? undefined, tag: sp.get("tag") ?? undefined, since: sp.get("since") ?? undefined,
  });
  const rows = decorateItems(ctx.dataDir, [...r.added, ...r.updated], (i) => i.id);
  return json({ ...r, added: rows.slice(0, r.added.length), updated: rows.slice(r.added.length) });
});
route("GET", "/api/recent", (_r, url, _p, ctx) => json({ items: recent(ctx.dataDir, Number(url.searchParams.get("limit") ?? 10) || 10) }));
route("GET", "/api/item-by-source", (_r, url, _p, ctx) => {
  const u = url.searchParams.get("url");
  if (!u) return error("url is required");
  return json({ item: itemBySource(ctx.dataDir, u) });
});
route("GET", "/api/item/:id", (_r, _u, p, ctx) => {
  const r = getItem(ctx.dataDir, p.id);
  if (!r) return error("not found", 404);
  const initiative = r.item.source === "task" ? initiativeOfTask(ctx.dataDir, p.id) : undefined;
  return json(initiative ? { ...r, initiative } : r);
});
route("POST", "/api/item/:id/tags", async (req, _u, p, ctx) => {
  const b = await body<{ tags?: string[]; author?: string }>(req);
  if (!Array.isArray(b.tags)) return error("tags[] is required");
  setTags(ctx.dataDir, p.id, b.tags, b.author);
  return json({ id: p.id, status: "updated" });
});
route("POST", "/api/item/:id/context", async (req, _u, p, ctx) => {
  const b = await body<{ context?: string; author?: string }>(req);
  if (typeof b.context !== "string") return error("context is required");
  setContext(ctx.dataDir, p.id, b.context, b.author);
  return json({ id: p.id, status: "updated" });
});
route("GET", "/api/filters", (_r, _u, _p, ctx) => json({ filters: readFilters(ctx.dataDir) }));
route("POST", "/api/filters", async (req, _u, _p, ctx) => {
  const b = await body<{ pattern?: string; action?: "block" | "allow" }>(req);
  if (!b.pattern || !b.action) return error("pattern and action are required");
  return json({ filters: addFilter(ctx.dataDir, { pattern: b.pattern, action: b.action }) });
});
route("POST", "/api/ask", async (req, _u, _p, ctx) => {
  const b = await body<{ question?: string; q?: string; mode?: SearchMode; limit?: number }>(req);
  const q = b.question ?? b.q;
  if (!q || typeof q !== "string") return error("question is required");
  const limit = Math.min(ASK_MAX_LIMIT, Math.max(1, Number(b.limit ?? 5) || 5));
  const router = (ctx.router as Awaited<ReturnType<typeof getRouter>> | undefined) ?? (await getRouter());
  return json(await ask(ctx.dataDir, router, q, { mode: b.mode, limit }));
});

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

export async function handle(req: Request, ctx: ServerContext, webDist?: string): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    const m = matchRoute(req.method, url.pathname);
    if (!m) return error("not found", 404);
    try {
      return await m.handler(req, url, m.params, ctx);
    } catch (e) {
      if (e instanceof HttpError) return error(e.message, e.status);
      const msg = (e as Error).message ?? String(e);
      if (/not found/i.test(msg)) return error(msg, 404);
      return error(msg, 500);
    }
  }
  if (webDist) {
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(webDist, rel);
    if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    if (existsSync(file)) {
      const ext = file.slice(file.lastIndexOf("."));
      return new Response(Bun.file(file), { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
    }
  }
  return new Response("jarvis service. Web UI not built (run `bun run web:build`).", { status: 200 });
}

export function startServer(ctx: ServerContext, port: number, webDist?: string) {
  // idleTimeout 0: a sync, an ask or a briefing waits on model calls far longer than Bun's 10 s default, which
  // dropped the answer while the work went on (jv-m9l). The service listens on loopback only.
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (req) => handle(req, ctx, webDist) });
  return server;
}

// ---- briefings ----
import "./briefings/index.ts";
import { addComment, listBriefings, readBriefing, readComments } from "./briefings/store.ts";
import { renderBriefingHtml } from "./briefings/render.ts";

route("GET", "/api/briefings", (_r, _u, _p, ctx) => json(listBriefings(ctx.dataDir)));
route("GET", "/api/briefing/:id", (_r, url, p, ctx) => {
  const b = readBriefing(ctx.dataDir, p.id);
  if (!b) return error("not found", 404);
  const html = url.searchParams.get("html") === "1" ? renderBriefingHtml(b.tree) : undefined;
  return json({ id: b.id, title: b.title, subtitle: b.subtitle, createdAt: b.createdAt, updatedAt: b.updatedAt, kind: b.kind, status: b.status, trail: b.trail, frontmatter: b.frontmatter, tree: b.tree, toc: b.toc, html });
});
route("GET", "/api/briefing/:id/comments", (_r, _u, p, ctx) => json(readComments(ctx.dataDir, p.id)));
route("POST", "/api/briefing/:id/comments", async (req, _u, p, ctx) => {
  const b = await body<{ comment?: string; text?: string; author?: string; selectedText?: string; contextText?: string; anchor?: Record<string, unknown> }>(req);
  const text = b.comment ?? b.text;
  if (!text) return error("comment is required");
  return json(addComment(ctx.dataDir, p.id, { comment: text, author: resolveAuthor(b.author), selectedText: b.selectedText, contextText: b.contextText, anchor: b.anchor as never }));
});

// ---- tasks + manual links (the routes the extension expects) ----
import { addTask, listTasks, showTask, setTaskStatus, suggestLinks } from "./core/tasks.ts";
import { link as linkItems, LINK_RELATIONS } from "./core/links.ts";
import type { Relation } from "./core/constants.ts";

route("GET", "/api/tasks", (_r, url, _p, ctx) => json({ tasks: listTasks(ctx.dataDir, { status: (url.searchParams.get("status") as "open" | "done" | "all") ?? "open", owner: url.searchParams.get("owner") ?? undefined }) }));
route("POST", "/api/task", async (req, _u, _p, ctx) => {
  const b = await body<{ title?: string; body?: string; due?: string; owner?: string; author?: string; links?: string[]; link?: string; relation?: Relation }>(req);
  if (!b.title) return error("title is required");
  const links = b.links ?? (b.link ? [b.link] : []);
  const r = await addTask(ctx.dataDir, { title: b.title, body: b.body, due: b.due, owner: b.owner, author: b.author, links, relation: b.relation });
  return json({ id: r.id, status: "captured", linked: r.linked });
});
route("GET", "/api/task/:id", (_r, _u, p, ctx) => json(showTask(ctx.dataDir, p.id)));
route("POST", "/api/task/:id/done", async (req, _u, p, ctx) => json(setTaskStatus(ctx.dataDir, p.id, "done", (await req.json().catch(() => ({})) as { author?: string }).author)));
route("POST", "/api/task/:id/reopen", async (req, _u, p, ctx) => json(setTaskStatus(ctx.dataDir, p.id, "open", (await req.json().catch(() => ({})) as { author?: string }).author)));
route("GET", "/api/task/:id/suggest", async (_r, url, p, ctx) => json({ suggestions: await suggestLinks(ctx.dataDir, p.id, { limit: Number(url.searchParams.get("limit") ?? 5) || 5 }) }));
route("POST", "/api/link", async (req, _u, _p, ctx) => {
  const b = await body<{ src?: string; dst?: string | string[]; relation?: Relation; author?: string }>(req);
  if (!b.src || !b.dst) return error("src and dst are required");
  if (b.relation && !LINK_RELATIONS.includes(b.relation)) return error(`relation must be one of ${LINK_RELATIONS.join("|")}`);
  return json({ links: linkItems(ctx.dataDir, b.src, Array.isArray(b.dst) ? b.dst : [b.dst], { relation: b.relation, author: b.author }) });
});

// ---- presentations ----
import { deckInSlidecraft, discoverSlidecraft, listPresentations, readPresentation } from "./core/presentations.ts";

route("GET", "/api/presentations", async (_r, _u, _p, ctx) => {
  const slidecraft = await discoverSlidecraft(ctx.dataDir);
  const indexed = new Set(withDb(ctx.dataDir, (db) => (db.query("SELECT id FROM documents WHERE source = 'presentation'").all() as { id: string }[]).map((r) => r.id)));
  return json(listPresentations(ctx.dataDir).map((p) => ({ id: p.id, slug: p.slug, title: p.title, author: p.author, created_at: p.created_at, updated_at: p.updated_at, tags: p.frontmatter.tags, indexed: indexed.has(p.id), slidecraft: deckInSlidecraft(slidecraft, p.slug) })));
});
route("GET", "/api/presentation/:id", async (_r, _u, p, ctx) => {
  const pres = readPresentation(ctx.dataDir, p.id);
  if (!pres) return error("not found", 404);
  const slidecraft = await discoverSlidecraft(ctx.dataDir);
  const indexed = !!withDb(ctx.dataDir, (db) => db.query("SELECT 1 FROM documents WHERE id = ?").get(pres.id));
  return json({ id: pres.id, slug: pres.slug, title: pres.title, author: pres.author, created_at: pres.created_at, updated_at: pres.updated_at, indexed, slidecraft: deckInSlidecraft(slidecraft, pres.slug), frontmatter: pres.frontmatter, body: pres.body, filePath: pres.filePath });
});

// ---- chat over Copilot ACP ----
import "./chat/routes.ts";

// ---- initiatives in the web UI ----
import "./initiatives/routes.ts";
