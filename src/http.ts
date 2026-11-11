/** Route registry shared by server.ts and feature route modules (no import cycle). */
export type RouteHandler = (req: Request, url: URL, params: Record<string, string>, ctx: ServerContext) => Promise<Response> | Response;
export interface ServerContext {
  dataDir: string;
  router?: unknown;
}
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}
const routes: Route[] = [];

/** Register `METHOD /api/path/:param` handlers. */
export function route(method: string, path: string, handler: RouteHandler): void {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return "([^/]+)";
  }) + "/?$");
  routes.push({ method, pattern, keys, handler });
}
export function matchRoute(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return null;
}
export function listRoutes(): string[] {
  return routes.map((r) => `${r.method} ${r.pattern.source}`);
}
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}
export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError("invalid JSON body", 400);
  }
}
export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
