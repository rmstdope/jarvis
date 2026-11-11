import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installWebEnv, type Handler, type WebEnv } from "./webEnv.ts";
import { createChat, ndjsonDecoder, type Chat } from "../web/src/chat.ts";

let env: WebEnv;
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, title: `Task ${i + 1}`, status: "open", owner: "mia" }));
interface Setup { name?: string; available?: boolean; tasks?: unknown[]; hour?: number; answer?: Handler; undoMs?: number }
let nav: string[];
async function setup(o: Setup = {}): Promise<Chat> {
  env.routes.set("GET /api/me", () => ({ json: o.name === undefined ? {} : { name: o.name } }));
  env.routes.set("GET /api/chat/status", () => ({ json: { available: o.available ?? true } }));
  env.routes.set("GET /api/tasks", () => ({ json: { tasks: o.tasks ?? [] } }));
  env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1", sources: [] } }));
  env.routes.set("DELETE /api/chat/sessions/S1", () => ({ json: { ok: true } }));
  env.routes.set("POST /api/chat/sessions/S1/cancel", () => ({ json: { ok: true } }));
  env.routes.set("POST /api/chat/sessions/S1/messages", o.answer ?? (() => ({ stream: async (push) => { push({ type: "status", text: "Searching your knowledge for “x”…" }); push({ type: "status", text: "Reading 3 items" }); push({ type: "source", docId: "D1", title: "Doc one", source: "note" }); push({ type: "message", text: "Hello **there**" }); push({ type: "done" }); } })));
  env.routes.set("POST /api/task/T1/done", () => ({ json: {} }));
  env.routes.set("POST /api/task/T1/reopen", () => ({ json: {} }));
  const chat = createChat({ navigate: (hash) => nav.push(hash), now: () => new Date(2026, 0, 5, o.hour ?? 14, 0, 0), undoMs: o.undoMs ?? 30 });
  document.body.append(chat.el);
  chat.show();
  await chat.ready;
  return chat;
}
beforeEach(() => { env = installWebEnv(1280); document.body.innerHTML = ""; nav = []; });
afterEach(() => env.restore());
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const input = () => q(".jv-input") as HTMLTextAreaElement;
const type = (text: string) => { input().value = text; };
const key = (el: Element, k: string, mods: Record<string, boolean> = {}) => el.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }) as unknown as Event);
async function ask(text: string) { type(text); (q(".jv-send") as HTMLElement).click(); await env.tick(60); }

describe("first screen", () => {
  test("greeting by time of day and name, exactly at the boundaries", async () => {
    for (const [hour, word] of [[0, "morning"], [11, "morning"], [12, "afternoon"], [17, "afternoon"], [18, "evening"], [23, "evening"]] as const) {
      document.body.innerHTML = "";
      await setup({ name: "Mia", hour });
      expect(q(".jv-hello").textContent).toBe(`Good ${word}, Mia.`);
    }
  });
  test("no configured name: the greeting has no name", async () => {
    await setup({ hour: 15 });
    expect(q(".jv-hello").textContent).toBe("Good afternoon.");
  });
  test("line, four suggestion cards, typing box and hint", async () => {
    await setup({ name: "Mia" });
    expect(q(".jv-sub").textContent).toBe("Ask anything about your team's knowledge — I'll cite what I find.");
    expect(qa(".jv-sg").map((e) => e.textContent)).toEqual(["Summarise the newest captures", "What did the team decide this week?", "What are my open tasks?", "Which briefings are still drafts?"]);
    expect(input().placeholder).toBe("Ask J.A.R.V.I.S.…");
    expect(q(".jv-hint").textContent).toBe("Enter to send · Shift+Enter for a new line");
    expect(q(".jv-send").title).toBe("Send");
    expect(document.activeElement).toBe(input());
  });
  test("clicking a suggestion sends it, and greeting and suggestions go away", async () => {
    await setup({ name: "Mia" });
    q(".jv-sg").click();
    await env.tick(60);
    expect(q(".jv-user").textContent).toBe("Summarise the newest captures");
    expect(document.querySelector(".jv-hello")).toBeNull();
    expect(document.querySelector(".jv-sg")).toBeNull();
  });
});

describe("open tasks", () => {
  test("up to five rows, the count, + n more and All tasks →", async () => {
    await setup({ tasks: tasks(7) });
    expect(q(".jv-tasks h4").textContent).toContain("Your open tasks · 7");
    expect(qa(".jv-task").length).toBe(5);
    expect(q(".jv-tasks-more").textContent).toBe("+ 2 more");
    const all = q(".jv-tasks-all") as HTMLAnchorElement;
    expect(all.textContent).toBe("All tasks →");
    expect(all.getAttribute("href")).toBe("#/tasks");
    expect(qa(".jv-task a")[0].getAttribute("href")).toBe("#/item/T1");
  });
  test("no open tasks keeps the box", async () => {
    await setup({ tasks: [] });
    expect(q(".jv-tasks").textContent).toContain("Nothing open — you're all caught up.");
  });
  test("ticking shows Done · Undo, then the row leaves and the count drops", async () => {
    await setup({ tasks: tasks(2) });
    (q(".jv-task input") as HTMLInputElement).click();
    await env.tick(5);
    const row = q(".jv-task");
    expect(row.classList.contains("jv-done")).toBe(true);
    expect(row.textContent).toContain("Done · Undo");
    expect(env.calls.some((c) => c.method === "POST" && c.path === "/api/task/T1/done")).toBe(true);
    await env.tick(60);
    expect(qa(".jv-task").length).toBe(1);
    expect(q(".jv-tasks h4").textContent).toContain("Your open tasks · 1");
  });
  test("Undo reopens the task and keeps it in the list", async () => {
    await setup({ tasks: tasks(2), undoMs: 80 });
    (q(".jv-task input") as HTMLInputElement).click();
    await env.tick(5);
    (q(".jv-undo") as HTMLElement).click();
    await env.tick(5);
    expect(env.calls.some((c) => c.path === "/api/task/T1/reopen")).toBe(true);
    await env.tick(100);
    expect(qa(".jv-task").length).toBe(2);
    expect(q(".jv-task").classList.contains("jv-done")).toBe(false);
  });
  test("a failed tick unticks the row and says so", async () => {
    await setup({ tasks: tasks(1) });
    env.routes.set("POST /api/task/T1/done", () => ({ status: 500, json: { error: "boom" } }));
    (q(".jv-task input") as HTMLInputElement).click();
    await env.tick(20);
    expect((q(".jv-task input") as HTMLInputElement).checked).toBe(false);
    expect(q(".jv-task").classList.contains("jv-done")).toBe(false);
    expect(q(".toast.error").textContent).toBe("Couldn't mark the task done.");
  });
});

describe("answering", () => {
  test("user bubble, steps while the agent works, then folded steps, serif answer and source chips", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup({ answer: () => ({ stream: async (push) => { push({ type: "status", text: "Searching your knowledge for “x”…" }); push({ type: "status", text: "Reading 3 items" }); push({ type: "message", text: "Hello " }); await gate; push({ type: "message", text: "**there**" }); push({ type: "source", docId: "D1", title: "Doc one", source: "note" }); push({ type: "done" }); } }) });
    type("what?");
    (q(".jv-send") as HTMLElement).click();
    await env.tick(40);
    expect(q(".jv-user").textContent).toBe("what?");
    expect(qa(".jv-step").map((e) => e.textContent)).toEqual(["✓ Searching your knowledge for “x”…", "● Reading 3 items"]);
    expect(q(".jv-stop").title).toBe("Stop");
    expect(document.querySelector(".jv-send")).toBeNull();
    expect(q(".jv-hint").textContent).toBe("Esc to stop");
    release();
    await env.tick(40);
    expect(q(".jv-answer").innerHTML).toContain("<strong>there</strong>");
    const fold = q(".jv-steps-toggle");
    expect(fold.textContent).toBe("▸ 2 steps");
    expect(document.querySelector(".jv-step")).toBeNull();
    fold.click();
    expect(qa(".jv-step").length).toBe(2);
    const chip = q(".jv-chip") as HTMLAnchorElement;
    expect(chip.textContent).toBe("Doc one");
    expect(chip.getAttribute("href")).toBe("#/item/D1");
    expect(q(".jv-send").title).toBe("Send");
    expect(q(".jv-hint").textContent).toBe("Enter to send · Shift+Enter for a new line");
  });
  test("no steps reported: no steps line", async () => {
    await setup({ answer: () => ({ stream: async (push) => { push({ type: "message", text: "Hi" }); push({ type: "done" }); } }) });
    await ask("hello");
    expect(document.querySelector(".jv-steps-toggle")).toBeNull();
    expect(q(".jv-answer").textContent).toBe("Hi");
  });
  test("Stop keeps what was written and says Stopped.; the session is told to cancel", async () => {
    const chat = await setup({ answer: () => ({ stream: async (push, signal) => { push({ type: "message", text: "Partial" }); await new Promise<void>((r) => signal.addEventListener("abort", () => r())); } }) });
    type("long");
    (q(".jv-send") as HTMLElement).click();
    await env.tick(40);
    expect(chat.isAnswering()).toBe(true);
    (q(".jv-stop") as HTMLElement).click();
    await env.tick(40);
    expect(q(".jv-answer").textContent).toBe("Partial");
    expect(q(".jv-stopped").textContent).toBe("Stopped.");
    expect(env.calls.some((c) => c.path === "/api/chat/sessions/S1/cancel")).toBe(true);
    expect(chat.isAnswering()).toBe(false);
  });
  test("Esc stops an answer", async () => {
    const chat = await setup({ answer: () => ({ stream: async (push, signal) => { push({ type: "message", text: "Partial" }); await new Promise<void>((r) => signal.addEventListener("abort", () => r())); } }) });
    type("long");
    (q(".jv-send") as HTMLElement).click();
    await env.tick(40);
    chat.stop();
    await env.tick(40);
    expect(q(".jv-stopped").textContent).toBe("Stopped.");
  });
  test("failure shows the notice and Try again resends the same question", async () => {
    let n = 0;
    await setup({ answer: () => (++n === 1 ? { status: 500, json: { error: "agent died" } } : { stream: async (push) => { push({ type: "message", text: "Second time" }); push({ type: "done" }); } }) });
    await ask("same question");
    expect(q(".jv-failed").textContent).toContain("Something went wrong and I couldn't answer.");
    (q(".jv-retry") as HTMLElement).click();
    await env.tick(60);
    expect(q(".jv-answer").textContent).toBe("Second time");
    expect(qa(".jv-user").length).toBe(1);
    expect(qa(".jv-user")[0].textContent).toBe("same question");
  });
  test("an error event in the stream is a failure too", async () => {
    await setup({ answer: () => ({ stream: async (push) => { push({ type: "error", error: "x" }); } }) });
    await ask("q");
    expect(q(".jv-failed")).not.toBeNull();
  });
  test("a vanished server session is replaced transparently on the next send", async () => {
    await setup({ answer: (_b, r) => ({ stream: async (push) => { push({ type: "message", text: "ok" }); push({ type: "done" }); } }) });
    await ask("one");
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ status: 404, json: { error: "session not found" } }));
    env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S2", sources: [] } }));
    env.routes.set("POST /api/chat/sessions/S2/messages", () => ({ stream: async (push) => { push({ type: "message", text: "fresh" }); push({ type: "done" }); } }));
    await ask("two");
    expect(qa(".jv-answer")[1].textContent).toBe("fresh");
  });
  test("Enter sends, Shift+Enter does not", async () => {
    await setup();
    type("via enter");
    key(input(), "Enter", { shiftKey: true });
    await env.tick(30);
    expect(document.querySelector(".jv-user")).toBeNull();
    key(input(), "Enter");
    await env.tick(60);
    expect(q(".jv-user").textContent).toBe("via enter");
    expect(input().value).toBe("");
  });
});

describe("one conversation that survives", () => {
  test("a reload restores messages, the server session and the attached item", async () => {
    const c1 = await setup();
    await ask("remember me");
    c1.askAbout; // present
    document.body.innerHTML = "";
    await setup();
    expect(q(".jv-user").textContent).toBe("remember me");
    expect(q(".jv-answer").textContent).toContain("Hello");
    expect(document.querySelector(".jv-hello")).toBeNull();
    await ask("again");
    expect(env.calls.filter((c) => c.path === "/api/chat/sessions" && c.method === "POST").length).toBe(1);
  });
  test("a reload in the middle of an answer shows it as stopped", async () => {
    await setup({ answer: () => ({ stream: async (push, signal) => { push({ type: "message", text: "Half" }); await new Promise<void>((r) => signal.addEventListener("abort", () => r())); } }) });
    type("long");
    (q(".jv-send") as HTMLElement).click();
    await env.tick(40);
    document.body.innerHTML = "";
    await setup();
    expect(q(".jv-answer").textContent).toBe("Half");
    expect(q(".jv-stopped").textContent).toBe("Stopped.");
  });
  test("hide and show keep the conversation and its scroll position", async () => {
    const chat = await setup();
    await ask("hello");
    const box = q(".jv-scroll");
    box.scrollTop = 123;
    chat.hide();
    expect(chat.el.hidden).toBe(true);
    chat.show();
    expect(box.scrollTop).toBe(123);
    expect(q(".jv-user").textContent).toBe("hello");
  });
  test("onChange tells the shell whether a conversation exists (for the dot)", async () => {
    const seen: boolean[] = [];
    env.routes.set("GET /api/me", () => ({ json: {} }));
    env.routes.set("GET /api/chat/status", () => ({ json: { available: true } }));
    env.routes.set("GET /api/tasks", () => ({ json: { tasks: [] } }));
    env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p) => { p({ type: "done" }); } }));
    const chat = createChat({ navigate: () => {}, onChange: () => seen.push(chat.hasConversation()) });
    document.body.append(chat.el);
    chat.show();
    await chat.ready;
    await ask("x");
    expect(seen.at(-1)).toBe(true);
  });
});

describe("no model available", () => {
  test("notice, shortcut cards, greyed typing box, no suggestions, tasks still shown", async () => {
    await setup({ available: false, name: "Mia", tasks: tasks(1) });
    expect(q(".jv-notice h3").textContent).toBe("The agent isn't available right now.");
    expect(q(".jv-notice p").textContent).toBe("Everything else works — search, capture and your briefings don't need it. Run jarvis doctor to see what's missing.");
    expect(qa(".jv-card-link").map((e) => e.textContent)).toEqual(["Browse & searchFind anything your team captured", "CaptureSave a note or a link"]);
    expect(qa(".jv-card-link").map((e) => e.getAttribute("href"))).toEqual(["#/browse", "#/capture"]);
    expect(document.querySelector(".jv-sg")).toBeNull();
    expect(q(".jv-hello").textContent).toBe("Good afternoon, Mia.");
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe("The agent isn't available");
    expect(q(".jv-composer").classList.contains("jv-off")).toBe(true);
    expect(q(".jv-send").hasAttribute("disabled")).toBe(true);
    expect(q(".jv-tasks")).not.toBeNull();
  });
});

describe("ask about this and new chat", () => {
  test("attaches the item as a chip with a heading and the scope's suggestions", async () => {
    const chat = await setup();
    chat.askAbout({ type: "item", ids: ["I1"] }, "On-call rollout");
    await env.tick(10);
    expect(nav.at(-1)).toBe("#/chat");
    expect(q(".jv-hello").textContent).toBe("Ask about “On-call rollout”.");
    expect(q(".jv-attach").textContent).toContain("On-call rollout");
    expect(q(".jv-attach").title).toBe("On-call rollout");
    expect(qa(".jv-sg").map((e) => e.textContent)).toEqual(["Summarise this in three bullets", "What questions does this raise?", "Draft a task from this"]);
    expect(input().placeholder).toBe("Ask about this item…");
    expect(document.querySelector(".jv-tasks")).toBeNull();
    await ask("Summarise");
    const create = env.calls.find((c) => c.method === "POST" && c.path === "/api/chat/sessions" && (c.body as { scope: { type: string } }).scope.type === "item");
    expect(create).toBeTruthy();
    expect(document.activeElement).toBe(input());
  });
  test("a briefing has its own suggestions and placeholder", async () => {
    const chat = await setup();
    chat.askAbout({ type: "briefing", ids: ["B1"] }, "Q3 plan");
    await env.tick(10);
    expect(qa(".jv-sg").map((e) => e.textContent)).toEqual(["What is the key takeaway?", "List the open decisions", "Suggest a diagram for section 2"]);
    expect(input().placeholder).toBe("Ask about this briefing…");
  });
  test("× removes the chip and returns to the general chat", async () => {
    const chat = await setup({ name: "Mia" });
    chat.askAbout({ type: "item", ids: ["I1"] }, "T");
    await env.tick(10);
    (q(".jv-attach button") as HTMLElement).click();
    expect(document.querySelector(".jv-attach")).toBeNull();
    expect(q(".jv-hello").textContent).toBe("Good afternoon, Mia.");
    expect(input().placeholder).toBe("Ask J.A.R.V.I.S.…");
  });
  test("with a conversation, Ask about this first asks; Cancel keeps it, New chat replaces it", async () => {
    const chat = await setup();
    await ask("first");
    chat.askAbout({ type: "item", ids: ["I1"] }, "Doc");
    await env.tick(5);
    expect(q(".modal h3").textContent).toBe("Start a new chat?");
    expect(q(".modal p").textContent).toBe("This conversation will be cleared.");
    expect(qa(".modal button").map((b) => b.textContent)).toEqual(["Cancel", "New chat"]);
    expect(document.activeElement!.textContent).toBe("New chat");
    (qa(".modal button")[0]).click();
    expect(q(".jv-user").textContent).toBe("first");
    expect(document.querySelector(".jv-attach")).toBeNull();
    chat.askAbout({ type: "item", ids: ["I1"] }, "Doc");
    await env.tick(5);
    (qa(".modal button")[1]).click();
    await env.tick(10);
    expect(document.querySelector(".jv-user")).toBeNull();
    expect(q(".jv-attach").textContent).toContain("Doc");
    expect(env.calls.some((c) => c.method === "DELETE" && c.path === "/api/chat/sessions/S1")).toBe(true);
  });
  test("New chat on an empty chat asks nothing and focuses the typing box", async () => {
    const chat = await setup();
    (document.activeElement as HTMLElement).blur();
    chat.newChat();
    await env.tick(5);
    expect(document.querySelector(".modal")).toBeNull();
    expect(document.activeElement).toBe(input());
  });
  test("New chat with a conversation asks, and confirming clears it", async () => {
    const chat = await setup({ name: "Mia" });
    await ask("first");
    chat.newChat();
    await env.tick(5);
    (qa(".modal button")[1]).click();
    await env.tick(10);
    expect(document.querySelector(".jv-user")).toBeNull();
    expect(q(".jv-hello").textContent).toBe("Good afternoon, Mia.");
    expect(document.activeElement).toBe(input());
    expect(chat.hasConversation()).toBe(false);
  });
});

describe("ndjson decoder", () => {
  test("splits across chunk boundaries", () => {
    const events: unknown[] = [];
    const d = ndjsonDecoder((e) => events.push(e));
    d('{"type":"message","text":"he');
    d('llo"}\n{"type":"usage","used":1,"size":2}\n{"type":"do');
    d('ne"}', true);
    expect(events).toEqual([{ type: "message", text: "hello" }, { type: "usage", used: 1, size: 2 }, { type: "done" }]);
  });
});
