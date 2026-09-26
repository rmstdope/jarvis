import { route, json, error, body, HttpError, type ServerContext } from "../http.ts";
import { ChatService, ChatError, type ChatScope } from "./sessions.ts";

const services = new Map<string, ChatService>();
export function chatService(ctx: ServerContext): ChatService {
  const key = ctx.dataDir;
  let s = services.get(key);
  if (!s) {
    s = new ChatService(ctx.dataDir, (ctx as ServerContext & { chatDeps?: ConstructorParameters<typeof ChatService>[1] }).chatDeps);
    services.set(key, s);
  }
  return s;
}
export function resetChatServices(): void {
  for (const s of services.values()) s.shutdown();
  services.clear();
}
const wrap = async (fn: () => Promise<Response>): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ChatError) return error(e.message, e.status);
    if (e instanceof HttpError) return error(e.message, e.status);
    return error((e as Error).message, /not found/i.test((e as Error).message) ? 404 : 500);
  }
};

route("POST", "/api/chat/sessions", (req, _u, _p, ctx) => wrap(async () => {
  const b = await body<{ scope?: ChatScope }>(req);
  if (!b.scope) return error("scope is required");
  const s = await chatService(ctx).create(b.scope);
  return json({ sessionId: s.id, sources: s.sources, model: undefined });
}));
route("POST", "/api/chat/sessions/:id/messages", (req, _u, p, ctx) => wrap(async () => {
  const b = await body<{ message?: string }>(req);
  if (!b.message) return error("message is required");
  const svc = chatService(ctx);
  const gen = svc.send(p.id, b.message);
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
