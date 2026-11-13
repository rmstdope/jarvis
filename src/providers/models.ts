import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../core/config.ts";
import { OMLX_EMBED_MODEL, OMLX_URL, PROBE_TIMEOUT_MS } from "../core/constants.ts";
import { COPILOT_CLI_DEFAULT } from "./copilot.ts";
import { OPENAI_DEFAULTS } from "./openaiCompat.ts";
import { ollamaModels } from "./local.ts";
import { REASONING_EFFORTS, TASK_KINDS, type Quality, type ReasoningEffort, type TaskKind } from "./types.ts";

export type ProviderName = "local" | "copilot" | "openai-compat";
export const PROVIDER_NAMES: ProviderName[] = ["local", "copilot", "openai-compat"];
export const DEFAULT_PREFERENCE: ProviderName[] = ["local", "openai-compat", "copilot"];
/**
 * Copilot model id used by live detection: `default`, which lets the Copilot CLI pick the account's own
 * default model; override with JARVIS_COPILOT_MODEL (an id your entitlement offers, `copilot --help`).
 * Detection sets no reasoning effort: the Copilot CLI refuses one for a model that lacks it.
 */
export const COPILOT_DEFAULT_MODEL = (): string => process.env.JARVIS_COPILOT_MODEL || COPILOT_CLI_DEFAULT;
/** Model id used when OPENAI_API_KEY is detected; override with JARVIS_OPENAI_MODEL. */
export const OPENAI_DEFAULT_MODEL = () => process.env.JARVIS_OPENAI_MODEL ?? "gpt-4o";

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

/** The models.toml in use: JARVIS_MODELS when set and non-empty, else {@link defaultModelsPath}. */
export function modelsPath(): string {
  return process.env.JARVIS_MODELS || defaultModelsPath();
}

/** The models.toml used when JARVIS_MODELS is unset: `models.toml` in the config home. */
export function defaultModelsPath(): string {
  return join(configHome(), "models.toml");
}

/**
 * Whether JARVIS_MODELS names a file that does not exist. Such a path is a mistake to name, never a reason to
 * fall back to live detection: the user chose a file, and detection could pick a cloud model they did not.
 */
export function namedModelsFileMissing(): boolean {
  const named = process.env.JARVIS_MODELS;
  return !!named && !existsSync(named);
}

/** The exact fix for a JARVIS_MODELS naming a missing file: write that file, or stop naming it. */
export function missingModelsFileFix(): string {
  return `jarvis config preset <name>   or   jarvis config redetect --write   or   unset JARVIS_MODELS to use ${defaultModelsPath()}`;
}

/** Identity of the models.toml on disk (path, mtime, size), or "absent": changes when the file is edited, created or removed (an edit that keeps the size within one coarse mtime tick is missed). */
export function modelsSignature(): string {
  const p = modelsPath();
  try {
    const st = statSync(p);
    return `${p}|${st.mtimeMs}|${st.size}`;
  } catch {
    return `${p}|absent`;
  }
}

function asQuality(q: unknown): Quality {
  return q === "cheap" || q === "standard" || q === "high" ? q : "standard";
}
function asEffort(e: unknown, where: string): ReasoningEffort | undefined {
  if (e === undefined) return undefined;
  if (!REASONING_EFFORTS.includes(e as ReasoningEffort)) throw new Error(`${where}: invalid reasoningEffort "${e}" (one of ${REASONING_EFFORTS.join("|")})`);
  return e as ReasoningEffort;
}

/** Whether a `[[model]]` provider or id is usable: a non-empty string. */
function isKey(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}
/** How a `[[model]]` key reads: usable, absent, or present but empty or not a string. */
function keyState(v: unknown): "ok" | "missing" | "bad" {
  return isKey(v) ? "ok" : v === undefined ? "missing" : "bad";
}

/**
 * Parse models.toml. Entries whose provider/id is missing, empty or not a string, and a single `[model]` table,
 * are dropped; `jarvis doctor` names them and misspelt ones ({@link ignoredModelsEntries}). Throws on malformed
 * TOML ({@link modelsTomlError}).
 */
export function parseModelsToml(text: string): { preference: ProviderName[]; models: ModelEntry[] } {
  const t = Bun.TOML.parse(text) as { preference?: unknown; model?: Record<string, unknown>[] };
  const preference = Array.isArray(t.preference) ? (t.preference.filter((p) => PROVIDER_NAMES.includes(p as ProviderName)) as ProviderName[]) : DEFAULT_PREFERENCE;
  const models: ModelEntry[] = [];
  for (const m of Array.isArray(t.model) ? t.model : []) {
    if (!m || !isKey(m.provider) || !isKey(m.id) || !PROVIDER_NAMES.includes(m.provider as ProviderName)) continue;
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

/** The TOML parser's message when `text` is not valid TOML, else null; `jarvis doctor` shows it. */
export function modelsTomlError(text: string): string | null {
  try {
    Bun.TOML.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The entries {@link parseModelsToml} skips, each named as a person would find it in the file:
 * a `models` table or key and a single `[model]` table (the parser reads `[[model]]`), every `[[model]]`
 * whose provider is not one of {@link PROVIDER_NAMES}, and every `[[model]]` whose provider or id is missing, or
 * present but empty or not a string, each said as such (named by the key it does have, or by its 1-based position
 * when it has neither). Empty when none occurs; malformed TOML is {@link modelsTomlError}'s to report.
 */
export function ignoredModelsEntries(text: string): string[] {
  let t: { models?: unknown; model?: unknown };
  try {
    t = Bun.TOML.parse(text) as typeof t;
  } catch {
    return [];
  }
  const ignored: string[] = [];
  if (t.models !== undefined) ignored.push(Array.isArray(t.models) ? "the [[models]] table" : "the models key");
  if (t.model !== undefined && !Array.isArray(t.model)) ignored.push("the [model] table");
  const entries = Array.isArray(t.model) ? (t.model as Record<string, unknown>[]) : [];
  entries.forEach((m, i) => {
    if (!m || typeof m !== "object") return;
    const provider = keyState(m.provider);
    const id = keyState(m.id);
    const wrong = (key: string, state: "missing" | "bad"): string => (state === "missing" ? `missing ${key}` : `whose ${key} is empty or not a string`);
    if (provider !== "ok" && id !== "ok") {
      const both =
        provider === id
          ? provider === "missing"
            ? "missing provider and id"
            : "whose provider and id are empty or not strings"
          : provider === "missing"
            ? "missing provider, with an id that is empty or not a string"
            : "missing id, with a provider that is empty or not a string";
      ignored.push(`the [[model]] #${i + 1} ${both}`);
    } else if (provider !== "ok") ignored.push(`the [[model]] with id "${m.id}" ${wrong("provider", provider)}`);
    else if (!PROVIDER_NAMES.includes(m.provider as ProviderName)) ignored.push(`the [[model]] with provider "${m.provider}"${id === "ok" ? ` (${m.id})` : ` ${wrong("id", id)}`}`);
    else if (id !== "ok") ignored.push(`the [[model]] with provider "${m.provider}" ${wrong("id", id)}`);
  });
  return ignored;
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
    models.push({ provider: "copilot", id: COPILOT_DEFAULT_MODEL(), quality: "high", bestFor: [...TASK_KINDS] });
  }
  if ((opts.openaiKey ?? (() => !!process.env.OPENAI_API_KEY))()) models.push({ provider: "openai-compat", id: OPENAI_DEFAULT_MODEL(), quality: "high", baseUrl: OPENAI_DEFAULTS.baseUrl, apiKeyEnv: OPENAI_DEFAULTS.apiKeyEnv, bestFor: ["synthesis"] });
  return { preference: DEFAULT_PREFERENCE, models };
}

/**
 * A models.toml that exists but cannot be loaded (malformed TOML, or an invalid value). Its message names the
 * file and points at `jarvis doctor`, which names the broken entry; `reason` is the bare cause doctor shows.
 */
export class ModelsConfigError extends Error {
  /** The parser's or validator's own message, without the path. */
  readonly reason: string;
  /** The models.toml that could not be loaded. */
  readonly path: string;
  /** The file and the cause, without the CLI fix line: what a browser user is shown. */
  readonly summary: string;
  /** `fix` replaces the default doctor pointer when the cause has an exact fix of its own. */
  constructor(path: string, reason: string, fix = "run jarvis doctor, which names the broken entry and how to fix it") {
    const summary = `${path} could not be loaded: ${reason}`;
    super(`${summary}\nfix: ${fix}`);
    this.name = "ModelsConfigError";
    this.path = path;
    this.reason = reason;
    this.summary = summary;
  }
}

/**
 * The models config: models.toml when it exists (throws {@link ModelsConfigError} if it cannot be loaded), else live
 * detection. A JARVIS_MODELS naming a missing file throws {@link ModelsConfigError} rather than detecting.
 */
export async function loadModelsConfig(detect: DetectOpts = {}): Promise<ModelsConfig> {
  const p = modelsPath();
  if (namedModelsFileMissing()) throw new ModelsConfigError(p, "JARVIS_MODELS names it, and it does not exist", missingModelsFileFix());
  if (existsSync(p)) {
    let parsed: ReturnType<typeof parseModelsToml>;
    try {
      parsed = parseModelsToml(readFileSync(p, "utf8"));
    } catch (e) {
      throw new ModelsConfigError(p, e instanceof Error ? e.message : String(e));
    }
    return { ...parsed, source: "file", path: p };
  }
  return { ...(await detectModels(detect)), source: "detected" };
}
export function writeModelsConfig(cfg: { preference: ProviderName[]; models: ModelEntry[] }): string {
  const p = modelsPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, serializeModelsToml(cfg));
  return p;
}
