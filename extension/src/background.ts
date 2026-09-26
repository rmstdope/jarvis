import { Api, loadSettings, type PagePayload } from "./api.ts";
import { DEFAULT_RULES, hostBlockPattern, isBlocked, type FilterRule } from "./blocklist.ts";

const dwellTimers = new Map<number, ReturnType<typeof setTimeout>>();
const dwellStart = new Map<number, number>();
let serverRules: FilterRule[] | null = null;

async function rules(): Promise<FilterRule[]> {
  const s = await loadSettings();
  return serverRules?.length ? serverRules : s.filterRules?.length ? s.filterRules : DEFAULT_RULES;
}
async function syncFilters(): Promise<void> {
  try {
    const s = await loadSettings();
    const r = await new Api(s.serverUrl).filters();
    serverRules = r.filters.length ? r.filters : null;
  } catch {
    /* service down: keep the local list */
  }
}
chrome.alarms.create("filters", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "filters") syncFilters(); });
syncFilters();

async function badge(tabId: number, text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 2000);
  } catch {}
}

export async function capture(tabId: number, url: string, opts: { bypassBlocklist?: boolean; forceUpdate?: boolean; starred?: boolean } = {}): Promise<{ id: string; status: string } | { error: string }> {
  const s = await loadSettings();
  if (!opts.bypassBlocklist && isBlocked(url, await rules())) return { error: "blocked by the blocklist" };
  let ex: { title: string; content: string; byline?: string };
  try {
    ex = await chrome.tabs.sendMessage(tabId, { type: "extract" });
  } catch {
    return { error: "page not ready (reload it and try again)" };
  }
  const dwell = dwellStart.get(tabId);
  const payload: PagePayload = { url, title: ex.title, content: ex.content, byline: ex.byline, starred: opts.starred, forceUpdate: opts.forceUpdate, capturedAt: new Date().toISOString(), metadata: { dwell_time_seconds: dwell ? Math.round((Date.now() - dwell) / 1000) : undefined, source_author: ex.byline } };
  try {
    const r = await new Api(s.serverUrl).capture(payload);
    await badge(tabId, "✓", r.status === "captured" ? "#14a05c" : "#c2760c");
    return r;
  } catch (e) {
    await badge(tabId, "!", "#d32f3a");
    return { error: (e as Error).message };
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
  clearTimeout(dwellTimers.get(tabId));
  dwellStart.set(tabId, Date.now());
  const s = await loadSettings();
  if (!s.autoCapture) return;
  const url = tab.url;
  dwellTimers.set(tabId, setTimeout(async () => {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.url !== url) return;
      if (isBlocked(url, await rules())) return;
      await capture(tabId, url);
    } catch {}
  }, s.minDwellMs));
});
chrome.tabs.onRemoved.addListener((tabId) => { clearTimeout(dwellTimers.get(tabId)); dwellTimers.delete(tabId); dwellStart.delete(tabId); });

chrome.runtime.onMessage.addListener((msg: { type: string; [k: string]: unknown }, sender, reply) => {
  (async () => {
    const s = await loadSettings();
    const api = new Api(s.serverUrl);
    const tabId = (msg.tabId as number | undefined) ?? sender.tab?.id;
    switch (msg.type) {
      case "getStatus": {
        let online = false, docs = 0;
        try { const h = await api.health(); online = h.ok; docs = h.docs; } catch {}
        return reply({ online, docs, autoCapture: s.autoCapture, serverUrl: s.serverUrl });
      }
      case "getPageState": {
        const url = String(msg.url);
        let captured = false;
        try { captured = !!(await api.itemBySource(url)).item; } catch {}
        return reply({ autoCapture: s.autoCapture, captured, blocked: isBlocked(url, await rules()) });
      }
      case "captureNow":
        return reply(tabId === undefined ? { error: "no tab" } : await capture(tabId, String(msg.url), { bypassBlocklist: !!msg.bypassBlocklist }));
      case "forceUpdate":
        return reply(tabId === undefined ? { error: "no tab" } : await capture(tabId, String(msg.url), { bypassBlocklist: true, forceUpdate: true }));
      case "star":
        return reply(tabId === undefined ? { error: "no tab" } : await capture(tabId, String(msg.url), { bypassBlocklist: true, starred: true }));
      case "addBlockRule": {
        const pattern = hostBlockPattern(String(msg.url));
        try { await api.addFilter(pattern, "block"); await syncFilters(); } catch { serverRules = [...(serverRules ?? DEFAULT_RULES), { pattern, action: "block" }]; }
        return reply({ ok: true, pattern });
      }
      case "toggleAutoCapture":
        await chrome.storage.local.set({ autoCapture: !s.autoCapture });
        return reply({ autoCapture: !s.autoCapture });
      default:
        return reply({ error: `unknown message ${msg.type}` });
    }
  })().catch((e) => reply({ error: (e as Error).message }));
  return true;
});
