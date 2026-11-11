import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { configIsMalformed, configPath, loadConfig, resolveDataDir } from "./config.ts";
import { EMBEDDING_DIMS } from "./constants.ts";
import { ensureCustomSqlite } from "./db.ts";
import { getEmbedder } from "./embed.ts";
import { hasRemote, isWorkTree } from "./git.ts";
import { modelsPath } from "../providers/models.ts";
import { getRouter } from "../providers/index.ts";
import { unresolvedKinds } from "../providers/router.ts";
import { detectWhisperBackend } from "../producers/whisper.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export interface Check {
  name: string;
  required: boolean;
  status: CheckStatus;
  detail: string;
  fix?: string;
}
export interface DoctorReport {
  summary: { ok: number; warn: number; fail: number; skip: number; healthy: boolean };
  checks: Check[];
}
export interface DoctorOpts {
  coreOnly?: boolean;
  port?: number;
  dataDir?: string;
  which?: (b: string) => string | null;
  embedProbe?: () => Promise<number>; // returns dims
  /** Absolute path of the code repo doctor runs from (seam for tests). */
  codeRepo?: string;
  /** The user's home directory (seam for tests). */
  home?: string;
  /** The user's login shell, e.g. `/bin/zsh` (seam for tests). */
  shell?: string;
}

/** Probes for {@link checkJarvisCommand}; all injectable so every state is unit-tested. */
export interface JarvisCommandProbe {
  /** Where `jarvis` resolves on PATH, or null. */
  found: string | null;
  codeRepo: string;
  home: string;
  shell: string;
  exists: (p: string) => boolean;
  realpath: (p: string) => string;
}

/** Checks that a plain `jarvis` command on PATH runs this copy of the code; always a warning, never a failure. */
export function checkJarvisCommand(o: JarvisCommandProbe): Check {
  const name = "jarvis-command";
  const link = `cd ${o.codeRepo} && bun link`;
  if (o.found) {
    let target = "";
    try {
      target = o.realpath(o.found);
    } catch {}
    if (target === join(o.codeRepo, "src", "cli.ts")) return ok(name, false, "jarvis on PATH");
    const other = target ? dirname(dirname(target)) : o.found;
    return warn(name, `jarvis on PATH runs ${other}, not ${o.codeRepo}`, link);
  }
  if (o.exists(join(o.home, ".bun", "bin", "jarvis"))) {
    const sh = basename(o.shell);
    const fix = sh === "fish" ? "fish_add_path ~/.bun/bin" : `echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ${sh === "zsh" ? "~/.zshrc" : sh === "bash" ? "~/.bashrc" : "~/.profile"}`;
    return warn(name, "jarvis is installed in ~/.bun/bin, but that folder is not on PATH", `${fix}   then open a new terminal`);
  }
  return warn(name, "jarvis is not on PATH, so agents in the content repo cannot run it", link);
}

const ok = (name: string, required: boolean, detail: string): Check => ({ name, required, status: "ok", detail });
const bad = (name: string, required: boolean, detail: string, fix: string): Check => ({ name, required, status: required ? "fail" : "warn", detail, fix });
const warn = (name: string, detail: string, fix?: string): Check => ({ name, required: false, status: "warn", detail, fix });

export function checkSqliteVec(): Check {
  const dir = mkdtempSync(join(tmpdir(), "jv-doctor-"));
  try {
    ensureCustomSqlite();
    const db = new Database(join(dir, "t.db"));
    sqliteVec.load(db);
    db.run(`CREATE VIRTUAL TABLE v USING vec0(id TEXT PRIMARY KEY, e float[${EMBEDDING_DIMS}])`);
    const unit = new Array(EMBEDDING_DIMS).fill(0);
    unit[0] = 1;
    db.run("INSERT INTO v (id, e) VALUES ('a', ?)", [JSON.stringify(unit)]);
    const r = db.query("SELECT id FROM v WHERE e MATCH ? AND k = 1").get(JSON.stringify(unit)) as { id: string } | null;
    const ver = (db.query("SELECT vec_version() v").get() as { v: string }).v;
    db.close();
    if (r?.id !== "a") return bad("sqlite-vec", true, "kNN query returned nothing", "reinstall: bun install (sqlite-vec) and on macOS brew install sqlite");
    return ok("sqlite-vec", true, `loaded ${ver}, kNN round trip works`);
  } catch (e) {
    return bad("sqlite-vec", true, (e as Error).message, process.platform === "darwin" ? "brew install sqlite   (Bun's bundled SQLite cannot load extensions)" : "bun install; on Linux ensure libsqlite3 allows extension loading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function doctor(opts: DoctorOpts = {}): Promise<DoctorReport> {
  const which = opts.which ?? ((b: string) => Bun.which(b));
  const checks: Check[] = [];
  checks.push(which("bun") ? ok("bun", true, `bun ${Bun.version}`) : bad("bun", true, "bun not on PATH", "curl -fsSL https://bun.sh/install | bash"));
  checks.push(which("git") ? ok("git", true, "git on PATH") : bad("git", true, "git not on PATH", process.platform === "darwin" ? "xcode-select --install" : "install git with your package manager"));
  checks.push(checkSqliteVec());
  checks.push(checkJarvisCommand({ found: which("jarvis"), codeRepo: opts.codeRepo ?? join(import.meta.dir, "..", ".."), home: opts.home ?? homedir(), shell: opts.shell ?? process.env.SHELL ?? "", exists: existsSync, realpath: realpathSync }));

  const embedder = getEmbedder();
  if (await embedder.available()) {
    checks.push(ok("embedding-server", true, `${embedder.name} reachable`));
    try {
      const dims = opts.embedProbe ? await opts.embedProbe() : (await embedder.embed(["doctor probe"]))[0].length;
      checks.push(dims === EMBEDDING_DIMS ? ok("embed-model", true, `${embedder.model} → ${dims} dims`) : bad("embed-model", true, `got ${dims} dims, expected ${EMBEDDING_DIMS}`, "the embedding contract is 512 dims after truncation; check the embedder implementation"));
    } catch (e) {
      checks.push(bad("embed-model", true, (e as Error).message, embedder.name === "ollama" ? `ollama pull ${embedder.model}` : `load ${embedder.model} in oMLX`));
    }
  } else {
    checks.push(bad("embedding-server", true, `${embedder.name} unreachable`, embedder.name === "ollama" ? "install Ollama (https://ollama.com), run `ollama serve`, then `ollama pull qwen3-embedding:0.6b`" : "start oMLX on http://127.0.0.1:8000 or set JARVIS_OMLX_URL"));
    checks.push({ name: "embed-model", required: true, status: "skip", detail: "skipped: embedding server unreachable" });
  }

  const cfgPath = configPath();
  if (!existsSync(cfgPath)) checks.push(bad("user-config", true, `${cfgPath} missing`, "jarvis init"));
  else if (configIsMalformed()) checks.push(bad("user-config", true, `${cfgPath} is not valid TOML`, `fix or delete ${cfgPath}, then jarvis init`));
  else checks.push(ok("user-config", true, cfgPath));

  let dataDir: string | null = null;
  try {
    dataDir = resolveDataDir(opts.dataDir);
  } catch {}
  if (!dataDir || !existsSync(dataDir)) checks.push(bad("data-dir", true, dataDir ? `${dataDir} does not exist` : "no content repo configured", "jarvis init   (or jarvis config set-data <path>)"));
  else {
    checks.push(ok("data-dir", true, dataDir));
    if (!isWorkTree(dataDir)) checks.push(bad("data-git", true, `${dataDir} is not a git work tree`, `cd ${dataDir} && git init -b main`));
    else {
      checks.push(ok("data-git", true, "git work tree"));
      checks.push(hasRemote(dataDir) ? ok("data-remote", false, "remote configured") : warn("data-remote", "no git remote: sync stays local-only", `cd ${dataDir} && git remote add origin <url>`));
    }
  }

  const mp = modelsPath();
  checks.push(existsSync(mp) ? ok("models-config", false, mp) : warn("models-config", `${mp} missing; models are detected live`, "jarvis config preset <name>   or   jarvis config redetect --write"));
  const router = await getRouter();
  if (router) {
    const avail = router.entries.filter((e) => e.available);
    checks.push(router.entries.length === 0 ? warn("models-available", "no chat models configured (Tier 0: capture/search only)", "jarvis config preset <name>") : avail.length ? ok("models-available", false, avail.map((e) => `${e.entry.provider}:${e.entry.id}`).join(", ")) : warn("models-available", "no configured model is reachable", "start Ollama / install the Copilot CLI / set OPENAI_API_KEY (or the key env named in models.toml)"));
    const missing = unresolvedKinds(router);
    checks.push(missing.length ? warn("models-tasks", `no model for: ${missing.join(", ")}`, "add a model with quality >= the task's minimum to models.toml") : ok("models-tasks", false, "every task kind resolves"));
  }

  if (!opts.coreOnly) {
    const port = opts.port ?? loadConfig().port ?? 7281;
    try {
      const s = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
      s.stop(true);
      checks.push(ok("port", false, `127.0.0.1:${port} is free`));
    } catch {
      checks.push(warn("port", `port ${port} is in use (another jarvis serve, or the macOS app?)`, `jarvis serve --port <other>   or   jarvis config set-port <n>`));
    }
    checks.push(which("copilot") ? ok("copilot", false, "copilot CLI on PATH") : warn("copilot", "copilot CLI not on PATH (Tier-1 fallback and chat unavailable)", "npm install -g @github/copilot   then   copilot auth"));
    checks.push(which("yt-dlp") ? ok("yt-dlp", false, "on PATH") : warn("yt-dlp", "yt-dlp not on PATH (YouTube capture unavailable)", process.platform === "darwin" ? "brew install yt-dlp" : "pipx install yt-dlp"));
    const wb = detectWhisperBackend(undefined, which);
    checks.push(wb ? ok("whisper", false, wb) : warn("whisper", "no Whisper backend (audio transcription unavailable; Teams .vtt and pasted transcripts still work)", process.platform === "darwin" ? "pipx install mlx-whisper" : "pipx install faster-whisper"));
    const inbox = process.env.JARVIS_INBOX ?? loadConfig().inboxDir;
    if (inbox && dataDir && inbox.startsWith(dataDir)) checks.push(warn("inbox", `inbox ${inbox} is inside the content repo`, "jarvis config set-inbox <path outside the repo>"));
    else checks.push(ok("inbox", false, inbox ?? "~/.jarvis/inbox (default)"));
  }

  const summary = { ok: 0, warn: 0, fail: 0, skip: 0, healthy: true };
  for (const c of checks) {
    summary[c.status]++;
    if (c.status === "fail") summary.healthy = false;
  }
  return { summary, checks };
}

export function formatDoctor(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "-" };
  const lines = r.checks.map((c) => `${icon[c.status]} ${c.name.padEnd(18)} ${c.detail}${c.fix && c.status !== "ok" ? `\n    fix: ${c.fix}` : ""}`);
  lines.push("", `${r.summary.ok} ok, ${r.summary.warn} warning(s), ${r.summary.fail} failure(s)${r.summary.healthy ? "" : " — fix the failures above"}`);
  return lines.join("\n");
}
