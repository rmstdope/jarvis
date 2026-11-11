/** Tiny imperative DOM helpers. */
export type Child = Node | string | null | undefined | false | Child[];
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "html") el.innerHTML = String(v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (k === "checked" && "checked" in el) (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}
export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}
export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, kind: "ok" | "error" = "ok", ms = 4000): void {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: `toast${kind === "error" ? " error" : ""}` }, message);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}
/**
 * A dialog over the page. Esc and a click outside close it; focus starts on the action labelled
 * `focus` (else the first button) and returns to where it was when the dialog closes.
 */
export function modal(title: string, body: Child, actions: { label: string; primary?: boolean; onClick: () => void }[], focus?: string): HTMLElement {
  const before = document.activeElement as HTMLElement | null;
  const bg = h("div", { class: "modal-bg" });
  const close = () => { document.removeEventListener("keydown", onKey, true); bg.remove(); before?.focus?.(); };
  const onKey = (e: Event) => { if ((e as KeyboardEvent).key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const buttons = actions.map((a) => h("button", { class: a.primary ? "primary" : "", onClick: () => { close(); a.onClick(); } }, a.label));
  const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h3", { style: "margin-top:0" }, title), body, h("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" }, ...buttons));
  bg.appendChild(box);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(bg);
  (buttons[actions.findIndex((a) => a.label === focus)] ?? buttons[0])?.focus();
  return bg;
}
/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}
/** "<kind> · <who> · <when>": the details line of every entry; missing parts are left out. */
export function entryLine(...parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p).join(" · ");
}
/** Escape a search snippet and turn its `[matched]` words into <mark> (the only markup produced). */
export function highlightSnippet(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\[([^\]]+)\]/g, "<mark>$1</mark>");
}
export function itemHref(i: { id: string; source: string }): string {
  if (i.source === "briefing") return `#/briefing/${i.id}`;
  if (i.source === "presentation") return `#/presentation/${i.id}`;
  return `#/item/${i.id}`;
}
export function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}
export function parseRoute(hash: string): { name: string; id?: string } {
  const h = (hash || "#/chat").replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  return { name: name || "chat", id: rest.length ? decodeURIComponent(rest.join("/")) : undefined };
}
