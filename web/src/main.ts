import { api, ApiError, type ItemSummary, type SearchHit } from "./api.ts";
import { append, clear, fmtDate, h, itemHref, metaLine, modal, parseRoute, sinceIso, toast } from "./ui.ts";
import { renderMarkdown } from "../../src/briefings/markdown.ts";
import { renderBriefingHtml } from "../../src/briefings/render.ts";
import type { Node as BriefingNode } from "../../src/briefings/parser.ts";
import { createChat, type Chat } from "./chat.ts";
import { applyTheme, getPref, getTheme, KEY_LAST_SYNC, KEY_SYNC_SKIP, setPref } from "./prefs.ts";
import { createShell, type Shell } from "./shell.ts";

declare global {
  interface Window { __JARVIS_APP__?: boolean; }
}
const inApp = () => window.__JARVIS_APP__ === true;

// ---- chrome ----
let page: HTMLElement;
let main: HTMLElement; // where the current page draws
let shell: Shell;
let chat: Chat;

async function confirmSync() {
  if (getPref(KEY_SYNC_SKIP) === "1") return runSync();
  const cb = h("input", { type: "checkbox" });
  modal("Sync with the team?", h("div", {}, h("p", {}, "This commits your captures, pulls teammates' changes, runs enrichment and pushes."), h("label", { class: "row small" }, cb, " Do not show again")), [
    { label: "Cancel", onClick: () => {} },
    { label: "Sync", primary: true, onClick: () => { if (cb.checked) setPref(KEY_SYNC_SKIP, "1"); void runSync(); } },
  ], "Sync");
}
function lastSyncState() {
  const at = Number(getPref(KEY_LAST_SYNC));
  return at > 0 ? { kind: "ok" as const, at } : { kind: "never" as const };
}
async function runSync() {
  shell.setSync({ kind: "syncing" });
  let failed = false;
  try {
    const r = await api.sync();
    if (r.conflicted.length) { failed = true; toast(`Sync stopped: resolve ${r.conflicted.length} merge conflict(s).`, "error", 8000); }
    else { setPref(KEY_LAST_SYNC, String(Date.now())); toast(`Synced: ${r.committed} captured, ${r.committedEnriched} enriched, ${r.pulled ? "pulled" : "no pull"}, ${r.pushed ? "pushed" : "not pushed"}${r.collisions.length ? `, ${r.collisions.length} collision(s)` : ""}`); }
    if (parseRoute(location.hash).name === "browse") void render();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast("A sync is already running.", "error", 6000);
    else { failed = true; toast(`Sync failed: ${(e as Error).message}`, "error", 6000); }
  } finally {
    shell.setSync(failed ? { kind: "failed" } : lastSyncState());
  }
}

// ---- views ----
function card(i: ItemSummary): HTMLElement {
  return h("div", { class: "card" }, h("h3", {}, h("a", { href: itemHref(i) }, i.title || "(untitled)")), h("div", { class: "muted small" }, metaLine(i)), i.summary ? h("div", { class: "small" }, i.summary) : null, i.tags?.length ? h("div", {}, ...i.tags.map((t) => h("span", { class: "tag" }, t))) : null);
}
function hitCard(x: SearchHit): HTMLElement {
  return h("div", { class: "card hit" }, h("span", { class: "score" }, x.score.toFixed(3)), h("h3", {}, h("a", { href: itemHref({ id: x.docId, source: x.source }) }, x.title || x.docId)), h("div", { class: "muted small" }, x.source), h("div", { class: "small snip", html: escapeSnippet(x.snippet) }));
}
function escapeSnippet(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\[([^\]]+)\]/g, "<b>$1</b>");
}

const browseState = { q: "", mode: "hybrid", source: "", author: "", tag: "", days: "", addedOffset: 0, updatedOffset: 0 };
async function viewBrowse() {
  const qInput = h("input", { type: "search", placeholder: "Search J.A.R.V.I.S.…", value: browseState.q });
  const mode = h("select", {}, ...["hybrid", "semantic", "keyword"].map((m) => h("option", { value: m, selected: browseState.mode === m }, m)));
  const form = h("form", { class: "row", onSubmit: (e: Event) => { e.preventDefault(); browseState.q = qInput.value.trim(); browseState.mode = mode.value; browseState.addedOffset = browseState.updatedOffset = 0; render(); } }, h("div", { style: "flex:1;min-width:240px" }, qInput), mode, h("button", { class: "primary" }, "Search"));
  const facets = h("div", { class: "facets" });
  const lists = h("div");
  main.append(form, facets, lists);
  if (browseState.q) {
    const hits = await api.search(browseState.q, browseState.mode, 20);
    lists.append(h("h2", {}, `${hits.length} result(s)`), ...(hits.length ? hits.map(hitCard) : [h("p", { class: "muted" }, "No results.")]));
    return;
  }
  const b = await api.browse({ limit: 20, addedOffset: browseState.addedOffset, updatedOffset: browseState.updatedOffset, source: browseState.source, author: browseState.author, tag: browseState.tag, since: browseState.days ? sinceIso(Number(browseState.days)) : undefined });
  const sel = (label: string, key: "source" | "author" | "tag" | "days", opts: { value: string; label: string }[]) => {
    const s = h("select", { onChange: () => { browseState[key] = s.value; browseState.addedOffset = browseState.updatedOffset = 0; render(); } }, h("option", { value: "" }, label), ...opts.map((o) => h("option", { value: o.value, selected: browseState[key] === o.value }, o.label)));
    return s;
  };
  facets.append(
    sel("All sources", "source", b.facets.sources.map((f) => ({ value: f.value, label: `${f.value} (${f.count})` }))),
    sel("All contributors", "author", b.facets.authors.map((f) => ({ value: f.value, label: `${f.value} (${f.count})` }))),
    sel("All tags", "tag", b.facets.tags.map((f) => ({ value: f.value, label: `${f.value} (${f.count})` }))),
    sel("Any time", "days", [{ value: "1", label: "Last day" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "365", label: "Last year" }]),
  );
  const pager = (key: "addedOffset" | "updatedOffset", p: { offset: number; limit: number; total: number; hasMore: boolean }) =>
    h("div", { class: "row small muted" }, `${p.total ? p.offset + 1 : 0}–${Math.min(p.offset + p.limit, p.total)} of ${p.total}`, h("button", { disabled: p.offset === 0, onClick: () => { browseState[key] = Math.max(0, p.offset - p.limit); render(); } }, "Prev"), h("button", { disabled: !p.hasMore, onClick: () => { browseState[key] = p.offset + p.limit; render(); } }, "Next"));
  lists.append(h("div", { class: "two" },
    h("section", {}, h("h2", {}, "Recently added"), ...(b.added.length ? b.added.map(card) : [h("p", { class: "muted" }, "Nothing yet. Capture something!")]), pager("addedOffset", b.pagination.added)),
    h("section", {}, h("h2", {}, "Recently updated"), ...(b.updated.length ? b.updated.map(card) : [h("p", { class: "muted" }, "No updates yet.")]), pager("updatedOffset", b.pagination.updated)),
  ));
}

function viewCapture() {
  const title = h("input", { type: "text", placeholder: "Title" });
  const body = h("textarea", { rows: 14, placeholder: "Paste or write anything…" });
  const btn = h("button", { class: "primary" }, "Capture");
  main.append(h("h2", {}, "Capture"), h("form", { onSubmit: async (e: Event) => {
    e.preventDefault();
    if (!title.value.trim() || !body.value.trim()) return toast("Title and text are required", "error");
    btn.setAttribute("disabled", "true");
    try {
      const r = await api.capture(title.value.trim(), body.value);
      toast(`${r.status}: ${title.value.trim()}`);
      location.hash = `#/item/${r.id}`;
    } catch (err) { toast(`Capture failed: ${(err as Error).message}`, "error"); } finally { btn.removeAttribute("disabled"); }
  } }, h("p", {}, title), h("p", {}, body), btn));
}

async function viewItem(id: string) {
  const { item, edges } = await api.item(id);
  append(main, [
    h("h1", {}, item.title), h("div", { class: "muted small" }, metaLine(item)),
    item.source_url ? h("p", { class: "small" }, h("a", { href: safeHref(item.source_url), target: "_blank", rel: "noopener" }, item.source_url)) : null,
    item.tags?.length ? h("p", {}, ...item.tags.map((t) => h("span", { class: "tag" }, t))) : null,
    item.summary ? h("p", { class: "card" }, item.summary) : null,
    h("div", { class: "row", style: "margin:8px 0" }, h("button", { onClick: () => chat.askAbout({ type: "item", ids: [item.id] }, item.title) }, "Ask about this")),
    h("div", { class: "body-md", html: renderMarkdown(item.body) }),
    h("h3", {}, `Links (${edges.length})`),
    h("ul", { class: "edges" }, ...edges.map((e) => h("li", {}, h("span", { class: "pill" }, e.relation), " ", e.direction === "out" ? "→" : "←", " ", h("a", { href: `#/item/${e.otherId}` }, e.otherTitle ?? e.otherId), h("span", { class: "muted small" }, ` (${e.createdBy}${e.weight != null ? `, ${e.weight.toFixed(2)}` : ""})`)))),
  ]);
}
function safeHref(u: string): string { return /^https?:\/\//i.test(u) ? u : "#"; }

const briefState = { filter: "", sort: "updated" as "updated" | "created" | "title" };
async function viewBriefings() {
  const list = await api.briefings();
  const f = h("input", { type: "search", placeholder: "Filter…", value: briefState.filter, onInput: () => { briefState.filter = f.value; draw(); } });
  const s = h("select", { onChange: () => { briefState.sort = s.value as typeof briefState.sort; draw(); } }, ...(["updated", "created", "title"] as const).map((k) => h("option", { value: k, selected: briefState.sort === k }, `Sort by ${k}`)));
  const box = h("div");
  main.append(h("h2", {}, "Briefings"), h("div", { class: "row" }, h("div", { style: "flex:1" }, f), s), box);
  function draw() {
    clear(box);
    const q = briefState.filter.toLowerCase();
    const items = list.filter((b) => !q || b.title.toLowerCase().includes(q) || (b.subtitle ?? "").toLowerCase().includes(q) || (b.tags ?? []).some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => briefState.sort === "title" ? a.title.localeCompare(b.title) : briefState.sort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt));
    append(box, items.length ? items.map((b) => h("div", { class: "card" }, h("h3", {}, h("a", { href: `#/briefing/${b.id}` }, b.title)), h("div", { class: "muted small" }, `${b.kind} · updated ${fmtDate(b.updatedAt)}${b.author ? ` by ${b.author}` : ""} `, b.status ? h("span", { class: `pill ${b.status === "approved" ? "green" : "orange"}` }, b.status) : null), b.subtitle ? h("div", { class: "small" }, b.subtitle) : null)) : [h("p", { class: "muted" }, "No briefings yet. Create one with `jarvis briefing create --title …`.")]);
  }
  draw();
}

async function viewBriefing(id: string) {
  const [b, comments] = await Promise.all([api.briefing(id), api.comments(id)]);
  const html = renderBriefingHtml(b.tree as BriefingNode[]);
  const toc = b.toc ? h("nav", { class: "toc" }, h("div", { class: "muted small" }, "Contents"), ...b.toc.map((t) => h("a", { href: `#/briefing/${id}#${t.slug}`, class: t.level >= 3 ? "l3" : "", onClick: (e: Event) => { e.preventDefault(); document.getElementById(t.slug)?.scrollIntoView({ behavior: "smooth" }); } }, t.text))) : h("div");
  const rail = h("aside", { class: "comments" });
  const drawComments = (cs: typeof comments) => {
    clear(rail);
    const ta = h("textarea", { rows: 3, placeholder: "Add a comment…" });
    rail.append(h("h3", { style: "margin-top:0" }, `Comments (${cs.length})`), ...cs.map((c) => h("div", { class: "comment" }, h("div", { class: "muted small" }, `${c.author ?? "anonymous"} · ${fmtDate(c.createdAt)} `, h("span", { class: `pill ${c.status === "done" ? "green" : c.status === "handled" ? "purple" : ""}` }, c.status)), h("div", {}, c.comment))),
      h("form", { onSubmit: async (e: Event) => { e.preventDefault(); if (!ta.value.trim()) return; try { await api.addComment(id, ta.value.trim()); drawComments(await api.comments(id)); toast("Comment added"); } catch (err) { toast((err as Error).message, "error"); } } }, ta, h("button", { class: "primary", style: "margin-top:6px" }, "Post")));
  };
  drawComments(comments);
  append(main, [
    h("div", { class: "row" }, h("h1", { style: "flex:1;margin:0" }, b.title), b.status ? h("span", { class: `pill ${b.status === "approved" ? "green" : "orange"}` }, b.status) : null, h("button", { onClick: () => chat.askAbout({ type: "briefing", ids: [id] }, b.title) }, "Ask about this")),
    b.subtitle ? h("p", { class: "muted" }, b.subtitle) : null,
    h("div", { class: "brief-layout" }, toc, h("article", { class: "brief", html }), rail),
  ]);
}

async function viewPresentations() {
  main.append(h("h2", {}, "Presentations"));
  try {
    const list = await api.presentations();
    append(main, list.length ? list.map((p) => h("div", { class: "card" }, h("h3", {}, h("a", { href: `#/presentation/${p.slug}` }, p.title)), h("div", { class: "muted small" }, `${p.slug} · ${fmtDate(p.created_at)} by ${p.author} `, h("span", { class: `pill ${p.indexed ? "green" : ""}` }, p.indexed ? "indexed" : "not indexed")))) : [h("p", { class: "muted" }, "No presentations yet.")]);
  } catch (e) {
    main.append(h("p", { class: "muted" }, e instanceof ApiError && e.status === 404 ? "Presentations are not available in this service build yet." : (e as Error).message));
  }
}
async function viewPresentation(id: string) {
  const p = await api.presentation(id);
  const present = p.viewer.status === "ready" && p.viewer.launchUrl ? h("a", { href: p.viewer.launchUrl, target: inApp() ? "_self" : "_blank", rel: "noopener" }, h("button", { class: "primary" }, "Present in deck viewer")) : h("span", { class: "muted small" }, p.viewer.status === "not-running" ? "Deck viewer is not running (set JARVIS_DECK_VIEWER_URL)" : p.viewer.status === "content-not-mounted" ? "Content repo is not mounted in the deck viewer" : p.viewer.status);
  main.append(h("h1", {}, p.title), h("div", { class: "muted small" }, `${p.slug} · added ${fmtDate(p.created_at)} by ${p.author} `, h("span", { class: `pill ${p.indexed ? "green" : ""}` }, p.indexed ? "indexed" : "not indexed")), h("p", {}, present), h("h3", {}, "MDX source"), h("pre", { class: "body-md" }, h("code", {}, p.body)));
}

// ---- router ----
async function render() {
  const r = parseRoute(location.hash);
  shell.setActive(r.name);
  if (r.name === "chat") {
    page.hidden = true;
    chat.show();
    shell.setChatDot(false);
    return;
  }
  chat.hide();
  page.hidden = false;
  shell.setChatDot(chat.hasConversation());
  clear(main);
  try {
    switch (r.name) {
      case "tasks": browseState.q = ""; browseState.source = "task"; browseState.addedOffset = browseState.updatedOffset = 0; await viewBrowse(); break;
      case "browse": case "search": await viewBrowse(); break;
      case "capture": viewCapture(); break;
      case "briefings": await viewBriefings(); break;
      case "briefing": if (r.id) await viewBriefing(r.id.split("#")[0]); break;
      case "presentations": await viewPresentations(); break;
      case "presentation": if (r.id) await viewPresentation(r.id); break;
      case "item": if (r.id) await viewItem(r.id); break;
      default: main.append(h("p", {}, "Not found. ", h("a", { href: "#/chat" }, "Back to chat")));
    }
  } catch (e) {
    main.append(h("p", { class: "muted" }, e instanceof ApiError && e.status === 404 ? "Not found." : `Error: ${(e as Error).message}`));
  }
}
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && e.shiftKey && k === "o") { e.preventDefault(); chat.newChat(); }
  else if (mod && e.shiftKey && k === "s") { e.preventDefault(); shell.toggleFold(); }
  else if (e.key === "Escape") { if (shell.menuOpen()) shell.closeMenu(); else if (chat.isAnswering()) chat.stop(); }
  else if (e.key === "/" && !mod && !typing(e.target)) { e.preventDefault(); if (parseRoute(location.hash).name !== "chat") location.hash = "#/chat"; chat.focusInput(); }
}

/** Build the app into `root` and start routing. */
export function mountApp(root: HTMLElement): void {
  applyTheme(getTheme());
  shell = createShell({ onNewChat: () => chat.newChat(), onSync: () => void confirmSync() });
  chat = createChat({ navigate: (hash) => { if (location.hash === hash) void render(); else location.hash = hash; }, onChange: () => shell.setChatDot(chat.hasConversation() && parseRoute(location.hash).name !== "chat") });
  page = h("div", { class: "jv-page" });
  main = page;
  shell.main.append(chat.el, page);
  shell.setSync(lastSyncState());
  root.append(shell.el);
  window.addEventListener("hashchange", () => void render());
  document.addEventListener("keydown", onKey);
  void render();
}
if (typeof document !== "undefined" && document.getElementById("app")) mountApp(document.getElementById("app")!);
export { render, parseRoute };
