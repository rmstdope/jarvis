import type { WebChange } from "./changes.ts";
/** Same-origin thin client for the local service. */
export interface ItemSummary { initiative?: InitiativeRef; progress?: InitiativeProgress; id: string; source: string; title: string; author: string; created_at: string; updated_at: string | null; updated_by: string | null; source_url: string | null; starred: boolean; summary: string | null; tags: string[]; metadata: Record<string, unknown> | null; }
export interface Item extends ItemSummary { body: string; proc_version: number; file_path: string | null; }
export interface ItemEdge { otherId: string; otherTitle: string | null; relation: string; createdBy: string; weight: number | null; direction: "out" | "in"; }
export interface SearchHit { initiative?: InitiativeRef; progress?: InitiativeProgress; docId: string; title: string; snippet: string; score: number; source: string; author?: string; createdAt?: string; }
export interface Facet { value: string; count: number; }
export interface Page { offset: number; limit: number; total: number; hasMore: boolean; }
export interface BrowseResult { added: ItemSummary[]; updated: ItemSummary[]; pagination: { added: Page; updated: Page }; facets: { sources: Facet[]; authors: Facet[]; tags: Facet[] }; }
export interface BriefingSummary { id: string; title: string; subtitle?: string; createdAt: string; updatedAt: string; kind: string; trail?: string; status?: string; tags?: string[]; author?: string; }
export interface BriefingDetail extends BriefingSummary { frontmatter: Record<string, unknown>; tree: unknown[]; toc: { level: number; text: string; slug: string }[] | null; html?: string; }
export interface Comment { id: string; status: string; author?: string; comment: string; createdAt: string; }
export interface SyncResult { remote: boolean; committed: number; committedEnriched: number; pulled: boolean; pushed: boolean; conflicted: string[]; reindexed?: { docsIndexed: number; chunksEmbedded: number }; collisions: { source_url: string; ids: string[] }[]; notes: string[]; failures: SyncStepFailure[]; }
/** A model step a sync ran that failed for `failed` units (items for enrich, batches for refine). */
export interface SyncStepFailure { step: string; failed: number; reason: string; doctor: boolean; }
export interface PresentationSummary { id: string; slug: string; title: string; author: string; created_at: string; updated_at?: string; indexed: boolean; viewer: { status: string; launchUrl?: string }; }

export interface InitiativeRef { id: string; title: string; }
export interface InitiativeProgress { done: number; total: number; owner: string; status: "open" | "closed"; closed_at?: string; goal?: string; updated_at?: string; }
export interface TaskRow { id: string; title: string; status: "open" | "done"; owner: string; due?: string; initiative?: InitiativeRef; }
export interface InitiativeSummary { id: string; title: string; owner: string; status: "open" | "closed"; done: number; total: number; created_at: string; closed_at?: string; closed_by?: string; }
export interface InitiativeCard extends InitiativeSummary { goal: string; updated_at: string; }
export interface TiedItem { id: string; title: string; source: string | null; author?: string | null; created_at: string; via: string[]; }
export interface TiedSection { total: number; items: TiedItem[]; }
export interface InitiativeTask extends TaskRow { created_at: string; completed_at?: string; completed_by?: string; author: string; links: number; }
export interface InitiativeDetail { initiative: InitiativeSummary & { goal: string; updated_at?: string }; tasks: InitiativeTask[]; through: TiedSection; direct: TiedSection; }
export interface InitiativeSuggestion { id: string; title: string; source: string; author?: string; reason: string; }

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!r.ok) throw new ApiError((data as { error?: string })?.error ?? `${r.status}`, r.status);
  return data as T;
}
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
export const api = {
  health: () => req<{ ok: boolean; docs: number }>("GET", "/api/health"),
  search: (q: string, mode: string, limit = 20, filter: { source?: string; author?: string; tag?: string; since?: string } = {}) => req<SearchHit[]>("GET", `/api/search${qs({ q, mode, limit, ...filter })}`),
  browse: (o: Record<string, string | number | undefined>) => req<BrowseResult>("GET", `/api/browse${qs(o)}`),
  item: (id: string) => req<{ item: Item; edges: ItemEdge[]; initiative?: InitiativeRef & { done: number; total: number } }>("GET", `/api/item/${encodeURIComponent(id)}`),
  capture: (title: string, body: string) => req<{ id: string; status: string }>("POST", "/api/capture", { source: "paste", title, body }),
  me: () => req<{ name?: string }>("GET", "/api/me"),
  chatStatus: () => req<{ available: boolean }>("GET", "/api/chat/status"),
  chatChanges: (cid: string) => req<{ changes: WebChange[] }>("GET", `/api/chat/conversations/${encodeURIComponent(cid)}/changes`),
  undoChange: (cid: string, id: string) => req<{ change: WebChange; changes?: WebChange[] }>("POST", `/api/chat/conversations/${encodeURIComponent(cid)}/changes/${encodeURIComponent(id)}/undo`, {}),
  undoAll: (cid: string, turn?: string) => req<{ changes: WebChange[]; error?: string }>("POST", `/api/chat/conversations/${encodeURIComponent(cid)}/changes/undo-all`, { turn }),
  tasks: (owner?: string) => req<{ tasks: TaskRow[] }>("GET", `/api/tasks${qs({ status: "open", owner })}`),
  taskDone: (id: string) => req<unknown>("POST", `/api/task/${encodeURIComponent(id)}/done`, {}),
  taskReopen: (id: string) => req<unknown>("POST", `/api/task/${encodeURIComponent(id)}/reopen`, {}),
  initiatives: (status: string) => req<{ initiatives: InitiativeCard[] }>("GET", `/api/initiatives${qs({ status })}`),
  initiative: (id: string) => req<InitiativeDetail>("GET", `/api/initiative/${encodeURIComponent(id)}`),
  initiativeSuggest: (id: string) => req<{ model: boolean; suggestions: InitiativeSuggestion[] }>("GET", `/api/initiative/${encodeURIComponent(id)}/suggest`),
  closeInitiative: (id: string, anyway: boolean) => req<unknown>("POST", `/api/initiative/${encodeURIComponent(id)}/close`, { anyway }),
  reopenInitiative: (id: string) => req<unknown>("POST", `/api/initiative/${encodeURIComponent(id)}/reopen`, {}),
  link: (src: string, dst: string) => req<unknown>("POST", "/api/link", { src, dst }),
  sync: () => req<SyncResult>("POST", "/api/sync"),
  briefings: () => req<BriefingSummary[]>("GET", "/api/briefings"),
  briefing: (id: string) => req<BriefingDetail>("GET", `/api/briefing/${encodeURIComponent(id)}?html=1`),
  comments: (id: string) => req<Comment[]>("GET", `/api/briefing/${encodeURIComponent(id)}/comments`),
  addComment: (id: string, comment: string) => req<Comment>("POST", `/api/briefing/${encodeURIComponent(id)}/comments`, { comment }),
  presentations: () => req<PresentationSummary[]>("GET", "/api/presentations"),
  presentation: (id: string) => req<PresentationSummary & { frontmatter: Record<string, unknown>; body: string; filePath: string }>("GET", `/api/presentation/${encodeURIComponent(id)}`),
};
