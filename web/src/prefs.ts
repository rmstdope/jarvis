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
