import type { Router } from "../src/providers/router.ts";
import type { CompleteOpts, TaskProfile } from "../src/providers/types.ts";

/** A router backed by a scripted completion function. */
export function fakeRouter(complete: (prompt: string, opts: CompleteOpts, task: TaskProfile) => Promise<string> | string, kinds?: TaskProfile["kind"][]): Router {
  return {
    config: { preference: ["local"], models: [], source: "file" },
    entries: [],
    resolve(task) {
      if (kinds && !kinds.includes(task.kind)) return null;
      return { id: "fake:model", provider: "fake", model: "model", complete: async (prompt, opts = {}) => complete(prompt, opts, task) };
    },
  };
}
export const noRouter: Router = { config: { preference: [], models: [], source: "file" }, entries: [], resolve: () => null };
