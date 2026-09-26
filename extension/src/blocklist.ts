/** Single blocklist module shared by background and popup. Glob patterns (`*`, `?`), case-insensitive, anchored; allow overrides block. */
export interface FilterRule { pattern: string; action: "block" | "allow"; }

export const DEFAULT_RULES: FilterRule[] = [
  "*google.*/search*", "*google.*/maps*", "mail.google.com/*", "*facebook.com/*", "*instagram.com/*", "*x.com/*", "*twitter.com/*",
  "*youtube.com/", "*youtube.com/feed*", "*youtube.com/results*", "*youtube.com/shorts*", "*netflix.com/*", "*spotify.com/*", "*amazon.*/*",
  "localhost*", "127.0.0.1*", "chrome://*", "chrome-extension://*", "edge://*", "about:*", "file://*",
].map((pattern) => ({ pattern, action: "block" as const }));

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
function stripScheme(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}
function matches(rule: FilterRule, url: string): boolean {
  const re = globToRegExp(rule.pattern);
  return re.test(url) || re.test(stripScheme(url));
}
/** True when the URL must not be auto-captured. */
export function isBlocked(url: string, rules: FilterRule[] = DEFAULT_RULES): boolean {
  if (rules.some((r) => r.action === "allow" && matches(r, url))) return false;
  return rules.some((r) => r.action === "block" && matches(r, url));
}
/** Pattern for a "block this site" action: `*.<host>/*` with any www. prefix dropped. */
export function hostBlockPattern(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return `*${host}/*`;
}
