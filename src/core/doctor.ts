import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { configIsMalformed, configPath, loadConfig, resolveDataDir } from "./config.ts";
import { CHAT_PROBE_TIMEOUT_MS, EMBEDDING_DIMS, PROBE_TIMEOUT_MS } from "./constants.ts";
import { ensureCustomSqlite } from "./db.ts";
import { getEmbedder } from "./embed.ts";
import { hasRemote, isWorkTree } from "./git.ts";
import { defaultModelsPath, ignoredModelsEntries, ModelsConfigError, modelsPath, modelsTomlError, namedModelsFileMissing } from "../providers/models.ts";
import { getRouter } from "../providers/index.ts";
import { COPILOT_CLI_DEFAULT, readCopilotModelCatalog } from "../providers/copilot.ts";
import { unresolvedKinds, type RouterEntry } from "../providers/router.ts";
import { TruncationError } from "../providers/types.ts";
import { ChatHttpError } from "../providers/openaiCompat.ts";
import { detectWhisperBackend } from "../producers/whisper.ts";
import { discoverSlidecraft, listPresentations, SLIDECRAFT_DECK_GLOB, vaultListsDeck, type SlidecraftStatus } from "./presentations.ts";

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
  /** Where decks can be presented; defaults to probing for a running Slidecraft. */
  slidecraft?: (dataDir: string) => Promise<SlidecraftStatus>;
  /** Absolute path of the code repo doctor runs from (seam for tests). */
  codeRepo?: string;
  /** The user's home directory (seam for tests). */
  home?: string;
  /** The user's login shell, e.g. `/bin/zsh` (seam for tests). */
  shell?: string;
  /** The Copilot CLI's model catalog, or null when it cannot be read (seam for tests). */
  copilotCatalog?: () => Promise<string[] | null>;
  /** How long one openai-compat chat probe may take (seam for tests); defaults to `CHAT_PROBE_TIMEOUT_MS`. */
  chatProbeTimeoutMs?: number;
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
  /** Bun's install root (`$BUN_INSTALL`); defaults to `<home>/.bun`. */
  bunInstall?: string;
  /** Defaults to `process.platform`. */
  platform?: string;
}

/** Checks that a plain `jarvis` command on PATH runs this copy of the code; always a warning, never a failure. */
/** POSIX paths only: win32 returns before any comparison. */
export function checkJarvisCommand(o: JarvisCommandProbe): Check {
  const name = "jarvis-command";
  const link = `cd ${o.codeRepo} && bun link`;
  // On Windows `bun link` writes a jarvis.exe shim, not a symlink, so the target cannot be compared.
  if (o.found && (o.platform ?? process.platform) === "win32") return ok(name, false, "jarvis on PATH");
  if (o.found) {
    let target = "";
    try {
      target = o.realpath(o.found);
    } catch {}
    if (target === posix.join(o.codeRepo, "src", "cli.ts")) return ok(name, false, "jarvis on PATH");
    const other = target.endsWith(posix.join("src", "cli.ts")) ? posix.dirname(posix.dirname(target)) : target || o.found;
    return warn(name, `jarvis on PATH runs ${other}, not ${o.codeRepo}`, link);
  }
  const bunBin = posix.join(o.bunInstall ?? posix.join(o.home, ".bun"), "bin");
  if (o.exists(posix.join(bunBin, "jarvis"))) {
    const sh = posix.basename(o.shell);
    const isDefault = bunBin === posix.join(o.home, ".bun", "bin");
    const shown = isDefault ? "~/.bun/bin" : bunBin;
    const pathExpr = isDefault ? "$HOME/.bun/bin" : bunBin;
    const fix = sh === "fish" ? `echo 'fish_add_path ${shown}' >> ~/.config/fish/config.fish` : `echo 'export PATH="${pathExpr}:$PATH"' >> ${sh === "zsh" ? "~/.zshrc" : sh === "bash" ? "~/.bashrc" : "~/.profile"}`;
    return warn(name, `jarvis is installed in ${shown}, but that folder is not on PATH`, `${fix}   then open a new terminal`);
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
  checks.push(checkJarvisCommand({ found: which("jarvis"), codeRepo: opts.codeRepo ?? join(import.meta.dir, "..", ".."), home: opts.home ?? homedir(), shell: opts.shell ?? process.env.SHELL ?? "", exists: existsSync, realpath: realpathSync, bunInstall: process.env.BUN_INSTALL }));

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
  const modelsText = existsSync(mp) ? readFileSync(mp, "utf8") : null;
  const tomlError = modelsText === null ? null : modelsTomlError(modelsText);
  const ignored = modelsText === null ? [] : ignoredModelsEntries(modelsText);
  // A router that cannot load models.toml is reported in models-config, not a reason to stop the report.
  let routerError: string | null = null;
  const router = await getRouter().catch((e: unknown) => {
    routerError = e instanceof ModelsConfigError ? e.reason : e instanceof Error ? e.message : String(e);
    return null;
  });
  checks.push(
    namedModelsFileMissing()
      ? warn("models-config", `${mp} does not exist, and JARVIS_MODELS names it; model steps are skipped`, `jarvis config preset <name>   or   jarvis config redetect --write   or   unset JARVIS_MODELS to use ${defaultModelsPath()}`)
      : modelsText === null
      ? warn("models-config", `${mp} missing; models are detected live`, "jarvis config preset <name>   or   jarvis config redetect --write")
      : tomlError
        ? warn("models-config", `${mp} is not valid TOML: ${tomlError}`, `fix the TOML in ${mp}, and spell each table [[model]]   or   jarvis config preset <name>`)
        : routerError !== null
          ? warn("models-config", `${mp}: ${routerError}`, `fix that entry in ${mp}   or   jarvis config preset <name>`)
          : ignored.length
            ? warn("models-config", `${mp}: ignored ${ignored.join(", ")}`, `spell each table [[model]] and give it a provider and id, with provider local, copilot or openai-compat, in ${mp}   or   jarvis config preset <name>`)
            : ok("models-config", false, mp),
  );
  if (routerError !== null) {
    // The router could not load models.toml; say what that leaves unchecked rather than dropping the lines.
    for (const name of ["models-available", "models-tasks"]) checks.push(warn(name, "skipped: models.toml could not be loaded", `fix ${mp} as the models-config line says`));
  } else if (router) {
    // A named Copilot id outside the CLI's catalog is refused at run time (`--model … is not available`).
    const named = router.entries.filter((e) => e.available && e.entry.provider === "copilot" && e.entry.id !== COPILOT_CLI_DEFAULT && e.entry.id !== "auto");
    const catalog = named.length ? await (opts.copilotCatalog ?? (() => readCopilotModelCatalog(undefined, which)))() : null;
    const refused = catalog ? named.filter((e) => !catalog.includes(e.entry.id)) : [];
    if (catalog) checks.push(refused.length ? bad("copilot-model", true, `the Copilot CLI does not offer model ${refused.map((e) => `"${e.entry.id}"`).join(", ")}`, `set id = "${COPILOT_CLI_DEFAULT}" for ${refused.map((e) => e.entry.id).join(", ")} in ${mp}   or   jarvis config preset <name>`) : ok("copilot-model", false, `${named.map((e) => e.entry.id).join(", ")} offered by Copilot`));
    // An openai-compat server can list its models and still refuse the configured id at chat time, so ask it once.
    const compat = router.entries.filter((e) => e.available && e.entry.provider === "openai-compat");
    const timeoutMs = opts.chatProbeTimeoutMs ?? CHAT_PROBE_TIMEOUT_MS;
    const probed = await Promise.all(compat.map(async (e) => ({ e, probe: await probeOpenaiChat(e, timeoutMs) })));
    for (const { e, probe } of probed) {
      if (probe.kind === "refused") checks.push(bad("openai-model", true, `the server refuses model "${e.entry.id}": ${probe.reason}`, `set id for ${e.entry.id} in ${mp} to a model the server offers   or   jarvis config preset <name>`));
      else if (probe.kind === "unknown") checks.push(warn("openai-model", `could not check model "${e.entry.id}": ${probe.reason}`, "run jarvis doctor again once the server answers chat requests"));
    }
    const accepted = probed.filter((x) => x.probe.kind === "accepted");
    if (accepted.length) checks.push(ok("openai-model", false, `${accepted.map((x) => x.e.entry.id).join(", ")} accepted by the server`));
    refused.push(...probed.filter((x) => x.probe.kind === "refused").map((x) => x.e));
    const avail = router.entries.filter((e) => e.available && !refused.includes(e));
    // When only refused ids remain, the copilot-model / openai-model failures above are the whole story: every task would route to them.
    // An openai-compat server whose key is set (or needs none) and whose connection fails is down or at the wrong baseUrl: name it.
    // A server that answers with an error status (wrong key, wrong path) is not silent and keeps the generic line.
    const generic = "start Ollama / install the Copilot CLI / set OPENAI_API_KEY (or the key env named in models.toml)";
    const down = router.entries.filter((e) => !e.available);
    const candidates = [...new Set(down.filter((e) => e.entry.provider === "openai-compat" && e.entry.baseUrl && !(e.entry.apiKeyEnv && !process.env[e.entry.apiKeyEnv])).map((e) => e.entry.baseUrl!))];
    const silent = avail.length ? [] : (await Promise.all(candidates.map(async (u) => ((await connects(u)) ? null : u)))).filter((u): u is string => u !== null);
    const others = down.some((e) => !(e.entry.baseUrl && silent.includes(e.entry.baseUrl)));
    const unreachable = silent.length
      ? warn("models-available", `no configured model is reachable: nothing answers at ${silent.join(", ")}`, `start the server at ${silent.join(" / ")}   or   change baseUrl in ${mp}${others ? `;   for the other models: ${generic}` : ""}`)
      : warn("models-available", "no configured model is reachable", generic);
    if (avail.length || !refused.length) checks.push(router.entries.length === 0 ? warn("models-available", "no chat models configured (Tier 0: capture/search only)", "jarvis config preset <name>") : avail.length ? ok("models-available", false, avail.map((e) => `${e.entry.provider}:${e.entry.id}`).join(", ")) : unreachable);
    const missing = unresolvedKinds(router);
    if (avail.length || !refused.length) checks.push(missing.length ? warn("models-tasks", `no model for: ${missing.join(", ")}`, "add a model with quality >= the task's minimum to models.toml") : ok("models-tasks", false, "every task kind resolves"));
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
    if (dataDir && existsSync(dataDir)) {
      checks.push(slidecraftCheck(await (opts.slidecraft ?? discoverSlidecraft)(dataDir), dataDir));
      checks.push(decksOutsideCheck(dataDir));
    }
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

/** Whether anything answers HTTP at `baseUrl`/models, whatever its status: false only when the connection fails or times out. */
async function connects(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** What one chat probe of an openai-compat entry showed: answered, refused (the id), or neither (a key, quota, server or network fault). */
type ChatProbe = { kind: "accepted" } | { kind: "refused"; reason: string } | { kind: "unknown"; reason: string };

/** Ask an openai-compat entry for a few tokens; only a 400 or 404 judges the id itself. */
async function probeOpenaiChat(e: RouterEntry, timeoutMs: number): Promise<ChatProbe> {
  try {
    await e.provider.complete(e.entry.id, "Reply with OK.", { maxTokens: 16, timeoutMs });
    return { kind: "accepted" };
  } catch (err) {
    if (err instanceof TruncationError) return { kind: "accepted" }; // it answered; the probe's short budget cut it off
    if (err instanceof ChatHttpError) return err.status === 400 || err.status === 404 ? { kind: "refused", reason: err.reason } : { kind: "unknown", reason: err.reason };
    if ((err as Error).name === "TimeoutError") return { kind: "unknown", reason: `no answer within ${timeoutMs / 1000} s` };
    return { kind: "unknown", reason: (err as Error).message };
  }
}

export function formatDoctor(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "-" };
  const lines = r.checks.map((c) => `${icon[c.status]} ${c.name.padEnd(18)} ${c.detail}${c.fix && c.status !== "ok" ? `\n    fix: ${c.fix}` : ""}`);
  lines.push("", `${r.summary.ok} ok, ${r.summary.warn} warning(s), ${r.summary.fail} failure(s)${r.summary.healthy ? "" : " — fix the failures above"}`);
  return lines.join("\n");
}

/** Presenting decks is optional, so every Slidecraft state short of ready is a warning with its exact fix. */
function slidecraftCheck(s: SlidecraftStatus, dataDir: string): Check {
  if (s.status === "not-running")
    return warn("slidecraft", "Slidecraft is not running (decks are listed and searchable, but cannot be presented)", "start Slidecraft (its release binary, or `bun run dev` in its checkout)   or   set JARVIS_SLIDECRAFT_URL to where it runs");
  if (s.status === "no-vault")
    return warn("slidecraft", `Slidecraft at ${s.base} has no vault for the content repo`, `add ${dataDir} as a vault on ${s.base}/settings (its default include covers ${SLIDECRAFT_DECK_GLOB})`);
  const slugs = listPresentations(dataDir).map((p) => p.slug);
  const unlisted = (slugs.length ? slugs : ["deck"]).filter((slug) => !vaultListsDeck(s.include, slug));
  if (unlisted.length)
    return warn("slidecraft", `Slidecraft vault "${s.vault}" is the content repo, but its include does not list ${slugs.length ? `these decks: ${unlisted.join(", ")}` : "decks under presentations/"}`, `add "${SLIDECRAFT_DECK_GLOB}" to the "include" of vault "${s.vault}" in ${s.configFile ?? "Slidecraft's config.json"}, then restart Slidecraft`);
  const where = `decks present in Slidecraft at ${s.base}, vault "${s.vault}"`;
  return ok("slidecraft", false, s.readOnly ? `${where} (read-only: present only; Slidecraft cannot edit decks there or keep its skill in the repo)` : where);
}

/**
 * Slidecraft creates decks at its vault's top level, which for the content repo is outside
 * `presentations/`: such a deck is neither indexed nor shared until it is brought in.
 */
function decksOutsideCheck(dataDir: string): Check {
  let names: string[] = [];
  try {
    names = readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "presentations" && existsSync(join(dataDir, e.name, "index.mdx")))
      .map((e) => e.name).sort();
  } catch {}
  if (!names.length) return ok("decks-outside", false, "every deck is under presentations/");
  return warn("decks-outside", `deck(s) outside presentations/, neither indexed nor shared: ${names.join(", ")}`, names.map((n) => `jarvis presentation share ${join(dataDir, n)} --slug ${n}   then delete ${join(dataDir, n)}`).join("   ;   "));
}
