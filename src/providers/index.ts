import { modelsSignature } from "./models.ts";
import { createRouter, type Router } from "./router.ts";

let cached: Promise<Router> | null = null;
let cachedSig = "";
let override: Router | null | undefined;

/**
 * Process-wide router, created once per version of models.toml (availability probes run in parallel at creation).
 * An edit to the file (see {@link modelsSignature}) drops the cached router, so a long-running serve uses a changed
 * config on its next call. A creation that fails (an unloadable models.toml) is not kept either.
 */
export function getRouter(): Promise<Router | null> {
  if (override !== undefined) return Promise.resolve(override);
  const sig = modelsSignature();
  if (cached && sig !== cachedSig) cached = null;
  if (!cached) {
    cachedSig = sig;
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
