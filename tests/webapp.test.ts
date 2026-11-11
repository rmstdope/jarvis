import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { mountApp } from "../web/src/main.ts";

let env: WebEnv;
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const ITEM = { id: "I1", source: "note", title: "On-call rollout", author: "mia", created_at: "2026-01-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "Body text", proc_version: 1, file_path: null };
async function boot(hash = "", stored: Record<string, string> = {}) {
  env = installWebEnv(1280);
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  env.routes.set("GET /api/me", () => ({ json: { name: "Mia" } }));
  env.routes.set("GET /api/chat/status", () => ({ json: { available: true } }));
  env.routes.set("GET /api/tasks", () => ({ json: { tasks: [] } }));
  env.routes.set("GET /api/browse", () => ({ json: { added: [], updated: [], pagination: { added: { offset: 0, limit: 20, total: 0, hasMore: false }, updated: { offset: 0, limit: 20, total: 0, hasMore: false } }, facets: { sources: [], authors: [], tags: [] } } }));
  env.routes.set("GET /api/item/I1", () => ({ json: { item: ITEM, edges: [] } }));
  env.routes.set("POST /api/chat/sessions", () => ({ json: { sessionId: "S1" } }));
  env.routes.set("DELETE /api/chat/sessions/S1", () => ({ json: {} }));
  env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p) => { p({ type: "message", text: "Hi" }); p({ type: "done" }); } }));
  document.body.innerHTML = '<div id="app"></div>';
  if (hash) location.hash = hash;
  mountApp(document.getElementById("app")!);
  await env.tick(40);
}
afterEach(() => env.restore());
/** Everything this page stored in localStorage, to carry into a fresh `boot` that stands for a reload. */
const snapshotStorage = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).map((k) => [k, localStorage.getItem(k)!]));
const key = (k: string, mods: Record<string, boolean> = {}, target: Element | Document = document) => target.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }) as unknown as Event);
const go = async (hash: string) => { location.hash = hash; await env.tick(40); };

describe("app shell", () => {
  test("opening the app with no page lands in Chat, with the sidebar and nothing of the old top bar", async () => {
    await boot();
    expect(q(".jv-chat").hidden).toBe(false);
    expect(q(".jv-page").hidden).toBe(true);
    expect(q(".jv-nav.active").getAttribute("data-route")).toBe("chat");
    expect(q(".jv-hello").textContent).toMatch(/^Good (morning|afternoon|evening), Mia\.$/);
    expect(document.querySelector("header.top")).toBeNull();
    expect(qa("button").some((b) => b.textContent === "Discuss")).toBe(false);
  });
  test("a page replaces the chat; the conversation comes back as left, with a dot while away", async () => {
    await boot();
    q(".jv-sg").click();
    await env.tick(60);
    await go("#/browse");
    expect(q(".jv-chat").hidden).toBe(true);
    expect(q(".jv-page").hidden).toBe(false);
    expect(q(".jv-nav.active").getAttribute("data-route")).toBe("browse");
    expect(q(".jv-dot").hidden).toBe(false);
    await go("#/chat");
    expect(q(".jv-chat").hidden).toBe(false);
    expect(q(".jv-user").textContent).toBe("Summarise the newest captures");
    expect(q(".jv-dot").hidden).toBe(true);
    expect(document.activeElement).toBe(q(".jv-input"));
  });
  test("All tasks → opens Browse showing only tasks", async () => {
    await boot();
    await go("#/tasks");
    expect(q(".jv-nav.active").getAttribute("data-route")).toBe("browse");
    expect(env.calls.some((c) => c.path.startsWith("/api/browse") && c.path.includes("source=task"))).toBe(true);
  });
  test("an item page offers Ask about this, which switches to Chat with the item attached", async () => {
    await boot("#/item/I1");
    const btn = qa("button").find((b) => b.textContent === "Ask about this")!;
    expect(qa("button").some((b) => b.textContent === "Discuss this item")).toBe(false);
    btn.click();
    await env.tick(40);
    expect(location.hash).toBe("#/chat");
    expect(q(".jv-hello").textContent).toBe("Ask about “On-call rollout”.");
    expect(q(".jv-attach").textContent).toContain("On-call rollout");
  });
});

describe("keyboard", () => {
  test("⌘/Ctrl+Shift+S folds and unfolds; ⌘/Ctrl+Shift+O asks before clearing a conversation", async () => {
    await boot();
    key("S", { ctrlKey: true, shiftKey: true });
    expect(q(".jv-shell").classList.contains("jv-folded")).toBe(true);
    key("s", { metaKey: true, shiftKey: true });
    expect(q(".jv-shell").classList.contains("jv-folded")).toBe(false);
    q(".jv-sg").click();
    await env.tick(60);
    key("O", { ctrlKey: true, shiftKey: true });
    await env.tick(5);
    expect(q(".modal h3").textContent).toBe("Start a new chat?");
    expect(document.activeElement!.textContent).toBe("New chat");
    key("Escape");
    expect(document.querySelector(".modal")).toBeNull();
    expect(q(".jv-user")).not.toBeNull();
  });
  test("/ jumps to the typing box unless a field has focus", async () => {
    await boot();
    (document.activeElement as HTMLElement | null)?.blur();
    key("/");
    expect(document.activeElement).toBe(q(".jv-input"));
    await go("#/capture");
    (document.activeElement as HTMLElement | null)?.blur();
    key("/", {}, document);
    await env.tick(40);
    expect(location.hash).toBe("#/chat");
    expect(document.activeElement).toBe(q(".jv-input"));
    const ta = q(".jv-input") as HTMLTextAreaElement;
    ta.value = "";
    key("/", {}, ta);
    expect(ta.value).toBe("");
  });
  test("a briefing page offers Ask about this too", async () => {
    await boot();
    env.routes.set("GET /api/briefing/B1", () => ({ json: { id: "B1", title: "Q3 plan", kind: "briefing", createdAt: "2026-01-01", updatedAt: "2026-01-01", frontmatter: {}, tree: [], toc: null } }));
    env.routes.set("GET /api/briefing/B1/comments", () => ({ json: [] }));
    await go("#/briefing/B1");
    expect(qa("button").some((b) => b.textContent === "Discuss")).toBe(false);
    qa("button").find((b) => b.textContent === "Ask about this")!.click();
    await env.tick(40);
    expect(q(".jv-hello").textContent).toBe("Ask about “Q3 plan”.");
    expect(q(".jv-input").getAttribute("placeholder")).toBe("Ask about this briefing…");
  });
  test("Esc stops an answer in progress and closes the phone menu", async () => {
    await boot();
    env.routes.set("POST /api/chat/sessions/S1/messages", () => ({ stream: async (p, signal) => { p({ type: "message", text: "Part" }); await new Promise<void>((r) => signal.addEventListener("abort", () => r())); } }));
    env.routes.set("POST /api/chat/sessions/S1/cancel", () => ({ json: {} }));
    q(".jv-sg").click();
    await env.tick(40);
    key("Escape");
    await env.tick(40);
    expect(q(".jv-stopped").textContent).toBe("Stopped.");
    env.setWidth(390);
    q(".jv-menu").click();
    expect(q(".jv-shell").classList.contains("jv-menu-open")).toBe(true);
    key("Escape");
    expect(q(".jv-shell").classList.contains("jv-menu-open")).toBe(false);
    expect(document.activeElement).toBe(q(".jv-menu"));
  });
});

describe("sync", () => {
  const syncOk = { committed: 1, committedEnriched: 0, pulled: true, pushed: true, conflicted: [], collisions: [], notes: [], failures: [], remote: true };
  test("asks first, reports in a toast, shows the status line, and remembers Do not show again", async () => {
    await boot();
    expect(q(".jv-syncline").textContent).toBe("Not synced yet");
    env.routes.set("POST /api/sync", () => ({ json: syncOk }));
    q(".jv-sync").click();
    expect(q(".modal h3").textContent).toBe("Sync with the team?");
    expect(q(".modal p").textContent).toBe("This commits your captures, pulls teammates' changes, runs enrichment and pushes.");
    expect(q(".modal label").textContent).toContain("Do not show again");
    (q(".modal input") as HTMLInputElement).click();
    qa(".modal button").find((b) => b.textContent === "Sync")!.click();
    await env.tick(30);
    expect(q(".toast").textContent).toBe("Synced: 1 captured, 0 enriched, pulled, pushed");
    expect(q(".jv-syncline").textContent).toBe("Synced just now");
    q(".jv-sync").click();
    expect(document.querySelector(".modal")).toBeNull(); // skipped now
    await env.tick(30);
  });
  test("a sync that pushed but whose model step failed says it was shared and names the step (jv-m9l)", async () => {
    await boot();
    localStorage.setItem("sb.sync.noconfirm", "1");
    const reason = 'Model "gpt-4.1" from --model flag is not available.';
    env.routes.set("POST /api/sync", () => ({ json: { ...syncOk, committed: 7, failures: [{ step: "enrich", failed: 7, reason, doctor: true }] } }));
    q(".jv-sync").click();
    await env.tick(30);
    expect(q(".toast").textContent).toBe(`Shared with the team, but enrichment failed for 7 item(s): ${reason} Run \`jarvis doctor\` for the fix.`);
    expect(q(".jv-syncline").textContent).toBe("Synced just now · enrichment failed");
    expect(q(".jv-syncline").classList.contains("jv-err")).toBe(true);
  });
  test("a reload still shows that the last sync's model step failed (jv-zgk)", async () => {
    await boot();
    localStorage.setItem("sb.sync.noconfirm", "1");
    env.routes.set("POST /api/sync", () => ({ json: { ...syncOk, failures: [{ step: "enrich", failed: 2, reason: "file missing", doctor: false }] } }));
    q(".jv-sync").click();
    await env.tick(30);
    expect(q(".jv-syncline").textContent).toBe("Synced just now · enrichment failed");
    const stored = snapshotStorage();
    env.restore();
    await boot("", stored); // the reload: a fresh page over the same browser storage
    expect(q(".jv-syncline").textContent).toBe("Synced just now · enrichment failed");
    expect(q(".jv-syncline").classList.contains("jv-err")).toBe(true);
    // A later clean sync clears it, and a reload after that shows no failure.
    env.routes.set("POST /api/sync", () => ({ json: syncOk }));
    q(".jv-sync").click();
    await env.tick(30);
    expect(q(".jv-syncline").textContent).toBe("Synced just now");
    const stored2 = snapshotStorage();
    env.restore();
    await boot("", stored2);
    expect(q(".jv-syncline").textContent).toBe("Synced just now");
    expect(q(".jv-syncline").classList.contains("jv-err")).toBe(false);
  });
  test("an unpushed sync with two failed steps says so, and points at doctor only where it has a fix (jv-m9l)", async () => {
    await boot();
    localStorage.setItem("sb.sync.noconfirm", "1");
    env.routes.set("POST /api/sync", () => ({ json: { ...syncOk, pushed: false, failures: [
      { step: "enrich", failed: 1, reason: "file missing", doctor: false },
      { step: "refine", failed: 2, reason: "no results array", doctor: false },
    ] } }));
    q(".jv-sync").click();
    await env.tick(30);
    expect(q(".toast").textContent).toBe("Not shared with the team, but enrichment failed for 1 item(s): file missing; link refinement failed for 2 batch(es): no results array.");
    expect(q(".jv-syncline").textContent).toBe("Synced just now · enrichment and link refinement failed");
  });
  test("a failed sync says so in the line; a running one is reported as today", async () => {
    await boot();
    localStorage.setItem("sb.sync.noconfirm", "1");
    env.routes.set("POST /api/sync", () => ({ status: 409, json: { error: "busy" } }));
    q(".jv-sync").click();
    await env.tick(30);
    expect(q(".toast").textContent).toBe("A sync is already running.");
    expect(q(".jv-syncline").textContent).toBe("Not synced yet"); // busy is not a failure
    env.routes.set("POST /api/sync", () => ({ status: 500, json: { error: "disk" } }));
    q(".jv-sync").click();
    await env.tick(30);
    expect(q(".jv-syncline").textContent).toBe("Sync failed");
  });
});
