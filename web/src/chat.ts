/** The conversation: the front door of the app. One chat at a time, kept across pages and reloads. */
import { api } from "./api.ts";
import { getPref, setPref } from "./prefs.ts";
import { createTasks } from "./tasks.ts";
import { h, modal } from "./ui.ts";
import { renderMarkdown } from "../../src/briefings/markdown.ts";

export interface Scope { type: "jarvis" | "item" | "briefing"; ids: string[]; }
type ChatEvent = { type: "source"; docId?: string; title?: string } | { type: "message"; text: string } | { type: "status"; text: string } | { type: "usage"; used: number; size: number } | { type: "done"; stopReason?: string } | { type: "error"; error: string };

/** Split a byte stream into NDJSON objects; partial trailing lines carry over between chunks. */
export function ndjsonDecoder(onEvent: (e: ChatEvent) => void): (chunk: string, final?: boolean) => void {
  let buf = "";
  return (chunk, final = false) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = final ? "" : lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      try { onEvent(JSON.parse(l)); } catch { /* ignore malformed line */ }
    }
    if (final && buf.trim()) { try { onEvent(JSON.parse(buf)); } catch { /* ignore */ } buf = ""; }
  };
}

export const SUGGESTIONS: Record<Scope["type"], string[]> = {
  jarvis: ["Summarise the newest captures", "What did the team decide this week?", "What are my open tasks?", "Which briefings are still drafts?"],
  item: ["Summarise this in three bullets", "What questions does this raise?", "Draft a task from this"],
  briefing: ["What is the key takeaway?", "List the open decisions", "Suggest a diagram for section 2"],
};
export const KEY_CHAT = "jv.chat";
export const MAX_SAVED_MESSAGES = 100;
const GENERAL: Scope = { type: "jarvis", ids: [] };

interface Step { text: string; done: boolean }
interface Msg { role: "user" | "assistant"; text: string; steps?: Step[]; sources?: { docId: string; title: string }[]; status?: "streaming" | "done" | "stopped" | "failed"; question?: string }
interface Conv { sessionId?: string; scope: Scope; attached?: { id: string; title: string }; messages: Msg[] }

/** "Good morning" before noon, "Good afternoon" until 18:00, "Good evening" after; with the name when known. */
export function greeting(hour: number, name?: string): string {
  const word = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${word}${name ? `, ${name}` : ""}.`;
}

export interface Chat {
  el: HTMLElement;
  /** Resolves when the name, the agent's availability and the tasks have first loaded. */
  ready: Promise<void>;
  show(): void;
  hide(): void;
  /** Start a conversation about an item or briefing (asks first when one exists). */
  askAbout(scope: Scope, title: string): void;
  newChat(): void;
  hasConversation(): boolean;
  isAnswering(): boolean;
  stop(): void;
  focusInput(): void;
}

/** Build the chat view. `navigate` changes the hash; `onChange` fires when the conversation changes. */
export function createChat(opts: { navigate: (hash: string) => void; onChange?: () => void; now?: () => Date; undoMs?: number }): Chat {
  const now = opts.now ?? (() => new Date());
  let conv = restore();
  let name: string | undefined;
  let available: boolean | null = null;
  let answering = false, stoppedByUser = false;
  let controller: AbortController | null = null;
  const openSteps = new Set<Msg>();
  const tasks = createTasks({ undoMs: opts.undoMs });

  const el = h("section", { class: "jv-chat" });
  const col = h("div", { class: "jv-col" });
  const scroll = h("div", { class: "jv-scroll" }, col);
  const attachRow = h("div", { class: "jv-attachrow" });
  const input = h("textarea", { class: "jv-input", rows: "1", "aria-label": "Message" });
  const bar = h("div", { class: "jv-bar" });
  const composer = h("div", { class: "jv-composer" }, input, bar);
  el.append(scroll, h("div", { class: "jv-composer-wrap" }, attachRow, composer));
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && !k.shiftKey && !k.isComposing) { k.preventDefault(); void send(input.value); }
  });

  function restore(): Conv {
    try {
      const v = JSON.parse(getPref(KEY_CHAT) ?? "null") as Conv | null;
      if (v && Array.isArray(v.messages) && v.scope?.type) {
        for (const m of v.messages) if (m.status === "streaming") m.status = "stopped";
        return v;
      }
    } catch { /* fall through */ }
    return { scope: GENERAL, messages: [] };
  }
  function persist(): void {
    setPref(KEY_CHAT, JSON.stringify({ ...conv, messages: conv.messages.slice(-MAX_SAVED_MESSAGES) }));
    opts.onChange?.();
  }
  const toBottom = () => { scroll.scrollTop = scroll.scrollHeight; };

  // ---- view ----
  function drawFirstScreen(): void {
    if (available === null) return;
    const ctx = conv.attached ? conv.scope.type : "jarvis";
    col.append(h("h1", { class: "jv-hello" }, conv.attached ? `Ask about “${conv.attached.title}”.` : greeting(now().getHours(), name)));
    if (!conv.attached && available) col.append(h("p", { class: "jv-sub" }, "Ask anything about your team's knowledge — I'll cite what I find."));
    if (!available) col.append(h("div", { class: "jv-notice" }, h("h3", {}, "The agent isn't available right now."), h("p", {}, "Everything else works — search, capture and your briefings don't need it. Run jarvis doctor to see what's missing.")));
    if (!conv.attached) col.append(tasks.el);
    if (available) col.append(h("div", { class: "jv-suggest" }, ...SUGGESTIONS[ctx].map((s) => h("button", { class: "jv-sg", onClick: () => void send(s) }, s))));
    else if (!conv.attached) col.append(h("div", { class: "jv-suggest" },
      h("a", { class: "jv-card-link", href: "#/browse" }, h("b", {}, "Browse & search"), h("small", {}, "Find anything your team captured")),
      h("a", { class: "jv-card-link", href: "#/capture" }, h("b", {}, "Capture"), h("small", {}, "Save a note or a link"))));
  }
  function drawMessage(m: Msg): HTMLElement {
    if (m.role === "user") return h("div", { class: "jv-msg jv-user" }, m.text);
    const parts: (HTMLElement | null)[] = [];
    const steps = m.steps ?? [];
    const list = () => h("div", { class: "jv-steps" }, ...steps.map((s) => h("div", { class: "jv-step" }, `${s.done ? "✓" : "●"} ${s.text}`)));
    if (m.status === "streaming") { if (steps.length) parts.push(list()); }
    else if (steps.length) {
      const open = openSteps.has(m);
      parts.push(h("button", { class: "jv-steps-toggle", "aria-expanded": String(open), onClick: () => { if (open) openSteps.delete(m); else openSteps.add(m); render(); } }, `${open ? "▾" : "▸"} ${steps.length} ${steps.length === 1 ? "step" : "steps"}`));
      if (open) parts.push(list());
    }
    if (m.status === "failed") parts.push(h("div", { class: "jv-failed" }, "Something went wrong and I couldn't answer.", h("button", { class: "jv-retry", onClick: () => retry(m) }, "Try again")));
    else {
      if (m.text) parts.push(h("div", { class: "jv-answer", html: renderMarkdown(m.text) }));
      else if (m.status === "streaming" && !steps.length) parts.push(h("div", { class: "jv-answer muted" }, "…"));
      if (m.status === "stopped") parts.push(h("div", { class: "jv-stopped muted small" }, "Stopped."));
      if (m.sources?.length) parts.push(h("div", { class: "jv-chips" }, ...m.sources.map((s) => h("a", { class: "jv-chip", href: `#/item/${encodeURIComponent(s.docId)}`, title: s.title }, s.title))));
    }
    return h("div", { class: "jv-msg jv-a" }, ...parts);
  }
  function drawComposer(): void {
    const off = available === false;
    composer.classList.toggle("jv-off", off);
    input.disabled = off;
    input.placeholder = off ? "The agent isn't available" : conv.attached ? `Ask about this ${conv.scope.type}…` : "Ask J.A.R.V.I.S.…";
    attachRow.replaceChildren();
    if (conv.attached) attachRow.append(h("span", { class: "jv-attach", title: conv.attached.title }, h("span", { class: "jv-attach-t" }, conv.attached.title), h("button", { "aria-label": "Remove", title: "Remove", onClick: detach }, "×")));
    const action = answering
      ? h("button", { class: "jv-stop", title: `Stop (Esc)`, onClick: () => stop() }, "■")
      : h("button", { class: "jv-send", title: "Send", "aria-label": "Send", disabled: off ? "" : null, onClick: () => void send(input.value) }, "↑");
    if (answering) action.title = "Stop";
    bar.replaceChildren(h("span", { class: "jv-hint" }, answering ? "Esc to stop" : "Enter to send · Shift+Enter for a new line"), action);
  }
  function render(): void {
    col.replaceChildren();
    if (conv.messages.length === 0) drawFirstScreen();
    else col.append(...conv.messages.map(drawMessage));
    drawComposer();
  }

  // ---- conversation ----
  function resetConv(): void {
    stop();
    if (conv.sessionId) fetch(`/api/chat/sessions/${conv.sessionId}`, { method: "DELETE" }).catch(() => {});
    conv = { scope: GENERAL, messages: [] };
    openSteps.clear();
  }
  function detach(): void {
    if (conv.sessionId) fetch(`/api/chat/sessions/${conv.sessionId}`, { method: "DELETE" }).catch(() => {});
    conv.attached = undefined; conv.scope = GENERAL; conv.sessionId = undefined;
    persist(); render(); input.focus();
  }
  async function newSession(): Promise<string> {
    const r = await fetch("/api/chat/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: conv.scope }) });
    if (!r.ok) throw new Error("chat unavailable");
    conv.sessionId = ((await r.json()) as { sessionId: string }).sessionId;
    return conv.sessionId;
  }
  const post = (id: string, message: string, signal: AbortSignal) => fetch(`/api/chat/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }), signal });
  async function send(text: string): Promise<void> {
    text = text.trim();
    if (!text || answering || available === false) return;
    const a: Msg = { role: "assistant", text: "", steps: [], sources: [], status: "streaming", question: text };
    conv.messages.push({ role: "user", text }, a);
    input.value = "";
    answering = true; stoppedByUser = false;
    controller = new AbortController();
    persist(); render(); toBottom();
    try {
      let r = await post(conv.sessionId ?? (await newSession()), text, controller.signal);
      if (r.status === 404) r = await post(await newSession(), text, controller.signal);
      if (!r.ok || !r.body) throw new Error("chat failed");
      const decode = ndjsonDecoder((e) => {
        if (e.type === "message") a.text += e.text;
        else if (e.type === "status") {
          const last = a.steps!.at(-1);
          if (last?.text === e.text) return;
          if (last) last.done = true;
          a.steps!.push({ text: e.text, done: false });
        } else if (e.type === "source" && e.docId && !a.sources!.some((s) => s.docId === e.docId)) a.sources!.push({ docId: e.docId, title: e.title ?? e.docId });
        else if (e.type === "error") a.status = "failed";
        persist(); render(); toBottom();
      });
      const reader = r.body.getReader();
      const td = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; decode(td.decode(value, { stream: true })); }
      decode("", true);
    } catch {
      if (!stoppedByUser) a.status = "failed";
    }
    if (stoppedByUser) a.status = "stopped";
    else if (a.status === "streaming") a.status = "done";
    for (const s of a.steps ?? []) s.done = true;
    answering = false; controller = null;
    persist(); render(); toBottom();
    if (!document.activeElement || document.activeElement === document.body) input.focus();
  }
  function stop(): void {
    if (!answering) return;
    stoppedByUser = true;
    controller?.abort();
    if (conv.sessionId) fetch(`/api/chat/sessions/${conv.sessionId}/cancel`, { method: "POST" }).catch(() => {});
  }
  function retry(m: Msg): void {
    const i = conv.messages.indexOf(m);
    if (i < 1 || !m.question) return;
    conv.messages.splice(i - 1, 2);
    void send(m.question);
  }
  function confirmNew(then: () => void): void {
    modal("Start a new chat?", h("p", {}, "This conversation will be cleared."), [{ label: "Cancel", onClick: () => {} }, { label: "New chat", primary: true, onClick: then }], "New chat");
  }
  function begin(scope: Scope, attached?: { id: string; title: string }): void {
    resetConv();
    conv.scope = scope; conv.attached = attached;
    persist(); render();
    opts.navigate("#/chat");
    void refresh();
    input.focus();
  }

  async function refresh(): Promise<void> {
    const [me, st] = await Promise.all([api.me().catch(() => ({} as { name?: string })), api.chatStatus().catch(() => ({ available: false }))]);
    name = me.name; available = st.available;
    render();
    await tasks.load(name);
  }
  const ready = refresh();
  render();

  let savedTop = 0;
  return {
    el, ready,
    show() { el.hidden = false; scroll.scrollTop = savedTop; void refresh(); input.focus(); },
    hide() { savedTop = scroll.scrollTop; el.hidden = true; },
    askAbout(scope, title) {
      const go = () => begin(scope, { id: scope.ids[0], title });
      if (conv.messages.length) confirmNew(go); else go();
    },
    newChat() {
      if (conv.messages.length) confirmNew(() => begin(GENERAL));
      else { opts.navigate("#/chat"); input.focus(); }
    },
    hasConversation: () => conv.messages.length > 0,
    isAnswering: () => answering,
    stop,
    focusInput: () => input.focus(),
  };
}
