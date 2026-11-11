/** Briefings: the list, and one briefing in three columns (Contents, text, Comments). */
import { api, type Comment } from "../api.ts";
import { renderBriefingHtml } from "../../../src/briefings/render.ts";
import type { Node as BriefingNode } from "../../../src/briefings/parser.ts";
import { PHONE_MAX, TABLET_MAX } from "../shell.ts";
import { append, clear, entryLine, fmtDate, h, toast } from "../ui.ts";
import { getJson, KEY_BRIEF_COLS, KEY_BRIEF_LIST, setJson } from "../prefs.ts";
import { type Ctx, emptyBox, entryCard, heading, type Page, statusPill, trail } from "./common.ts";

type Sort = "updated" | "created" | "title";
const freshList = () => ({ filter: "", sort: "updated" as Sort });
let list = freshList();
const SORTS: [Sort, string][] = [["updated", "Sort: Last updated"], ["created", "Sort: Newest"], ["title", "Sort: Title"]];
const tone = (status: string) => (status === "approved" || status === "done" ? "g" : status === "draft" || status === "open" ? "a" : "n");

/** The Briefings list. */
export async function viewBriefings(ctx: Ctx): Page {
  list = getJson(KEY_BRIEF_LIST, freshList());
  const all = await api.briefings();
  const box = h("div");
  const filter = h("input", { type: "search", placeholder: "Filter…", "aria-label": "Filter", value: list.filter, onInput: () => { list.filter = filter.value; setJson(KEY_BRIEF_LIST, list); draw(); } });
  const sort = h("select", { class: "jv-fp", "aria-label": "Sort", onChange: () => { list.sort = sort.value as Sort; setJson(KEY_BRIEF_LIST, list); draw(); } }, ...SORTS.map(([v, l]) => h("option", { value: v }, l)));
  sort.value = list.sort;
  ctx.main.append(heading("Briefings"), h("div", { class: "jv-bar" }, filter, sort), box);
  function draw(): void {
    clear(box);
    const q = list.filter.trim().toLowerCase();
    const rows = all.filter((b) => !q || b.title.toLowerCase().includes(q) || (b.subtitle ?? "").toLowerCase().includes(q) || (b.tags ?? []).some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => list.sort === "title" ? a.title.localeCompare(b.title) : list.sort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt));
    if (!rows.length) {
      box.append(all.length ? emptyBox(`No briefings match “${list.filter.trim()}”.`) : emptyBox("No briefings yet.", undefined, h("div", {}, "Create one with ", h("code", {}, "jarvis briefing create --title …"))));
      return;
    }
    append(box, rows.map((b) => entryCard({ href: `#/briefing/${b.id}`, title: b.title, details: entryLine(b.kind, b.author, `updated ${fmtDate(b.updatedAt)}`), pill: b.status ? statusPill(b.status, tone(b.status)) : null, summary: b.subtitle, tags: b.tags })));
  }
  draw();
  return () => filter.focus();
}

type Col = "contents" | "comments";
const COL = { contents: { icon: "☰", name: "Contents", fold: "⇤", hide: "Hide contents", show: "Show contents" }, comments: { icon: "💬", name: "Comments", fold: "⇥", hide: "Hide comments", show: "Show comments" } } as const;

/** One briefing. */
export async function viewBriefing(ctx: Ctx, id: string): Page {
  const [b, comments] = await Promise.all([api.briefing(id), api.comments(id)]);
  const html = renderBriefingHtml(b.tree as BriefingNode[]);
  const toc = b.toc ?? [];
  const hidden = getJson(KEY_BRIEF_COLS, { contents: false, comments: false });
  let open: Col | null = null; // the slide-over, on narrow windows
  let narrow = matchMedia(`(max-width: ${TABLET_MAX}px)`).matches, phone = matchMedia(`(max-width: ${PHONE_MAX}px)`).matches;
  let count = comments.length;
  const cols: Col[] = toc.length ? ["contents", "comments"] : ["comments"];

  const article = h("article", { class: "jv-brief jv-prose", html, onClick: () => { if (open) close(); } });
  const links = toc.map((t) => h("a", { href: `#/briefing/${id}#${t.slug}`, class: t.level >= 3 ? "l3" : "", onClick: (e: Event) => { e.preventDefault(); activate(t.slug); article.querySelector(`[id="${t.slug}"]`)?.scrollIntoView?.({ behavior: "smooth" }); } }, t.text));
  function activate(slug: string): void { toc.forEach((t, i) => links[i].classList.toggle("on", t.slug === slug)); }
  if (toc.length) activate(toc[0].slug);
  ctx.scroller.addEventListener("scroll", () => {
    const top = ctx.scroller.getBoundingClientRect().top + 90;
    let cur = toc[0]?.slug;
    for (const t of toc) { const el = article.querySelector(`[id="${t.slug}"]`); if (el && el.getBoundingClientRect().top <= top) cur = t.slug; }
    if (cur) activate(cur);
  });

  const fold = (c: Col) => h("button", { class: "jv-cfold", "data-col": c, onClick: () => (narrow ? close() : setHidden(c, true)) });
  const strip = (c: Col) => h("button", { class: "jv-strip", "data-col": c, onClick: () => (narrow ? openCol(c) : setHidden(c, false)) });
  const folds = { contents: fold("contents"), comments: fold("comments") };
  const strips = { contents: strip("contents"), comments: strip("comments") };
  const phoneBtns = { contents: h("button", { class: "jv-pbtn", "data-col": "contents", onClick: () => openCol("contents") }, "☰ Contents"), comments: h("button", { class: "jv-pbtn", "data-col": "comments", onClick: () => openCol("comments") }) };

  const rail = h("div", { class: "jv-cm-body" });
  const drawComments = (cs: Comment[]): void => {
    count = cs.length;
    clear(rail);
    const ta = h("textarea", { rows: 3, placeholder: "Add a comment…", "aria-label": "Add a comment…" });
    const problem = h("div");
    rail.append(
      h("div", { class: "jv-cm-list" }, ...(cs.length ? cs.map((c) => h("div", { class: "jv-cmt" }, h("div", { class: "jv-m" }, `${c.author ?? "anonymous"} · ${fmtDate(c.createdAt)} `, statusPill(c.status, tone(c.status))), h("div", {}, c.comment))) : [h("div", { class: "muted small" }, "No comments yet — be the first.")])),
      h("form", { onSubmit: async (e: Event) => {
        e.preventDefault();
        if (!ta.value.trim()) return;
        try { await api.addComment(id, ta.value.trim()); drawComments(await api.comments(id)); toast("Comment added"); }
        catch (err) { problem.replaceChildren(h("div", { class: "jv-err" }, (err as Error).message)); }
      } }, ta, problem, h("button", { class: "primary" }, "Post")));
    paint();
  };
  const colEl = (c: Col, body: Node) => h("aside", { class: `jv-col jv-col-${c}` }, h("div", { class: "jv-colh" }, h("h3", { class: "jv-sh" }, c === "contents" ? "Contents" : `Comments · ${count}`), folds[c]), body);
  const contentsCol = colEl("contents", h("nav", { class: "jv-toc" }, ...links));
  const commentsCol = colEl("comments", rail);
  const colOf = { contents: contentsCol, comments: commentsCol };

  const shown = (c: Col): boolean => (narrow ? open === c : !hidden[c]);
  function paint(): void {
    wrap.classList.toggle("jv-narrow", narrow);
    wrap.classList.toggle("jv-phone", phone);
    for (const c of cols) {
      const on = shown(c);
      colOf[c].hidden = !on;
      colOf[c].classList.toggle("jv-over", narrow && on);
      strips[c].hidden = on || phone;
      phoneBtns[c].hidden = !phone;
      const label = COL[c];
      const f = folds[c];
      f.textContent = narrow ? "✕" : label.fold;
      f.title = narrow ? "Close" : label.hide;
      f.setAttribute("aria-label", f.title);
      strips[c].title = label.show;
      strips[c].setAttribute("aria-label", label.show);
      strips[c].replaceChildren(h("span", { class: "jv-ic" }, label.icon + (c === "comments" ? ` ${count}` : "")), h("span", { class: "jv-vert" }, label.name));
    }
    phoneBtns.comments.textContent = `💬 Comments · ${count}`;
    const head = commentsCol.querySelector(".jv-sh");
    if (head) head.textContent = `Comments · ${count}`;
  }
  function setHidden(c: Col, v: boolean): void { hidden[c] = v; setJson(KEY_BRIEF_COLS, hidden); paint(); (v ? strips[c] : folds[c]).focus(); }
  function openCol(c: Col): void { open = c; paint(); folds[c].focus(); }
  function close(): void { const c = open; open = null; paint(); if (c) (phone ? phoneBtns[c] : strips[c]).focus(); }

  const grid = h("div", { class: "jv-bgrid" },
    cols.includes("contents") ? [strips.contents, contentsCol] : null, article, strips.comments, commentsCol);
  const titleRow = h("div", { class: "jv-titlerow" }, h("h1", { class: "jv-title" }, b.title), b.status ? statusPill(b.status, tone(b.status)) : null,
    toc.length ? phoneBtns.contents : null, phoneBtns.comments, h("button", { onClick: () => ctx.chat.askAbout({ type: "briefing", ids: [id] }, b.title) }, "Ask about this"));
  const wrap = h("div", { class: "jv-bwrap", onKeydown: (e: KeyboardEvent) => { if (e.key === "Escape" && open) { e.preventDefault(); close(); } } },
    trail("Briefings", "#/briefings", b.title), titleRow, h("div", { class: "jv-meta" }, entryLine(b.kind, b.author, `updated ${fmtDate(b.updatedAt)}`)), b.subtitle ? h("div", { class: "jv-sub muted" }, b.subtitle) : null, grid);
  drawComments(comments);
  const mqT = matchMedia(`(max-width: ${TABLET_MAX}px)`), mqP = matchMedia(`(max-width: ${PHONE_MAX}px)`);
  let seen = false;
  const read = () => {
    if (seen && !wrap.isConnected) { mqT.removeEventListener("change", read); mqP.removeEventListener("change", read); return; }
    seen = seen || wrap.isConnected;
    narrow = mqT.matches; phone = mqP.matches; if (!narrow) open = null; paint(); };
  mqT.addEventListener("change", read);
  mqP.addEventListener("change", read);
  read();
  ctx.main.append(wrap);
}
