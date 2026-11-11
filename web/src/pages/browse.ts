/** Browse & search: the search box, the four filters, and either the two "Recently" lists or the results. */
import { api, type BrowseResult, type ItemSummary, type Page as PageInfo, type SearchHit } from "../api.ts";
import { clear, entryLine, fmtDate, h, highlightSnippet, itemHref, sinceIso } from "../ui.ts";
import { getJson, KEY_BROWSE, setJson } from "../prefs.ts";
import { type Ctx, emptyBox, entryCard, errorBox, heading, initiativeLabel, type Page, skeleton } from "./common.ts";
import { initiativeCard } from "./initiatives.ts";

type Key = "source" | "author" | "tag" | "days";
const fresh = () => ({ q: "", mode: "hybrid", source: "", author: "", tag: "", days: "", addedOffset: 0, updatedOffset: 0 });
/** What the page shows; storage is the truth (read when the page opens) so a reload and the trail bring it back as left. */
let state = fresh();
const save = () => setJson(KEY_BROWSE, state);
/** Forget search, filters and paging (used when a shortcut opens Browse on one source). */
export function resetBrowse(over: Partial<ReturnType<typeof fresh>> = {}): void { state = { ...fresh(), ...over }; save(); }

const KINDS: [string, string][] = [["hybrid", "Best match"], ["semantic", "By meaning"], ["keyword", "Exact words"]];
const TIMES: [string, string][] = [["1", "Last day"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["365", "Last year"]];

const card = (i: ItemSummary) => i.source === "initiative" && i.progress
  ? initiativeCard({ id: i.id, title: i.title, updated_at: i.updated_at ?? i.created_at, ...i.progress })
  : entryCard({ href: itemHref(i), title: i.title || "(untitled)", details: entryLine(i.source, i.author, fmtDate(i.created_at)), pill: i.initiative ? initiativeLabel(i.initiative) : null, summary: i.summary, tags: i.tags });
const hitCard = (x: SearchHit) => {
  if (x.source === "initiative" && x.progress) return initiativeCard({ id: x.docId, title: x.title, ...x.progress }); // its goal is the summary: no snippet repeating it
  const c = entryCard({ href: itemHref({ id: x.docId, source: x.source }), title: x.title || x.docId, details: entryLine(x.source, x.author, x.createdAt ? fmtDate(x.createdAt) : null), pill: x.initiative ? initiativeLabel(x.initiative) : null });
  c.append(h("div", { class: "jv-s jv-snip", html: highlightSnippet(x.snippet) }));
  return c;
};

/** The Browse & search page. */
export async function viewBrowse(ctx: Ctx): Page {
  state = getJson(KEY_BROWSE, fresh());
  const input = h("input", { type: "search", placeholder: "Search J.A.R.V.I.S.…", "aria-label": "Search", value: state.q });
  const clearBtn = h("button", { type: "button", class: "jv-x", title: "Clear the search", "aria-label": "Clear the search", onClick: () => { state.q = ""; state.addedOffset = state.updatedOffset = 0; input.value = ""; save(); paintClear(); void load(); input.focus(); } }, "✕");
  const kind = h("select", { class: "jv-kind", "aria-label": "Search kind", onChange: () => { state.mode = kind.value; save(); if (state.q) void load(); } }, ...KINDS.map(([v, l]) => h("option", { value: v }, l)));
  kind.value = state.mode;
  const paintClear = () => { clearBtn.hidden = !state.q; };
  const bar = h("form", { class: "jv-searchbar", onSubmit: (e: Event) => { e.preventDefault(); state.q = input.value.trim(); state.addedOffset = state.updatedOffset = 0; save(); paintClear(); void load(); } }, input, clearBtn, kind);
  paintClear();
  const filters = h("div", { class: "jv-filters" });
  const lists = h("div", { class: "jv-lists" });
  ctx.main.append(heading("Browse & search"), bar, filters, lists);

  const pill = (label: string, key: Key, opts: { value: string; label: string }[]) => {
    if (state[key] && !opts.some((o) => o.value === state[key])) opts = [...opts, { value: state[key], label: state[key] }]; // a stored filter keeps showing even when the library no longer has it
    const s = h("select", { class: "jv-fp", "aria-label": label, onChange: () => { state[key] = s.value; state.addedOffset = state.updatedOffset = 0; save(); void load(); } }, h("option", { value: "" }, label), ...opts.map((o) => h("option", { value: o.value }, o.label)));
    s.value = state[key];
    s.classList.toggle("on", !!s.value);
    return s;
  };
  const pager = (key: "addedOffset" | "updatedOffset", p: { offset: number; limit: number; total: number; hasMore: boolean }) =>
    h("div", { class: "jv-pager" }, `${p.total ? p.offset + 1 : 0}–${Math.min(p.offset + p.limit, p.total)} of ${p.total}`, h("span", { class: "jv-sp" }),
      h("button", { disabled: p.offset === 0, onClick: () => { state[key] = Math.max(0, p.offset - p.limit); save(); void load(); } }, "‹ Previous"),
      h("button", { disabled: !p.hasMore, onClick: () => { state[key] = p.offset + p.limit; save(); void load(); } }, "Next ›"));

  let seq = 0;
  let facets: BrowseResult["facets"] | null = null;
  const paintFilters = (f: BrowseResult["facets"]) => {
    const counted = (xs: { value: string; count: number }[]) => xs.map((x) => ({ value: x.value, label: `${x.value} (${x.count})` }));
    clear(filters);
    filters.append(pill("All sources", "source", counted(f.sources)), pill("All contributors", "author", counted(f.authors)), pill("All tags", "tag", counted(f.tags)), pill("Any time", "days", TIMES.map(([value, label]) => ({ value, label }))));
  };
  async function load(): Promise<void> {
    const mine = ++seq;
    clear(lists);
    lists.append(skeleton());
    const body = h("div");
    const filter = { source: state.source, author: state.author, tag: state.tag, since: state.days ? sinceIso(Number(state.days)) : undefined };
    try {
      let b: BrowseResult | null = null;
      if (state.q) {
        const hits = await api.search(state.q, state.mode, 20, filter);
        if (!facets) facets = await api.browse({ limit: 1 }).then((r) => r.facets, () => ({ sources: [], authors: [], tags: [] }));
        if (mine !== seq) return;
        body.append(...(hits.length ? [h("h2", { class: "jv-sh" }, hits.length === 1 ? "1 result" : `${hits.length} results`), ...hits.map(hitCard)] : [emptyBox(`No matches for “${state.q}”.`, "Try fewer or different words, or switch the search to Exact words.")]));
      } else {
        b = await api.browse({ limit: 20, addedOffset: state.addedOffset, updatedOffset: state.updatedOffset, ...filter });
        if (mine !== seq) return;
        // A stored page past the end (the library shrank) goes back to the first page instead of showing a false empty state.
        const past = (key: "addedOffset" | "updatedOffset", p: PageInfo) => state[key] > 0 && p.total > 0 && p.total <= state[key];
        if (past("addedOffset", b.pagination.added) || past("updatedOffset", b.pagination.updated)) {
          if (past("addedOffset", b.pagination.added)) state.addedOffset = 0;
          if (past("updatedOffset", b.pagination.updated)) state.updatedOffset = 0;
          save();
          return load();
        }
        facets = b.facets;
      }
      paintFilters(facets!);
      if (b) {
        const filtered = !!(state.source || state.author || state.tag || state.days);
        const col = (name: string, rows: ItemSummary[], empty: HTMLElement, key: "addedOffset" | "updatedOffset", p: BrowseResult["pagination"]["added"]) =>
          h("section", {}, h("h2", { class: "jv-sh" }, name), ...(rows.length ? [...rows.map(card), pager(key, p)] : [empty]));
        if (filtered && !b.added.length && !b.updated.length) {
          // Filters are why nothing shows: one message with a way out, not the empty-library one.
          const reset = () => { state.source = state.author = state.tag = state.days = ""; state.addedOffset = state.updatedOffset = 0; save(); void load(); input.focus(); };
          body.append(emptyBox("Nothing matches these filters.", "Remove a filter to see more.", h("div", {}, h("button", { class: "primary", onClick: reset }, "Clear filters"))));
        } else {
          const capture = h("div", {}, h("button", { class: "primary", onClick: () => { location.hash = "#/capture"; } }, "＋ Capture"));
          body.append(h("div", { class: "jv-two" },
            col("Recently added", b.added, filtered ? emptyBox("Nothing added matches these filters.") : emptyBox("Nothing captured yet.", "Save a note or a link and it shows up here.", capture), "addedOffset", b.pagination.added),
            col("Recently updated", b.updated, emptyBox(filtered ? "Nothing updated matches these filters." : "Nothing updated yet."), "updatedOffset", b.pagination.updated)));
        }
      }
    } catch (e) {
      if (mine !== seq) return;
      clear(lists);
      lists.append(errorBox("Couldn't load this page.", (e as Error).message, () => void load()));
      return;
    }
    if (mine !== seq) return;
    clear(lists);
    lists.append(body);
  }
  await load();
  return () => input.focus();
}
