/** Right-docked, resizable "Discuss" chat panel over the NDJSON chat API (server side lands in M9). */
import { h, clear, toast } from "./ui.ts";
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
    if (final && buf.trim()) { try { onEvent(JSON.parse(buf)); } catch {} buf = ""; }
  };
}

const SUGGESTIONS: Record<Scope["type"], string[]> = {
  jarvis: ["What did we decide about firmware last month?", "Summarise the newest captures", "Which items mention Acorn?"],
  item: ["Summarise this item in three bullets", "What questions does this raise?", "Draft a task from this"],
  briefing: ["What is the key takeaway?", "List the open decisions", "Suggest a diagram for section 2"],
};
let panel: HTMLElement | null = null;

export function openDiscuss(scope: Scope): void {
  panel?.remove();
  panel = h("div", { class: "discuss" });
  const resizer = h("div", { class: "resizer" });
  const msgs = h("div", { class: "msgs" });
  const usage = h("span", { class: "muted small" });
  const input = h("input", { type: "text", placeholder: "Ask about this " + scope.type + "…", style: "flex:1" });
  const send = h("button", { class: "primary" }, "Send");
  const stop = h("button", { disabled: true }, "Stop");
  let sessionId: string | null = null;
  let controller: AbortController | null = null;
  const bubble = (cls: string, html: string) => { const b = h("div", { class: `msg ${cls}`, html }); msgs.append(b); msgs.scrollTop = msgs.scrollHeight; return b; };
  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const r = await fetch("/api/chat/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? "chat unavailable");
    const j = (await r.json()) as { sessionId: string };
    sessionId = j.sessionId;
    return sessionId;
  };
  const ask = async (text: string) => {
    if (!text.trim()) return;
    bubble("user", renderMarkdown(text));
    input.value = "";
    send.setAttribute("disabled", "true");
    stop.removeAttribute("disabled");
    const out = bubble("assistant", "<span class='muted'>…</span>");
    let acc = "";
    const chips = h("div", { class: "small" });
    try {
      const id = await ensureSession();
      controller = new AbortController();
      const r = await fetch(`/api/chat/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }), signal: controller.signal });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? "chat failed");
      const decode = ndjsonDecoder((e) => {
        if (e.type === "message") { acc += e.text; out.innerHTML = renderMarkdown(acc); }
        else if (e.type === "source") chips.append(h("a", { class: "tag", href: `#/item/${e.docId}` }, e.title ?? e.docId ?? "source"));
        else if (e.type === "status") out.title = e.text;
        else if (e.type === "usage") usage.textContent = `context ${e.used}/${e.size} tokens`;
        else if (e.type === "error") { out.innerHTML = `<span style='color:var(--error)'>${e.error}</span>`; }
      });
      const reader = r.body.getReader();
      const td = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; decode(td.decode(value, { stream: true })); }
      decode("", true);
      if (chips.childElementCount) out.append(chips);
      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) {
      if ((e as Error).name !== "AbortError") out.innerHTML = `<span style='color:var(--error)'>${(e as Error).message}</span>`;
    } finally {
      send.removeAttribute("disabled");
      stop.setAttribute("disabled", "true");
      controller = null;
    }
  };
  stop.addEventListener("click", async () => { controller?.abort(); if (sessionId) fetch(`/api/chat/sessions/${sessionId}/cancel`, { method: "POST" }).catch(() => {}); });
  const reset = async () => { if (sessionId) fetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {}); sessionId = null; clear(msgs); showSuggestions(); usage.textContent = ""; };
  const close = () => { reset(); panel?.remove(); panel = null; };
  const showSuggestions = () => { msgs.append(h("div", { class: "muted small" }, "Suggestions:"), ...SUGGESTIONS[scope.type].map((s) => h("div", {}, h("a", { href: "#", onClick: (e: Event) => { (e as unknown as MouseEvent).preventDefault(); ask(s); } }, s)))); };
  showSuggestions();
  panel.append(resizer, h("div", { class: "row", style: "padding:10px;border-bottom:1px solid var(--border)" }, h("strong", { style: "flex:1" }, `Discuss · ${scope.type}`), usage, h("button", { onClick: reset }, "New"), h("button", { onClick: close }, "Close")), msgs,
    h("form", { onSubmit: (e: Event) => { e.preventDefault(); ask(input.value); } }, input, stop, send));
  document.body.append(panel);
  // resize
  let startX = 0, startW = 0;
  resizer.addEventListener("mousedown", (e) => { startX = e.clientX; startW = panel!.offsetWidth; const mv = (m: MouseEvent) => { panel!.style.width = `${Math.min(window.innerWidth * 0.85, Math.max(320, startW + (startX - m.clientX)))}px`; }; const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); });
  input.focus();
  void toast;
}
