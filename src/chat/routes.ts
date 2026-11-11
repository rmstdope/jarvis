import { route, json, error, body, HttpError, type ServerContext } from "../http.ts";
import { ChatService, ChatError, type ChatFile, type ChatScope } from "./sessions.ts";
import { UndoConflict } from "./changes.ts";
import { resolvePort } from "../core/config.ts";

const services = new Map<string, ChatService>();
export function chatService(ctx: ServerContext): ChatService {
  const key = ctx.dataDir;
  let s = services.get(key);
  if (!s) {
    s = new ChatService(ctx.dataDir, { serverUrl: () => ctx.url ?? `http://127.0.0.1:${resolvePort()}`, ...(ctx as ServerContext & { chatDeps?: ConstructorParameters<typeof ChatService>[1] }).chatDeps });
    services.set(key, s);
  }
  return s;
}
/** Shut every chat service down; resolves once their agent processes have exited. */
export async function resetChatServices(): Promise<void> {
  const all = [...services.values()];
  services.clear();
  await Promise.all(all.map((s) => s.shutdown()));
}
const wrap = async (fn: () => Promise<Response>): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ChatError) return error(e.message, e.status);
    if (e instanceof HttpError) return error(e.message, e.status);
    return error((e as Error).message, /not found/i.test((e as Error).message) ? 404 : /^invalid /.test((e as Error).message) ? 400 : 500);
  }
};

/** Whether an agent can be started: an injected one (tests), a probe, or the `copilot` CLI on PATH. */
route("GET", "/api/chat/status", (_r, _u, _p, ctx) => {
  const deps = (ctx as ServerContext & { chatDeps?: ConstructorParameters<typeof ChatService>[1] & { available?: () => boolean } }).chatDeps;
  const available = deps?.available ? deps.available() : deps?.spawn ? true : Bun.which("copilot") !== null;
  return json({ available });
});
route("POST", "/api/chat/sessions", (req, _u, _p, ctx) => wrap(async () => {
  const b = await body<{ scope?: ChatScope; conversationId?: string }>(req);
  if (!b.scope) return error("scope is required");
  const s = await chatService(ctx).create(b.scope, b.conversationId);
  return json({ sessionId: s.id, sources: s.sources, model: undefined });
}));
route("POST", "/api/chat/sessions/:id/messages", (req, _u, p, ctx) => wrap(async () => {
  let message: string | undefined;
  const files: ChatFile[] = [];
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const form = await req.formData();
    message = String(form.get("message") ?? "");
    for (const f of form.getAll("files")) if (typeof f !== "string") files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  } else message = (await body<{ message?: string }>(req)).message;
  if (!message) return error("message is required");
  const svc = chatService(ctx);
  const gen = svc.send(p.id, message, files);
  const first = await gen.next(); // surface 404/409/400 before streaming
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) controller.enqueue(enc.encode(JSON.stringify(first.value) + "\n"));
        for await (const ev of gen) controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      } catch (e) {
        controller.enqueue(enc.encode(JSON.stringify({ type: "error", error: (e as Error).message }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
}));
route("POST", "/api/chat/sessions/:id/cancel", (_r, _u, p, ctx) => wrap(async () => {
  await chatService(ctx).cancel(p.id);
  return json({ ok: true });
}));
route("DELETE", "/api/chat/sessions/:id", (_r, _u, p, ctx) => wrap(async () => {
  chatService(ctx).delete(p.id);
  return json({ ok: true });
}));
route("POST", "/api/chat/sessions/:id/actions", (req, _u, p, ctx) => wrap(async () => {
  const b = await body<{ tool?: string; args?: Record<string, unknown> }>(req);
  if (!b.tool) return error("tool is required");
  const r = await chatService(ctx).act(p.id, b.tool, b.args ?? {});
  return json(r);
}));
route("GET", "/api/chat/conversations/:cid/changes", (_r, _u, p, ctx) => wrap(async () => json({ changes: chatService(ctx).changes(p.cid).list() })));
route("POST", "/api/chat/conversations/:cid/changes/undo-all", (req, _u, p, ctx) => wrap(async () => json(await chatService(ctx).changes(p.cid).undoAll((await req.json().catch(() => ({}) as { turn?: string })).turn))));
route("POST", "/api/chat/conversations/:cid/changes/:changeId/undo", (_r, _u, p, ctx) => wrap(async () => {
  try {
    return json({ change: await chatService(ctx).changes(p.cid).undo(p.changeId) });
  } catch (e) {
    if (e instanceof UndoConflict) return error(e.message, 409);
    throw e;
  }
}));
