/** Presentations: the list (one presentation opens as a tab, see docview.ts). */
import { api, ApiError } from "../api.ts";
import { entryLine, fmtDate, h } from "../ui.ts";
import { type Ctx, emptyBox, entryCard, heading, type Page, statusPill } from "./common.ts";

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
