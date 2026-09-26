import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../core/config.ts";
import { OMLX_EMBED_MODEL, OMLX_URL, PROBE_TIMEOUT_MS } from "../core/constants.ts";
import { OPENAI_DEFAULTS } from "./openaiCompat.ts";
import { ollamaModels } from "./local.ts";
import { REASONING_EFFORTS, TASK_KINDS, type Quality, type ReasoningEffort, type TaskKind } from "./types.ts";

export type ProviderName = "local" | "copilot" | "openai-compat";
export const PROVIDER_NAMES: ProviderName[] = ["local", "copilot", "openai-compat"];
export const DEFAULT_PREFERENCE: ProviderName[] = ["local", "openai-compat", "copilot"];
/** Copilot model id used by live detection; override with SECOND_BRAIN_COPILOT_MODEL. Must be an id your entitlement offers (`copilot --help`). */
export const COPILOT_DEFAULT_MODEL = () => process.env.SECOND_BRAIN_COPILOT_MODEL ?? "gpt-4.1";
/** Model id used when OPENAI_API_KEY is detected; override with SECOND_BRAIN_OPENAI_MODEL. */
export const OPENAI_DEFAULT_MODEL = () => process.env.SECOND_BRAIN_OPENAI_MODEL ?? "gpt-4o";

export interface ModelEntry {
  provider: ProviderName;
  id: string;
  quality: Quality;
  langs?: string[];
  bestFor?: TaskKind[];
  reasoningEffort?: ReasoningEffort;
  reasoningEffortByTask?: Partial<Record<TaskKind, ReasoningEffort>>;
  baseUrl?: string;
  apiKeyEnv?: string;
  extraBody?: Record<string, unknown>;
}
export interface ModelsConfig {
  preference: ProviderName[];
  models: ModelEntry[];
  source: "file" | "detected";
  path?: string;
}

export function modelsPath(): string {
  return process.env.SECOND_BRAIN_MODELS ?? join(configHome(), "models.toml");
}

function asQuality(q: unknown): Quality {
  return q === "cheap" || q === "standard" || q === "high" ? q : "standard";
}
function asEffort(e: unknown, where: string): ReasoningEffort | undefined {
  if (e === undefined) return undefined;
  if (!REASONING_EFFORTS.includes(e as ReasoningEffort)) throw new Error(`${where}: invalid reasoningEffort "${e}" (one of ${REASONING_EFFORTS.join("|")})`);
  return e as ReasoningEffort;
}

/** Parse models.toml. Entries missing provider/id are dropped silently. */
export function parseModelsToml(text: string): { preference: ProviderName[]; models: ModelEntry[] } {
  const t = Bun.TOML.parse(text) as { preference?: unknown; model?: Record<string, unknown>[] };
  const preference = Array.isArray(t.preference) ? (t.preference.filter((p) => PROVIDER_NAMES.includes(p as ProviderName)) as ProviderName[]) : DEFAULT_PREFERENCE;
  const models: ModelEntry[] = [];
  for (const m of t.model ?? []) {
    if (!m || typeof m.provider !== "string" || typeof m.id !== "string" || !PROVIDER_NAMES.includes(m.provider as ProviderName)) continue;
    const where = `models.toml [[model]] ${m.provider}:${m.id}`;
    const entry: ModelEntry = { provider: m.provider as ProviderName, id: m.id, quality: asQuality(m.quality) };
    if (Array.isArray(m.langs)) entry.langs = m.langs.map(String);
    if (Array.isArray(m.bestFor)) entry.bestFor = m.bestFor.filter((k) => TASK_KINDS.includes(k as TaskKind)) as TaskKind[];
    if (m.provider === "copilot") {
      entry.reasoningEffort = asEffort(m.reasoningEffort, where);
      if (m.reasoningEffortByTask && typeof m.reasoningEffortByTask === "object") {
        entry.reasoningEffortByTask = {};
        for (const [k, v] of Object.entries(m.reasoningEffortByTask as Record<string, unknown>)) {
          if (TASK_KINDS.includes(k as TaskKind)) entry.reasoningEffortByTask[k as TaskKind] = asEffort(v, where);
        }
      }
    }
    if (typeof m.baseUrl === "string") entry.baseUrl = m.baseUrl;
    if (typeof m.apiKeyEnv === "string") entry.apiKeyEnv = m.apiKeyEnv;
    if (m.extraBody && typeof m.extraBody === "object") entry.extraBody = m.extraBody as Record<string, unknown>;
    models.push(entry);
  }
  return { preference: preference.length ? preference : DEFAULT_PREFERENCE, models };
}

function tomlInline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(tomlInline).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlInline(x)}`).join(", ")} }`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}
export function serializeModelsToml(cfg: { preference: ProviderName[]; models: ModelEntry[] }): string {
  const out: string[] = [`preference = ${tomlInline(cfg.preference)}`, ""];
  for (const m of cfg.models) {
    out.push("[[model]]");
    for (const [k, v] of Object.entries(m)) if (v !== undefined) out.push(`${k} = ${tomlInline(v)}`);
    out.push("");
  }
  return out.join("\n");
}

export interface DetectOpts {
  ollama?: () => Promise<string[]>;
  omlxModels?: () => Promise<string[]>;
  copilotOnPath?: () => boolean;
  openaiKey?: () => boolean;
}
async function omlxModelsDefault(): Promise<string[]> {
  try {
    const r = await fetch(`${OMLX_URL}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id).filter((id) => id !== OMLX_EMBED_MODEL);
  } catch {
    return [];
  }
}

/** Synthesize a config from live detection when no models.toml exists. */
export async function detectModels(opts: DetectOpts = {}): Promise<{ preference: ProviderName[]; models: ModelEntry[] }> {
  const models: ModelEntry[] = [];
  const names = await (opts.ollama ?? ollamaModels)();
  for (const n of names) {
    if (/embed/i.test(n)) continue;
    if (/^gemma4:26b/.test(n)) models.push({ provider: "local", id: n, quality: "high", langs: ["sv", "en"], bestFor: ["cleanup"] });
    else if (/^qwen3/.test(n)) models.push({ provider: "local", id: n, quality: "high", bestFor: ["edge-judge", "summary", "entities"] });
    else models.push({ provider: "local", id: n, quality: "standard" });
  }
  const omlx = await (opts.omlxModels ?? omlxModelsDefault)();
  if (omlx[0]) models.push({ provider: "openai-compat", id: omlx[0], quality: "high", baseUrl: OMLX_URL, apiKeyEnv: "OMLX_API_KEY", extraBody: { chat_template_kwargs: { enable_thinking: false } } });
  if ((opts.copilotOnPath ?? (() => Bun.which("copilot") !== null))()) {
    models.push({ provider: "copilot", id: COPILOT_DEFAULT_MODEL(), quality: "high", bestFor: [...TASK_KINDS], reasoningEffort: "high", reasoningEffortByTask: { "edge-judge": "xhigh" } });
  }
  if ((opts.openaiKey ?? (() => !!process.env.OPENAI_API_KEY))()) models.push({ provider: "openai-compat", id: OPENAI_DEFAULT_MODEL(), quality: "high", baseUrl: OPENAI_DEFAULTS.baseUrl, apiKeyEnv: OPENAI_DEFAULTS.apiKeyEnv, bestFor: ["synthesis"] });
  return { preference: DEFAULT_PREFERENCE, models };
}

export async function loadModelsConfig(detect: DetectOpts = {}): Promise<ModelsConfig> {
  const p = modelsPath();
  if (existsSync(p)) return { ...parseModelsToml(readFileSync(p, "utf8")), source: "file", path: p };
  return { ...(await detectModels(detect)), source: "detected" };
}
export function writeModelsConfig(cfg: { preference: ProviderName[]; models: ModelEntry[] }): string {
  const p = modelsPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, serializeModelsToml(cfg));
  return p;
}
