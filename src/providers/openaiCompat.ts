import { LLM_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "../core/constants.ts";
import { TruncationError, type CompleteOpts, type Provider } from "./types.ts";

export interface OpenAICompatConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  extraBody?: Record<string, unknown>;
}
/** Any OpenAI-compatible chat-completions server: OpenAI itself, oMLX, vLLM, LM Studio, a gateway. */
export const OPENAI_DEFAULTS = { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" };

export function openaiCompatProvider(name: "openai-compat" = "openai-compat", cfg: OpenAICompatConfig = {}): Provider {
  const baseUrl = cfg.baseUrl?.replace(/\/$/, "");
  const keyEnv = cfg.apiKeyEnv;
  const key = keyEnv ? process.env[keyEnv] : undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  return {
    name,
    async available() {
      if (!baseUrl) return false;
      if (keyEnv && !key) return false; // a configured key env var that is unset means "not available"
      try {
        const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return r.ok;
      } catch {
        return false;
      }
    },
    async complete(modelId, prompt, opts: CompleteOpts = {}) {
      if (!baseUrl) throw new Error(`${name}: no baseUrl configured`);
      const body: Record<string, unknown> = { model: modelId, messages: [{ role: "user", content: prompt }], stream: false, ...(cfg.extraBody ?? {}) };
      if (opts.json) body.response_format = { type: "json_object" };
      else if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort; // mutually exclusive with response_format
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      const r = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`${name} chat failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
      const c = j.choices?.[0];
      if (c?.finish_reason === "length") throw new TruncationError();
      return c?.message?.content ?? "";
    },
  };
}
