import { api, ApiError } from "./api.ts";
import { cardsFromSync, loadCards, saveCards } from "./syncnotes.ts";
import { clear, h, modal, parseRoute, toast } from "./ui.ts";
import { createChat, type Chat } from "./chat.ts";
import { applyTheme, getPref, getTheme, KEY_LAST_SYNC, KEY_SYNC_SKIP, setPref } from "./prefs.ts";
import { createShell, type Shell } from "./shell.ts";
import { createStrip, type Strip } from "./strip.ts";
import { createTabs, KEY_TABS_STORE, tabKey, type DocRef, type Tabs } from "./tabs.ts";
import { renderDoc, type DocView } from "./docview.ts";
import { kindLabel } from "./transcript.ts";

import { type Ctx, errorBox, inApp, skeleton } from "./pages/common.ts";
import { resetBrowse, viewBrowse } from "./pages/browse.ts";
import { viewCapture } from "./pages/capture.ts";
import { viewBriefings } from "./pages/briefings.ts";
import { viewInitiatives } from "./pages/initiatives.ts";
import { viewPresentations } from "./pages/presentations.ts";

// ---- chrome ----
let page: HTMLElement;
let main: HTMLElement; // where the current page draws
let shell: Shell;
let chat: Chat;
let tabs: Tabs;
let strip: Strip;
let docHost: HTMLElement;
const views = new Map<string, DocView>();
let pageHash: string | null = null; // the hash the sidebar page on screen was drawn for
let lastPageHash = "#/chat"; // where the address returns to after a document route
let firstRender = true;

async function confirmSync() {
  if (getPref(KEY_SYNC_SKIP) === "1") return runSync();
  const cb = h("input", { type: "checkbox" });
  modal("Sync with the team?", h("div", {}, h("p", {}, "This commits your captures, pulls teammates' changes, runs enrichment and pushes."), h("label", { class: "row small" }, cb, " Do not show again")), [
    { label: "Cancel", onClick: () => {} },
    { label: "Sync", primary: true, onClick: () => { if (cb.checked) setPref(KEY_SYNC_SKIP, "1"); void runSync(); } },
  ], "Sync");
}
/** The last sync as stored in this browser: when it ran, if ever. */
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
    else {
      setPref(KEY_LAST_SYNC, String(Date.now()));
      const cards = cardsFromSync(r);
      saveCards(cards);
      shell.setNotes(cards);
      toast(`Synced: ${r.committed} captured, ${r.committedEnriched} enriched, ${r.pulled ? "pulled" : "no pull"}, ${r.pushed ? "pushed" : "not pushed"}${r.collisions.length ? `, ${r.collisions.length} collision(s)` : ""}`);
    }
    if (parseRoute(location.hash).name === "browse") void render();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast("A sync is already running.", "error", 6000);
    else { failed = true; toast(`Sync failed: ${(e as Error).message}`, "error", 6000); }
  } finally {
    shell.setSync(failed ? { kind: "failed" } : lastSyncState());
  }
}

// ---- router ----
const DOC_ROUTES: Record<string, DocRef["type"]> = { item: "item", briefing: "briefing", presentation: "presentation", initiative: "initiative" };
const guessKind = (t: DocRef["type"]): string => (t === "briefing" ? "Briefing" : t === "presentation" ? "Presentation" : t === "initiative" ? "Initiative" : kindLabel("note"));

/** Make sure the tab's page exists (drawn once, kept hidden while another tab shows). */
function ensureView(key: string): DocView {
  let v = views.get(key);
  if (v) return v;
  const t = tabs.list().find((x) => x.key === key)!;
  v = renderDoc({ type: t.type, id: t.id }, {
    chat,
    scroller: docHost,
    askAbout: (scope, title) => chat.askAbout(scope, title),
    close: () => closeTab(key),
    loaded: (title, kind) => { tabs.setTitle(key, title, kind); strip.draw(tabs.list(), tabs.shown()); },
    inApp,
  });
  views.set(key, v);
  v.el.hidden = true;
  docHost.append(v.el);
  return v;
}
/** An open document got a new title elsewhere: its tab reads it now and its page is drawn afresh (jv-maq). */
function retitleTab(ref: DocRef, title: string): void {
  const key = tabKey(ref);
  if (!tabs.has(key)) return;
  tabs.setTitle(key, title);
  views.get(key)?.el.remove(); views.delete(key);
  syncView();
}
/** Draw what the state says: the shown tab, else Chat, else the sidebar page already drawn. */
function syncView(focusDoc = false): void {
  const key = tabs.shown();
  const r = parseRoute(location.hash);
  for (const [k] of views) if (!tabs.has(k)) { views.get(k)!.el.remove(); views.delete(k); }
  docHost.hidden = !key;
  for (const [k, v] of views) v.el.hidden = k !== key;
  const onChat = r.name === "chat" || !r.name;
  if (key) {
    const v = ensureView(key);
    v.el.hidden = false;
    chat.hide();
    page.hidden = true;
    shell.setActive("");
    shell.setChatDot(chat.hasConversation());
    if (focusDoc) void v.ready.then(() => { if (tabs.shown() === key) v.el.querySelector<HTMLElement>("[data-doc-title]")?.focus(); });
  } else if (onChat) {
    page.hidden = true;
    if (chat.el.hidden) chat.show();
    shell.setActive("chat");
    shell.setChatDot(false);
  } else {
    chat.hide();
    page.hidden = false;
    shell.setActive(r.name);
    shell.setChatDot(chat.hasConversation());
  }
  strip.draw(tabs.list(), key ?? (onChat ? "chat" : null));
  chat.redraw();
}
/** Open a document as a tab: shown now (a click) or quietly with a dot (the agent). */
function openDoc(ref: DocRef, title: string, kind: string, show: boolean, after: string | null = null): void {
  tabs.open(ref, title, kind, { show, dot: !show, after });
  syncView(show);
}
function showTab(key: string | null, focusDoc = true): void {
  if (key === null) { tabs.show(null); if (parseRoute(location.hash).name !== "chat") location.hash = "#/chat"; else syncView(); return; }
  tabs.show(key);
  syncView(focusDoc);
}
function closeTab(key: string): void {
  tabs.close(key);
  views.get(key)?.el.remove(); views.delete(key);
  syncView(true);
  if (tabs.shown() === null && parseRoute(location.hash).name === "chat") chat.focusInput();
}
let renderSeq = 0;
async function drawPage(r: { name: string; id?: string }): Promise<void> {
  pageHash = location.hash;
  const mine = ++renderSeq;
  clear(main);
  main.append(skeleton());
  const view = h("div", { class: "jv-view" });
  const ctx: Ctx = { main: view, scroller: main, chat, rerender: () => void render() };
  let after: void | (() => void) = undefined;
  try {
    switch (r.name) {
      case "tasks": resetBrowse({ source: "task" }); after = await viewBrowse(ctx); break;
      case "browse": case "search": after = await viewBrowse(ctx); break;
      case "capture": after = await viewCapture(ctx); break;
      case "briefings": after = await viewBriefings(ctx); break;
      case "initiatives": after = await viewInitiatives(ctx); break;
      case "presentations": after = await viewPresentations(ctx); break;
      default: view.append(h("p", {}, "Not found. ", h("a", { href: "#/chat" }, "Back to chat")));
    }
  } catch (e) {
    clear(view);
    view.append(errorBox("Couldn't load this page.", (e as Error).message, () => void render()));
  }
  if (mine !== renderSeq) return;
  clear(main);
  main.append(view);
  main.scrollTop = 0;
  after?.();
}
async function render() {
  const r = parseRoute(location.hash);
  const type = DOC_ROUTES[r.name];
  if (type && r.id) {
    // A document route: the click that opens a tab. The address goes back to where the person was.
    const id = r.id.split("#")[0];
    const ref: DocRef = { type, id };
    firstRender = false;
    const had = tabs.list().find((t) => t.type === type && t.id === id);
    window.history.replaceState(null, "", lastPageHash);
    // A link inside a tab opens right after it, as in a browser; from a sidebar page or Chat no tab is shown.
    openDoc(ref, had?.title ?? id, had?.kind ?? guessKind(type), true, tabs.shown());
    return;
  }
  lastPageHash = location.hash || "#/chat";
  const keepShown = firstRender && tabs.shown() !== null; // a reload keeps the tab that was shown
  firstRender = false;
  if (!keepShown) tabs.show(null);
  if (r.name !== "chat" && (!keepShown || pageHash !== location.hash)) await drawPage(r);
  syncView();
}
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey && e.key === "Tab") || (e.ctrlKey && e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft"))) {
    e.preventDefault();
    const d = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
    const keys: (string | null)[] = [null, ...tabs.list().map((t) => t.key)];
    showTab(keys[(keys.indexOf(tabs.shown()) + d + keys.length) % keys.length]);
  }
  else if (mod && e.shiftKey && k === "o") { e.preventDefault(); chat.newChat(); }
  else if (mod && e.shiftKey && k === "s") { e.preventDefault(); shell.toggleFold(); }
  else if (e.key === "Escape") { if (strip.closeLists()) return; if (shell.menuOpen()) shell.closeMenu(); else if (chat.isAnswering()) chat.stop(); }
  else if (e.key === "/" && !mod && !typing(e.target)) { e.preventDefault(); if (tabs.shown() !== null || parseRoute(location.hash).name !== "chat") showTab(null); chat.focusInput(); }
}

/** Build the app into `root` and start routing. */
export function mountApp(root: HTMLElement): void {
  applyTheme(getTheme());
  views.clear(); pageHash = null; lastPageHash = "#/chat"; firstRender = true;
  tabs = createTabs({ get: () => getPref(KEY_TABS_STORE), set: (v) => setPref(KEY_TABS_STORE, v) });
  strip = createStrip({ show: showTab, close: closeTab });
  window.addEventListener("resize", () => strip.draw(tabs.list(), tabs.shown() ?? (parseRoute(location.hash).name === "chat" ? "chat" : null)));
  shell = createShell({ onNotes: saveCards, onNewChat: () => chat.newChat(), onSync: () => void confirmSync(), strip, onNav: () => { if (tabs.shown() !== null) { tabs.show(null); syncView(); } } });
  chat = createChat({
    navigate: (hash) => { if (location.hash === hash) void render(); else location.hash = hash; },
    onChange: () => shell.setChatDot(chat.hasConversation() && (tabs.shown() !== null || parseRoute(location.hash).name !== "chat")),
    openQuietly: (ref, title, kind) => openDoc(ref, title, kind, false),
    showDoc: (ref, title, kind) => openDoc(ref, title, kind, true),
    renamed: (ref, title) => retitleTab(ref, title),
    shownKey: () => tabs.shown(),
  });
  docHost = h("div", { class: "jv-doc-host", hidden: "" });
  docHost.hidden = true;
  page = h("div", { class: "jv-page" });
  main = page;
  shell.main.append(chat.el, page, docHost);
  shell.setSync(lastSyncState());
  shell.setNotes(loadCards());
  root.append(shell.el);
  window.addEventListener("hashchange", () => void render());
  document.addEventListener("keydown", onKey);
  void render();
}
if (typeof document !== "undefined" && document.getElementById("app")) mountApp(document.getElementById("app")!);
export { render, parseRoute };
