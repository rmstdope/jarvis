/** Pieces every page is built from: the trail, entry cards, pills, and the loading, empty and error boxes. */
import type { Child } from "../ui.ts";
import { append, h } from "../ui.ts";
import type { Chat } from "../chat.ts";

/** What the router hands a page. */
export interface Ctx {
  /** The element the page draws into (attached once the page has loaded). */
  main: HTMLElement;
  /** The scrolling area the page sits in. */
  scroller: HTMLElement;
  chat: Chat;
  /** Draw the current route again from scratch. */
  rerender(): void;
}
/** A page may return what to do once it is on screen (focus, …). */
export type Page = Promise<void | (() => void)>;

declare global {
  interface Window { __JARVIS_APP__?: boolean; }
}
/** True inside the macOS app's own window. */
export const inApp = (): boolean => window.__JARVIS_APP__ === true;

/** The page heading. */
export const heading = (name: string): HTMLElement => h("h1", { class: "jv-pt" }, name);

/** "<page you came from> › <title>"; the first part is a link back. */
export function trail(backLabel: string, backHref: string, title?: string): HTMLElement {
  return h("nav", { class: "jv-trail", "aria-label": "Trail" }, h("a", { href: backHref }, backLabel), title === undefined ? null : [" › ", h("span", { class: "jv-trail-t", title }, title)]);
}
/** Small accent-tinted tag pills. */
export const tagPills = (tags: string[] | undefined): HTMLElement | null =>
  tags?.length ? h("div", { class: "jv-tags" }, ...tags.map((t) => h("span", { class: "jv-tag" }, t))) : null;
/** A small status pill; `tone` picks the colour. */
export const statusPill = (label: string, tone: "g" | "a" | "n" = "n"): HTMLElement => h("span", { class: `jv-status jv-st-${tone}` }, label);

/** A list card: linked title, details line (with an optional pill after it), summary, tags. */
export function entryCard(o: { href: string; title: string; details: string; pill?: HTMLElement | null; summary?: string | null; tags?: string[] }): HTMLElement {
  return h("div", { class: "jv-card" },
    h("a", { class: "jv-ct", href: o.href, title: o.title }, o.title),
    h("div", { class: "jv-m" }, o.details, o.pill ? [" ", o.pill] : null),
    o.summary ? h("div", { class: "jv-s" }, o.summary) : null,
    tagPills(o.tags));
}
/** Grey placeholder cards while something loads. */
export function skeleton(n = 3): HTMLElement {
  return h("div", { class: "jv-skel", "aria-hidden": "true" }, ...Array.from({ length: n }, () => h("div", { class: "jv-card" }, h("div", { class: "jv-sk w60" }), h("div", { class: "jv-sk w90" }), h("div", { class: "jv-sk w40" }))));
}
/** A dashed box for an empty list or a missing page. */
export function emptyBox(title: string, sub?: string, ...extra: Child[]): HTMLElement {
  const box = h("div", { class: "jv-empty" }, h("b", {}, title));
  if (sub) append(box, [h("div", {}, sub)]);
  append(box, extra);
  return box;
}
/** The error box: what failed, the reason in plain words, and a Try again button. */
export function errorBox(what: string, reason: string, retry?: () => void, after?: string): HTMLElement {
  return h("div", { class: "jv-errbox", role: "alert" }, h("b", {}, what), h("div", { class: "jv-reason" }, reason), after ? h("div", {}, after) : null, retry ? h("button", { onClick: retry }, "Try again") : null);
}
/** The progress bar with "<d> of <n> done" (or "No tasks yet") beside it. */
export function progress(done: number, total: number, o: { small?: boolean } = {}): HTMLElement {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const bar = h("span", { class: "jv-bar-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done) }, h("span", { class: "jv-bar-fill", style: `width:${pct}%` }));
  return h("div", { class: `jv-progress${o.small ? " jv-small" : ""}` }, bar, h("span", { class: "jv-ptext" }, total === 0 ? "No tasks yet" : `${done} of ${total} done`));
}
/** The small outlined "◎ <initiative title>" link a task in an initiative carries. */
export function initiativeLabel(i: { id: string; title: string }): HTMLElement {
  return h("a", { class: "jv-ilabel", href: `#/initiative/${encodeURIComponent(i.id)}`, title: i.title }, `◎ ${i.title}`);
}
