/** The tab strip above the main area, its "more" list, and the phone's "▤ n" button with its list. */
import type { Tab } from "./tabs.ts";
import { h } from "./ui.ts";

export const TAB_MIN_PX = 96;
const HOVER = "Ctrl+Tab or Ctrl+Alt+→ next tab · Ctrl+Shift+Tab or Ctrl+Alt+← previous tab";

export interface StripOpts {
  /** Show a tab, or Chat with null. */
  show(key: string | null, focusDoc?: boolean): void;
  close(key: string): void;
}
export interface Strip {
  /** The strip itself (hidden while no document is open). */
  el: HTMLElement;
  /** The phone's "▤ n" button and its list. */
  phoneBtn: HTMLElement;
  phoneList: HTMLElement;
  /** Redraw for these tabs; `active` is a tab key, "chat", or null when a sidebar page shows. */
  draw(tabs: Tab[], active: string | null): void;
  /** Redraw the last tabs against the strip's current width, e.g. once the phone layout no longer hides it. */
  refit(): void;
  /** Close the phone list; returns true when it was open. */
  closeLists(): boolean;
}

/** A first estimate of how many document tabs fit: a test hook, else from the strip's width (all when it has none); `draw` corrects it against the real layout. */
function capacity(el: HTMLElement): number {
  const w = window as unknown as { __JV_TAB_CAPACITY__?: number };
  if (typeof w.__JV_TAB_CAPACITY__ === "number") return w.__JV_TAB_CAPACITY__;
  const width = el.clientWidth;
  return width > 0 ? Math.max(1, Math.floor((width - 190) / TAB_MIN_PX)) : Infinity;
}

/** Build the strip. It draws nothing until `draw` is called. */
export function createStrip(opts: StripOpts): Strip {
  const el = h("div", { class: "jv-tabstrip", role: "tablist", "aria-label": "Open tabs", hidden: "" });
  el.hidden = true;
  const phoneBtn = h("button", { class: "jv-tabsbtn", title: "Open tabs", "aria-haspopup": "true", "aria-expanded": "false", hidden: "", onClick: () => (phoneList.hidden ? openPhone() : closePhone()) });
  phoneBtn.hidden = true;
  const phoneList = h("div", { class: "jv-tablist", hidden: "" });
  phoneList.hidden = true;
  let last: { tabs: Tab[]; active: string | null } = { tabs: [], active: null };
  let moreOpen = false;

  function closePhone(focus = true) { phoneList.hidden = true; phoneBtn.setAttribute("aria-expanded", "false"); if (focus) phoneBtn.focus(); }
  function openPhone() { phoneList.hidden = false; phoneBtn.setAttribute("aria-expanded", "true"); }
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!phoneList.hidden && !phoneList.contains(t) && !phoneBtn.contains(t)) closePhone(true);
    if (moreOpen && !el.querySelector(".jv-more")?.contains(t)) { moreOpen = false; draw(last.tabs, last.active); }
  });

  const tabBtn = (key: string, title: string, kind: string, active: boolean, dot: boolean, closable: boolean): HTMLElement => {
    const b = h("button", { class: "jv-tab", role: "tab", "data-key": key, "aria-selected": String(active), tabindex: active || (key === "chat" && last.active === null) ? "0" : "-1", title: `${title}\n${HOVER}`, onClick: () => opts.show(key === "chat" ? null : key) },
      dot ? h("span", { class: "jv-tab-dot", title: "Opened by the agent" }) : null,
      kind ? h("span", { class: "jv-tab-k" }, kind === "Briefing" ? "▤" : kind === "Presentation" ? "▣" : kind === "Initiative" ? "◎" : "▫") : null,
      h("span", { class: "jv-tab-t" }, title));
    const x = closable ? h("span", { class: "jv-tab-x", role: "button", title: "Close tab", "aria-label": "Close tab", onClick: (e: Event) => { e.stopPropagation(); opts.close(key); } }, "✕") : null;
    if (x) b.append(x);
    b.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      const all = [...el.querySelectorAll<HTMLElement>(".jv-tab")];
      const i = all.indexOf(b);
      if (k === "ArrowRight" || k === "ArrowLeft") { e.preventDefault(); all[(i + (k === "ArrowRight" ? 1 : -1) + all.length) % all.length]?.focus(); }
      else if (k === "Delete" && closable) { e.preventDefault(); opts.close(key); }
    });
    return b;
  };

  function draw(tabs: Tab[], active: string | null): void {
    last = { tabs, active };
    const any = tabs.length > 0;
    el.hidden = !any;
    phoneBtn.hidden = !any;
    phoneBtn.textContent = `▤ ${tabs.length + 1}`;
    el.replaceChildren();
    phoneList.replaceChildren();
    if (!any) { closePhone(false); moreOpen = false; return; }
    // Start from the estimate, then hand one more tab to '⌄ n more' while the strip still overflows,
    // so Chat (which never shrinks) keeps its full width and no tab runs past the edge.
    let cap = Math.min(capacity(el), tabs.length);
    fill(tabs, active, cap);
    while (cap > 1 && el.scrollWidth > el.clientWidth) fill(tabs, active, --cap);
    if (!el.querySelector(".jv-more")) moreOpen = false;
    const entry = (key: string, title: string, closable: boolean) => h("div", { class: "jv-tablist-item" },
      h("button", { class: "jv-tablist-t", onClick: () => { opts.show(key === "chat" ? null : key, false); closePhone(true); } }, title),
      closable ? h("button", { class: "jv-tablist-x", title: "Close tab", "aria-label": "Close tab", onClick: () => opts.close(key) }, "✕") : null);
    phoneList.append(entry("chat", "Chat", false), ...tabs.map((t) => entry(t.key, t.title, true)));
  }

  /** Draw Chat, the first `cap` document tabs (the active one always among them) and '⌄ n more' for the rest. */
  function fill(tabs: Tab[], active: string | null, cap: number): void {
    el.replaceChildren(tabBtn("chat", "Chat", "", active === "chat", false, false));
    let visible = tabs;
    let hidden: Tab[] = [];
    if (tabs.length > cap) {
      visible = tabs.slice(0, cap);
      hidden = tabs.slice(cap);
      const sel = hidden.find((t) => t.key === active);
      if (sel) { visible = [...visible.slice(0, -1), sel]; hidden = tabs.filter((t) => !visible.includes(t)); }
    }
    for (const t of visible) el.append(tabBtn(t.key, t.title, t.kind, active === t.key, t.dot, true));
    if (hidden.length) {
      const list = h("div", { class: "jv-more-list", hidden: "" }, ...hidden.map((t) => h("div", { class: "jv-more-item" },
        h("button", { class: "jv-more-t", title: t.title, onClick: () => { moreOpen = false; opts.show(t.key); } }, t.title),
        h("button", { class: "jv-more-x", title: "Close tab", "aria-label": "Close tab", onClick: () => opts.close(t.key) }, "✕"))));
      list.hidden = !moreOpen;
      el.append(h("div", { class: "jv-more" }, h("button", { class: "jv-more-btn", "aria-expanded": String(moreOpen), onClick: (e: Event) => { e.stopPropagation(); moreOpen = !moreOpen; draw(last.tabs, last.active); } }, `⌄ ${hidden.length} more`), list));
    }
  }
  return { el, phoneBtn, phoneList, draw, refit: () => draw(last.tabs, last.active), closeLists: () => { if (!phoneList.hidden) { closePhone(); return true; } if (moreOpen) { moreOpen = false; draw(last.tabs, last.active); return true; } return false; } };
}
