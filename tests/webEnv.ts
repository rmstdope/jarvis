/** A happy-dom browser for the web UI tests: globals, a controllable viewport, and a scripted `fetch`. */
import { Window } from "happy-dom";

export interface Reply { status?: number; json?: unknown; text?: string; stream?: (push: (line: unknown) => void, signal: AbortSignal) => Promise<void> }
export type Handler = (body: unknown, req: { method: string; path: string }) => Reply | Promise<Reply>;

export interface WebEnv {
  win: Window;
  /** Routes by `"METHOD /path"`; unmatched calls answer 404. */
  routes: Map<string, Handler>;
  calls: { method: string; path: string; body: unknown }[];
  setWidth(px: number): void;
  tick(ms?: number): Promise<void>;
  /** Remove every global this installed. */
  restore(): void;
}

const KEYS = ["window", "document", "localStorage", "location", "HTMLElement", "Node", "navigator", "KeyboardEvent", "Event", "MouseEvent", "fetch", "matchMedia"] as const;

/** The env whose globals are installed now: a second install restores it first, so a test that boots twice
 *  does not save the first fake `fetch` as the real one and leak it into every later test file (jv-m9l). */
let active: WebEnv | null = null;

export function installWebEnv(width = 1280): WebEnv {
  active?.restore();
  const win = new Window({ url: "http://127.0.0.1:7281/", width, height: 800 });
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const k of KEYS) saved[k] = g[k];
  const listeners = new Set<() => void>();
  let w = width;
  const matchMedia = (q: string) => {
    const m = /max-width:\s*(\d+)px/.exec(q);
    const mql = {
      media: q,
      get matches() { return m ? w <= Number(m[1]) : false; },
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    };
    return mql;
  };
  (win as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
  // Real browsers (Chrome, Safari, WKWebView) fire no hashchange for history.replaceState; happy-dom does, so swallow it.
  let replacing = false;
  const origReplace = win.history.replaceState.bind(win.history);
  win.history.replaceState = ((a: unknown, b: string, u?: string | URL) => { replacing = true; origReplace(a, b, u); }) as typeof win.history.replaceState;
  win.addEventListener("hashchange", (e) => { if (replacing) { replacing = false; e.stopImmediatePropagation(); } });
  const routes = new Map<string, Handler>();
  const calls: WebEnv["calls"] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:7281");
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    const body = raw instanceof FormData ? { message: raw.get("message"), files: raw.getAll("files").map((f) => (f as File).name) } : raw ? JSON.parse(String(raw)) : undefined;
    const path = url.pathname + url.search;
    calls.push({ method, path, body });
    const h = routes.get(`${method} ${url.pathname}`) ?? routes.get(`${method} ${path}`);
    if (!h) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const r = await h(body, { method, path });
    if (r.stream) {
      const signal = init?.signal ?? new AbortController().signal;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          signal.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } });
          try { await r.stream!((line) => c.enqueue(enc.encode(JSON.stringify(line) + "\n")), signal); } catch { /* aborted */ }
          try { c.close(); } catch { /* already closed */ }
        },
      });
      return new Response(stream, { status: r.status ?? 200 });
    }
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  const w2 = win as unknown as Record<string, unknown>;
  for (const k of ["window", "document", "localStorage", "location", "HTMLElement", "Node", "navigator", "KeyboardEvent", "Event", "MouseEvent"] as const) g[k] = k === "window" ? win : w2[k];
  g.fetch = fakeFetch;
  g.matchMedia = matchMedia;
  (win as unknown as { fetch: unknown }).fetch = fakeFetch;
  let restored = false;
  const env: WebEnv = {
    win, routes, calls,
    setWidth(px: number) { w = px; for (const l of [...listeners]) l(); },
    tick: (ms = 15) => new Promise((r) => setTimeout(r, ms)),
    restore() {
      if (restored) return; // idempotent: an afterEach after an explicit or nested restore must not clobber a newer env
      restored = true;
      if (active === env) active = null;
      for (const k of KEYS) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; }
      win.close();
    },
  };
  active = env;
  return env;
}
