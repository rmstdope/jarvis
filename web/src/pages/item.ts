/** One item: the trail, the text, and a details panel (Ask about this, Source, Tags, Links). */
import { api } from "../api.ts";
import { renderMarkdown } from "../../../src/briefings/markdown.ts";
import { entryLine, fmtDate, h } from "../ui.ts";
import { type Ctx, type Page, progress, tagPills, trail } from "./common.ts";

const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

/** The item page; a missing item throws the 404 the router turns into the "couldn't find that" box. */
export async function viewItem(ctx: Ctx, id: string, from?: string): Page {
  const { item, edges, initiative } = await api.item(id);
  const block = (name: string, ...body: (Node | string | null)[]) => h("div", { class: "jv-blk" }, h("h5", {}, name), ...body);
  const panel = h("aside", { class: "jv-panel" },
    h("button", { class: "primary jv-wide", onClick: () => ctx.chat.askAbout({ type: "item", ids: [item.id] }, item.title) }, "Ask about this"),
    initiative ? block("Initiative", h("a", { href: `#/initiative/${encodeURIComponent(initiative.id)}`, title: initiative.title }, initiative.title), progress(initiative.done, initiative.total, { small: true })) : null,
    item.source_url ? block("Source", h("a", { href: safeHref(item.source_url), target: "_blank", rel: "noopener", title: item.source_url }, item.source_url)) : null,
    item.tags?.length ? block("Tags", tagPills(item.tags)) : null,
    block(`Links · ${edges.length}`, ...(edges.length ? edges.map((e) => h("div", { class: "jv-lk" }, h("span", { class: "jv-rel" }, e.relation), h("a", { href: `#/item/${e.otherId}`, title: e.otherTitle ?? e.otherId }, e.otherTitle ?? e.otherId))) : [h("div", { class: "muted small" }, "No links yet.")])));
  ctx.main.append(initiative && from === initiative.id ? trail(initiative.title, `#/initiative/${encodeURIComponent(initiative.id)}`, item.title) : trail("Browse & search", "#/browse", item.title), h("div", { class: "jv-read" },
    h("article", {}, h("h1", { class: "jv-title" }, item.title), h("div", { class: "jv-meta" }, entryLine(item.source, item.author, fmtDate(item.created_at))),
      item.summary ? h("blockquote", { class: "jv-summary" }, item.summary) : null,
      h("div", { class: "jv-prose body-md", html: renderMarkdown(item.body) })),
    panel));
}
