import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installWebEnv, type Handler, type WebEnv } from "./webEnv.ts";
import { createChat, ndjsonDecoder, type Chat } from "../web/src/chat.ts";

let env: WebEnv;
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, title: `Task ${i + 1}`, status: "open", owner: "mia" }));
interface Setup { name?: string; available?: boolean; tasks?: unknown[]; hour?: number; answer?: Handler; undoMs?: number; slowMs?: number }
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
  const chat = createChat({ navigate: (hash) => nav.push(hash), now: () => new Date(2026, 0, 5, o.hour ?? 14, 0, 0), undoMs: o.undoMs ?? 30, slowMs: o.slowMs });
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
    expect(qa(".jv-sg").map((e) => e.textContent)).toEqual(["Summarise the newest captures", "What did the team decide this week?", "Turn this week's decisions into tasks for me", "Draft a briefing on what changed this week"]);
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
  test("Undo before the tick is confirmed wins: the row stays", async () => {
    await setup({ tasks: tasks(2), undoMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    env.routes.set("POST /api/task/T1/done", async () => { await gate; return { json: {} }; });
    (q(".jv-task input") as HTMLInputElement).click();
    await env.tick(5);
    (q(".jv-undo") as HTMLElement).click();
    await env.tick(5);
    release();
    await env.tick(60);
    expect(qa(".jv-task").length).toBe(2);
    expect(q(".jv-task").classList.contains("jv-done")).toBe(false);
  });
  test("a failed Undo still lets the row leave", async () => {
    await setup({ tasks: tasks(2), undoMs: 30 });
    env.routes.set("POST /api/task/T1/reopen", () => ({ status: 500, json: { error: "x" } }));
    (q(".jv-task input") as HTMLInputElement).click();
    await env.tick(5);
    (q(".jv-undo") as HTMLElement).click();
    await env.tick(10);
    expect(q(".toast.error").textContent).toBe("Couldn't reopen the task.");
    await env.tick(80);
    expect(qa(".jv-task").length).toBe(1);
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
  describe("an answer that finishes with no text", () => {
    const NOTICE = "I finished without writing an answer.";
    const emptyWithSteps = () => ({ stream: async (push: (e: unknown) => void) => { push({ type: "status", text: "thinking" }); push({ type: "status", text: "List capture files" }); push({ type: "done" }); } });
    test("steps start unfolded, the grey notice follows with Try again, and the toggle folds", async () => {
      await setup({ answer: emptyWithSteps as never });
      await ask("q");
      expect(q(".jv-steps-toggle").textContent).toBe("▾ 2 steps");
      expect(qa(".jv-step").length).toBe(2);
      expect(q(".jv-noanswer").textContent).toContain(NOTICE);
      expect(q(".jv-noanswer .jv-retry").textContent).toBe("Try again");
      expect(document.querySelector(".jv-failed")).toBeNull();
      q(".jv-steps-toggle").click();
      expect(q(".jv-steps-toggle").textContent).toBe("▸ 2 steps");
      expect(document.querySelector(".jv-step")).toBeNull();
      expect(q(".jv-noanswer")).not.toBeNull();
    });
    test("no steps: the notice alone", async () => {
      await setup({ answer: () => ({ stream: async (push) => { push({ type: "done" }); } }) });
      await ask("q");
      expect(document.querySelector(".jv-steps-toggle")).toBeNull();
      expect(q(".jv-noanswer").textContent).toContain(NOTICE);
    });
    test("sources still appear, after the notice", async () => {
      await setup({ answer: () => ({ stream: async (push) => { push({ type: "source", docId: "D1", title: "Doc one", source: "note" }); push({ type: "done" }); } }) });
      await ask("q");
      expect(q(".jv-noanswer").nextElementSibling?.className).toBe("jv-chips");
    });
    test("stopped before any text: Stopped. only", async () => {
      await setup({ answer: () => ({ stream: async (_push, signal) => { await new Promise<void>((r) => signal.addEventListener("abort", () => r())); } }) });
      type("q");
      (q(".jv-send") as HTMLElement).click();
      await env.tick(40);
      (q(".jv-stop") as HTMLElement).click();
      await env.tick(40);
      expect(q(".jv-stopped").textContent).toBe("Stopped.");
      expect(document.querySelector(".jv-noanswer")).toBeNull();
    });
    test("an answer with text has no notice", async () => {
      await setup();
      await ask("q");
      expect(document.querySelector(".jv-noanswer")).toBeNull();
    });
    test("Try again removes the pair and asks the same question again", async () => {
      let n = 0;
      await setup({ answer: () => (++n === 1 ? { stream: async (push) => { push({ type: "done" }); } } : { stream: async (push) => { push({ type: "message", text: "Now" }); push({ type: "done" }); } }) });
      await ask("same");
      (q(".jv-noanswer .jv-retry") as HTMLElement).click();
      await env.tick(60);
      expect(q(".jv-answer").textContent).toBe("Now");
      expect(qa(".jv-user").length).toBe(1);
      expect(document.querySelector(".jv-noanswer")).toBeNull();
    });
    test("an answer of only whitespace counts as empty", async () => {
      await setup({ answer: () => ({ stream: async (push) => { push({ type: "message", text: "\n " }); push({ type: "done" }); } }) });
      await ask("q");
      expect(q(".jv-noanswer")).not.toBeNull();
    });
    test("a failed answer shows only the red notice", async () => {
      await setup({ answer: () => ({ status: 500, json: { error: "x" } }) });
      await ask("q");
      expect(q(".jv-failed")).not.toBeNull();
      expect(document.querySelector(".jv-noanswer")).toBeNull();
    });
    test("an answer with no text but a change card gets no notice", async () => {
      await setup({ answer: () => ({ stream: async (push) => { push({ type: "change", change: { id: "C1", ok: true, verb: "capture", items: [{ title: "T" }] } }); push({ type: "done" }); } }) });
      await ask("q");
      expect(document.querySelector(".jv-noanswer")).toBeNull();
    });
    test("Try again on an old empty answer while another answer is coming does nothing and keeps the question", async () => {
      let n = 0;
      await setup({ answer: () => (++n === 1 ? { stream: async (push) => { push({ type: "done" }); } } : { stream: async (_push, signal) => { await new Promise<void>((r) => signal.addEventListener("abort", () => r())); } }) });
      await ask("first");
      type("second");
      (q(".jv-send") as HTMLElement).click();
      await env.tick(40);
      (q(".jv-noanswer .jv-retry") as HTMLElement).click();
      await env.tick(20);
      expect(qa(".jv-user").map((e) => e.textContent)).toEqual(["first", "second"]);
    });
    test("a reload shows the notice again with the steps unfolded", async () => {
      await setup({ answer: emptyWithSteps as never });
      await ask("q");
      q(".jv-steps-toggle").click();
      document.body.innerHTML = "";
      await setup();
      expect(q(".jv-steps-toggle").textContent).toBe("▾ 2 steps");
      expect(q(".jv-noanswer")).not.toBeNull();
    });
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
  test("hiding twice (page to page) keeps the saved scroll position", async () => {
    const chat = await setup();
    await ask("hello");
    const box = q(".jv-scroll");
    box.scrollTop = 123;
    chat.hide();
    box.scrollTop = 0; // a hidden element reads 0 in a real browser
    chat.hide();
    chat.show();
    expect(box.scrollTop).toBe(123);
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
  test("New chat on an empty chat with an attached item drops the attachment without asking", async () => {
    const chat = await setup({ name: "Mia" });
    chat.askAbout({ type: "item", ids: ["I1"] }, "Doc");
    await env.tick(10);
    chat.newChat();
    await env.tick(5);
    expect(document.querySelector(".modal")).toBeNull();
    expect(document.querySelector(".jv-attach")).toBeNull();
    expect(q(".jv-hello").textContent).toBe("Good afternoon, Mia.");
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

describe("the agent acts: the change card (jv-oya.4)", () => {
  const ch = (o: Record<string, unknown>) => ({ id: `C${Math.random().toString(36).slice(2, 8)}`, turn: "T", ok: true, undone: false, undoable: true, items: [], ...o });
  const task = (id: string, title: string) => ({ id, title, kind: "task" });
  async function answerWith(changes: Record<string, unknown>[], text = "Done.", opts: Setup = {}) {
    const chat = await setup({ name: "Mia", ...opts, answer: () => ({ stream: async (push) => { for (const c of changes) push({ type: "change", change: c }); push({ type: "message", text }); push({ type: "done" }); } }) });
    await ask("do it");
    return chat;
  }
  const card = () => q(".jv-changes");
  const rows = () => qa(".jv-crow").map((r) => r.textContent);

  test("no changes, no card", async () => {
    await answerWith([]);
    expect(document.querySelector(".jv-changes")).toBeNull();
  });
  test("one change: heading, sentence with the title as a link, Undo and Undo all", async () => {
    await answerWith([ch({ kind: "task.create", items: [task("T9", "Ring the vendor")] })]);
    expect(card().querySelector("h4")!.textContent).toBe("I made 1 change");
    expect(rows()).toEqual(["✓Created task Ring the vendorUndo"]);
    expect(q(".jv-crow a").getAttribute("href")).toBe("#/item/T9");
    expect(q(".jv-crow-undo").textContent).toBe("Undo");
    expect(q(".jv-undoall").textContent).toBe("Undo all");
    expect(q(".jv-answer").previousElementSibling).toBe(card());
  });
  test("every kind of row, in the words agreed", async () => {
    await answerWith([
      ch({ kind: "capture.note", items: [{ id: "N1", title: "A", kind: "doc" }] }),
      ch({ kind: "capture.link", items: [{ id: "N2", title: "B", kind: "doc" }] }),
      ch({ kind: "capture.file", items: [{ id: "N3", title: "C", kind: "doc" }] }),
      ch({ kind: "capture.meeting", items: [{ id: "N4", title: "D", kind: "doc" }] }),
      ch({ kind: "task.done", items: [task("T1", "E")] }),
      ch({ kind: "task.reopen", items: [task("T1", "E")] }),
      ch({ kind: "task.due", items: [task("T1", "E")], detail: { from: "2026-11-20", to: "2025-01-03" } }),
      ch({ kind: "task.owner", items: [task("T1", "E")], detail: { from: "Sam", to: "you" } }),
      ch({ kind: "link", items: [task("T1", "E"), { id: "N1", title: "A", kind: "doc" }], detail: { relation: "related" } }),
      ch({ kind: "draft.briefing", items: [{ id: "B1", title: "F", kind: "briefing" }], draft: { kind: "briefing", sections: ["One", "Two"], sources: 3 } }),
      ch({ kind: "draft.presentation", items: [{ id: "deck", title: "G", kind: "presentation" }], draft: { kind: "presentation", sections: ["S1"], sources: 0, slides: 4 } }),
      ch({ kind: "initiative.create", items: [{ id: "I1", title: "H", kind: "initiative" }] }),
    ]);
    expect(card().querySelector("h4")!.textContent).toBe("I made 12 changes");
    expect(rows().map((r) => r!.replace(/Undo$/, ""))).toEqual([
      "✓Captured note A", "✓Captured link B", "✓Captured file C", "✓Captured meeting D", "✓Marked task E done", "✓Reopened task E",
      "✓Changed task E: due 20 Nov 2026 → 3 Jan 2025".replace("20 Nov 2026", "20 Nov"), "✓Changed task E: owner Sam → you", "✓Linked E to A · relates to",
      "✓Drafted briefing F", "✓Drafted presentation G", "✓Created initiative H"]);
    const drafts = qa(".jv-draft");
    expect(drafts[0].textContent).toBe("BRIEFING · DRAFT · 2 sections · 3 sourcesFOne · TwoOpen draft");
    expect(drafts[1].querySelector(".jv-draft-k")!.textContent).toBe("PRESENTATION · DRAFT · 4 slides · 0 sources");
    expect((drafts[0].querySelector("a") as HTMLElement).getAttribute("href")).toBe("#/briefing/B1");
    expect((drafts[1].querySelector("a") as HTMLElement).getAttribute("href")).toBe("#/presentation/deck");
  });
  test("a failed change is a red row with the reason, counted in the heading, with no Undo", async () => {
    await answerWith([ch({ kind: "task.create", items: [task("T1", "Ok")] }), ch({ kind: "link", ok: false, undoable: false, verb: "link", error: "the meeting note was not found", items: [{ id: "x", title: "Retire the channel", kind: "doc" }] })]);
    expect(card().querySelector("h4")!.textContent).toBe("I made 1 change · 1 failed");
    const bad = q(".jv-cfail");
    expect(bad.textContent).toBe("✗Couldn't link Retire the channel — the meeting note was not found.");
    expect(bad.querySelector("button")).toBeNull();
  });
  test("every change failed: heading counts 0 changes", async () => {
    await answerWith([ch({ kind: "link", ok: false, undoable: false, verb: "link", error: "nope", items: [] })]);
    expect(card().querySelector("h4")!.textContent).toBe("I made 0 changes · 1 failed");
    expect(document.querySelector(".jv-undoall")).toBeNull();
  });
  test("Undo strikes the row, marks it Undone, keeps Undo all; the last Undo says all undone and removes Undo all", async () => {
    const a = ch({ kind: "task.create", items: [task("T1", "One")] }), b = ch({ kind: "task.create", items: [task("T2", "Two")] });
    await answerWith([a, b]);
    env.routes.set(`POST /api/chat/conversations/${(JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId}/changes/${a.id}/undo`, () => ({ json: { change: { ...a, undone: true } } }));
    const cid = (JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/${b.id}/undo`, () => ({ json: { change: { ...b, undone: true } } }));
    (qa(".jv-crow-undo")[0]).click();
    await env.tick(30);
    expect(qa(".jv-crow")[0].classList.contains("jv-cundone")).toBe(true);
    expect(qa(".jv-crow")[0].textContent).toBe("↺Created task OneUndone");
    expect(document.activeElement).toBe(qa(".jv-crow-undo")[0]); // the next row's Undo
    expect(q(".jv-undoall")).toBeTruthy();
    (qa(".jv-crow-undo")[0]).click();
    await env.tick(30);
    expect(card().querySelector("h4")!.textContent).toBe("I made 2 changes · all undone");
    expect(document.querySelector(".jv-undoall")).toBeNull();
    expect(document.activeElement).toBe(input());
  });
  test("Undo on a Created task row shows its Linked rows Undone at once (jv-a9b)", async () => {
    const a = ch({ kind: "task.create", items: [task("T1", "One")] }), l = ch({ kind: "link", items: [task("T1", "One"), { id: "N1", title: "Zoom drift", kind: "doc" }], detail: { relation: "related" } });
    await answerWith([a, l]);
    const cid = (JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/${a.id}/undo`, () => ({ json: { change: { ...a, undone: true }, changes: [{ ...a, undone: true }, { ...l, undone: true }] } }));
    q(".jv-crow-undo").click();
    await env.tick(30);
    expect(qa(".jv-crow").map((r) => r.classList.contains("jv-cundone"))).toEqual([true, true]);
    expect(rows()[1]).toBe("↺Linked One to Zoom drift · relates toUndone");
    expect(card().querySelector("h4")!.textContent).toBe("I made 2 changes · all undone");
  });
  test("Undo all asks for its own answer only", async () => {
    const a = ch({ turn: "TURN-9", kind: "task.create", items: [task("T1", "One")] });
    await answerWith([a]);
    const cid = (JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/undo-all`, () => ({ json: { changes: [{ ...a, undone: true }] } }));
    q(".jv-undoall").click();
    await env.tick(30);
    expect(env.calls.find((c) => c.path.endsWith("/undo-all"))!.body).toEqual({ turn: "TURN-9" });
  });
  test("Undo all undoes the rest, then focus goes to the typing box", async () => {
    const a = ch({ kind: "task.create", items: [task("T1", "One")] }), b = ch({ kind: "task.done", items: [task("T2", "Two")] });
    await answerWith([a, b]);
    const cid = (JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/undo-all`, () => ({ json: { changes: [{ ...a, undone: true }, { ...b, undone: true }] } }));
    q(".jv-undoall").click();
    await env.tick(30);
    expect(card().querySelector("h4")!.textContent).toBe("I made 2 changes · all undone");
    expect(document.activeElement).toBe(input());
  });
  test("an Undo that cannot be done leaves the row as it was and shows the error", async () => {
    const a = ch({ kind: "task.create", items: [task("T1", "One")] });
    await answerWith([a]);
    const cid = (JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId;
    env.routes.set(`POST /api/chat/conversations/${cid}/changes/${a.id}/undo`, () => ({ status: 409, json: { error: "Couldn't undo — One was changed after the agent changed it." } }));
    q(".jv-crow-undo").click();
    await env.tick(30);
    expect(q(".toast.error").textContent).toBe("Couldn't undo — One was changed after the agent changed it.");
    expect(rows()).toEqual(["✓Created task OneUndo"]);
  });
  test("after a reload the card comes back, with undone rows brought up to date from the service", async () => {
    const a = ch({ kind: "task.create", items: [task("T1", "One")] });
    await answerWith([a]);
    const cid = (JSON.parse(localStorage.getItem("jv.chat")!) as { conversationId: string }).conversationId;
    document.body.innerHTML = "";
    env.routes.set(`GET /api/chat/conversations/${cid}/changes`, () => ({ json: { changes: [{ ...a, undone: true }] } }));
    await setup({ name: "Mia" });
    await env.tick(30);
    expect(q(".jv-changes h4").textContent).toBe("I made 1 change · all undone");
  });
  test("a task the agent changed reloads the open tasks (the first screen's box) without a reload", async () => {
    let loads = 0;
    const chat = await setup({ name: "Mia", answer: () => ({ stream: async (push) => { push({ type: "change", change: ch({ kind: "task.create", items: [task("T1", "One")] }) }); push({ type: "done" }); } }) });
    void chat;
    env.routes.set("GET /api/tasks", () => { loads++; return { json: { tasks: [] } }; });
    await ask("add a task");
    expect(loads).toBe(1);
  });
  test("New chat: the question adds a line when changes are kept (plural, singular), and not otherwise", async () => {
    const chat = await answerWith([ch({ kind: "task.create", items: [task("T1", "One")] }), ch({ kind: "task.create", items: [task("T2", "Two")] }), ch({ kind: "task.create", undone: true, items: [task("T3", "Three")] })]);
    chat.newChat();
    expect(q(".modal").textContent).toContain("This conversation will be cleared.");
    expect(q(".modal .muted").textContent).toBe("The 2 changes the agent made are kept, but you won't be able to undo them from here.");
    qa(".modal button")[0].click();
    document.body.innerHTML = ""; localStorage.clear();
    const c2 = await answerWith([ch({ kind: "task.create", items: [task("T1", "One")] })]);
    c2.newChat();
    expect(q(".modal .muted").textContent).toBe("The 1 change the agent made is kept, but you won't be able to undo it from here.");
    qa(".modal button")[0].click();
    document.body.innerHTML = ""; localStorage.clear();
    const c3 = await answerWith([]);
    c3.newChat();
    expect(document.querySelector(".modal .muted")).toBeNull();
  });
});

describe("attaching files (jv-oya.4)", () => {
  const drop = (files: File[]) => {
    const ev = new env.win.Event("drop", { bubbles: true, cancelable: true }) as unknown as Event & { dataTransfer: unknown };
    ev.dataTransfer = { types: ["Files"], files };
    q(".jv-chat").dispatchEvent(ev);
  };
  const file = (name: string, size = 10) => { const f = new File(["x"], name); Object.defineProperty(f, "size", { value: size }); return f; };
  test("the paperclip opens the picker; chips show name and size; × removes and moves focus to the next ×", async () => {
    await setup({ name: "Mia" });
    let opened = false;
    (q(".jv-picker") as HTMLInputElement).click = () => { opened = true; };
    q(".jv-clip").click();
    expect(opened).toBe(true);
    drop([file("a.pdf", 1.2 * 1024 * 1024), file("b.md", 4096), file("c.txt", 312)]);
    expect(qa(".jv-file").map((c) => c.textContent)).toEqual(["📄 a.pdf · 1.2 MB×", "📄 b.md · 4 KB×", "📄 c.txt · 312 B×"]);
    qa(".jv-file-x")[0].click();
    expect(document.activeElement).toBe(qa(".jv-file-x")[0]);
    expect(qa(".jv-file").length).toBe(2);
    qa(".jv-file-x")[1].click();
    qa(".jv-file-x")[0].click();
    expect(document.activeElement).toBe(input());
  });
  test("unsupported and oversize files are red chips with the reason and are not sent", async () => {
    await setup({ name: "Mia" });
    drop([file("demo.mov"), file("export.pdf", 26 * 1024 * 1024), file("ok.md")]);
    const chips = qa(".jv-file");
    expect(chips[0].textContent).toBe("⚠ demo.mov — can't capture this kind of file×");
    expect(chips[1].textContent).toBe("⚠ export.pdf — larger than 25 MB×");
    expect(chips[0].classList.contains("jv-bad") && chips[1].classList.contains("jv-bad") && !chips[2].classList.contains("jv-bad")).toBe(true);
    await ask("capture it");
    const sent = env.calls.find((c) => c.path === "/api/chat/sessions/S1/messages")!.body as { files: string[] };
    expect(sent.files).toEqual(["ok.md"]);
    expect(q(".jv-user").textContent).toContain("📄 ok.md");
    expect(document.querySelector(".jv-files:not([hidden]) .jv-file")).toBeNull();
  });
  test("dragging shows the drop outline and message; leaving removes them", async () => {
    await setup({ name: "Mia" });
    const ev = (t: string) => { const e = new env.win.Event(t, { bubbles: true, cancelable: true }) as unknown as Event & { dataTransfer: unknown }; e.dataTransfer = { types: ["Files"] }; q(".jv-chat").dispatchEvent(e); };
    ev("dragenter");
    expect(q(".jv-chat").classList.contains("jv-dropping")).toBe(true);
    expect(q(".jv-drop").textContent).toBe("Drop files to attach");
    expect(q(".jv-drop").hidden).toBe(false);
    ev("dragleave");
    expect(q(".jv-drop").hidden).toBe(true);
  });
  test("no model: the paperclip is greyed out and a dropped file does nothing", async () => {
    await setup({ available: false });
    expect((q(".jv-clip") as HTMLButtonElement).disabled).toBe(true);
    drop([file("a.md")]);
    expect(document.querySelector(".jv-file")).toBeNull();
  });
});

describe("@ path suggestions", () => {
  type E = { name: string; dir: boolean };
  const d = (name: string): E => ({ name, dir: true }), f = (name: string): E => ({ name, dir: false });
  const TREE: Record<string, E[]> = {
    "": [d(".git"), d("notes"), d("Zeta"), f("Apple.md"), f("readme.md")],
    "notes/": [d("oncall"), f("on-call handover checklist.md"), f("plan.md")],
    "notes/oncall/": [],
    "~/": [d("Downloads")],
    "/Users/sam/": [f("a.txt")],
    "many/": Array.from({ length: 312 }, (_, i) => f(`file${String(i).padStart(3, "0")}.md`)),
  };
  const lookups: string[] = [];
  async function at(opts: Setup & { slow?: number } = {}): Promise<Chat> {
    lookups.length = 0;
    env.routes.set("GET /api/chat/paths", async (_b, req) => {
      const dir = new URL(req.path, "http://x").searchParams.get("dir") ?? "";
      lookups.push(dir);
      if (opts.slow) await new Promise((r) => setTimeout(r, opts.slow));
      return dir in TREE ? { json: { entries: TREE[dir] } } : { status: 404, json: { error: "no" } };
    });
    return setup(opts);
  }
  /** Type `text` with the caret at its end, as the browser would. */
  async function typed(text: string): Promise<void> {
    input().value = text;
    input().setSelectionRange(text.length, text.length);
    input().dispatchEvent(new env.win.Event("input", { bubbles: true }) as unknown as Event);
    await env.tick(20);
  }
  const rows = () => qa(".jv-at-row");
  const names = () => rows().map((r) => r.textContent);
  const panel = () => { const p = document.querySelector(".jv-at") as HTMLElement | null; return p && !p.hidden ? p : null; };

  test("a bare @ lists the top of the team content: folders first, A-Z, dot names hidden, header and count", async () => {
    await at();
    await typed("@");
    expect(lookups).toEqual([""]);
    expect(q(".jv-at-dir").textContent).toBe("Team content");
    expect(q(".jv-at-n").textContent).toBe("4");
    expect(names()).toEqual(["📁notes/", "📁Zeta/", "📄Apple.md", "📄readme.md"]);
    expect(rows()[0].classList.contains("jv-on")).toBe(true);
    expect(q(".jv-at-hint").textContent).toBe("↑↓ to move · Enter or Tab to choose · Esc to close");
    expect(panel()!.parentElement!.parentElement).toBe(q(".jv-composer-wrap"));
    expect(panel()!.nextElementSibling).toBe(q(".jv-composer"));
  });
  test("an @ inside a word opens nothing", async () => {
    await at();
    await typed("mail sam@team.io");
    expect(panel()).toBeNull();
    expect(lookups).toEqual([]);
  });
  test("typing narrows by prefix ignoring case, with the typed letters bold; a typed dot shows dot names", async () => {
    await at();
    await typed("@NO");
    expect(names()).toEqual(["📁notes/"]);
    expect(q(".jv-at-row b").textContent).toBe("no");
    await typed("@.");
    expect(names()).toEqual(["📁.git/"]);
  });
  test("a folder is entered with Enter, Tab or a click, stays open and shows the folder's entries", async () => {
    await at();
    await typed("@no");
    key(input(), "Enter");
    await env.tick(20);
    expect(input().value).toBe("@notes/");
    expect(lookups).toEqual(["", "notes/"]);
    expect(q(".jv-at-dir").textContent).toBe("notes/");
    expect(names()).toEqual(["📁oncall/", "📄on-call handover checklist.md", "📄plan.md"]);
    key(input(), "Tab");
    await env.tick(20);
    expect(input().value).toBe("@notes/oncall/");
    expect(q(".jv-at-row").textContent).toBe("Empty folder");
    await typed("@notes/");
    rows()[0].dispatchEvent(new env.win.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event);
    rows()[0].click();
    await env.tick(20);
    expect(input().value).toBe("@notes/oncall/");
  });
  test("a file inserts its path with escaped spaces and a trailing space, and closes; the rest of the text is untouched", async () => {
    await at();
    await typed("see @notes/on-");
    expect(names()).toEqual(["📄on-call handover checklist.md"]);
    key(input(), "Enter");
    await env.tick(20);
    expect(input().value).toBe("see @notes/on-call\\ handover\\ checklist.md ");
    expect(panel()).toBeNull();
    expect(nav).toEqual([]);
    expect(env.calls.some((c) => c.path.includes("/messages"))).toBe(false);
  });
  test("↑/↓ move the highlight (and stop at the ends), Esc closes and leaves the text", async () => {
    await at();
    await typed("@");
    key(input(), "ArrowDown"); key(input(), "ArrowDown");
    expect(rows().findIndex((r) => r.classList.contains("jv-on"))).toBe(2);
    for (let i = 0; i < 9; i++) key(input(), "ArrowDown");
    expect(rows().findIndex((r) => r.classList.contains("jv-on"))).toBe(3);
    key(input(), "ArrowUp");
    expect(rows().findIndex((r) => r.classList.contains("jv-on"))).toBe(2);
    key(input(), "Escape");
    expect(panel()).toBeNull();
    expect(input().value).toBe("@");
    expect(document.activeElement).toBe(input());
  });
  test("while the list is open Enter never sends; with it closed Enter sends the @path as plain text", async () => {
    await at();
    await typed("@no");
    key(input(), "Enter");
    await env.tick(20);
    expect(env.calls.some((c) => c.path.includes("/messages"))).toBe(false);
    key(input(), "Escape");
    input().value = "look at @notes/plan.md";
    key(input(), "Enter");
    await env.tick(60);
    expect(q(".jv-user").textContent).toBe("look at @notes/plan.md");
    expect(env.calls.find((c) => c.path.endsWith("/messages"))!.body).toEqual({ message: "look at @notes/plan.md" });
  });
  test("a space, a click outside, closes it; moving the caret back into the path opens it again", async () => {
    await at();
    await typed("@notes/");
    expect(panel()).not.toBeNull();
    await typed("@notes/ ");
    expect(panel()).toBeNull();
    await typed("@notes/");
    document.body.dispatchEvent(new env.win.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    expect(panel()).toBeNull();
    expect(input().value).toBe("@notes/");
    input().setSelectionRange(3, 3);
    input().dispatchEvent(new env.win.KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }) as unknown as Event);
    await env.tick(20);
    expect(panel()).not.toBeNull();
    expect(q(".jv-at-dir").textContent).toBe("Team content");
    expect(names()).toEqual(["📁notes/"]);
  });
  test("/ and ~/ paths list from the top of the computer and the home folder", async () => {
    await at();
    await typed("@/Users/sam/");
    expect(q(".jv-at-dir").textContent).toBe("/Users/sam/");
    expect(names()).toEqual(["📄a.txt"]);
    await typed("@~/");
    expect(lookups.at(-1)).toBe("~/");
    expect(q(".jv-at-dir").textContent).toBe("~/");
    key(input(), "Enter");
    await env.tick(20);
    expect(input().value).toBe("@~/Downloads/");
  });
  test("nothing matches, empty folder and a folder that can't be opened are single rows; the text stays sendable", async () => {
    await at();
    await typed("@zzz");
    expect(names()).toEqual(["No matches"]);
    expect(q(".jv-at-row").classList.contains("jv-at-dim")).toBe(true);
    expect(q(".jv-at-n")).toBeNull();
    await typed("@notes/oncall/");
    expect(names()).toEqual(["Empty folder"]);
    await typed("@nope/");
    expect(names()).toEqual(["Can't open this folder"]);
    expect(q(".jv-at-row").classList.contains("jv-bad")).toBe(true);
    key(input(), "Enter"); // Enter never sends while the list is open
    await env.tick(20);
    expect(q(".jv-user")).toBeNull();
    key(input(), "Escape");
    key(input(), "Enter");
    await env.tick(60);
    expect(q(".jv-user").textContent).toBe("@nope/");
  });
  test("a slow folder shows Looking… only after a moment", async () => {
    await at({ slow: 120, slowMs: 40 });
    await typed("@");
    expect(panel()).toBeNull(); // fast enough lookups never flicker: nothing before the threshold
    await env.tick(80);
    expect(names()).toEqual(["Looking…"]);
    await env.tick(200);
    expect(names()[0]).toBe("📁notes/");
  });
  test("rows of the previous folder can't be chosen while the next folder loads", async () => {
    await at({ slow: 100, slowMs: 500 });
    await typed("@no");
    await env.tick(150);
    key(input(), "Enter"); // -> @notes/, its listing is pending
    await env.tick(5);
    key(input(), "Enter");
    rows()[0]?.click();
    expect(input().value).toBe("@notes/");
    await env.tick(150);
    expect(names()[0]).toBe("📁oncall/");
  });
  test("moving the caret into an @path with ↑/↓ opens it again; a caret just before the @ does not", async () => {
    await at();
    await typed("@notes/ x");
    expect(panel()).toBeNull();
    input().setSelectionRange(3, 3);
    input().dispatchEvent(new env.win.KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }) as unknown as Event);
    await env.tick(20);
    expect(panel()).not.toBeNull();
    await typed("hi @notes");
    input().setSelectionRange(3, 3);
    input().dispatchEvent(new env.win.KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }) as unknown as Event);
    await env.tick(20);
    expect(panel()).toBeNull();
  });
  test("a big folder shows the count and every row (the list scrolls), long names are cut in the middle", async () => {
    await at();
    await typed("@many/");
    expect(q(".jv-at-n").textContent).toBe("312");
    expect(rows().length).toBe(312);
    document.body.innerHTML = "";
    TREE["long/"] = [f("2026-03-14 quarterly planning meeting with the whole team.md")];
    await at();
    await typed("@long/");
    const row = q(".jv-at-row .jv-at-name");
    expect(row.textContent).toContain("…");
    expect(row.textContent!.endsWith("team.md")).toBe(true);
    expect(row.title).toBe("2026-03-14 quarterly planning meeting with the whole team.md");
  });
  test("no agent: the box is disabled and @ does nothing", async () => {
    await at({ available: false });
    expect(input().disabled).toBe(true);
    await typed("@");
    expect(panel()).toBeNull();
    expect(lookups).toEqual([]);
  });
  test("nothing persists: a fresh chat starts with no panel", async () => {
    await at();
    await typed("@");
    document.body.innerHTML = "";
    await at();
    expect(panel()).toBeNull();
  });
});
