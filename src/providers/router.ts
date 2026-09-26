import { copilotProvider } from "./copilot.ts";
import { localProvider } from "./local.ts";
import { loadModelsConfig, type ModelEntry, type ModelsConfig, type ProviderName } from "./models.ts";
import { openaiCompatProvider } from "./openaiCompat.ts";
import { DEFAULT_MIN_QUALITY, QUALITY_RANK, type CompleteOpts, type Provider, type ResolvedModel, type TaskKind, type TaskProfile } from "./types.ts";

export interface RouterEntry {
  entry: ModelEntry;
  provider: Provider;
  available: boolean;
}
export interface Router {
  config: ModelsConfig;
  entries: RouterEntry[];
  resolve(task: TaskProfile): ResolvedModel | null;
}

export type ProviderFactory = (entry: ModelEntry) => Provider;
export const defaultProviderFactory: ProviderFactory = (e) => {
  switch (e.provider) {
    case "local":
      return localProvider();
    case "copilot":
      return copilotProvider();
    case "openai-compat":
      return openaiCompatProvider("openai-compat", { baseUrl: e.baseUrl, apiKeyEnv: e.apiKeyEnv, extraBody: e.extraBody });
  }
};

/** Availability is detected once (in parallel) at creation, so resolve() is synchronous. */
export async function createRouter(opts: { config?: ModelsConfig; factory?: ProviderFactory } = {}): Promise<Router> {
  const config = opts.config ?? (await loadModelsConfig());
  const factory = opts.factory ?? defaultProviderFactory;
  const cache = new Map<string, Provider>();
  const entries: RouterEntry[] = await Promise.all(
    config.models.map(async (entry) => {
      const key = `${entry.provider}|${entry.baseUrl ?? ""}|${entry.apiKeyEnv ?? ""}`;
      let provider = cache.get(key);
      if (!provider) {
        provider = factory(entry);
        cache.set(key, provider);
      }
      let available = false;
      try {
        available = await provider.available(entry.id);
      } catch {}
      return { entry, provider, available };
    }),
  );
  const prefIndex = (p: ProviderName) => {
    const i = config.preference.indexOf(p);
    return i < 0 ? 999 : i;
  };
  return {
    config,
    entries,
    resolve(task) {
      const minQ = task.minQuality ?? DEFAULT_MIN_QUALITY[task.kind];
      let cands = entries.filter((e) => e.available && QUALITY_RANK[e.entry.quality] >= QUALITY_RANK[minQ] && (!task.lang || !e.entry.langs || e.entry.langs.includes(task.lang)));
      const affine = cands.filter((e) => e.entry.bestFor?.includes(task.kind));
      if (affine.length) cands = affine;
      cands = cands
        .map((e, i) => ({ e, i }))
        .sort((a, b) => prefIndex(a.e.entry.provider) - prefIndex(b.e.entry.provider) || QUALITY_RANK[a.e.entry.quality] - QUALITY_RANK[b.e.entry.quality] || a.i - b.i)
        .map((x) => x.e);
      const top = cands[0];
      if (!top) return null;
      return wrap(top, task.kind);
    },
  };
}

function wrap(re: RouterEntry, kind: TaskKind): ResolvedModel {
  const effort = re.entry.reasoningEffortByTask?.[kind] ?? re.entry.reasoningEffort;
  return {
    id: `${re.entry.provider}:${re.entry.id}`,
    provider: re.entry.provider,
    model: re.entry.id,
    complete(prompt: string, opts: CompleteOpts = {}) {
      return re.provider.complete(re.entry.id, prompt, { ...opts, reasoningEffort: opts.reasoningEffort ?? effort });
    },
  };
}

/** Task kinds that currently resolve to nothing (for doctor / models). */
export function unresolvedKinds(router: Router): TaskKind[] {
  return (["tag", "summary", "entities", "edge-judge", "cleanup", "synthesis"] as TaskKind[]).filter((k) => router.resolve({ kind: k }) === null);
}
