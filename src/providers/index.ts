import { createRouter, type Router } from "./router.ts";

let cached: Promise<Router> | null = null;
let override: Router | null | undefined;

/**
 * Process-wide router, created once (availability probes run in parallel at creation). A creation that fails
 * (an unloadable models.toml) is not kept, so a long-running serve picks up the fixed file on its next call.
 */
export function getRouter(): Promise<Router | null> {
  if (override !== undefined) return Promise.resolve(override);
  if (!cached) {
    const created = createRouter();
    cached = created;
    created.catch(() => {
      if (cached === created) cached = null;
    });
  }
  return cached;
}
export function setRouterForTests(r: Router | null | undefined): void {
  override = r;
  cached = null;
}
