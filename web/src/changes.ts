/** The change card: what the agent changed in one answer, each row with its Undo. Pure rendering; the chat owns the calls. */
import { h, type Child } from "./ui.ts";

/** One change as the service reports it (mirrors `src/chat/changes.ts`; the web never imports core). */
export interface WebChange {
  id: string;
  turn: string;
  kind: string;
  ok: boolean;
  items: { id: string; title: string; kind: "doc" | "task" | "initiative" | "briefing" | "presentation" }[];
  detail?: { from?: string; to?: string; relation?: string };
  draft?: { kind: "briefing" | "presentation"; sections: string[]; sources: number; slides?: number };
  error?: string;
  verb?: string;
  undone: boolean;
  undoable: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Nov" (with the year when it is not this year); "none" for no date. */
export function shortDate(iso: string | undefined, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return iso || "none";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${Number(m[1]) === now.getFullYear() ? "" : ` ${m[1]}`}`;
}
const RELATION: Record<string, string> = { related: "relates to", same_topic: "same topic", follows_up: "follows up" };
export const relationWords = (r: string | undefined): string => RELATION[r ?? ""] ?? (r ?? "relates to");

/** Where an item's title links to. */
export function itemHref(i: WebChange["items"][number]): string {
  return i.kind === "briefing" ? `#/briefing/${encodeURIComponent(i.id)}` : i.kind === "presentation" ? `#/presentation/${encodeURIComponent(i.id)}` : `#/item/${encodeURIComponent(i.id)}`;
}

/** "I made 2 changes · 1 failed" and its variants. */
export function heading(changes: WebChange[]): string {
  const made = changes.filter((c) => c.ok);
  const failed = changes.length - made.length;
  let t = `I made ${made.length} ${made.length === 1 ? "change" : "changes"}`;
  if (failed) t += ` · ${failed} failed`;
  if (made.length && made.every((c) => c.undone)) t += " · all undone";
  return t;
}
/** The number of changes made and not undone (what New chat warns about). */
export const keptCount = (changes: WebChange[]): number => changes.filter((c) => c.ok && c.undoable && !c.undone).length;

const KIND_WORD: Record<string, string> = { "capture.note": "note", "capture.link": "link", "capture.file": "file", "capture.meeting": "meeting" };
/** The sentence of a row, the item titles as links (plain text when `plain`, as in an undone row). */
export function sentence(c: WebChange, opts: { me?: string; now?: Date; plain?: boolean } = {}): Child[] {
  const t = (i: number): Child => (opts.plain || !c.items[i] ? c.items[i]?.title : h("a", { href: itemHref(c.items[i]), title: c.items[i].title }, c.items[i].title));
  const who = (v: string | undefined) => v ?? "none"; // the service already says "you" for the user
  if (!c.ok) return [`Couldn't ${c.verb ?? "do that"}`, ...(c.items[0] ? [" ", h("i", {}, c.items[0].title)] : []), ` — ${c.error ?? "something went wrong"}.`];
  const d = c.detail ?? {};
  switch (c.kind) {
    case "task.create": return ["Created task ", t(0)];
    case "initiative.create": return ["Created initiative ", t(0)];
    case "initiative.title": return ["Changed initiative ", t(0), `: title ${who(d.from)} → ${who(d.to)}`];
    case "initiative.owner": return ["Changed initiative ", t(0), `: owner ${who(d.from)} → ${who(d.to)}`];
    case "initiative.goal": return ["Changed initiative ", t(0), ": goal changed"];
    case "task.done": return ["Marked task ", t(0), " done"];
    case "task.reopen": return ["Reopened task ", t(0)];
    case "task.due": return ["Changed task ", t(0), `: due ${shortDate(d.from, opts.now)} → ${shortDate(d.to, opts.now)}`];
    case "task.owner": return ["Changed task ", t(0), `: owner ${who(d.from)} → ${who(d.to)}`];
    case "task.move": return ["Moved task ", t(0), d.to ? ` to initiative ${d.to}` : " out of its initiative"];
    case "link": return ["Linked ", t(0), " to ", t(1), ` · ${relationWords(d.relation)}`];
    case "draft.briefing": return ["Drafted briefing ", t(0)];
    case "draft.presentation": return ["Drafted presentation ", t(0)];
    default: return [`Captured ${KIND_WORD[c.kind] ?? "item"} `, t(0)];
  }
}

export interface CardHandlers { onUndo(c: WebChange): void; onUndoAll(): void }
/** The card for one answer, or null when it changed nothing. `key` ties the Undo all button to its message for focus. */
export function drawCard(changes: WebChange[], key: string, hd: CardHandlers, opts: { me?: string; now?: Date } = {}): HTMLElement | null {
  if (!changes.length) return null;
  const rows = changes.map((c) => {
    const mark = !c.ok ? "✗" : c.undone ? "↺" : "✓";
    const text = h("span", { class: "jv-crow-t" }, ...sentence(c, { ...opts, plain: c.undone }));
    const tail: Child = c.undone ? h("span", { class: "jv-crow-undone" }, "Undone") : c.ok && c.undoable ? h("button", { class: "jv-crow-undo", "data-undo": c.id, onClick: () => hd.onUndo(c) }, "Undo") : null;
    const row = h("div", { class: `jv-crow${!c.ok ? " jv-cfail" : c.undone ? " jv-cundone" : ""}` }, h("span", { class: "jv-crow-m", "aria-hidden": "true" }, mark), text, tail);
    const dr = c.ok && !c.undone ? c.draft : undefined;
    if (!dr) return row;
    const head = dr.kind === "briefing" ? `BRIEFING · DRAFT · ${dr.sections.length} sections · ${dr.sources} sources` : `PRESENTATION · DRAFT · ${dr.slides ?? dr.sections.length} slides · ${dr.sources} sources`;
    return h("div", { class: "jv-crow-wrap" }, row, h("div", { class: "jv-draft" }, h("div", { class: "jv-draft-k" }, head), h("div", { class: "jv-draft-t" }, c.items[0].title), h("div", { class: "jv-draft-s" }, dr.sections.join(" · ")), h("a", { class: "jv-btn primary jv-draft-open", href: itemHref(c.items[0]) }, "Open draft")));
  });
  const anyLeft = changes.some((c) => c.ok && c.undoable && !c.undone);
  return h("div", { class: "jv-changes" }, h("h4", {}, heading(changes)), ...rows, anyLeft ? h("div", { class: "jv-changes-foot" }, h("button", { class: "jv-undoall", "data-undoall": key, onClick: () => hd.onUndoAll() }, "Undo all")) : null);
}
