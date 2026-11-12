/** The conversation: the front door of the app. One chat at a time, kept across pages and reloads. */
import { api } from "./api.ts";
import { getPref, setPref } from "./prefs.ts";
import { createTasks } from "./tasks.ts";
import { docRefFor, tabKey, type DocRef } from "./tabs.ts";
import { kindLabel } from "./transcript.ts";
import { drawCard, keptCount, type ChoiceOption, type WebChange } from "./changes.ts";
import { h, modal, toast } from "./ui.ts";
import { escapePath, findMention, headerFor, middleCut, narrow, splitPath, type DirEntry } from "./atpath.ts";
import { renderMarkdown } from "../../src/briefings/markdown.ts";

export interface Scope { type: "jarvis" | "item" | "briefing" | "initiative"; ids: string[]; }
type ChatEvent = { type: "change"; change: WebChange } | { type: "open"; docId: string; title?: string; source?: string } | { type: "source"; docId?: string; title?: string; source?: string; detail?: string } | { type: "message"; text: string } | { type: "status"; text: string } | { type: "usage"; used: number; size: number } | { type: "done"; stopReason?: string } | { type: "error"; error: string };

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
  jarvis: ["Summarise the newest captures", "What did the team decide this week?", "Turn this week's decisions into tasks for me", "Draft a briefing on what changed this week"],
  item: ["Summarise this in three bullets", "What questions does this raise?", "Draft a task from this"],
  initiative: ["What's left before we can close it?", "What's blocking it right now?", "Write a status update I can share"],
  briefing: ["What is the key takeaway?", "List the open decisions", "Suggest a diagram for section 2"],
};
export const KEY_CHAT = "jv.chat";
export const MAX_SAVED_MESSAGES = 100;
const GENERAL: Scope = { type: "jarvis", ids: [] };

interface Step { text: string; done: boolean }
export const FILE_EXT = [".txt", ".md", ".markdown", ".pdf", ".vtt", ".srt"];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** "312 B", "4 KB", "1.2 MB". */
export function fileSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** Why a file can't be sent, or null when it can. */
export function fileProblem(f: { name: string; size: number }): string | null {
  if (!FILE_EXT.includes(f.name.slice(f.name.lastIndexOf(".")).toLowerCase())) return `${f.name} — can't capture this kind of file`;
  return f.size > MAX_FILE_BYTES ? `${f.name} — larger than 25 MB` : null;
}
interface Pending { file: File; problem: string | null }
interface Msg { role: "user" | "assistant"; text: string; files?: { name: string; size: number }[]; changes?: WebChange[]; /** Length of `text` when the first change arrived: the card sits there. Absent on replies saved before it existed (card first). */ changesAt?: number; steps?: Step[]; sources?: { docId: string; title: string; source?: string; detail?: string }[]; chosen?: Record<string, string>; status?: "streaming" | "done" | "stopped" | "failed"; question?: string; cards?: { type: DocRef["type"]; id: string; title: string; kind: string }[] }
interface Conv { conversationId?: string; sessionId?: string; scope: Scope; attached?: { id: string; title: string }; messages: Msg[] }

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
  /** Redraw (the cards outline the document whose tab is shown). */
  redraw(): void;
}

/** Build the chat view. `navigate` changes the hash; `onChange` fires when the conversation changes. */
export function createChat(opts: { navigate: (hash: string) => void; onChange?: () => void; openQuietly?: (ref: DocRef, title: string, kind: string) => void; showDoc?: (ref: DocRef, title: string, kind: string) => void; shownKey?: () => string | null; now?: () => Date; undoMs?: number; slowMs?: number }): Chat {
  const now = opts.now ?? (() => new Date());
  const newId = (): string => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let conv = restore();
  if (!conv.conversationId) conv.conversationId = newId();
  let pending: Pending[] = [];
  let name: string | undefined;
  let available: boolean | null = null;
  let answering = false, stoppedByUser = false;
  let controller: AbortController | null = null;
  /** Messages whose steps differ from their default fold state: folded by default, except for an empty answer, which starts unfolded. */
  const flippedSteps = new Set<Msg>();
  const tasks = createTasks({ undoMs: opts.undoMs });

  const el = h("section", { class: "jv-chat" });
  const col = h("div", { class: "jv-col" });
  const scroll = h("div", { class: "jv-scroll" }, col);
  const attachRow = h("div", { class: "jv-attachrow" });
  const fileRow = h("div", { class: "jv-files" });
  const input = h("textarea", { class: "jv-input", rows: "1", "aria-label": "Message" });
  const bar = h("div", { class: "jv-bar" });
  const picker = h("input", { type: "file", multiple: "", class: "jv-picker", hidden: "", tabindex: "-1", "aria-hidden": "true" }) as HTMLInputElement;
  const composer = h("div", { class: "jv-composer" }, fileRow, input, bar, picker);
  const dropMsg = h("div", { class: "jv-drop", hidden: "" }, "Drop files to attach");
  el.append(scroll, h("div", { class: "jv-composer-wrap" }, attachRow, composer), dropMsg);
  picker.addEventListener("change", () => { addFiles([...(picker.files ?? [])]); picker.value = ""; });
  let dragDepth = 0;
  const hasFiles = (e: Event) => [...((e as DragEvent).dataTransfer?.types ?? [])].includes("Files");
  el.addEventListener("dragenter", (e) => { if (available === false || !hasFiles(e)) return; e.preventDefault(); dragDepth++; setDropping(true); });
  el.addEventListener("dragover", (e) => { if (available === false || !hasFiles(e)) return; e.preventDefault(); });
  el.addEventListener("dragleave", () => { if (dragDepth > 0 && --dragDepth === 0) setDropping(false); });
  el.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; setDropping(false);
    if (available !== false) addFiles([...((e as DragEvent).dataTransfer?.files ?? [])]);
  });
  function setDropping(on: boolean): void { el.classList.toggle("jv-dropping", on); dropMsg.hidden = !on; }
  function addFiles(files: File[]): void {
    if (available === false) return;
    for (const f of files) pending.push({ file: f, problem: fileProblem(f) });
    drawComposer();
  }
  function removeFile(i: number): void {
    pending.splice(i, 1);
    drawComposer();
    ((fileRow.querySelectorAll(".jv-file-x")[i] ?? fileRow.querySelectorAll(".jv-file-x")[i - 1] ?? input) as HTMLElement).focus();
  }
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (mentionKey(k)) return;
    if (k.key === "Enter" && !k.shiftKey && !k.isComposing) { k.preventDefault(); void send(input.value); }
  });

  // ---- @ path suggestions ----
  const slowMs = opts.slowMs ?? 150;
  const AT_NAME_MAX = 36;
  const atPanel = h("div", { class: "jv-at", role: "listbox", hidden: "" });
  const atAnchor = h("div", { class: "jv-at-anchor" });
  composer.replaceWith(atAnchor);
  atAnchor.append(atPanel, composer);
  type Listing = { entries: DirEntry[] } | "error";
  const listings = new Map<string, Listing>();
  let atDir: string | null = null, atPrefix = "", atShown: Listing | "loading" | null = null, atHi = 0, atOpen = false, atDismissed = false, atReq = 0;
  let atSlow: ReturnType<typeof setTimeout> | undefined;
  const atRows = (): DirEntry[] => (atShown && atShown !== "loading" && atShown !== "error" ? narrow(atShown.entries, atPrefix) : []);
  function atClose(dismiss: boolean): void {
    atDismissed = dismiss; atOpen = false; atDir = null; atShown = null; atReq++; clearTimeout(atSlow);
    listings.clear(); atPanel.hidden = true; atPanel.replaceChildren(); input.removeAttribute("aria-expanded");
  }
  /** Look at the caret: open, narrow or close the suggestions for the @path it is in. */
  function atEvaluate(): void {
    const m = available === false || atDismissed ? null : findMention(input.value, input.selectionStart ?? input.value.length);
    if (!m) { if (atOpen || atDir !== null) atClose(atDismissed); return; }
    const { dir, prefix } = splitPath(m.raw);
    if (dir === atDir && prefix === atPrefix) return;
    const dirChanged = dir !== atDir;
    atPrefix = prefix; atHi = 0;
    if (!dirChanged) { if (atShown !== "loading") atDraw(); return; }
    atDir = dir;
    const have = listings.get(dir);
    if (have) { atShown = have; atDraw(); return; }
    const mine = ++atReq;
    clearTimeout(atSlow);
    atShown = "loading"; // the previous folder's rows can no longer be chosen; the panel says so only after slowMs
    atSlow = setTimeout(() => { if (mine === atReq) atDraw(); }, slowMs);
    api.chatPaths(dir).then((r) => r, () => "error" as const).then((r) => {
      if (mine !== atReq) return;
      clearTimeout(atSlow);
      const l: Listing = r === "error" ? "error" : { entries: r.entries };
      listings.set(dir, l); atShown = l; atDraw();
    });
  }
  function atDraw(): void {
    if (atShown === null) return;
    atOpen = true; atPanel.hidden = false; input.setAttribute("aria-expanded", "true");
    const rows = atRows();
    const single = (text: string, cls: string) => [h("div", { class: `jv-at-row ${cls}`, role: "option" }, text)];
    const body = atShown === "loading" ? single("Looking…", "jv-at-dim") : atShown === "error" ? single("Can't open this folder", "jv-bad")
      : rows.length ? rows.map((e, i) => {
        const full = e.name + (e.dir ? "/" : ""), shown = middleCut(full, AT_NAME_MAX), n = atPrefix.length;
        const cutAt = shown === full ? -1 : shown.indexOf("…"), m = cutAt >= 0 ? Math.min(n, cutAt) : n;
        const bold = m > 0 && shown.slice(0, m).toLowerCase() === atPrefix.slice(0, m).toLowerCase();
        const row = h("div", { class: `jv-at-row${i === atHi ? " jv-on" : ""}`, role: "option", "aria-selected": String(i === atHi), onMousedown: (ev: Event) => ev.preventDefault(), onClick: () => { atHi = i; atChoose(); } },
          h("span", { class: "jv-at-i" }, e.dir ? "📁" : "📄"), h("span", { class: "jv-at-name", title: full }, bold ? h("b", {}, shown.slice(0, m)) : null, bold ? shown.slice(m) : shown));
        return row;
      }) : single(atShown.entries.length === 0 ? "Empty folder" : "No matches", "jv-at-dim");
    atPanel.replaceChildren(
      h("div", { class: "jv-at-h" }, h("span", { class: "jv-at-dir" }, headerFor(atDir ?? "")), rows.length ? h("span", { class: "jv-at-n" }, String(rows.length)) : null),
      h("div", { class: "jv-at-list" }, ...body),
      h("div", { class: "jv-at-hint" }, "↑↓ to move · Enter or Tab to choose · Esc to close"));
    (atPanel.querySelector(".jv-on") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }
  /** Put the highlighted entry into the message: a folder continues into it, a file ends the mention. */
  function atChoose(): void {
    const e = atRows()[atHi], m = findMention(input.value, input.selectionStart ?? input.value.length);
    if (!e || !m) return;
    const rawDir = m.raw.slice(0, m.raw.lastIndexOf("/") + 1);
    const text = input.value, spaceAfter = e.dir ? false : /\s/.test(text[m.end] ?? "");
    const insert = rawDir + escapePath(e.name) + (e.dir ? "/" : spaceAfter ? "" : " ");
    input.value = text.slice(0, m.start + 1) + insert + text.slice(m.end);
    const caret = m.start + 1 + insert.length + (spaceAfter ? 1 : 0);
    input.setSelectionRange(caret, caret);
    input.focus();
    atDir = null; atPrefix = "";
    if (e.dir) atEvaluate(); else atClose(false);
  }
  /** Keys the open suggestion list owns; true when handled (so Enter never sends). */
  function mentionKey(k: KeyboardEvent): boolean {
    if (!atOpen || k.isComposing) return false;
    const rows = atRows();
    if (k.key === "Escape") { k.preventDefault(); k.stopPropagation(); atClose(true); return true; }
    if (k.key === "ArrowDown" || k.key === "ArrowUp") {
      k.preventDefault();
      if (rows.length) { atHi = Math.max(0, Math.min(rows.length - 1, atHi + (k.key === "ArrowDown" ? 1 : -1))); atDraw(); }
      return true;
    }
    if (k.key === "Enter" || k.key === "Tab") {
      if (k.key === "Enter" && k.shiftKey) return false;
      if (!rows.length && k.key === "Tab") return false; // nothing to choose: Tab moves on as usual
      k.preventDefault(); // Enter never sends while the list is open
      if (rows.length) atChoose();
      return true;
    }
    return false;
  }
  input.addEventListener("input", () => { atDismissed = false; atEvaluate(); });
  input.addEventListener("click", () => { atDismissed = false; atEvaluate(); });
  input.addEventListener("keyup", (e) => { if (["ArrowLeft", "ArrowRight", "Home", "End", "ArrowUp", "ArrowDown"].includes((e as KeyboardEvent).key)) { atDismissed = false; atEvaluate(); } });
  document.addEventListener("mousedown", (e) => { if (atOpen && !atPanel.contains(e.target as Node) && e.target !== input) atClose(true); });

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
    if (m.role === "user") return h("div", { class: "jv-msg jv-user" }, m.files?.length ? h("div", { class: "jv-fchips" }, ...m.files.map((f) => h("span", { class: "jv-file", title: f.name }, h("span", { class: "jv-fn" }, `📄 ${f.name}`), ` · ${fileSize(f.size)}`))) : null, m.text);
    const parts: (HTMLElement | null)[] = [];
    const steps = m.steps ?? [];
    const empty = m.status === "done" && !m.text.trim() && !m.changes?.length;
    const list = () => h("div", { class: "jv-steps" }, ...steps.map((s) => h("div", { class: "jv-step" }, `${s.done ? "✓" : "●"} ${s.text}`)));
    if (m.status === "streaming") { if (steps.length) parts.push(list()); }
    else if (steps.length) {
      const open = empty !== flippedSteps.has(m);
      parts.push(h("button", { class: "jv-steps-toggle", "aria-expanded": String(open), onClick: () => { if (flippedSteps.has(m)) flippedSteps.delete(m); else flippedSteps.add(m); render(); } }, `${open ? "▾" : "▸"} ${steps.length} ${steps.length === 1 ? "step" : "steps"}`));
      if (open) parts.push(list());
    }
    const at = m.changes?.length ? Math.min(m.changesAt ?? 0, m.text.length) : 0;
    const before = m.text.slice(0, at), after = m.text.slice(at);
    const say = (t: string) => (t.trim() ? h("div", { class: "jv-answer", html: renderMarkdown(t) }) : null);
    if (m.status !== "failed") parts.push(say(before));
    parts.push(drawCard(m.changes ?? [], String(conv.messages.indexOf(m)), { onUndo: (c) => void undoOne(m, c), onUndoAll: () => void undoEverything(m) }, { me: name, now: now(), chosen: (c) => chosenOption(m, c) }));
    if (m.status === "failed") parts.push(h("div", { class: "jv-failed" }, "Something went wrong and I couldn't answer.", h("button", { class: "jv-retry", onClick: () => retry(m) }, "Try again")));
    else {
      if (m.text) parts.push(say(after));
      else if (m.status === "streaming" && !steps.length) parts.push(h("div", { class: "jv-answer muted" }, "…"));
      if (empty) parts.push(h("div", { class: "jv-noanswer" }, "I finished without writing an answer.", h("button", { class: "jv-retry", onClick: () => retry(m) }, "Try again")));
      if (m.status === "stopped") parts.push(h("div", { class: "jv-stopped muted small" }, "Stopped."));
      if (m.status !== "streaming") for (const c of m.changes ?? []) if (c.ask) parts.push(drawPicks(m, c));
      if (m.sources?.length) parts.push(h("div", { class: "jv-chips" }, ...m.sources.map((s) => h("a", { class: "jv-chip", href: `#/${docRefFor(s.source ?? "note", s.docId).type}/${encodeURIComponent(s.docId)}`, title: s.title }, s.detail ? `${s.title} · ${s.detail}` : s.title))));
    }
    for (const c of m.cards ?? []) {
      const ref: DocRef = { type: c.type, id: c.id };
      parts.push(h("button", { class: `jv-docard${opts.shownKey?.() === tabKey(ref) ? " jv-on" : ""}`, onClick: () => opts.showDoc?.(ref, c.title, c.kind) },
        h("span", { class: "jv-docard-i" }, c.type === "briefing" ? "▤" : c.type === "presentation" ? "▣" : "▫"),
        h("span", { class: "jv-docard-b" }, h("span", { class: "jv-docard-t" }, c.title), h("span", { class: "jv-docard-s" }, `${c.kind} · opened in a tab`))));
    }
    return h("div", { class: "jv-msg jv-a" }, ...parts);
  }
  /** The option chosen for a waiting row: the button pressed, else an item a later change of the conversation touched. */
  function chosenOption(m: Msg, c: WebChange): ChoiceOption | undefined {
    const options = c.ask?.options ?? [];
    const pressed = m.chosen?.[c.id];
    if (pressed) return options.find((o) => o.id === pressed);
    const later = conv.messages.slice(conv.messages.indexOf(m) + 1).flatMap((x) => x.changes ?? []).filter((x) => x.ok && !x.undone);
    return options.find((o) => later.some((x) => x.items.some((i) => i.id === o.id)));
  }
  /** The buttons of one question: pressable only under the newest, finished answer and until one is pressed. */
  function drawPicks(m: Msg, c: WebChange): HTMLElement {
    const chosen = m.chosen?.[c.id];
    const live = m.status === "done" && !chosen && !answering && conv.messages.at(-1) === m;
    return h("div", { class: "jv-picks" }, ...c.ask!.options.map((o) => h("button", {
      class: `jv-pick${chosen === o.id ? " jv-chosen" : ""}${live ? "" : " jv-pick-off"}`, disabled: live ? null : "",
      onClick: () => { m.chosen = { ...m.chosen, [c.id]: o.id }; persist(); void send(`${o.title}${o.tail}`); input.focus(); },
    }, h("b", {}, o.title), h("span", {}, o.detail))));
  }
  function drawComposer(): void {
    const off = available === false;
    composer.classList.toggle("jv-off", off);
    input.disabled = off;
    input.placeholder = off ? "The agent isn't available" : conv.attached ? `Ask about this ${conv.scope.type}…` : "Ask J.A.R.V.I.S.…";
    attachRow.replaceChildren();
    fileRow.replaceChildren(...pending.map((p, i) => h("span", { class: `jv-file${p.problem ? " jv-bad" : ""}`, title: p.file.name }, h("span", { class: "jv-fn" }, p.problem ? `⚠ ${p.problem}` : `📄 ${p.file.name}`), p.problem ? "" : ` · ${fileSize(p.file.size)}`, h("button", { class: "jv-file-x", "aria-label": `Remove ${p.file.name}`, title: "Remove", onClick: () => removeFile(i) }, "×"))));
    fileRow.hidden = pending.length === 0;
    if (conv.attached) attachRow.append(h("span", { class: "jv-attach", title: conv.attached.title }, h("span", { class: "jv-attach-t" }, conv.scope.type === "initiative" ? `◎ ${conv.attached.title}` : conv.attached.title), h("button", { "aria-label": "Remove", title: "Remove", onClick: detach }, "×")));
    const action = answering
      ? h("button", { class: "jv-stop", title: "Stop", "aria-label": "Stop", onClick: () => stop() }, "■")
      : h("button", { class: "jv-send", title: "Send", "aria-label": "Send", disabled: off ? "" : null, onClick: () => void send(input.value) }, "↑");
    bar.replaceChildren(h("button", { class: "jv-clip", title: "Attach files", "aria-label": "Attach files", disabled: off ? "" : null, onClick: () => picker.click() }, "📎"), h("span", { class: "jv-hint" }, answering ? "Esc to stop" : "Enter to send · Shift+Enter for a new line"), action);
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
    conv = { conversationId: newId(), scope: GENERAL, messages: [] };
    pending = [];
    flippedSteps.clear();
  }
  function detach(): void {
    if (conv.sessionId) fetch(`/api/chat/sessions/${conv.sessionId}`, { method: "DELETE" }).catch(() => {});
    conv.attached = undefined; conv.scope = GENERAL; conv.sessionId = undefined;
    persist(); render(); input.focus();
  }
  async function newSession(): Promise<string> {
    const r = await fetch("/api/chat/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: conv.scope, conversationId: conv.conversationId }) });
    if (!r.ok) throw new Error("chat unavailable");
    conv.sessionId = ((await r.json()) as { sessionId: string }).sessionId;
    return conv.sessionId;
  }
  const post = (id: string, message: string, signal: AbortSignal, files: File[] = []) => {
    if (!files.length) return fetch(`/api/chat/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }), signal });
    const f = new FormData();
    f.set("message", message);
    for (const x of files) f.append("files", x);
    return fetch(`/api/chat/sessions/${id}/messages`, { method: "POST", body: f, signal });
  };
  async function send(text: string): Promise<void> {
    text = text.trim();
    if (!text || answering || available === false) return;
    const sendable = pending.filter((p) => !p.problem).map((p) => p.file);
    const a: Msg = { role: "assistant", text: "", steps: [], sources: [], changes: [], status: "streaming", question: text };
    conv.messages.push({ role: "user", text, files: sendable.length ? sendable.map((f) => ({ name: f.name, size: f.size })) : undefined }, a);
    pending = [];
    input.value = "";
    answering = true; stoppedByUser = false;
    controller = new AbortController();
    persist(); render(); toBottom();
    try {
      let r = await post(conv.sessionId ?? (await newSession()), text, controller.signal, sendable);
      if (r.status === 404) r = await post(await newSession(), text, controller.signal, sendable);
      if (!r.ok || !r.body) throw new Error("chat failed");
      const decode = ndjsonDecoder((e) => {
        if (e.type === "message") a.text += e.text;
        else if (e.type === "change") { a.changesAt ??= a.text.length; a.changes!.push(e.change); if (e.change.kind.startsWith("task.")) void tasks.load(name); }
        else if (e.type === "status") {
          const last = a.steps!.at(-1);
          if (last?.text === e.text) return;
          if (last) last.done = true;
          a.steps!.push({ text: e.text, done: false });
        } else if (e.type === "open") {
          const ref = docRefFor(e.source ?? "note", e.docId), title = e.title ?? e.docId, kind = kindLabel(e.source ?? "note");
          if (!(a.cards ??= []).some((c) => c.id === ref.id && c.type === ref.type)) { a.cards.push({ ...ref, title, kind }); opts.openQuietly?.(ref, title, kind); }
        } else if (e.type === "source" && e.docId && !a.sources!.some((s) => s.docId === e.docId)) a.sources!.push({ docId: e.docId, title: e.title ?? e.docId, source: e.source, detail: e.detail });
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
    if (i < 1 || !m.question || answering || available === false) return;
    conv.messages.splice(i - 1, 2);
    void send(m.question);
  }
  const allChanges = (): WebChange[] => conv.messages.flatMap((m) => m.changes ?? []);
  function merge(updated: WebChange[]): void {
    const by = new Map(updated.map((c) => [c.id, c]));
    for (const m of conv.messages) if (m.changes) m.changes = m.changes.map((c) => by.get(c.id) ?? c);
  }
  /** After an Undo the focus goes to the next row's Undo, else Undo all, else the typing box. */
  function focusAfter(m: Msg, id: string): void {
    const rest = (m.changes ?? []).slice((m.changes ?? []).findIndex((c) => c.id === id) + 1).find((c) => c.ok && c.undoable && !c.undone);
    const target = (rest && el.querySelector(`[data-undo="${rest.id}"]`)) ?? el.querySelector(`[data-undoall="${conv.messages.indexOf(m)}"]`) ?? input;
    (target as HTMLElement).focus();
  }
  async function undoOne(m: Msg, c: WebChange): Promise<void> {
    try { const r = await api.undoChange(conv.conversationId!, c.id); merge(r.changes ?? [r.change]); } // every row the Undo settled (a task's links)
    catch (e) { toast((e as Error).message, "error"); }
    persist(); render();
    focusAfter(m, c.id);
    if (c.kind.startsWith("task.")) void tasks.load(name);
  }
  async function undoEverything(m: Msg): Promise<void> {
    try {
      const r = await api.undoAll(conv.conversationId!, m.changes?.[0]?.turn);
      merge(r.changes);
      if (r.error) toast(r.error, "error");
    } catch (e) { toast((e as Error).message, "error"); }
    persist(); render(); input.focus();
    void tasks.load(name);
  }
  function confirmNew(then: () => void): void {
    const kept = keptCount(allChanges());
    modal("Start a new chat?", h("div", {}, h("p", {}, "This conversation will be cleared."), kept ? h("p", { class: "muted small" }, kept === 1 ? "The 1 change the agent made is kept, but you won't be able to undo it from here." : `The ${kept} changes the agent made are kept, but you won't be able to undo them from here.`) : null), [{ label: "Cancel", onClick: () => {} }, { label: "New chat", primary: true, onClick: then }], "New chat");
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
    if (allChanges().length && conv.conversationId) {
      try { merge((await api.chatChanges(conv.conversationId)).changes); persist(); render(); } catch { /* keep what the browser remembers */ }
    }
  }
  const ready = refresh();
  render();

  let savedTop = 0;
  return {
    el, ready,
    show() { el.hidden = false; scroll.scrollTop = savedTop; void refresh(); input.focus(); },
    hide() { if (!el.hidden) savedTop = scroll.scrollTop; el.hidden = true; },
    askAbout(scope, title) {
      const go = () => begin(scope, { id: scope.ids[0], title });
      if (conv.messages.length) confirmNew(go); else go();
    },
    newChat() {
      if (conv.messages.length) confirmNew(() => begin(GENERAL));
      else { if (conv.attached) detach(); opts.navigate("#/chat"); input.focus(); }
    },
    hasConversation: () => conv.messages.length > 0,
    isAnswering: () => answering,
    stop,
    focusInput: () => input.focus(),
    redraw: () => render(),
  };
}
