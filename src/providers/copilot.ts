import { LLM_TIMEOUT_MS } from "../core/constants.ts";
import { parseJsonObject, type CompleteOpts, type Provider } from "./types.ts";

export type Spawn = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
const defaultSpawn: Spawn = async (args, timeoutMs) => {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
};

/** Take the last assistant.message event's content from the NDJSON stream; fallback to the first {…} block. */
export function parseCopilotOutput(stdout: string): string {
  let last: string | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as { type?: string; data?: { content?: string }; content?: string };
      if (ev.type === "assistant.message") last = ev.data?.content ?? ev.content ?? last;
    } catch {}
  }
  if (last !== null) return last;
  try {
    return JSON.stringify(parseJsonObject(stdout));
  } catch {
    return stdout.trim();
  }
}

/**
 * The Copilot model id that passes no --model, so the CLI uses the account's own default model.
 * Live detection and the shipped presets use it: a named id is refused on an account that does not offer it.
 */
export const COPILOT_CLI_DEFAULT = "default";

/** Headless GitHub Copilot CLI. Availability is PATH-only. Never --allow-all-tools. */
export function copilotProvider(spawn: Spawn = defaultSpawn, which: (b: string) => string | null = (b) => Bun.which(b)): Provider {
  return {
    name: "copilot",
    async available() {
      return which("copilot") !== null;
    },
    async complete(modelId, prompt, opts: CompleteOpts = {}) {
      const args = ["copilot", "-p", prompt, ...(modelId === COPILOT_CLI_DEFAULT ? [] : ["--model", modelId]), "--silent", "--output-format", "json", "--no-color", "--disable-builtin-mcps", "--no-custom-instructions"];
      if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
      const r = await spawn(args, LLM_TIMEOUT_MS);
      if (r.code !== 0) throw new Error(`copilot failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`);
      return parseCopilotOutput(r.stdout);
    },
  };
}

/**
 * The model ids listed under `model` in `copilot help config`: the CLI's catalog, which a `--model`
 * outside it is refused against ("… from --model flag is not available"). Null when the section is absent.
 */
export function parseCopilotModelCatalog(help: string): string[] | null {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => /^\s*`model`:/.test(l));
  if (start < 0) return null;
  const ids: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*`/.test(l)) break;
    const m = /^\s*-\s*"([^"]+)"/.exec(l);
    if (m) ids.push(m[1]);
  }
  return ids.length ? ids : null;
}

/** Reads the catalog from `copilot help config`; null when the CLI is missing, fails or lists none. */
export async function readCopilotModelCatalog(spawn: Spawn = defaultSpawn, which: (b: string) => string | null = (b) => Bun.which(b)): Promise<string[] | null> {
  if (!which("copilot")) return null;
  try {
    const r = await spawn(["copilot", "help", "config"], 10_000);
    return r.code === 0 ? parseCopilotModelCatalog(r.stdout) : null;
  } catch {
    return null;
  }
}
