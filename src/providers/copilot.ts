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

/** Headless GitHub Copilot CLI. Availability is PATH-only. Never --allow-all-tools. */
export function copilotProvider(spawn: Spawn = defaultSpawn, which: (b: string) => string | null = (b) => Bun.which(b)): Provider {
  return {
    name: "copilot",
    async available() {
      return which("copilot") !== null;
    },
    async complete(modelId, prompt, opts: CompleteOpts = {}) {
      const args = ["copilot", "-p", prompt, "--model", modelId, "--silent", "--output-format", "json", "--no-color", "--disable-builtin-mcps", "--no-custom-instructions"];
      if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
      const r = await spawn(args, LLM_TIMEOUT_MS);
      if (r.code !== 0) throw new Error(`copilot failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`);
      return parseCopilotOutput(r.stdout);
    },
  };
}
