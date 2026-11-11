import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { osUsername } from "./util.ts";
import { DEFAULT_PORT } from "./constants.ts";

export interface MachineConfig {
  author?: string;
  dataDir?: string;
  dataRoot?: string;
  preset?: string;
  port?: number;
  projectionRole?: "consumer" | "publisher";
  embeddingProvider?: "ollama" | "omlx";
  omlxApiKey?: string;
  inboxDir?: string;
  chatModel?: string;
}

export function configHome(): string {
  if (process.env.JARVIS_HOME) return process.env.JARVIS_HOME;
  const base = process.platform === "win32" ? process.env.USERPROFILE ?? homedir() : homedir();
  return join(base, ".jarvis");
}
export function configPath(): string {
  return join(configHome(), "config.toml");
}

let cached: { path: string; cfg: MachineConfig; malformed: boolean } | null = null;

export function loadConfig(): MachineConfig {
  const p = configPath();
  if (cached && cached.path === p) return cached.cfg;
  let cfg: MachineConfig = {};
  let malformed = false;
  if (existsSync(p)) {
    try {
      cfg = (Bun.TOML.parse(readFileSync(p, "utf8")) as MachineConfig) ?? {};
    } catch {
      malformed = true;
      cfg = {};
    }
  }
  cached = { path: p, cfg, malformed };
  return cfg;
}
export function configIsMalformed(): boolean {
  loadConfig();
  return cached?.malformed ?? false;
}
export function resetConfigCache(): void {
  cached = null;
}

function tomlValue(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

export function saveConfig(cfg: MachineConfig): void {
  mkdirSync(configHome(), { recursive: true });
  const lines: string[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null || v === "") continue;
    lines.push(`${k} = ${tomlValue(v)}`);
  }
  writeFileSync(configPath(), lines.join("\n") + "\n");
  try {
    chmodSync(configPath(), 0o600);
  } catch {}
  resetConfigCache();
}

export function updateConfig(patch: Partial<MachineConfig>): MachineConfig {
  const cfg = { ...loadConfig(), ...patch };
  saveConfig(cfg);
  return cfg;
}

/** content repo = --data → JARVIS_DATA → config dataDir → error */
export function resolveDataDir(explicit?: string): string {
  const d = explicit || process.env.JARVIS_DATA || loadConfig().dataDir;
  if (!d) throw new Error("No content repo configured: run `jarvis init` or pass --data <dir> / JARVIS_DATA");
  return d;
}
/** author = explicit → JARVIS_AUTHOR → config → OS user → unknown */
export function resolveAuthor(explicit?: string): string {
  return explicit || process.env.JARVIS_AUTHOR || loadConfig().author || osUsername() || "unknown";
}
export function resolvePort(explicit?: number | string): number {
  const n = Number(explicit ?? loadConfig().port ?? DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}
export function resolveRole(): "consumer" | "publisher" {
  return loadConfig().projectionRole ?? "consumer";
}
export function resolveEmbeddingProvider(): "ollama" | "omlx" {
  return loadConfig().embeddingProvider ?? "ollama";
}

/** Shared team policy from <dataDir>/config/team.toml */
export function loadTeamConfig(dataDir: string): { projection: { mode: "local" | "published" }; privacy: { transcriptsToCloud: boolean } } {
  const none = { projection: { mode: "local" as const }, privacy: { transcriptsToCloud: false } };
  const p = join(dataDir, "config", "team.toml");
  if (!existsSync(p)) return none;
  try {
    const t = Bun.TOML.parse(readFileSync(p, "utf8")) as { projection?: { mode?: string }; privacy?: { transcripts_to_cloud?: unknown } };
    const mode = t.projection?.mode === "published" ? "published" : "local";
    return { projection: { mode }, privacy: { transcriptsToCloud: t.privacy?.transcripts_to_cloud === true } };
  } catch {
    return none;
  }
}
/** True when this machine only consumes a published projection (never embeds or runs LLMs). */
export function isConsumer(dataDir: string): boolean {
  return loadTeamConfig(dataDir).projection.mode === "published" && resolveRole() === "consumer";
}
