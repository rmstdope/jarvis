import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { configPath, loadConfig, resolveAuthor, updateConfig, type MachineConfig } from "./config.ts";
import { OLLAMA_EMBED_MODEL, OLLAMA_URL } from "./constants.ts";
import { doctor, formatDoctor } from "./doctor.ts";
import { git, gitOk, hasRemote, isWorkTree } from "./git.ts";
import { reindex } from "./reindex.ts";
import { search } from "./search.ts";
import { applyPreset, detectHardware, listPresets, recommendPreset } from "./presets.ts";
import { ollamaModels } from "../providers/local.ts";
import { modelsPath } from "../providers/models.ts";
import { osUsername } from "./util.ts";

export interface InitOpts {
  yes?: boolean;
  repo?: string;
  data?: string;
  dataRoot?: string;
  author?: string;
  preset?: string;
  embedding?: "ollama" | "omlx";
  pull?: boolean;
  log?: (s: string) => void;
  /** Test seam: answers for prompts in order; undefined → default. */
  ask?: (question: string, def: string) => Promise<string>;
}
export interface InitResult {
  dataDir: string;
  author: string;
  embedding: "ollama" | "omlx";
  preset: string | null;
  indexed: number;
  smokeHits: number;
  doctorHealthy: boolean;
}

function run(cmd: string[], cwd?: string): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}

/** Six steps, every default answerable non-interactively with --yes. Config is written after each step. */
export async function init(opts: InitOpts = {}): Promise<InitResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  let rl = null as ReturnType<typeof createInterface> | null;
  const ask = opts.ask ?? (async (q: string, def: string) => {
    if (opts.yes) return def;
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def;
  });
  const yn = async (q: string, def: boolean) => /^y/i.test(await ask(`${q} (y/n)`, def ? "y" : "n"));
  try {
    const cfg = loadConfig();
    log(`J.A.R.V.I.S. setup — config at ${configPath()}\n`);

    // 1. content repo
    log("Step 1/6 · content repo");
    const dataRoot = resolve(opts.dataRoot ?? cfg.dataRoot ?? join(homedir(), "jarvis-content"));
    let dataDir: string;
    if (opts.repo) {
      const name = basename(opts.repo.replace(/\.git$/, "").replace(/\/$/, ""));
      dataDir = join(dataRoot, name);
      if (!existsSync(dataDir)) {
        mkdirSync(dataRoot, { recursive: true });
        log(`  cloning ${opts.repo} → ${dataDir}`);
        const r = run(["git", "clone", "-q", opts.repo, dataDir]);
        if (r.code !== 0) throw new Error(`git clone failed: ${r.out.trim()}`);
      } else log(`  ${dataDir} already exists; using it`);
    } else {
      const def = opts.data ?? cfg.dataDir ?? dataRoot;
      dataDir = resolve(await ask("Path to the content repo (existing, or a new folder to create)", def));
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
        log(`  created ${dataDir}`);
      }
      if (!isWorkTree(dataDir) || git(dataDir, ["rev-parse", "--show-toplevel"]).stdout !== dataDir) {
        gitOk(dataDir, ["init", "-q", "-b", "main"]);
        log("  initialised a git repository");
      }
      if (!hasRemote(dataDir)) {
        const url = await ask("Git remote URL for the team (empty to skip)", "");
        if (url) gitOk(dataDir, ["remote", "add", "origin", url]);
      }
    }
    for (const d of ["docs", "edges", "entities", "briefings"]) mkdirSync(join(dataDir, d), { recursive: true });
    updateConfig({ dataDir, dataRoot });

    // 2. author
    log("\nStep 2/6 · author");
    const gitName = git(dataDir, ["config", "user.name"]).stdout;
    const author = await ask("Your capture identity", opts.author ?? cfg.author ?? gitName ?? osUsername());
    updateConfig({ author });

    // 3. embeddings
    log("\nStep 3/6 · embeddings");
    const hw = detectHardware();
    log(`  detected: ${hw.platform}/${hw.arch}, ${hw.memoryGb} GB${hw.appleSilicon ? ", Apple Silicon" : ""}${hw.nvidia ? ", NVIDIA GPU" : ""}${hw.integratedGpu ? ", integrated GPU (WSL)" : ""}`);
    const embedding = (opts.embedding ?? (await ask("Embedding server: ollama or omlx", cfg.embeddingProvider ?? "ollama"))) as "ollama" | "omlx";
    if (embedding !== "ollama" && embedding !== "omlx") throw new Error("embedding must be ollama|omlx");
    updateConfig({ embeddingProvider: embedding });
    if (embedding === "ollama") {
      const models = await ollamaModels(OLLAMA_URL);
      if (models.length === 0 && !(await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false))) {
        log(`  ⚠ Ollama is not reachable at ${OLLAMA_URL}. Install it from https://ollama.com and run: ollama pull ${OLLAMA_EMBED_MODEL}`);
      } else if (!models.some((m) => m.startsWith(OLLAMA_EMBED_MODEL))) {
        const pull = opts.pull ?? (opts.yes ? false : await yn(`Pull the embedding model ${OLLAMA_EMBED_MODEL} now (~640 MB)?`, true));
        if (pull) {
          log(`  pulling ${OLLAMA_EMBED_MODEL}…`);
          const r = run(["ollama", "pull", OLLAMA_EMBED_MODEL]);
          log(r.code === 0 ? "  pulled" : `  ⚠ pull failed: ${r.out.trim().slice(-200)}`);
        } else log(`  run later: ollama pull ${OLLAMA_EMBED_MODEL}`);
      } else log(`  ${OLLAMA_EMBED_MODEL} is installed`);
    }

    // 4. model preset
    log("\nStep 4/6 · model preset");
    const recommended = recommendPreset(hw);
    log(`  available: ${listPresets().join(", ")}\n  recommended for this machine: ${recommended}`);
    let preset: string | null = null;
    const wanted = opts.preset ?? (await ask("Preset to apply (empty to keep current/detect live)", existsSync(modelsPath()) ? "" : recommended));
    if (wanted) {
      if (existsSync(modelsPath()) && !opts.preset && !(await yn(`${modelsPath()} exists; overwrite with preset ${wanted}?`, false))) log("  kept existing models.toml");
      else {
        applyPreset(wanted);
        preset = wanted;
        updateConfig({ preset: wanted });
        log(`  wrote ${modelsPath()} from preset ${wanted}`);
      }
    }

    // 5. first reindex + smoke search
    log("\nStep 5/6 · first index");
    const r = await reindex(dataDir);
    log(`  indexed ${r.docsIndexed} doc(s), embedded ${r.chunksEmbedded} chunk(s)${r.embedError ? ` (⚠ ${r.embedError})` : ""}`);
    let smokeHits = 0;
    try {
      smokeHits = (await search(dataDir, "the", { mode: "keyword", limit: 1 })).length;
      log(`  keyword smoke search: ${smokeHits ? "ok" : "no hits yet (empty repo is fine)"}`);
    } catch (e) {
      log(`  ⚠ smoke search failed: ${(e as Error).message}`);
    }

    // 6. doctor
    log("\nStep 6/6 · doctor");
    const rep = await doctor({ dataDir });
    log(formatDoctor(rep));
    log(`\nDone. Next: jarvis note "hello" · jarvis search hello · jarvis serve · jarvis sync`);
    const final: MachineConfig = loadConfig();
    return { dataDir, author: final.author ?? resolveAuthor(author), embedding, preset, indexed: r.docsIndexed, smokeHits, doctorHealthy: rep.summary.healthy };
  } finally {
    if (rl) (rl as ReturnType<typeof createInterface>).close();
  }
}
