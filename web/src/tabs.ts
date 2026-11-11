/** The open documents as tabs beside Chat: a DOM-free model, persisted so a reload keeps them. */

/** A document that can be opened: an item (any capture), a briefing or a presentation. */
export interface DocRef { type: "item" | "briefing" | "presentation" | "initiative"; id: string; }
/** One open tab. `dot` is set while an agent-opened tab has not been shown yet. */
export interface Tab extends DocRef { key: string; title: string; kind: string; dot: boolean; }
/** Where the tabs are kept between page loads. */
export interface Store { get(): string | null; set(v: string): void; }
export const KEY_TABS_STORE = "jv.tabs";

/** The document a stored `source` and id name: briefings and presentations have their own pages, all else is an item. */
export function docRefFor(source: string, id: string): DocRef { return { type: source === "briefing" ? "briefing" : source === "presentation" ? "presentation" : source === "initiative" ? "initiative" : "item", id }; }

/** The tab key of a document. */
export function tabKey(r: DocRef): string { return `${r.type}:${r.id}`; }

export interface Tabs {
  list(): Tab[];
  /** The key of the tab shown, or null when Chat (or a sidebar page) is. */
  shown(): string | null;
  has(key: string): boolean;
  /** Open a tab (or find the existing one, which never moves); `show` brings it to the front, `dot` marks it as agent-opened, `after` puts a new tab right after that tab instead of at the end. */
  open(ref: DocRef, title: string, kind: string, o: { show: boolean; dot?: boolean; after?: string | null }): Tab;
  /** Show a tab, or Chat with null. */
  show(key: string | null): void;
  /** Close a tab: the one to its left is shown when this one was. */
  close(key: string): void;
  setTitle(key: string, title: string, kind?: string): void;
}

/** Create the model, restoring what `store` holds. */
export function createTabs(store: Store): Tabs {
  let tabs: Tab[] = [];
  let shown: string | null = null;
  try {
    const v = JSON.parse(store.get() ?? "null") as { tabs?: Tab[]; shown?: string | null } | null;
    if (v && Array.isArray(v.tabs)) {
      tabs = v.tabs.filter((t) => t && typeof t.id === "string" && ["item", "briefing", "presentation", "initiative"].includes(t.type)).map((t) => ({ type: t.type, id: t.id, key: tabKey(t), title: String(t.title ?? t.id), kind: String(t.kind ?? "Note"), dot: !!t.dot }));
      shown = tabs.some((t) => t.key === v.shown) ? (v.shown as string) : null;
    }
  } catch { /* start empty */ }
  const changed = () => { store.set(JSON.stringify({ tabs, shown })); };
  return {
    list: () => tabs,
    shown: () => shown,
    has: (k) => tabs.some((t) => t.key === k),
    open(ref, title, kind, o) {
      const key = tabKey(ref);
      let t = tabs.find((x) => x.key === key);
      if (!t) { t = { type: ref.type, id: ref.id, key, title, kind, dot: !!o.dot && !o.show };
        const at = o.after ? tabs.findIndex((x) => x.key === o.after) : -1;
        if (at >= 0) tabs.splice(at + 1, 0, t); else tabs.push(t);
      }
      else { t.title = title; t.kind = kind; }
      if (o.show) { shown = key; t.dot = false; }
      changed();
      return t;
    },
    show(key) {
      if (key !== null) { const t = tabs.find((x) => x.key === key); if (!t) return; t.dot = false; }
      shown = key;
      changed();
    },
    close(key) {
      const i = tabs.findIndex((t) => t.key === key);
      if (i < 0) return;
      tabs = tabs.filter((t) => t.key !== key);
      if (shown === key) shown = tabs[i - 1]?.key ?? null;
      changed();
    },
    setTitle(key, title, kind) { const t = tabs.find((x) => x.key === key); if (t && (t.title !== title || (kind && t.kind !== kind))) { t.title = title; if (kind) t.kind = kind; changed(); } },
  };
}
