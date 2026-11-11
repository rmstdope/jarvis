/** The Initiatives page: filters and a card per initiative with its progress. */
import { api, type InitiativeCard } from "../api.ts";
import { clear, entryLine, fmtDate, h } from "../ui.ts";
import { getJson, KEY_INITIATIVES, setJson } from "../prefs.ts";
import { type Ctx, emptyBox, entryCard, heading, type Page, progress, skeleton, statusPill } from "./common.ts";

/** The card of one initiative (the list and Browse & search both use it). */
export function initiativeCard(i: { id: string; title: string; goal?: string | null; owner: string; status: "open" | "closed"; done: number; total: number; updated_at?: string | null; closed_at?: string }, from?: "browse"): HTMLElement {
  const closed = i.status === "closed";
  const card = entryCard({ href: `#/initiative/${encodeURIComponent(i.id)}${from ? `?from=${from}` : ""}`, title: i.title, details: entryLine("initiative", i.owner, closed ? `closed ${fmtDate(i.closed_at)}` : i.updated_at ? `updated ${fmtDate(i.updated_at)}` : null), summary: i.goal, pill: !closed && i.total > 0 && i.done === i.total ? statusPill("✓ All tasks done — close it?", "g") : null });
  card.classList.toggle("jv-dim", closed);
  card.append(progress(i.done, i.total));
  return card;
}

const START = 'jarvis initiative add “<title>” --goal “<what done looks like>”';

/** The Initiatives page. */
export async function viewInitiatives(ctx: Ctx): Page {
  const state = getJson(KEY_INITIATIVES, { status: "open", owner: "" });
  const save = () => setJson(KEY_INITIATIVES, state);
  const all = (await api.initiatives("all")).initiatives;
  const owners = [...new Set(all.map((i) => i.owner))].sort();
  if (state.owner && !owners.includes(state.owner)) owners.push(state.owner); // a stored owner keeps showing
  const list = h("div", { class: "jv-lists" });
  const pill = (label: string, key: "status" | "owner", opts: [string, string][]) => {
    const s = h("select", { class: "jv-fp", "aria-label": label, onChange: () => { state[key] = s.value; save(); paint(); s.classList.toggle("on", key === "owner" && !!s.value); } }, ...opts.map(([v, l]) => h("option", { value: v }, l)));
    s.value = state[key];
    s.classList.toggle("on", key === "owner" && !!s.value);
    return s;
  };
  const filters = h("div", { class: "jv-filters" },
    pill("Status", "status", [["open", "Open"], ["closed", "Closed"], ["all", "All"]]),
    pill("Owner", "owner", [["", "All owners"], ...owners.map((o): [string, string] => [o, o])]));
  const paint = () => {
    clear(list);
    const byStatus = all.filter((i) => state.status === "all" || i.status === state.status);
    const shown = byStatus.filter((i) => !state.owner || i.owner === state.owner).sort((a: InitiativeCard, b: InitiativeCard) => b.updated_at.localeCompare(a.updated_at));
    if (shown.length) list.append(...shown.map((i) => initiativeCard(i)));
    else if (state.status === "closed" && byStatus.length === 0) list.append(emptyBox("No closed initiatives."));
    else if (all.length === 0) list.append(emptyBox("No initiatives yet.", undefined, h("div", {}, "Start one with ", h("code", {}, START))));
    else list.append(emptyBox(byStatus.length === 0 ? "No open initiatives." : "No initiatives match these filters."));
  };
  paint();
  ctx.main.append(heading("Initiatives"), filters, list);
}
