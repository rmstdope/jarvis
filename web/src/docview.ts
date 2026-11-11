/** The body of a document tab: the whole page for a note-like item, a briefing or a presentation. */
import { api, ApiError } from "./api.ts";
import type { Chat, Scope } from "./chat.ts";
import { viewBriefing } from "./pages/briefings.ts";
import { initiativePage } from "./pages/initiative.ts";
import type { Ctx } from "./pages/common.ts";
import type { DocRef } from "./tabs.ts";
import { kindLabel, speakerTurns } from "./transcript.ts";
import { entryLine, fmtDate, h } from "./ui.ts";
import { initiativeLabel, progress, tagPills } from "./pages/common.ts";
import { onInitiativeProgress } from "./initiativeBus.ts";
import { renderMarkdown } from "../../src/briefings/markdown.ts";
import { renderBriefingHtml } from "../../src/briefings/render.ts";
import type { Node as BriefingNode } from "../../src/briefings/parser.ts";

/** What a document view needs from the app around it. */
export interface DocCtx {
  chat: Chat;
  /** The scrolling area the tab sits in. */
  scroller: HTMLElement;
  askAbout(scope: Scope, title: string): void;
  /** Close this document's tab. */
  close(): void;
  /** The real title and kind badge are known once the document has loaded. */
  loaded(title: string, kind: string): void;
  /** True inside the macOS app window (deck links open in place). */
  inApp?: () => boolean;
}
/** A rendered tab body; `ready` settles when the document has loaded (or failed to). */
export interface DocView { el: HTMLElement; ready: Promise<void>; }

const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

/** Split a presentation's MDX body into slides: on `---` lines when present, else before each `## ` heading. */
export function splitSlides(body: string): string[] {
  const inner = body.replace(/<\/?Presentation[^>]*>/g, "").trim();
  if (!inner) return [];
  const parts = /^---\s*$/m.test(inner) ? inner.split(/^---\s*$/m) : inner.split(/^(?=## )/m);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function placeholder(): HTMLElement {
  return h("div", { class: "jv-opening" }, h("div", { class: "jv-skel" }), h("div", { class: "jv-skel" }), h("div", { class: "jv-skel short" }), h("p", { class: "muted small" }, "Opening…"));
}
function stateBox(title: string, sub: string, ctx: DocCtx, retry?: () => void): HTMLElement {
  return h("div", { class: "jv-docstate" }, h("h2", {}, title), h("p", { class: "muted" }, sub),
    h("div", { class: "row" }, retry ? h("button", { class: "primary", onClick: retry }, "Try again") : null, h("button", { onClick: () => ctx.close() }, "Close tab")));
}
function header(kind: string, title: string, actions: (Node | null)[]): { el: HTMLElement; heading: HTMLElement } {
  const heading = h("h1", { class: "jv-dtitle", "data-doc-title": "", tabindex: "-1", title }, title);
  return { heading, el: h("div", { class: "jv-dhead" }, h("span", { class: "jv-dkind" }, kind), heading, h("span", { class: "jv-grow" }), ...actions) };
}

/** Draw the document `ref` into a new element; opens with a placeholder and replaces it with the page or a state. */
export function renderDoc(ref: DocRef, ctx: DocCtx): DocView {
  const el = h("div", { class: "jv-doc" });
  const run = async () => {
    el.replaceChildren(placeholder());
    try {
      const page = ref.type === "initiative" ? await initiativePage(ref.id, ctx) : ref.type === "briefing" ? await briefingPage(ref.id, ctx) : ref.type === "presentation" ? await presentationPage(ref.id, ctx) : await itemPage(ref.id, ctx);
      el.replaceChildren(page.el);
      ctx.loaded(page.title, page.kind);
    } catch (e) {
      el.replaceChildren(e instanceof ApiError && e.status === 404
        ? stateBox("This document isn't here any more.", "It may have been removed, or renamed by a sync.", ctx)
        : stateBox("Couldn't open this document.", "Something went wrong while loading it.", ctx, () => void run()));
    }
  };
  return { el, ready: run() };
}
/** A drawn tab body with the title and kind badge the tab takes. */
export interface DocPage { el: HTMLElement; title: string; kind: string; }
type Page = DocPage;

/** Above a task's title: its initiative and how far that has got, kept current while the initiative's own tab is ticked. */
function initiativeLine(i: { id: string; title: string; done: number; total: number } | undefined): HTMLElement | null {
  if (!i) return null;
  const line = h("div", { class: "jv-iline" }, initiativeLabel(i), progress(i.done, i.total, { small: true }));
  const off = onInitiativeProgress(i.id, (p) => {
    if (!line.isConnected) return off();
    line.lastElementChild!.replaceWith(progress(p.done, p.total, { small: true }));
  });
  return line;
}

async function itemPage(id: string, ctx: DocCtx): Promise<Page> {
  const { item, edges, initiative } = await api.item(id);
  const kind = kindLabel(item.source);
  const meta = item.metadata ?? {};
  const askBtn = h("button", { onClick: () => ctx.askAbout({ type: "item", ids: [item.id] }, item.title) }, "Ask about this");
  const head = header(kind, item.title, [askBtn]);
  const filename = typeof meta.filename === "string" ? meta.filename : undefined;
  let summary: HTMLElement | null = null;
  if (item.source === "meeting") {
    const link = edges.find((e) => e.direction === "in" && e.createdBy === "briefing");
    if (link) { try { const b = await api.briefing(link.otherId); summary = h("section", { class: "jv-dsum brief", html: renderBriefingHtml(b.tree as BriefingNode[]) }); } catch { /* no summary */ } }
  }
  let text: HTMLElement;
  if (!item.body.trim()) text = h("p", { class: "muted" }, "Nothing written here yet.");
  else if (item.source === "meeting") {
    const turns = speakerTurns(item.body);
    text = h("div", { class: "jv-transcript" }, ...turns.map((t) => h("div", { class: "jv-turn" }, t.speaker ? h("div", { class: "jv-who" }, t.speaker) : null, h("p", {}, t.text))));
  } else text = h("div", { class: "body-md jv-text", html: renderMarkdown(item.body) });
  const el = h("div", {}, initiativeLine(initiative), head.el, h("div", { class: "jv-dbody" },
    h("div", { class: "muted small jv-meta" }, entryLine(item.source, item.author, fmtDate(item.created_at))),
    item.source === "pdf" ? h("p", { class: "jv-pdfnote small" }, `Text taken from ${filename ?? item.title} — the original layout and images aren't kept.`, item.source_url && /^https?:\/\//i.test(item.source_url) ? [" ", h("a", { href: safeHref(item.source_url), target: "_blank", rel: "noopener" }, "Open the original ↗")] : null) : null,
    item.source !== "pdf" && item.source_url ? h("p", { class: "small" }, h("a", { href: safeHref(item.source_url), target: "_blank", rel: "noopener" }, item.source_url)) : null,
    tagPills(item.tags),
    item.summary ? h("blockquote", { class: "jv-summary" }, item.summary) : null,
    summary, text,
    h("h3", {}, `Links (${edges.length})`),
    h("ul", { class: "edges" }, ...edges.map((e) => h("li", {}, h("span", { class: "jv-rel" }, e.relation), " ", e.direction === "out" ? "→" : "←", " ", h("a", { href: `#/item/${encodeURIComponent(e.otherId)}` }, e.otherTitle ?? e.otherId), h("span", { class: "muted small" }, ` (${e.createdBy}${e.weight != null ? `, ${e.weight.toFixed(2)}` : ""})`))))));
  return { el, title: item.title, kind };
}

async function briefingPage(id: string, ctx: DocCtx): Promise<Page> {
  const view = h("div", { class: "jv-view" });
  const c: Ctx = { main: view, scroller: ctx.scroller, chat: ctx.chat, rerender: () => {} };
  await viewBriefing(c, id); // the briefing's own Contents / rendered text / Comments layout, as before
  view.querySelector(".jv-trail")?.remove(); // a tab is the whole page: no "Briefings ›" trail
  const title = view.querySelector<HTMLElement>(".jv-title");
  title?.setAttribute("data-doc-title", ""); title?.setAttribute("tabindex", "-1");
  view.querySelector(".jv-titlerow")?.prepend(h("span", { class: "jv-dkind" }, "Briefing"));
  return { el: view, title: title?.textContent ?? id, kind: "Briefing" };
}

async function presentationPage(id: string, ctx: DocCtx): Promise<Page> {
  const p = await api.presentation(id);
  const slides = splitSlides(p.body);
  let i = 0;
  const frame = h("div", { class: "jv-slide", tabindex: "-1" });
  const count = h("span", { class: "jv-count" });
  const prev = h("button", { title: "Previous slide", "aria-label": "Previous slide", onClick: () => go(-1) }, "‹");
  const next = h("button", { title: "Next slide", "aria-label": "Next slide", onClick: () => go(1) }, "›");
  const stage = h("div", { class: "jv-stage" }, frame, h("div", { class: "jv-snav" }, prev, count, next), h("div", { class: "jv-esc muted small" }, "Esc to leave"));
  const draw = () => {
    frame.replaceChildren();
    if (!slides.length) frame.append(h("p", { class: "muted" }, "This presentation has no slides yet."));
    else { try { frame.innerHTML = renderMarkdown(slides[i]); } catch { frame.replaceChildren(h("p", { class: "muted" }, "This slide couldn't be shown.")); } }
    count.textContent = slides.length ? `${i + 1} / ${slides.length}` : "";
    prev.toggleAttribute("disabled", i === 0); next.toggleAttribute("disabled", i >= slides.length - 1);
  };
  const go = (d: number) => { i = Math.max(0, Math.min(slides.length - 1, i + d)); draw(); };
  const leave = () => stage.classList.remove("jv-presenting");
  stage.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    const ke = e as KeyboardEvent;
    if (ke.ctrlKey || ke.altKey || ke.metaKey) return; // tab-switching shortcuts pass through
    if (k === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (k === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (k === "Escape" && stage.classList.contains("jv-presenting")) { e.preventDefault(); e.stopPropagation(); leave(); }
  });
  const present = h("button", { onClick: () => { stage.classList.add("jv-presenting"); stage.tabIndex = -1; stage.focus(); } }, "Present");
  const viewer = p.viewer.status === "ready" && p.viewer.launchUrl ? h("a", { href: p.viewer.launchUrl, target: ctx.inApp?.() ? "_self" : "_blank", rel: "noopener" }, h("button", { class: "primary" }, "Present in deck viewer")) : null;
  const head = header("Presentation", p.title, [present, viewer, h("button", { onClick: () => ctx.askAbout({ type: "item", ids: [p.slug] }, p.title) }, "Ask about this")]);
  draw();
  return { el: h("div", {}, head.el, h("div", { class: "jv-dbody" }, h("div", { class: "muted small jv-meta" }, `${p.slug} · added ${fmtDate(p.created_at)} by ${p.author}`), stage)), title: p.title, kind: "Presentation" };
}
