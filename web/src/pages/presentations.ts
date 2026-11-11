/** Presentations: the list, and one presentation with its Present button. */
import { api, ApiError } from "../api.ts";
import { entryLine, fmtDate, h } from "../ui.ts";
import { type Ctx, emptyBox, entryCard, heading, inApp, type Page, statusPill, trail } from "./common.ts";

/** The Presentations list. */
export async function viewPresentations(ctx: Ctx): Page {
  ctx.main.append(heading("Presentations"));
  try {
    const list = await api.presentations();
    ctx.main.append(...(list.length ? list.map((p) => entryCard({ href: `#/presentation/${p.slug}`, title: p.title, details: entryLine(p.slug, p.author, fmtDate(p.created_at)), pill: statusPill(p.indexed ? "in search" : "not yet in search", p.indexed ? "g" : "n") })) : [emptyBox("No presentations yet.")]));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) ctx.main.append(emptyBox("Presentations aren't available in this version of J.A.R.V.I.S. yet."));
    else throw e;
  }
}

const NOT_READY: Record<string, string> = { "content-not-mounted": "The deck viewer can't see your team's files." };

/** One presentation. */
export async function viewPresentation(ctx: Ctx, id: string): Page {
  const p = await api.presentation(id);
  const ready = p.viewer.status === "ready" && !!p.viewer.launchUrl;
  const present = ready
    ? h("a", { class: "jv-btn primary jv-wide", href: p.viewer.launchUrl, target: inApp() ? "_self" : "_blank", rel: "noopener" }, "▶ Present")
    : h("div", { class: "muted small" }, NOT_READY[p.viewer.status] ?? "The deck viewer isn't running.");
  const code = h("pre", { class: "jv-code" }, h("code", {}, p.body));
  const fold = h("button", { class: "jv-srcfold", "aria-expanded": "false", onClick: () => { const open = fold.getAttribute("aria-expanded") !== "true"; fold.setAttribute("aria-expanded", String(open)); fold.textContent = open ? "▾ Hide source" : "▸ Show source"; code.hidden = !open; } }, "▸ Show source");
  code.hidden = true;
  ctx.main.append(trail("Presentations", "#/presentations", p.title), h("div", { class: "jv-read" },
    h("div", { class: "jv-view" }, h("h1", { class: "jv-title" }, p.title), h("div", { class: "jv-meta" }, `${p.slug} · added ${fmtDate(p.created_at)} by ${p.author}`),
      ready ? h("p", { class: "jv-prose" }, "Press Present to show it full screen in the deck viewer.") : null, fold, code),
    h("aside", { class: "jv-panel" }, present, h("div", { class: "jv-blk" }, h("h5", {}, "In search"), h("div", {}, p.indexed ? "yes" : "not yet")))));
}
