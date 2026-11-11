/** The app shell: sidebar (foldable to a rail, a slide-in menu on phones), look switch and sync line. */
import { ago, append, h } from "./ui.ts";
import type { Strip } from "./strip.ts";
import { getPref, getTheme, KEY_FOLDED, setPref, setTheme, type Theme } from "./prefs.ts";

export const TABLET_MAX = 999;
export const PHONE_MAX = 639;
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
/** "⌘⇧S" on a Mac, "Ctrl+Shift+S" elsewhere. */
export function shortcut(key: string): string { return isMac() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`; }

/** [route, sidebar label, rail name, icon] for the pages under "Your knowledge". */
export const PAGES: [string, string, string, string][] = [
  ["browse", "Browse & search", "Browse", "⌕"],
  ["initiatives", "Initiatives", "Initiatives", "◎"],
  ["capture", "Capture", "Capture", "✎"],
  ["briefings", "Briefings", "Briefings", "▤"],
  ["presentations", "Presentations", "Slides", "▣"],
];
/** Which sidebar entry a route lights up. */
export function navFor(route: string): string {
  if (route === "item" || route === "search" || route === "tasks") return "browse";
  if (route === "initiative") return "initiatives";
  if (route === "briefing") return "briefings";
  if (route === "presentation") return "presentations";
  return route;
}

export type SyncState = { kind: "never" } | { kind: "syncing" } | { kind: "failed" } | { kind: "ok"; at: number };

export interface Shell {
  el: HTMLElement;
  /** Where the chat and the pages go. */
  main: HTMLElement;
  setActive(route: string): void;
  setChatDot(on: boolean): void;
  setSync(s: SyncState): void;
  toggleFold(): void;
  isFolded(): boolean;
  openMenu(): void;
  closeMenu(): void;
  menuOpen(): boolean;
}

/** Build the shell. `onNewChat` and `onSync` are the two actions the sidebar owns. */
export function createShell(opts: { onNewChat: () => void; onSync: () => void; now?: () => number; strip?: Strip; onNav?: () => void }): Shell {
  const now = opts.now ?? (() => Date.now());
  let userFolded = getPref(KEY_FOLDED) === "1";
  let tablet = false, phone = false, menu = false;
  let sync: SyncState = { kind: "never" };

  const root = h("div", { class: "jv-shell" });
  const foldBtn = h("button", { class: "jv-fold", onClick: () => toggleFold() });
  const newBtn = h("button", { class: "jv-new", title: `New chat (${shortcut("O")})`, onClick: () => { closeMenu(); opts.onNewChat(); } }, h("span", { class: "ic" }, "＋"), h("span", { class: "lbl" }, " New chat"), h("span", { class: "rl" }, "New"));
  const dot = h("span", { class: "jv-dot", title: "Conversation in progress", hidden: "" });
  dot.hidden = true;
  const entry = (route: string, label: string, rail: string, icon: string, extra?: Node) =>
    h("a", { class: "jv-nav", href: `#/${route}`, "data-route": route, title: label, onClick: () => { closeMenu(); opts.onNav?.(); } }, h("span", { class: "ic" }, icon), h("span", { class: "lbl" }, label), h("span", { class: "rl" }, rail), extra);
  const chatEntry = entry("chat", "Chat", "Chat", "◈", dot);
  const nav = h("nav", { class: "jv-navlist", "aria-label": "Main" }, chatEntry, h("div", { class: "jv-sec" }, "Your knowledge"), ...PAGES.map(([r, l, rl, ic]) => entry(r, l, rl, ic)));
  const syncLine = h("span", { class: "jv-syncline lbl" });
  const syncBtn = h("button", { class: "jv-sync", onClick: () => opts.onSync() }, h("span", { class: "lbl" }, "Sync"), h("span", { class: "rl" }, "Sync"));
  const themeBtns = (["auto", "light", "dark"] as Theme[]).map((t) => h("button", { class: "jv-themebtn", "data-theme-choice": t, onClick: () => { setTheme(t); paintTheme(); } }, t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"));
  const themeSwitch = h("div", { class: "jv-theme lbl", role: "group", "aria-label": "Look" }, ...themeBtns);
  const side = h("aside", { class: "jv-side" },
    h("div", { class: "jv-brand" }, h("span", { class: "jv-mark" }), h("span", { class: "jv-name lbl" }, "J.A.R.V.I.S."), foldBtn),
    newBtn, nav, h("div", { class: "jv-grow" }),
    h("div", { class: "jv-foot" }, syncLine, syncBtn, themeSwitch));
  const menuBtn = h("button", { class: "jv-menu", "aria-label": "Menu", "aria-expanded": "false", onClick: () => (menu ? closeMenu() : openMenu()) }, "☰");
  const phoneBar = h("header", { class: "jv-phonebar" }, menuBtn, h("span", { class: "jv-name" }, "J.A.R.V.I.S."), opts.strip?.phoneBtn ?? null, h("button", { class: "jv-pnew", title: `New chat (${shortcut("O")})`, "aria-label": "New chat", onClick: () => opts.onNewChat() }, "＋"));
  const backdrop = h("div", { class: "jv-backdrop", onClick: () => closeMenu() });
  const main = h("main", { class: "jv-main", id: "jv-main" });
  append(root, [side, backdrop, h("div", { class: "jv-content" }, phoneBar, opts.strip?.phoneList ?? null, opts.strip?.el ?? null, main)]);

  const paintTheme = () => { const t = getTheme(); for (const b of themeBtns) b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-choice") === t)); };
  const paintFold = () => {
    const folded = !phone && (tablet || userFolded);
    root.classList.toggle("jv-folded", folded);
    root.classList.toggle("jv-phone", phone);
    root.classList.toggle("jv-menu-open", phone && menu);
    foldBtn.textContent = folded ? "⇥" : "⇤";
    const label = folded ? "Expand sidebar" : "Collapse sidebar";
    foldBtn.title = `${label} (${shortcut("S")})`;
    foldBtn.setAttribute("aria-label", label);
    menuBtn.setAttribute("aria-expanded", String(phone && menu));
  };
  const paintSync = () => {
    syncBtn.toggleAttribute("disabled", sync.kind === "syncing");
    syncLine.classList.toggle("jv-err", sync.kind === "failed");
    syncLine.textContent = sync.kind === "syncing" ? "Syncing…" : sync.kind === "failed" ? "Sync failed" : sync.kind === "never" ? "Not synced yet" : `Synced ${ago(now() - sync.at)}`;
    syncBtn.setAttribute("title", syncLine.textContent);
  };
  const mqTablet = matchMedia(`(max-width: ${TABLET_MAX}px)`), mqPhone = matchMedia(`(max-width: ${PHONE_MAX}px)`);
  const readMq = () => { tablet = mqTablet.matches; phone = mqPhone.matches; if (!phone) menu = false; paintFold(); };
  mqTablet.addEventListener("change", readMq);
  mqPhone.addEventListener("change", readMq);
  const timer = setInterval(paintSync, 30000);
  (timer as unknown as { unref?: () => void }).unref?.();

  let menuReturn: HTMLElement | null = null;
  function openMenu() { if (!phone) return; menu = true; paintFold(); menuReturn = menuBtn; (nav.querySelector("a") as HTMLElement | null)?.focus(); }
  function closeMenu() { if (!menu) return; menu = false; paintFold(); menuReturn?.focus(); }
  function toggleFold() { userFolded = !userFolded; setPref(KEY_FOLDED, userFolded ? "1" : "0"); paintFold(); }

  readMq(); paintTheme(); paintSync();
  return {
    el: root, main,
    setActive(route) { const a = navFor(route); for (const n of nav.querySelectorAll("a")) n.classList.toggle("active", n.getAttribute("data-route") === a); },
    setChatDot(on) { dot.hidden = !on; },
    setSync(s) { sync = s; paintSync(); },
    toggleFold, isFolded: () => root.classList.contains("jv-folded"), openMenu, closeMenu, menuOpen: () => menu,
  };
}
