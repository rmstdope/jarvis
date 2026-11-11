import { api, ApiError } from "./api.ts";
import { clear, h, modal, parseRoute, toast } from "./ui.ts";
import { createChat, type Chat } from "./chat.ts";
import { applyTheme, getPref, getTheme, KEY_LAST_SYNC, KEY_SYNC_SKIP, setPref } from "./prefs.ts";
import { createShell, type Shell } from "./shell.ts";

import { type Ctx, errorBox, notFound, skeleton } from "./pages/common.ts";
import { resetBrowse, viewBrowse } from "./pages/browse.ts";
import { viewCapture } from "./pages/capture.ts";
import { viewInitiative } from "./pages/initiative.ts";
import { viewInitiatives } from "./pages/initiatives.ts";
import { viewItem } from "./pages/item.ts";
import { viewBriefing, viewBriefings } from "./pages/briefings.ts";
import { viewPresentation, viewPresentations } from "./pages/presentations.ts";

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

// ---- router ----
/** Where "Back to …" goes when an item, briefing or presentation is missing. */
const BACK: Record<string, [string, string]> = { initiative: ["Initiatives", "#/initiatives"], item: ["Browse & search", "#/browse"], briefing: ["Briefings", "#/briefings"], presentation: ["Presentations", "#/presentations"] };
let renderSeq = 0;
async function render() {
  const r = parseRoute(location.hash);
  const [rid, rquery] = (r.id ?? "").split("?");
  const from = new URLSearchParams(rquery ?? "").get("from") ?? undefined;
  shell.setActive(r.name === "initiative" && from === "browse" ? "browse" : r.name);
  if (r.name === "chat") {
    page.hidden = true;
    chat.show();
    shell.setChatDot(false);
    return;
  }
  chat.hide();
  page.hidden = false;
  shell.setChatDot(chat.hasConversation());
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
      case "briefing": if (r.id) after = await viewBriefing(ctx, r.id.split("#")[0]); break;
      case "presentations": after = await viewPresentations(ctx); break;
      case "presentation": if (r.id) after = await viewPresentation(ctx, r.id); break;
      case "initiative": if (rid) after = await viewInitiative(ctx, rid, from); break;
      case "initiatives": after = await viewInitiatives(ctx); break;
      case "item": if (rid) after = await viewItem(ctx, rid, from); break;
      default: view.append(h("p", {}, "Not found. ", h("a", { href: "#/chat" }, "Back to chat")));
    }
  } catch (e) {
    clear(view);
    const back = BACK[r.name];
    if (back && e instanceof ApiError && e.status === 404) view.append(...notFound(...back));
    else view.append(errorBox("Couldn't load this page.", (e as Error).message, () => void render()));
  }
  if (mine !== renderSeq) return;
  clear(main);
  main.append(view);
  main.scrollTop = 0;
  after?.();
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
