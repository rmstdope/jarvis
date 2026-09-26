import { createRouter, type Router } from "./router.ts";

let cached: Promise<Router> | null = null;
let override: Router | null | undefined;

/** Process-wide router, created once (availability probes run in parallel at creation). */
export function getRouter(): Promise<Router | null> {
  if (override !== undefined) return Promise.resolve(override);
  if (!cached) cached = createRouter();
  return cached;
}
export function setRouterForTests(r: Router | null | undefined): void {
  override = r;
  cached = null;
}
