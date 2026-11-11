/** Shared boot for the page tests: the app mounted in a happy-dom browser with empty-library routes. */
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { mountApp } from "../web/src/main.ts";

export const q = (sel: string) => document.querySelector(sel) as HTMLElement;
export const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
export const text = (sel: string) => q(sel)?.textContent ?? "";
export const button = (label: string) => qa("button").find((b) => b.textContent?.trim() === label);
const page = (total: number) => ({ offset: 0, limit: 20, total, hasMore: false });
export const emptyBrowse = { added: [], updated: [], pagination: { added: page(0), updated: page(0) }, facets: { sources: [], authors: [], tags: [] } };
export const ITEM = { id: "I1", source: "note", title: "On-call rollout", author: "mia", created_at: "2026-01-01T00:00:00Z", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "Body text", proc_version: 1, file_path: null };

/** Mount the app at `hash`; `setup` may add or replace routes before it starts. */
export async function boot(hash = "#/browse", opts: { width?: number; setup?: (env: WebEnv) => void; keepStorage?: WebEnv } = {}): Promise<WebEnv> {
  const env = installWebEnv(opts.width ?? 1280);
  env.routes.set("GET /api/me", () => ({ json: { name: "Mia" } }));
  env.routes.set("GET /api/chat/status", () => ({ json: { available: true } }));
  env.routes.set("GET /api/tasks", () => ({ json: { tasks: [] } }));
  env.routes.set("GET /api/browse", () => ({ json: emptyBrowse }));
  env.routes.set("GET /api/briefings", () => ({ json: [] }));
  env.routes.set("GET /api/presentations", () => ({ json: [] }));
  opts.setup?.(env);
  document.body.innerHTML = '<div id="app"></div>';
  location.hash = hash;
  mountApp(document.getElementById("app")!);
  await env.tick(60);
  return env;
}
export const go = async (env: WebEnv, hash: string) => { location.hash = hash; await env.tick(60); };
export const type = (el: HTMLElement, value: string) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
