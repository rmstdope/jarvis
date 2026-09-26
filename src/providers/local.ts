import { LLM_TIMEOUT_MS, OLLAMA_TAGS_CACHE_MS, OLLAMA_URL, PROBE_TIMEOUT_MS } from "../core/constants.ts";
import { TruncationError, type CompleteOpts, type Provider } from "./types.ts";

let tagsCache: { at: number; names: string[] } | null = null;

export async function ollamaModels(base = OLLAMA_URL): Promise<string[]> {
  if (tagsCache && Date.now() - tagsCache.at < OLLAMA_TAGS_CACHE_MS) return tagsCache.names;
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: { name: string; details?: { families?: string[] }; capabilities?: string[] }[] };
    const names = (j.models ?? []).map((m) => m.name);
    tagsCache = { at: Date.now(), names };
    return names;
  } catch {
    return [];
  }
}
export function resetOllamaCache(): void {
  tagsCache = null;
}

/** Ollama chat models. think:false is mandatory for structured work. */
export function localProvider(base = OLLAMA_URL): Provider {
  return {
    name: "local",
    async available(modelId) {
      const names = await ollamaModels(base);
      return names.includes(modelId) || names.includes(`${modelId}:latest`);
    },
    async complete(modelId, prompt, opts: CompleteOpts = {}) {
      const body: Record<string, unknown> = { model: modelId, messages: [{ role: "user", content: prompt }], stream: false, think: false, options: {} };
      if (opts.json) body.format = "json";
      if (opts.maxTokens) (body.options as Record<string, unknown>).num_predict = opts.maxTokens;
      const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`ollama chat failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { message?: { content?: string }; done_reason?: string };
      if (j.done_reason === "length") throw new TruncationError();
      return j.message?.content ?? "";
    },
  };
}
