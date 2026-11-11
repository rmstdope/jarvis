import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { WHISPER_TIMEOUT_MS } from "../core/constants.ts";

export type WhisperBackend = "mlx_whisper" | "faster-whisper" | "whisper-cli";

export interface Runner {
  (args: string[], opts?: { cwd?: string; timeoutMs?: number }): { code: number; stdout: string; stderr: string };
}
export const defaultRunner: Runner = (args, opts = {}) => {
  const p = Bun.spawnSync(args, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs });
  return { code: p.exitCode, stdout: new TextDecoder().decode(p.stdout), stderr: new TextDecoder().decode(p.stderr) };
};

export type Which = (bin: string) => string | null;

/** Preference: mlx_whisper → faster-whisper → whisper-cli (whisper.cpp; legacy `main` only if --help reads as whisper.cpp). */
export function detectWhisperBackend(run: Runner = defaultRunner, which: Which = (b) => Bun.which(b)): WhisperBackend | null {
  const forced = process.env.JARVIS_WHISPER as WhisperBackend | undefined;
  if (forced) return forced;
  const onPath = (bin: string) => which(bin) !== null;
  if (onPath("mlx_whisper")) return "mlx_whisper";
  if (onPath("faster-whisper")) return "faster-whisper";
  if (onPath("whisper-cli")) return "whisper-cli";
  if (onPath("main")) {
    const h = run(["main", "--help"]);
    if (/whisper\.cpp|whisper/i.test(h.stdout + h.stderr)) return "whisper-cli";
  }
  return null;
}

export const NO_BACKEND_MESSAGE = [
  "no Whisper backend found. Install one:",
  "  macOS (Apple Silicon): pipx install mlx-whisper",
  "  any:                   pipx install faster-whisper",
  "  whisper.cpp:           brew install whisper-cpp   (provides whisper-cli)",
  "or use a no-Whisper path: `jarvis meeting <teams-export>.vtt` or `jarvis meeting <pasted-transcript>.md`",
].join("\n");

export interface TranscribeOpts {
  lang?: string;
  initialPrompt?: string;
  backend?: WhisperBackend;
  run?: Runner;
}

/** Run the backend and return plain transcript text. */
export function transcribeAudio(file: string, opts: TranscribeOpts = {}): { text: string; backend: WhisperBackend } {
  const run = opts.run ?? defaultRunner;
  const backend = opts.backend ?? detectWhisperBackend(run);
  if (!backend) throw new Error(NO_BACKEND_MESSAGE);
  const out = mkdtempSync(join(tmpdir(), "jarvis-whisper-"));
  try {
    let r;
    if (backend === "mlx_whisper") {
      const args = ["mlx_whisper", file, "--output-dir", out, "--output-format", "txt", "--verbose", "False"];
      if (opts.lang) args.push("--language", opts.lang);
      if (opts.initialPrompt) args.push("--initial-prompt", opts.initialPrompt);
      r = run(args, { timeoutMs: WHISPER_TIMEOUT_MS });
    } else if (backend === "faster-whisper") {
      const args = ["faster-whisper", file, "--output_dir", out, "--output_format", "txt"];
      if (opts.lang) args.push("--language", opts.lang);
      if (opts.initialPrompt) args.push("--initial_prompt", opts.initialPrompt);
      r = run(args, { timeoutMs: WHISPER_TIMEOUT_MS });
    } else {
      const model = process.env.JARVIS_WHISPER_MODEL;
      const args = ["whisper-cli", "-f", file, "-otxt", "-of", join(out, "out"), "-np"];
      if (model) args.push("-m", model);
      if (opts.lang) args.push("-l", opts.lang);
      if (opts.initialPrompt) args.push("--prompt", opts.initialPrompt);
      r = run(args, { timeoutMs: WHISPER_TIMEOUT_MS });
    }
    if (r.code !== 0) throw new Error(`${backend} failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    const txt = readdirSync(out).find((f) => f.endsWith(".txt"));
    const text = txt ? readFileSync(join(out, txt), "utf8").trim() : r.stdout.trim();
    if (!text) throw new Error(`${backend} produced no transcript`);
    return { text, backend };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A same-stem sibling .vtt (not containing "whisper") next to the audio file. */
export function siblingVtt(file: string): string | null {
  const dir = dirname(file);
  const stem = basename(file, extname(file));
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (f.toLowerCase().endsWith(".vtt") && !/whisper/i.test(f) && basename(f, ".vtt") === stem) return join(dir, f);
  }
  return null;
}
