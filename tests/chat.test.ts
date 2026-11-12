import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readDocFile } from "../src/core/docs.ts";
import { readSidecar } from "../src/core/sidecar.ts";
import { spawnBunAcp, AcpClient, copilotAcpArgs } from "../src/chat/acp.ts";
import { ChatService, retrievalTerms, chatModel } from "../src/chat/sessions.ts";
import { ingest } from "../src/core/ingest.ts";
import { addInitiative } from "../src/core/initiatives.ts";
import { addTask } from "../src/core/tasks.ts";
import { link } from "../src/core/links.ts";
import { createBriefing } from "../src/briefings/store.ts";
import { handle } from "../src/server.ts";
import { resetChatServices } from "../src/chat/routes.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-acp.ts");
const spawn = (_model: string | undefined, cwd: string) => spawnBunAcp(FAKE, cwd);
let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(async () => { await resetChatServices(); t.cleanup(); clearEmbedder(); });

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
    await c.close();
    await expect(c.prompt(sid, "x")).rejects.toThrow();
  });
});

describe("shutdown waits for the agent process (jv-den)", () => {
  // On Windows a live child keeps its cwd (the test's temporary directory) busy, so a close that
  // returns before the child has exited lets cleanup race it into EBUSY.
  /** A stub agent that exits 50 ms after kill(); `initialize` answers after answerDelayMs, with an error, or never. */
  function slowExitTransport(answerDelayMs = 0, init: "ok" | "error" | "never" = "ok") {
    const state = { exited: false };
    let exit!: () => void;
    const exited = new Promise<number>((r) => (exit = () => { state.exited = true; r(0); }));
    let push!: (o: unknown) => void;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { push = (o) => c.enqueue(new TextEncoder().encode(JSON.stringify(o) + "\n")); } });
    const answers: Record<string, unknown> = { initialize: { protocolVersion: 1 }, "session/new": { sessionId: "s1" } };
    const write = (line: string) => {
      const m = JSON.parse(line);
      if (m.id === undefined || (m.method === "initialize" && init === "never")) return;
      const reply = m.method === "initialize" && init === "error" ? { error: { code: -32000, message: "boom" } } : { result: answers[m.method] ?? {} };
      setTimeout(() => push({ jsonrpc: "2.0", id: m.id, ...reply }), answerDelayMs);
    };
    return { state, crash: exit, transport: { stdin: { write }, stdout, kill: () => { setTimeout(exit, 50); }, exited } };
  }
  test("AcpClient.close resolves only once the agent process has exited", async () => {
    const { state, transport } = slowExitTransport();
    const c = new AcpClient(transport);
    await c.close();
    expect(state.exited).toBe(true);
  });
  test("ChatService.shutdown and resetChatServices resolve only once the agent process has exited", async () => {
    const one = slowExitTransport();
    const svc = new ChatService(t.dir, { spawn: () => one.transport });
    await svc.create({ type: "jarvis", ids: [] });
    await svc.shutdown();
    expect(one.state.exited).toBe(true);
    const two = slowExitTransport();
    const ctx = { dataDir: t.dir, chatDeps: { spawn: () => two.transport } };
    const r = await handle(new Request("http://127.0.0.1:7281/api/chat/sessions", { method: "POST", body: JSON.stringify({ scope: { type: "jarvis", ids: [] } }), headers: { "content-type": "application/json" } }), ctx);
    expect(r.status).toBe(200);
    await resetChatServices();
    expect(two.state.exited).toBe(true);
  });
  test("ChatService.shutdown while the agent is still starting waits for that agent too", async () => {
    const starting = slowExitTransport(50);
    const svc = new ChatService(t.dir, { spawn: () => starting.transport });
    const created = svc.create({ type: "jarvis", ids: [] }).then(() => "created", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10)); // spawned, initialize not answered yet
    await svc.shutdown();
    expect(starting.state.exited).toBe(true);
    expect(await created).toMatch(/closed/);
  });
  test("ChatService.shutdown after the agent crashed and a restart is starting waits for the restarted agent", async () => {
    const first = slowExitTransport();
    const restarted = slowExitTransport(50);
    const transports = [first, restarted];
    const svc = new ChatService(t.dir, { spawn: () => transports.shift()!.transport });
    await svc.create({ type: "jarvis", ids: [] });
    first.crash();
    await new Promise((r) => setTimeout(r, 10));
    const created = svc.create({ type: "jarvis", ids: [] }).then(() => "created", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10)); // restart spawned, initialize not answered yet
    await svc.shutdown();
    expect(restarted.state.exited).toBe(true);
    expect(await created).toMatch(/closed/);
  });
  test("a failed initialize stops the agent it started", async () => {
    const failing = slowExitTransport(0, "error");
    const svc = new ChatService(t.dir, { spawn: () => failing.transport });
    await expect(svc.create({ type: "jarvis", ids: [] })).rejects.toThrow(/boom/);
    expect(failing.state.exited).toBe(true);
    await svc.shutdown();
  });
  test("ChatService.shutdown stops an agent whose initialize never answers, without waiting for its timeout", async () => {
    const silent = slowExitTransport(0, "never");
    const svc = new ChatService(t.dir, { spawn: () => silent.transport });
    const created = svc.create({ type: "jarvis", ids: [] }).then(() => "created", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    await svc.shutdown();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(silent.state.exited).toBe(true);
    expect(await created).toMatch(/closed/);
  });
});

describe("copilot acp command line", () => {
  test("no chatModel configured: Copilot picks its own model and no reasoning effort is forced (jv-e1c)", () => {
    const args = copilotAcpArgs(undefined);
    expect(args.slice(0, 2)).toEqual(["copilot", "--acp"]);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--reasoning-effort");
    expect(args).toContain("--available-tools=");
    expect(args.join(" ")).not.toContain("jarvis");
  });
  test("a configured chatModel is passed through, still without a reasoning effort a model may reject", () => {
    const args = copilotAcpArgs("gpt-4.1");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-4.1");
    expect(args).not.toContain("--reasoning-effort");
  });
});

describe("chat service", () => {
  test("terms and model", () => {
    expect(retrievalTerms("What did we decide about the camera firmware and the zoom drift?")).toEqual(["decide", "camera", "firmware", "zoom", "drift"]);
    expect(retrievalTerms("a b c d e f g h i j k l m n o p q r s t").length).toBe(0);
    expect(chatModel()).toBeUndefined();
    process.env.JARVIS_CHAT_MODEL = "x";
    expect(chatModel()).toBe("x");
    delete process.env.JARVIS_CHAT_MODEL;
  });
  test("with no chatModel configured the agent is spawned with no model (jv-e1c)", async () => {
    const models: (string | undefined)[] = [];
    const svc = new ChatService(t.dir, { spawn: (m, cwd) => { models.push(m); return spawnBunAcp(FAKE, cwd); } });
    await svc.create({ type: "jarvis", ids: [] });
    expect(models).toEqual([undefined]);
    await svc.shutdown();
  });
  test("jarvis scope retrieves per turn; item scope grounds the first turn only; busy and expiry", async () => {
    const doc = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "camera firmware zoom drift fixed in 11.8", author: "me" });
    let now = 1_000_000;
    const svc = new ChatService(t.dir, { spawn, now: () => now });
    await expect(svc.create({ type: "item", ids: [] })).rejects.toThrow(/exactly one id/);
    await expect(svc.create({ type: "item", ids: ["nope"] })).rejects.toThrow(/not found/);
    const jarvis = await svc.create({ type: "jarvis", ids: [] });
    const ev = await collect(svc.send(jarvis.id, "what about zoom drift?"));
    expect(ev[0]).toMatchObject({ type: "source", docId: doc.id, title: "Zoom drift" });
    expect(ev.filter((e) => e.type === "message").map((e) => e.text).join("")).toBe("Echo with context: what about zoom drift?");
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ used: 1200, size: 128000 });
    expect(ev[ev.length - 1]).toMatchObject({ type: "done", stopReason: "end_turn" });
    const ev2 = await collect(svc.send(jarvis.id, "pasta"));
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
    await svc.shutdown();
  });
  test("initiative scope: unknown id is not found, the first turn carries its tasks and tied captures, later turns are bare", async () => {
    const ini = await addInitiative(t.dir, { title: "Ledger move", goal: "everything on the new ledger", author: "me" });
    await addTask(t.dir, { title: "Dry-run invoices", initiative: ini.id });
    const note = await ingest(t.dir, { source: "note", title: "Cutover plan", body: "plan", author: "me" });
    link(t.dir, ini.id, [note.id]);
    const svc = new ChatService(t.dir, { spawn });
    await expect(svc.create({ type: "initiative", ids: ["nope"] })).rejects.toThrow(/not found/);
    const s = await svc.create({ type: "initiative", ids: [ini.id] });
    expect(s.sources).toEqual([{ docId: ini.id, title: "Ledger move", source: "initiative" }]);
    const first = svc.buildPrompt(s, "what is left?").prompt;
    expect(first).toContain("everything on the new ledger");
    expect(first).toContain("Dry-run invoices");
    expect(first).toContain("Cutover plan");
    s.turns = 1;
    expect(svc.buildPrompt(s, "more").prompt).toBe("more");
    await svc.shutdown();
  });
  test("a meeting kept off cloud models still reaches the prompt by title and id, never its transcript (jv-9z6)", async () => {
    const meeting = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "zebrafish rollout decided by Sam", author: "me" });
    const note = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "audio drifts after an hour", author: "me" });
    const svc = new ChatService(t.dir, { spawn });
    const s = await svc.create({ type: "jarvis", ids: [] });
    const r = svc.buildPrompt(s, "Link the Weekly sync meeting to the Zoom drift note.");
    expect(r.prompt).toContain(`[${meeting.id}] Weekly sync (meeting)`);
    expect(r.prompt).toContain(`[${note.id}] Zoom drift (note)`);
    expect(r.prompt).not.toContain("zebrafish");
    expect(r.prompt).not.toContain("Sam");
    expect(r.sources.map((x) => x.docId)).toContain(meeting.id);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(t.dir, "config"), { recursive: true });
    writeFileSync(join(t.dir, "config", "team.toml"), "[privacy]\ntranscripts_to_cloud = true\n");
    expect(svc.buildPrompt(s, "Link the Weekly sync meeting to the Zoom drift note.").prompt).toContain("zebrafish");
    await svc.shutdown();
  });
  test("HTTP routes stream NDJSON and map errors", async () => {
    const ctx = { dataDir: t.dir, chatDeps: { spawn } };
    const call = (method: string, path: string, body?: unknown) => handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx);
    expect((await call("POST", "/api/chat/sessions", {})).status).toBe(400);
    expect((await call("POST", "/api/chat/sessions", { scope: { type: "item", ids: ["nope"] } })).status).toBe(404);
    const s = await (await call("POST", "/api/chat/sessions", { scope: { type: "jarvis", ids: [] } })).json();
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

describe("chat status route", () => {
  const status = async (chatDeps?: { spawn?: unknown; available?: () => boolean }) =>
    (await (await handle(new Request("http://127.0.0.1:7281/api/chat/status"), { dataDir: t.dir, chatDeps } as never)).json()) as { available: boolean };
  test("available with an injected agent or a probe saying yes; unavailable when the probe says no", async () => {
    expect(await status({ spawn })).toEqual({ available: true });
    expect(await status({ available: () => true })).toEqual({ available: true });
    expect(await status({ available: () => false })).toEqual({ available: false });
  });
});

describe("the agent acts (jv-oya.4)", () => {
  let ctx: { dataDir: string; chatDeps: Record<string, unknown> };
  beforeEach(() => { ctx = { dataDir: t.dir, chatDeps: { spawn } }; });
  const call = (method: string, path: string, body?: unknown | FormData) =>
    handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? undefined : { "content-type": "application/json" } }), ctx as never);
  const ndjson = async (r: Response) => (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  const open = async (conversationId = "conv1") => (await (await call("POST", "/api/chat/sessions", { scope: { type: "jarvis", ids: [] }, conversationId })).json()).sessionId as string;

  test("action blocks in the answer make a change, streams it, and Undo works over HTTP", async () => {
    const sid = await open();
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_create_task {"title":"Ring the vendor","due":"2026-11-13"} ACT jarvis_link {"src":"nope","dst":"x"}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok])).toEqual([["task.create", true], ["link", false]]);
    expect(changes[0].turn).toBe(changes[1].turn);
    const listed = (await (await call("GET", "/api/chat/conversations/conv1/changes")).json()).changes;
    expect(listed.map((c: { id: string }) => c.id)).toEqual(changes.map((c) => c.id));
    const undone = await (await call("POST", `/api/chat/conversations/conv1/changes/${changes[0].id}/undo`)).json();
    expect(undone.change.undone).toBe(true);
    expect((await call("POST", `/api/chat/conversations/conv1/changes/${changes[0].id}/undo`)).status).toBe(200); // already undone: unchanged
    expect((await call("POST", "/api/chat/conversations/conv1/changes/undo-all")).status).toBe(200);
  });
  test("a task created with a link streams a Created task row and a Linked row (jv-eit)", async () => {
    const sid = await open("conv-eit");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_capture_note {"text":"zoom drift","title":"Zoom drift"} AS z ACT jarvis_create_task {"title":"Order spare Zoom cameras","link":["$z"]}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok, c.undoable])).toEqual([["capture.note", true, true], ["task.create", true, true], ["link", true, true]]);
    expect(changes[2].items.map((i: { title: string }) => i.title)).toEqual(["Order spare Zoom cameras", "Zoom drift"]);
  });
  test("undoing a created task settles its Linked rows as undone at once (jv-a9b)", async () => {
    const sid = await open("conv-a9b");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_capture_note {"text":"zoom drift","title":"Zoom drift"} AS z ACT jarvis_create_task {"title":"Order spare Zoom cameras","link":["$z"]}' }));
    const [note, made, linked] = evs.filter((e) => e.type === "change").map((e) => e.change);
    const r = await (await call("POST", `/api/chat/conversations/conv-a9b/changes/${made.id}/undo`)).json();
    expect(r.change.undone).toBe(true);
    const listed = (await (await call("GET", "/api/chat/conversations/conv-a9b/changes")).json()).changes as { id: string; undone: boolean }[];
    expect(listed.map((c) => [c.id, c.undone])).toEqual([[note.id, false], [made.id, true], [linked.id, true]]);
    expect(r.changes).toEqual(listed); // the Undo answer carries every row it settled, so the card updates at once
  });
  test("undoing a created task leaves every other Linked row as it was, even one already gone some other way (jv-a9b)", async () => {
    const { rmSync } = await import("node:fs");
    const { docPath } = await import("../src/core/docs.ts");
    const sid = await open("conv-a9b-2");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_capture_note {"text":"x","title":"X"} AS x ACT jarvis_capture_note {"text":"y","title":"Y"} AS y ACT jarvis_link {"src":"$x","dst":"$y"} ACT jarvis_create_task {"title":"One","link":["$x"]} ACT jarvis_create_task {"title":"Two","link":["$y"]}' }));
    const rows = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(rows.map((c) => c.kind)).toEqual(["capture.note", "capture.note", "link", "task.create", "link", "task.create", "link"]);
    const [, , xy, one, oneX, two, twoY] = rows;
    rmSync(docPath(t.dir, two.items[0].id)); // a teammate's sync removed task Two and its links, outside this chat
    rmSync(join(t.dir, "edges", `${two.items[0].id}.jsonl`), { force: true });
    expect((await call("POST", `/api/chat/conversations/conv-a9b-2/changes/${one.id}/undo`)).status).toBe(200);
    const listed = (await (await call("GET", "/api/chat/conversations/conv-a9b-2/changes")).json()).changes as { id: string; undone: boolean }[];
    const undone = new Map(listed.map((c) => [c.id, c.undone]));
    expect([undone.get(one.id), undone.get(oneX.id), undone.get(xy.id), undone.get(twoY.id)]).toEqual([true, true, false, false]);
  });
  test("the change log outlives the chat session", async () => {
    const sid = await open("conv2");
    await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_capture_note {"text":"remember this","title":"Remember"}' }));
    await call("DELETE", `/api/chat/sessions/${sid}`);
    const listed = (await (await call("GET", "/api/chat/conversations/conv2/changes")).json()).changes;
    expect(listed).toHaveLength(1);
    expect(listed[0].items[0].title).toBe("Remember");
  });
  test("a conflicting Undo is a 409 with the sentence", async () => {
    const sid = await open("conv3");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_create_task {"title":"Mine"}' }));
    const c = evs.find((e) => e.type === "change").change;
    const { writeFileSync, readFileSync } = await import("node:fs");
    const p = join(t.dir, "docs", `${c.items[0].id}.md`);
    writeFileSync(p, readFileSync(p, "utf8").replace("title: Mine", "title: Mine v2"));
    const r = await call("POST", `/api/chat/conversations/conv3/changes/${c.id}/undo`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("Couldn't undo — Mine was changed after the agent changed it.");
  });
  test("attachments: kinds and size are checked, files are named in the prompt, a transcript is withheld unless the team allows it", async () => {
    const sid = await open("conv4");
    const send = async (files: [string, string | Uint8Array<ArrayBuffer>][], message = "capture these") => {
      const f = new FormData();
      f.set("message", message);
      for (const [n, c] of files) f.append("files", new File([c], n));
      return call("POST", `/api/chat/sessions/${sid}/messages`, f);
    };
    const bad = await send([["demo.mov", "x"]]);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("demo.mov — can't capture this kind of file");
    expect((await (await send([["big.pdf", new Uint8Array(new ArrayBuffer(25 * 1024 * 1024 + 1))]])).json()).error).toBe("big.pdf — larger than 25 MB");
    const ok = await ndjson(await send([["notes.md", "# Notes\nhello"], ["sync.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Sam>We decided to ship."]]));
    const said = ok.filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(said).toContain("Attached files");
    expect(said).toContain("notes.md");
    expect(said).toContain("# Notes\nhello");
    expect(said).toContain("You may not read it");
    expect(said).toContain("I saved the transcript, but your team doesn't allow sending meeting transcripts to the model I'm using, so I can't read it to find the decisions.");
    expect(said).not.toContain("We decided to ship");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(t.dir, "config"), { recursive: true });
    writeFileSync(join(t.dir, "config", "team.toml"), "[privacy]\ntranscripts_to_cloud = true\n");
    const allowed = await ndjson(await send([["sync.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Sam>We decided to ship."]], "what was decided"));
    expect(allowed.filter((e) => e.type === "message").map((e) => e.text).join("")).toContain("We decided to ship");
  });
  test("a .srt is accepted and a transcript saved as .txt is withheld too, unless the team allows it", async () => {
    const sid = await open("conv6");
    const f = new FormData();
    f.set("message", "read these");
    f.append("files", new File(["1\n00:00:01,000 --> 00:00:02,000\nSecret srt line"], "talk.srt"));
    f.append("files", new File(["00:01 Sam: secret txt line\n00:09 Kim: more\n00:15 Sam: yet more\n"], "talk.txt"));
    f.append("files", new File(["# Plain notes\nbuy milk"], "plain.md"));
    const said = (await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, f))).filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(said).not.toContain("Secret srt line");
    expect(said).not.toContain("secret txt line");
    expect(said).toContain("buy milk");
  });
  test("a captured meeting's transcript never reaches the prompt through retrieval unless allowed", async () => {
    const { ingest } = await import("../src/core/ingest.ts");
    await ingest(t.dir, { source: "meeting", title: "Standup", body: "zebrafish rollout decision", author: "me" });
    const sid = await open("conv7");
    const said = (await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: "what about zebrafish rollout" }))).filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(said).not.toContain("zebrafish rollout decision");
  });
  test("capturing an attached file through the tool", async () => {
    const sid = await open("conv5");
    const f = new FormData();
    f.set("message", 'ACT jarvis_capture_file {"attachment":"notes.md"}');
    f.append("files", new File(["# Notes\nhello"], "notes.md"));
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, f));
    expect(evs.find((e) => e.type === "change").change).toMatchObject({ kind: "capture.file", ok: true });
  });
  test("events go out in the order written: text, then the change, then the text after the block (jv-de8)", async () => {
    const sid = await open("conv8b");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_create_task {"title":"Write notes"}' }));
    const seq = evs.filter((e) => e.type === "message" || e.type === "change").map((e) => (e.type === "change" ? "change" : e.text));
    expect(seq).toEqual(["On it.\n", "change", "Done."]);
  });
  test("the blocks and the Info lines never reach the person; aliases carry ids between blocks", async () => {
    const sid = await open("conv8");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_create_initiative {"title":"Launch","goal":"Ship it"} AS i1 ACT jarvis_create_task {"title":"Write notes","initiative":"$i1"}' }));
    const said = evs.filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(said).toBe("On it.\nDone.");
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok])).toEqual([["initiative.create", true], ["task.create", true]]);
    expect(evs.findIndex((e) => e.type === "done")).toBeGreaterThan(evs.findLastIndex((e) => e.type === "change"));
    const { readDocFile } = await import("../src/core/docs.ts");
    expect(readDocFile(t.dir, changes[1].items[0].id)?.frontmatter.task?.initiative).toBe(changes[0].items[0].id);
  });
  test("a failure is told to the agent in the same turn, and the next turn is told every id it made", async () => {
    const sid = await open("conv11");
    const first = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_create_task {"title":"Seed"} AS s ACT jarvis_set_task_status {"task":"missing","status":"done"}' }));
    expect(first.filter((e) => e.type === "message").map((e) => e.text).join("")).toContain("could not update task"); // the follow-up prompt (the fake echoes it)
    expect(first.filter((e) => e.type === "message").map((e) => e.text).join("").match(/Some of your actions failed/g)).toHaveLength(1); // exactly one extra prompt
    expect(first.filter((e) => e.type === "change")).toHaveLength(2); // the follow-up's own block did not run
    expect(first.filter((e) => e.type === "message").map((e) => e.text).join("")).not.toContain("jarvis-action");
    expect(first.filter((e) => e.type === "message").map((e) => e.text).join("")).toContain("Done.\n\nSorry.");
    expect(first.at(-1)!.type).toBe("done"); // nothing after done (jv-de8)
    const id = first.find((e) => e.type === "change").change.items[0].id;
    const second = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: "now mark that done" }));
    const said = second.filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(said).toContain(`Seed [${id}]`);
    expect(said).not.toContain("Some of your actions failed"); // a turn without failures sends no extra prompt
  });
  test("an action naming an unknown tool is dropped without a row", async () => {
    const sid = await open("conv9");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_format_disk {} ACT jarvis_capture_note {"text":"kept","title":"Kept"}' }));
    expect(evs.filter((e) => e.type === "change").map((e) => e.change.kind)).toEqual(["capture.note"]);
  });
  test("every permission request is cancelled", async () => {
    const sid = await open("conv10");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: "PERMISSION please" }));
    expect(evs.some((e) => e.type === "status" && e.text === "permission cancelled")).toBe(true);
  });
  test("an action may name an existing task or note by its title when its id is not in context (jv-zyp)", async () => {
    const task = await addTask(t.dir, { title: "Ship the firmware", author: "me" });
    const sync = await ingest(t.dir, { source: "note", title: "Weekly sync", body: "agenda", author: "me" });
    const drift = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "clock drift seen", author: "me" });
    const sid = await open("conv11");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_capture_note {"text":"new","title":"Fresh"} ACT jarvis_set_task_status {"task":"Ship the firmware","status":"done"} ACT jarvis_link {"src":"weekly sync","dst":"Zoom drift"}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok, c.error])).toEqual([["capture.note", true, undefined], ["task.done", true, undefined], ["link", true, undefined]]);
    expect(changes[1].items[0].id).toBe(task.id);
    expect(changes[2].items.map((i: { id: string }) => i.id)).toEqual([sync.id, drift.id]);
  });
  test("a title is found when the agent names it as the user said it, with 'the' and a kind word (jv-zyp)", async () => {
    const sync = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda", author: "me" });
    const drift = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "clock drift seen", author: "me" });
    const task = await addTask(t.dir, { title: "Ship the firmware", author: "me" });
    await ingest(t.dir, { source: "note", title: "Standup", body: "a shorter title", author: "me" });
    const standup = await ingest(t.dir, { source: "note", title: "Standup meeting", body: "a title that ends in a kind word", author: "me" });
    const roadmap = await ingest(t.dir, { source: "note", title: "The roadmap", body: "a title that starts with The", author: "me" });
    await ingest(t.dir, { source: "note", title: "Roadmap", body: "a title without it", author: "me" });
    const sid = await open("conv14");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_link {"src":"Weekly sync meeting","dst":"the Zoom drift note"} ACT jarvis_set_task_status {"task":"the Ship the firmware task","status":"done"} ACT jarvis_link {"src":"Standup meeting","dst":"Zoom drift"} ACT jarvis_link {"src":"the roadmap doc","dst":"Zoom drift"}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok, c.error])).toEqual([["link", true, undefined], ["task.done", true, undefined], ["link", true, undefined], ["link", true, undefined]]);
    expect(changes[0].items.map((i: { id: string }) => i.id)).toEqual([sync.id, drift.id]);
    expect(changes[1].items[0].id).toBe(task.id);
    expect(changes[2].items[0].id).toBe(standup.id); // the title as given wins over the one without its kind word
    expect(changes[3].items[0].id).toBe(roadmap.id); // "the" is kept while only the kind word is dropped
  });
  test("the kind word the user says picks the item when a meeting and a task share a title (jv-ldo)", async () => {
    const meeting = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda", author: "me" });
    const task = await addTask(t.dir, { title: "Weekly sync", author: "me" });
    const drift = await ingest(t.dir, { source: "note", title: "Zoom drift", body: "clock drift seen", author: "me" });
    const sid = await open("conv-ldo1");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_link {"src":"the Weekly sync meeting","dst":"Zoom drift"} ACT jarvis_link {"src":"Weekly sync task","dst":"Zoom drift"}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok, c.error])).toEqual([["link", true, undefined], ["link", true, undefined]]);
    expect(changes[0].items.map((i: { id: string }) => i.id)).toEqual([meeting.id, drift.id]);
    expect(changes[1].items.map((i: { id: string }) => i.id)).toEqual([task.id, drift.id]);
  });
  test("a kind word matching neither or both of the items sharing a title still refuses with the ids (jv-ldo)", async () => {
    const m1 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda one", author: "me" });
    const m2 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda two", author: "me" });
    const task = await addTask(t.dir, { title: "Weekly sync", author: "me" });
    await ingest(t.dir, { source: "note", title: "Zoom drift", body: "clock drift seen", author: "me" });
    const sid = await open("conv-ldo2");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_link {"src":"Weekly sync meeting","dst":"Zoom drift"} ACT jarvis_link {"src":"Weekly sync note","dst":"Zoom drift"}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    for (const c of changes) {
      expect(c.ok).toBe(false);
      for (const id of [m1.id, m2.id, task.id]) expect(c.error).toContain(`[${id}]`);
    }
    expect(changes.length).toBe(2);
  });
  test("a kind word that is part of the shared title does not pick an item (jv-ldo)", async () => {
    const m = await ingest(t.dir, { source: "meeting", title: "Standup meeting", body: "agenda", author: "me" });
    const task = await addTask(t.dir, { title: "Standup meeting", author: "me" });
    await ingest(t.dir, { source: "note", title: "Zoom drift", body: "clock drift seen", author: "me" });
    const sid = await open("conv-ldo3");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_link {"src":"the Standup meeting","dst":"Zoom drift"}' }));
    const c = evs.find((e) => e.type === "change").change;
    expect(c.ok).toBe(false);
    for (const id of [m.id, task.id]) expect(c.error).toContain(`[${id}]`);
  });
  test("the agent passing the id of one of two meetings in its context that share the title the user said is asked which, not linked (jv-6c1)", async () => {
    const m1 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda one", author: "me" });
    const m2 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda two", author: "me" });
    const task = await addTask(t.dir, { title: "Weekly sync", author: "me" });
    const rota = await ingest(t.dir, { source: "note", title: "Lunch rota", body: "who brings lunch", author: "me" });
    const sid = await open("conv-6c1");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `link the Weekly sync meeting to the Lunch rota note ACT jarvis_link {"src":"${m1.id}","dst":"${rota.id}"}` }));
    const seen = evs.filter((e) => e.type === "source").map((e) => e.docId);
    expect(seen).toEqual(expect.arrayContaining([m1.id, m2.id])); // both meetings were in the agent's context
    const c = evs.find((e) => e.type === "change").change;
    expect([c.kind, c.ok]).toEqual(["link", false]);
    expect(c.error).toBeUndefined(); // a question, not a failure (jv-bt4)
    expect(c.ask.options.map((o: { id: string }) => o.id).sort()).toEqual([m1.id, m2.id].sort());
    expect(c.ask.options.map((o: { id: string }) => o.id)).not.toContain(task.id); // the task is not a meeting: the agent told them apart
    expect([c.ask.title, c.ask.source, c.ask.tool]).toEqual(["Weekly sync", "meeting", "jarvis_link"]);
    expect(readSidecar(t.dir, m1.id).filter((l) => l.kind === "edge")).toEqual([]);
  });
  test("a question to the user is put to the agent as one follow-up prompt without ids, and the sources sharing a title carry their detail (jv-bt4)", async () => {
    const m1 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda one", author: "me" });
    const m2 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda two", author: "me" });
    const rota = await ingest(t.dir, { source: "note", title: "Lunch rota", body: "who brings lunch", author: "me" });
    const sid = await open("conv-bt4a");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `link the Weekly sync meeting to the Lunch rota note ACT jarvis_link {"src":"${m1.id}","dst":"${rota.id}"}` }));
    const said = evs.filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(said).toContain("You need the user to choose");
    expect(said).toContain("2 meetings are called \"Weekly sync\"");
    expect(said).not.toContain("Some of your actions failed");
    for (const id of [m1.id, m2.id]) expect(said).not.toContain(id);
    const sources = evs.filter((e) => e.type === "source");
    const byId = Object.fromEntries(sources.map((s) => [s.docId, s]));
    expect(byId[m1.id].detail).toMatch(/^(\d\d:\d\d|“agenda one”)$/);
    expect(byId[m2.id].detail).toBeTruthy();
    expect(byId[m1.id].detail).not.toBe(byId[m2.id].detail);
    expect(byId[rota.id].detail).toBeUndefined(); // a title nobody else shares stays bare
  });
  test("once the user was asked which, the agent's next pick of one of the meetings stands (jv-6c1)", async () => {
    const m1 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda one", author: "me" });
    await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda two", author: "me" });
    const rota = await ingest(t.dir, { source: "note", title: "Lunch rota", body: "who brings lunch", author: "me" });
    const sid = await open("conv-6c1b");
    const act = `ACT jarvis_link {"src":"${m1.id}","dst":"${rota.id}"}`;
    await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `link the Weekly sync meeting to the Lunch rota note ${act}` }));
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `the Weekly sync meeting from agenda one ${act}` }));
    const c = evs.find((e) => e.type === "change").change;
    expect([c.kind, c.ok, c.error]).toEqual(["link", true, undefined]);
    expect(c.items.map((i: { id: string }) => i.id)).toEqual([m1.id, rota.id]);
  });
  test("a second pick of the same shared title in the same answer is refused too, and so is a task picked among tasks (jv-6c1)", async () => {
    const m1 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda one", author: "me" });
    const m2 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda two", author: "me" });
    const t1 = await addTask(t.dir, { title: "Weekly sync", author: "me" });
    const t2 = await addTask(t.dir, { title: "Weekly sync", author: "me" });
    const rota = await ingest(t.dir, { source: "note", title: "Lunch rota", body: "who brings lunch", author: "me" });
    const sid = await open("conv-6c1d");
    const act = `ACT jarvis_link {"src":"${m2.id}","dst":"${rota.id}"}`;
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `link the Weekly sync meeting to the Lunch rota note and close the Weekly sync task ${act} ${act} ACT jarvis_set_task_status {"task":"${t1.id}","status":"done"}` }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok])).toEqual([["link", false], ["link", false], ["task.done", false]]);
    expect(changes[1].ask.options.map((o: { id: string }) => o.id).sort()).toEqual([m1.id, m2.id].sort());
    expect(changes[2].ask.options.map((o: { id: string }) => o.id).sort()).toEqual([t1.id, t2.id].sort());
  });
  test("a new task linked to a meeting picked among namesakes in context is not created at all (jv-6c1)", async () => {
    const m1 = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda one", author: "me" });
    await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda two", author: "me" });
    const sid = await open("conv-6c1e");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `make a task to book the room, linked to the Weekly sync meeting ACT jarvis_create_task {"title":"Book the room","link":["${m1.id}"]}` }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok])).toEqual([["task.create", false]]);
    expect(changes[0].ask.options.length).toBe(2);
    const { readdirSync } = await import("node:fs");
    const titles = readdirSync(join(t.dir, "docs")).map((f) => readDocFile(t.dir, f.replace(/\.md$/, ""))?.frontmatter.title);
    expect(titles).toContain("Weekly sync"); // the listing reads the docs
    expect(titles).not.toContain("Book the room");
  });
  test("an id the agent passes stands when no other item of its kind in context shares its title (jv-6c1)", async () => {
    const meeting = await ingest(t.dir, { source: "meeting", title: "Weekly sync", body: "agenda", author: "me" });
    await addTask(t.dir, { title: "Weekly sync", author: "me" });
    const rota = await ingest(t.dir, { source: "note", title: "Lunch rota", body: "who brings lunch", author: "me" });
    const sid = await open("conv-6c1c");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: `link the Weekly sync meeting to the Lunch rota note ACT jarvis_link {"src":"${meeting.id}","dst":"${rota.id}"}` }));
    const c = evs.find((e) => e.type === "change").change;
    expect([c.kind, c.ok, c.error]).toEqual(["link", true, undefined]);
  });
  test("a title two tasks share is refused rather than guessed (jv-zyp)", async () => {
    const a = await addTask(t.dir, { title: "Review", author: "me" });
    const b = await addTask(t.dir, { title: "review", author: "me" });
    const sid = await open("conv12");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_set_task_status {"task":"Review","status":"done"}' }));
    const c = evs.find((e) => e.type === "change").change;
    expect(c.ok).toBe(false);
    expect(c.error).toStartWith('more than one item is called "Review": ');
    for (const id of [a.id, b.id]) expect(c.error).toContain(`[${id}]`); // the agent can pick one by id, or ask
  });
  test("a title is matched among the kind of item the action takes: a task among tasks, an initiative among initiatives (jv-zyp)", async () => {
    await ingest(t.dir, { source: "note", title: "Ship the firmware", body: "the plan", author: "me" });
    const task = await addTask(t.dir, { title: "Ship the firmware", author: "me" });
    await ingest(t.dir, { source: "note", title: "Firmware 2", body: "a note of the same name", author: "me" });
    const ini = await addInitiative(t.dir, { title: "Firmware 2", goal: "v2 shipped", author: "me" });
    const spec = await ingest(t.dir, { source: "note", title: "Bootloader spec", body: "spec", author: "me" });
    const sid = await open("conv13");
    const evs = await ndjson(await call("POST", `/api/chat/sessions/${sid}/messages`, { message: 'ACT jarvis_set_task_status {"task":"Ship the firmware","status":"done"} ACT jarvis_move_task {"task":"ship the firmware","initiative":"Firmware 2"} ACT jarvis_create_task {"title":"Flash the bootloader","initiative":"Firmware 2","link":["Bootloader spec"]}' }));
    const changes = evs.filter((e) => e.type === "change").map((e) => e.change);
    expect(changes.map((c) => [c.kind, c.ok, c.error])).toEqual([["task.done", true, undefined], ["task.move", true, undefined], ["task.create", true, undefined], ["link", true, undefined]]);
    expect(changes[3].items[1].id).toBe(spec.id); // the link named by title is its own row (jv-eit)
    expect(changes[0].items[0].id).toBe(task.id);
    expect(readDocFile(t.dir, task.id)!.frontmatter.task!.initiative).toBe(ini.id);
    const created = readDocFile(t.dir, changes[2].items[0].id)!;
    expect(created.frontmatter.task!.initiative).toBe(ini.id);
    expect(readFileSync(join(t.dir, "edges", `${created.frontmatter.id}.jsonl`), "utf8")).toContain(spec.id);
  });
});

describe("what the assistant says before acting (jv-de8)", () => {
  test("the rules ask for intent before an action, never a claim that it is happening or done", async () => {
    const { CHAT_RULES } = await import("../src/chat/sessions.ts");
    expect(CHAT_RULES).toContain("I'll link Weekly sync to Q4 planning.");
    expect(CHAT_RULES).toContain("never as already happening or done");
    expect(CHAT_RULES).not.toContain("say in words what you are doing");
  });
});
