/** Typed client for the local service (the same contract the web UI and server share). */
export interface PagePayload {
  url: string; title: string; content: string; starred?: boolean; forceUpdate?: boolean; capturedAt: string;
  byline?: string; metadata: { dwell_time_seconds?: number; source_author?: string };
}
export interface CaptureResult { id: string; status: "captured" | "updated"; title: string; }
export interface ItemSummary { id: string; title: string; source: string; created_at: string; tags: string[]; starred: boolean; source_url: string | null; }
export interface SearchHit { docId: string; title: string; snippet: string; score: number; source: string; }
export interface TaskItem { id: string; title: string; status: "open" | "done"; owner: string; due?: string; links: number; }

export class Api {
  constructor(private base: string) {}
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new Error(data.error ?? `${r.status}`);
    return data as T;
  }
  health() { return this.req<{ ok: boolean; docs: number }>("GET", "/api/health"); }
  capture(p: PagePayload) { return this.req<CaptureResult>("POST", "/api/capture", { source: "web", ...p, source_url: p.url, body: p.content, source_author: p.byline }); }
  itemBySource(url: string) { return this.req<{ item: ItemSummary | null }>("GET", `/api/item-by-source?url=${encodeURIComponent(url)}`); }
  recent(limit = 5) { return this.req<{ items: ItemSummary[] }>("GET", `/api/recent?limit=${limit}`); }
  search(q: string, limit = 10) { return this.req<SearchHit[]>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`); }
  tasks() { return this.req<{ tasks: TaskItem[] }>("GET", "/api/tasks"); }
  addTask(title: string, link?: string) { return this.req<{ id: string }>("POST", "/api/task", { title, link }); }
  link(src: string, dst: string, relation = "references") { return this.req<{ links: unknown[] }>("POST", "/api/link", { src, dst, relation }); }
  setTags(id: string, tags: string[]) { return this.req<{ id: string }>("POST", `/api/item/${id}/tags`, { tags }); }
  setContext(id: string, context: string) { return this.req<{ id: string }>("POST", `/api/item/${id}/context`, { context }); }
  filters() { return this.req<{ filters: { pattern: string; action: "block" | "allow" }[] }>("GET", "/api/filters"); }
  addFilter(pattern: string, action: "block" | "allow") { return this.req<{ filters: unknown[] }>("POST", "/api/filters", { pattern, action }); }
}
export const DEFAULT_SERVER = "http://localhost:7281";
export interface Settings { serverUrl: string; minDwellMs: number; autoCapture: boolean; filterRules: { pattern: string; action: "block" | "allow" }[] | null; }
export const DEFAULT_SETTINGS: Settings = { serverUrl: DEFAULT_SERVER, minDwellMs: 5000, autoCapture: false, filterRules: null };
export async function loadSettings(): Promise<Settings> {
  const s = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...s, autoCapture: s.autoCapture === true }; // opt-in: forced false until explicitly set
}
