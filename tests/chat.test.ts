import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnBunAcp, AcpClient } from "../src/chat/acp.ts";
import { ChatService, retrievalTerms, chatModel } from "../src/chat/sessions.ts";
import { ingest } from "../src/core/ingest.ts";
import { createBriefing } from "../src/briefings/store.ts";
import { handle } from "../src/server.ts";
import { resetChatServices } from "../src/chat/routes.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-acp.ts");
const spawn = (_model: string, cwd: string) => spawnBunAcp(FAKE, cwd);
let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { resetChatServices(); t.cleanup(); clearEmbedder(); });

async function collect(gen: AsyncGenerator<{ type: string }>) {
  const out: { type: string; [k: string]: unknown }[] = [];
  for await (const e of gen) out.push(e as { type: string });
  return out;
}

describe("acp client", () => {
  test("initialize, session, prompt stream, permission refused, cancel", async () => {
    const c = new AcpClient(spawn("m", t.dir));
    await c.initialize();
    const sid = await c.newSession(t.dir);
    expect(sid).toBe("s1");
    const updates: string[] = [];
    c.onUpdate((u) => updates.push(String(u.update.sessionUpdate)));
    const r = await c.prompt(sid, "PERMISSION please");
    expect(r.stopReason).toBe("end_turn");
    expect(updates).toContain("agent_message_chunk");
    await new Promise((r) => setTimeout(r, 100)); // the fake reports our "cancelled" answer after the turn
    expect(updates).toContain("tool_call_update");
    const slow = c.prompt(sid, "SLOW");
    await c.cancel(sid);
    expect((await slow).stopReason).toBe("cancelled");
    c.close();
    await expect(c.prompt(sid, "x")).rejects.toThrow();
  });
});

describe("chat service", () => {
  test("terms and model", () => {
    expect(retrievalTerms("What did we decide about the camera firmware and the zoom drift?")).toEqual(["decide", "camera", "firmware", "zoom", "drift"]);
    expect(retrievalTerms("a b c d e f g h i j k l m n o p q r s t").length).toBe(0);
    expect(chatModel()).toBe("gpt-4.1");
    process.env.SECOND_BRAIN_CHAT_MODEL = "x";
    expect(chatModel()).toBe("x");
    delete process.env.SECOND_BRAIN_CHAT_MODEL;
  });
  test("brain scope retrieves per turn; item scope grounds the first turn only; busy and expiry", async () => {
    const doc = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "camera firmware zoom drift fixed in 11.8", author: "me" });
    let now = 1_000_000;
    const svc = new ChatService(t.dir, { spawn, now: () => now });
    await expect(svc.create({ type: "item", ids: [] })).rejects.toThrow(/exactly one id/);
    await expect(svc.create({ type: "item", ids: ["nope"] })).rejects.toThrow(/not found/);
    const brain = await svc.create({ type: "brain", ids: [] });
    const ev = await collect(svc.send(brain.id, "what about zoom drift?"));
    expect(ev[0]).toMatchObject({ type: "source", docId: doc.id, title: "Zoom drift" });
    expect(ev.filter((e) => e.type === "message").map((e) => e.text).join("")).toBe("Echo with context: what about zoom drift?");
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ used: 1200, size: 128000 });
    expect(ev[ev.length - 1]).toMatchObject({ type: "done", stopReason: "end_turn" });
    const ev2 = await collect(svc.send(brain.id, "pasta"));
    expect(ev2.some((e) => e.type === "source")).toBe(false);
    expect(ev2.filter((e) => e.type === "message").map((e) => e.text).join("")).toBe("Echo: pasta");
    const item = await svc.create({ type: "item", ids: [doc.id] });
    expect(item.sources[0].docId).toBe(doc.id);
    const first = await collect(svc.send(item.id, "summarise"));
    expect(first.filter((e) => e.type === "message").map((e) => e.text).join("")).toBe("Echo with context: summarise");
    const second = await collect(svc.send(item.id, "more"));
    expect(second.filter((e) => e.type === "message").map((e) => e.text).join("")).toBe("Echo: more");
    // one in-flight prompt per session
    const slow = collect(svc.send(item.id, "SLOW"));
    await new Promise((r) => setTimeout(r, 20));
    await expect(collect(svc.send(item.id, "again"))).rejects.toThrow(/in flight/);
    await slow;
    // idle expiry after 60 minutes
    now += 61 * 60_000;
    svc.expire();
    expect(svc.get(item.id)).toBeUndefined();
    const b = createBriefing(t.dir, { title: "B", body: "briefing body\n" });
    const bs = await svc.create({ type: "briefing", ids: [b.id] });
    expect(svc.buildPrompt(bs, "q").prompt).toContain("briefing body");
    svc.shutdown();
  });
  test("HTTP routes stream NDJSON and map errors", async () => {
    const ctx = { dataDir: t.dir, chatDeps: { spawn } };
    const call = (method: string, path: string, body?: unknown) => handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx);
    expect((await call("POST", "/api/chat/sessions", {})).status).toBe(400);
    expect((await call("POST", "/api/chat/sessions", { scope: { type: "item", ids: ["nope"] } })).status).toBe(404);
    const s = await (await call("POST", "/api/chat/sessions", { scope: { type: "brain", ids: [] } })).json();
    expect(s.sessionId).toMatch(/^[0-9A-Z]{26}$/);
    const r = await call("POST", `/api/chat/sessions/${s.sessionId}/messages`, { message: "hello there" });
    expect(r.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === "message").map((l) => l.text).join("")).toBe("Echo: hello there");
    expect(lines[lines.length - 1].type).toBe("done");
    expect((await call("POST", "/api/chat/sessions/nope/messages", { message: "x" })).status).toBe(404);
    expect((await call("POST", `/api/chat/sessions/${s.sessionId}/messages`, {})).status).toBe(400);
    expect((await (await call("POST", `/api/chat/sessions/${s.sessionId}/cancel`)).json()).ok).toBe(true);
    expect((await (await call("DELETE", `/api/chat/sessions/${s.sessionId}`)).json()).ok).toBe(true);
    expect((await call("POST", `/api/chat/sessions/${s.sessionId}/messages`, { message: "x" })).status).toBe(404);
  });
});
