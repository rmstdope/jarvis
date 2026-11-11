/** Per-browser preferences: every read and write is guarded, the app works with storage blocked. */
export type Theme = "auto" | "light" | "dark";

/** Read a stored value, or null when storage is missing or blocked. */
export function getPref(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
/** Store a value; silently does nothing when storage is blocked. */
export function setPref(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* blocked */ } }
/** Forget a stored value. */
export function delPref(k: string): void { try { localStorage.removeItem(k); } catch { /* blocked */ } }

export const KEY_THEME = "jv.theme";
export const KEY_FOLDED = "jv.folded";
export const KEY_LAST_SYNC = "jv.lastSync";
export const KEY_SYNC_SKIP = "sb.sync.noconfirm";
export const KEY_BROWSE = "jv.browse";
export const KEY_CAPTURE = "jv.capture";
export const KEY_BRIEF_COLS = "jv.briefCols";
export const KEY_BRIEF_LIST = "jv.briefList";

/** A stored JSON object merged over `fallback`; the fallback when nothing (or nonsense) is stored. */
export function getJson<T extends object>(k: string, fallback: T): T {
  try {
    const v = JSON.parse(getPref(k) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? { ...fallback, ...v } : fallback;
  } catch { return fallback; }
}
/** Store an object as JSON; silently does nothing when storage is blocked. */
export function setJson(k: string, v: object): void { setPref(k, JSON.stringify(v)); }

/** The saved look; Auto when nothing (or nonsense) is saved. */
export function getTheme(): Theme {
  const v = getPref(KEY_THEME);
  return v === "light" || v === "dark" ? v : "auto";
}
/** Put the look on the page: Auto removes the override so the computer's setting decides. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}
/** Save and apply a look. */
export function setTheme(t: Theme): void {
  if (t === "auto") delPref(KEY_THEME); else setPref(KEY_THEME, t);
  applyTheme(t);
}
