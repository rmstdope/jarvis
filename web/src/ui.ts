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
export function modal(title: string, body: Child, actions: { label: string; primary?: boolean; onClick: () => void }[]): HTMLElement {
  const bg = h("div", { class: "modal-bg" });
  const box = h("div", { class: "modal" }, h("h3", { style: "margin-top:0" }, title), body, h("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" }, ...actions.map((a) => h("button", { class: a.primary ? "primary" : "", onClick: () => { a.onClick(); bg.remove(); } }, a.label))));
  bg.appendChild(box);
  bg.addEventListener("click", (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  return bg;
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}
/** `source · added 2026-01-01 by mia · updated 2026-01-02 by kim · source by byline` */
export function metaLine(i: { source: string; created_at: string; author: string; updated_at?: string | null; updated_by?: string | null; metadata?: Record<string, unknown> | null }): string {
  const parts = [i.source, `added ${fmtDate(i.created_at)} by ${i.author}`];
  if (i.updated_at) parts.push(`updated ${fmtDate(i.updated_at)}${i.updated_by ? ` by ${i.updated_by}` : ""}`);
  const byline = i.metadata?.source_author;
  if (typeof byline === "string" && byline) parts.push(`source by ${byline}`);
  return parts.join(" · ");
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
  const h = (hash || "#/browse").replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  return { name: name || "browse", id: rest.length ? decodeURIComponent(rest.join("/")) : undefined };
}
