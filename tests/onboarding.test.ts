import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPresets, readPreset, recommendPreset, applyPreset } from "../src/core/presets.ts";
import { modelsPath, parseModelsToml } from "../src/providers/models.ts";
import { createRouter, defaultProviderFactory } from "../src/providers/router.ts";
import { setRouterForTests } from "../src/providers/index.ts";
import { parseCopilotModelCatalog, readCopilotModelCatalog } from "../src/providers/copilot.ts";
import { doctor, checkSqliteVec, checkJarvisCommand, formatDoctor } from "../src/core/doctor.ts";
import { init } from "../src/core/init.ts";
import { loadConfig, resetConfigCache } from "../src/core/config.ts";
import { ingest } from "../src/core/ingest.ts";
import type { SlidecraftStatus } from "../src/core/presentations.ts";
import { stepFailure } from "../src/core/sync.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
let home: string;
const envBackup: Record<string, string | undefined> = {};
beforeEach(() => {
  t = tmpDataDir();
  home = join(t.dir, "home");
  mkdirSync(home);
  for (const k of ["JARVIS_HOME", "JARVIS_DATA", "JARVIS_MODELS", "JARVIS_INBOX"]) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  process.env.JARVIS_HOME = home;
  resetConfigCache();
  useFakeEmbedder();
});
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  resetConfigCache();
  t.cleanup();
  clearEmbedder();
});

describe("presets", () => {
  test("all shipped presets parse with the real parser", () => {
    const names = listPresets();
    expect(names).toEqual(["copilot-only", "cpu-only-minimal", "mac-apple-silicon-16gb", "mac-apple-silicon-32gb", "windows-gpu-12gb", "windows-low-vram"]);
    for (const n of names) expect(() => parseModelsToml(readPreset(n))).not.toThrow();
    expect(parseModelsToml(readPreset("cpu-only-minimal")).models).toEqual([]);
    expect(parseModelsToml(readPreset("copilot-only")).models[0]).toMatchObject({ provider: "copilot", id: "default" });
    expect(parseModelsToml(readPreset("mac-apple-silicon-32gb")).models.map((m) => m.id)).toEqual(["gemma4:26b", "qwen3:35b", "default"]);
    expect(parseModelsToml(readPreset("windows-low-vram")).preference).toEqual(["copilot", "openai-compat"]);
    expect(parseModelsToml(readPreset("windows-low-vram")).models[1]).toMatchObject({ provider: "openai-compat", apiKeyEnv: "OPENAI_API_KEY" });
    expect(() => readPreset("nope")).toThrow(/unknown preset/);
  });
  test("recommendation and apply", () => {
    const base = { platform: "darwin", arch: "arm64", memoryGb: 36, appleSilicon: true, nvidia: false, wsl: false, integratedGpu: false, cpuModel: "" };
    expect(recommendPreset(base)).toBe("mac-apple-silicon-32gb");
    expect(recommendPreset({ ...base, memoryGb: 16 })).toBe("mac-apple-silicon-16gb");
    expect(recommendPreset({ ...base, platform: "win32", arch: "x64", appleSilicon: false, nvidia: true })).toBe("copilot-only");
    const p = applyPreset("windows-gpu-12gb");
    expect(p).toBe(join(home, "models.toml"));
    expect(readFileSync(p, "utf8")).toContain('id = "qwen3:14b"');
  });
});

describe("doctor", () => {
  test("sqlite-vec check passes here", () => {
    expect(checkSqliteVec().status).toBe("ok");
  });
  test("reports failures with fixes, then healthy after init", async () => {
    const r0 = await doctor({ coreOnly: true, which: (b) => (b === "git" ? "/usr/bin/git" : null) });
    const byName = Object.fromEntries(r0.checks.map((c) => [c.name, c]));
    expect(byName.bun.status).toBe("fail");
    expect(byName.bun.fix).toContain("bun.sh");
    expect(byName["user-config"]).toMatchObject({ status: "fail", fix: "jarvis init" });
    expect(byName["data-dir"].status).toBe("fail");
    expect(byName["embedding-server"].status).toBe("ok");
    expect(byName["embed-model"].detail).toContain("512");
    expect(r0.summary.healthy).toBe(false);
    expect(formatDoctor(r0)).toContain("fix: jarvis init");
    // malformed config
    writeFileSync(join(home, "config.toml"), "not = [toml");
    resetConfigCache();
    expect((await doctor({ coreOnly: true })).checks.find((c) => c.name === "user-config")!.status).toBe("fail");
    // proper init → healthy core
    const data = join(t.dir, "content");
    const res = await init({ yes: true, data, author: "tester", preset: "cpu-only-minimal", embedding: "ollama", log: () => {} });
    expect(res.dataDir).toBe(data);
    expect(res.author).toBe("tester");
    expect(res.preset).toBe("cpu-only-minimal");
    const r1 = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    const n1 = Object.fromEntries(r1.checks.map((c) => [c.name, c]));
    expect(n1["user-config"].status).toBe("ok");
    expect(n1["data-dir"].status).toBe("ok");
    expect(n1["data-git"].status).toBe("ok");
    expect(n1["data-remote"].status).toBe("warn");
    expect(n1["models-config"].status).toBe("ok");
    expect(r1.summary.healthy).toBe(true);
    // optional checks with everything missing are warnings, not failures
    const r2 = await doctor({ which: (b) => (["bun", "git"].includes(b) ? `/bin/${b}` : null), port: 0 });
    const n2 = Object.fromEntries(r2.checks.map((c) => [c.name, c]));
    expect(n2.copilot.status).toBe("warn");
    expect(n2["yt-dlp"].status).toBe("warn");
    expect(n2.whisper.status).toBe("warn");
    expect(r2.summary.healthy).toBe(true);
  });
  test("models-config warns about a [[models]] table and an unknown provider the parser ignores", async () => {
    const mp = join(home, "models.toml");
    writeFileSync(mp, 'preference = ["local"]\n\n[[models]]\nprovider = "local"\nid = "qwen3:8b"\n\n[[model]]\nprovider = "ollama"\nid = "gemma4:26b"\n\n[[model]]\nprovider = "local"\nid = "qwen3:14b"\n');
    const check = (await doctor({ coreOnly: true })).checks.find((c) => c.name === "models-config")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(mp);
    expect(check.detail).toContain("[[models]]");
    expect(check.detail).toContain('provider "ollama" (gemma4:26b)');
    expect(check.detail).not.toContain("qwen3:14b");
    expect(check.fix).toContain("[[model]]");
    expect(check.fix).toContain("local, copilot or openai-compat");
    // A file the parser reads in full stays ok.
    writeFileSync(mp, '[[model]]\nprovider = "local"\nid = "qwen3:14b"\n');
    expect((await doctor({ coreOnly: true })).checks.find((c) => c.name === "models-config")).toMatchObject({ status: "ok", detail: mp });
  });
  test("models-config names a [[model]] dropped for a missing provider or id, and the missing key", async () => {
    const mp = join(home, "models.toml");
    writeFileSync(mp, '[[model]]\nprovider = "local"\nmodel = "qwen3:8b"\n\n[[model]]\nid = "gemma4:26b"\n\n[[model]]\nquality = "high"\n\n[[model]]\nprovider = "bogus"\n\n[[model]]\nprovider = "local"\nid = "qwen3:14b"\n');
    const check = (await doctor({ coreOnly: true })).checks.find((c) => c.name === "models-config")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain('the [[model]] with provider "local" missing id');
    expect(check.detail).toContain('the [[model]] with id "gemma4:26b" missing provider');
    expect(check.detail).toContain("[[model]] #3 missing provider and id");
    expect(check.detail).toContain('the [[model]] with provider "bogus" missing id');
    expect(check.detail).not.toContain("qwen3:14b");
    expect(check.fix).toContain("provider and id");
  });
  test("models-config names a [[model]] whose provider or id is empty or not a string, not as missing (jv-cdi)", async () => {
    const mp = join(home, "models.toml");
    writeFileSync(mp, '[[model]]\nprovider = 1\nid = "gemma4:26b"\n\n[[model]]\nprovider = ""\nid = "qwen3:8b"\n\n[[model]]\nprovider = "local"\nid = ""\n\n[[model]]\nprovider = "copilot"\nid = 7\n\n[[model]]\nprovider = 1\nid = ""\n\n[[model]]\nid = 2\n\n[[model]]\nprovider = ""\n\n[[model]]\nprovider = "bogus"\nid = ""\n\n[[model]]\nprovider = "local"\nid = "qwen3:14b"\n');
    const check = (await doctor({ coreOnly: true })).checks.find((c) => c.name === "models-config")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain('the [[model]] with id "gemma4:26b" whose provider is empty or not a string');
    expect(check.detail).toContain('the [[model]] with id "qwen3:8b" whose provider is empty or not a string');
    expect(check.detail).toContain('the [[model]] with provider "local" whose id is empty or not a string');
    expect(check.detail).toContain('the [[model]] with provider "copilot" whose id is empty or not a string');
    expect(check.detail).toContain("the [[model]] #5 whose provider and id are empty or not strings");
    expect(check.detail).toContain("the [[model]] #6 missing provider, with an id that is empty or not a string");
    expect(check.detail).toContain("the [[model]] #7 missing id, with a provider that is empty or not a string");
    expect(check.detail).toContain('the [[model]] with provider "bogus" whose id is empty or not a string');
    expect(check.detail).not.toContain('provider ""');
    expect(check.detail).not.toContain("qwen3:14b");
  });
  test("parseModelsToml drops a [[model]] with an empty id, as doctor reports it (jv-cdi)", () => {
    expect(parseModelsToml('[[model]]\nprovider = "local"\nid = ""\n').models).toEqual([]);
  });
  test("a models.toml doctor cannot read is reported in models-config, not thrown (jv-3ah)", async () => {
    const mp = join(home, "models.toml");
    // The real router reads models.toml, as `jarvis doctor` does; every file here fails before any provider is probed.
    try {
      for (const [text, problem, fix] of [
        ['[model]\nprovider = "local"\nid = "qwen3:14b"\n', "[model]", "spell each table [[model]]"],
        ['[[models]\nprovider = "local"\n', "TOML Parse error", "spell each table [[model]]"],
        ['[[model]]\nprovider = "copilot"\nid = "x"\nreasoningEffort = "huge"\n', 'invalid reasoningEffort "huge"', "fix that entry in"],
      ] as const) {
        writeFileSync(mp, text);
        setRouterForTests(undefined);
        const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
        const names = r.checks.map((c) => c.name);
        expect(names).toContain("user-config");
        expect(names).toContain("data-dir");
        const check = r.checks.find((c) => c.name === "models-config")!;
        expect(check.status).toBe("warn");
        expect(check.detail).toContain(mp);
        expect(check.detail).toContain(problem);
        expect(check.fix).toContain(fix);
      }
    } finally {
      setRouterForTests(null);
    }
  });
  test("a models.toml doctor cannot load reports models-available and models-tasks as skipped, not left out (jv-ddc)", async () => {
    const mp = join(home, "models.toml");
    try {
      // Unparseable TOML, and an entry the router rejects: getRouter() fails on both.
      for (const text of [
        '[[models]\nprovider = "local"\n',
        '[[model]]\nprovider = "copilot"\nid = "x"\nreasoningEffort = "huge"\n',
      ]) {
        writeFileSync(mp, text);
        setRouterForTests(undefined);
        const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
        for (const name of ["models-available", "models-tasks"]) {
          const check = r.checks.find((c) => c.name === name);
          expect(check).toMatchObject({ status: "warn", detail: "skipped: models.toml could not be loaded", fix: `fix ${mp} as the models-config line says` });
        }
      }
    } finally {
      setRouterForTests(null);
    }
    // No router at all (pinned off) is not a load failure: nothing is reported as skipped.
    writeFileSync(mp, '[[models]\nprovider = "local"\n');
    const pinned = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(pinned.checks.filter((c) => c.detail.startsWith("skipped:"))).toEqual([]);
  });
  test("doctor says whether decks can be presented in Slidecraft, with the exact fix", async () => {
    const data = join(t.dir, "content");
    await init({ yes: true, data, author: "tester", preset: "cpu-only-minimal", embedding: "ollama", log: () => {} });
    const which = (b: string) => `/bin/${b}`;
    const deckGlob = ["*/index.mdx", "presentations/*/index.mdx"];
    const configFile = "/home/u/.config/slidecraft/config.json";
    const run = async (status: SlidecraftStatus) => Object.fromEntries((await doctor({ which, port: 0, slidecraft: async () => status })).checks.map((c) => [c.name, c]));
    const check = async (status: SlidecraftStatus) => (await run(status)).slidecraft;
    const vault = (include: string[], readOnly = false): SlidecraftStatus => ({ status: "ready", base: "http://localhost:6110", vault: "team", include, readOnly, configFile });

    const ready = await check(vault(deckGlob));
    expect(ready).toMatchObject({ status: "ok", required: false });
    expect(ready.detail).toContain('vault "team"');
    // A read-only vault presents, but Slidecraft cannot edit there or keep its skill in the repo.
    expect((await check(vault(deckGlob, true))).detail).toContain("read-only");
    const down = await check({ status: "not-running" });
    expect(down.status).toBe("warn");
    expect(down.fix).toContain("JARVIS_SLIDECRAFT_URL");
    const missing = await check({ status: "no-vault", base: "http://localhost:6110" });
    expect(missing.status).toBe("warn");
    expect(missing.fix).toContain(data);
    expect(missing.fix).toContain("http://localhost:6110/settings");

    // The vault's include is checked against the decks the repo really has.
    for (const slug of ["q3ab", "q3-review"]) {
      mkdirSync(join(data, "presentations", slug), { recursive: true });
      writeFileSync(join(data, "presentations", slug, "index.mdx"), `---\nid: 01Q3${slug.length === 4 ? "AAAAAAAAAAAAAAAAAAAAAA" : "BBBBBBBBBBBBBBBBBBBBBB"}\nsource: presentation\ntitle: ${slug}\nauthor: a\ncreated_at: 2026-01-01T00:00:00Z\n---\n<Presentation></Presentation>\n`);
    }
    expect((await check(vault(["presentations/????/index.mdx"]))).status).toBe("warn");
    const narrow = await check(vault(["presentations/????/index.mdx"]));
    expect(narrow.detail).toContain("q3-review");
    expect(narrow.detail).not.toContain("q3ab,");
    // The settings page cannot change include, so the fix names the vault and Slidecraft's config file.
    expect(narrow.fix).toContain('"team"');
    expect(narrow.fix).toContain(configFile);
    expect(narrow.fix).toContain("presentations/*/index.mdx");
    expect(narrow.fix).not.toContain("/settings");
    expect((await check(vault(deckGlob))).status).toBe("ok");

    // A deck Slidecraft created at the repo's top level is neither indexed nor shared: say how to bring it in.
    expect((await run(vault(deckGlob)))["decks-outside"].status).toBe("ok");
    mkdirSync(join(data, "kickoff"), { recursive: true });
    writeFileSync(join(data, "kickoff", "index.mdx"), "<Presentation></Presentation>\n");
    const outside = (await run({ status: "not-running" }))["decks-outside"];
    expect(outside.status).toBe("warn");
    expect(outside.detail).toContain("kickoff");
    expect(outside.fix).toContain(`jarvis presentation share ${join(data, "kickoff")} --slug kickoff`);

    // Presenting is optional: a missing Slidecraft never makes doctor unhealthy, and --core-only skips it.
    expect((await doctor({ which, port: 0, slidecraft: async () => ({ status: "not-running" }) })).summary.healthy).toBe(true);
    const core = (await doctor({ coreOnly: true, which, slidecraft: async () => ({ status: "not-running" }) })).checks.map((c) => c.name);
    expect(core).not.toContain("slidecraft");
    expect(core).not.toContain("decks-outside");
  }, 30000); // one init and a dozen full doctor runs
});

describe("doctor jarvis-command", () => {
  const base = { codeRepo: "/code/jarvis", home: "/home/u", shell: "/bin/zsh", platform: "linux", exists: () => false, realpath: (p: string) => p };
  test("installed and working", () => {
    const c = checkJarvisCommand({ ...base, found: "/home/u/.bun/bin/jarvis", realpath: (p) => (p.endsWith("/jarvis") ? "/code/jarvis/src/cli.ts" : p) });
    expect(c).toMatchObject({ name: "jarvis-command", status: "ok", detail: "jarvis on PATH" });
  });
  test("never installed", () => {
    const c = checkJarvisCommand({ ...base, found: null });
    expect(c).toMatchObject({ status: "warn", detail: "jarvis is not on PATH, so agents in the content repo cannot run it", fix: "cd /code/jarvis && bun link" });
  });
  test("installed in ~/.bun/bin but the folder is not on PATH, per shell", () => {
    const o = { ...base, found: null, exists: (p: string) => p === "/home/u/.bun/bin/jarvis" };
    const z = checkJarvisCommand(o);
    expect(z.status).toBe("warn");
    expect(z.detail).toBe("jarvis is installed in ~/.bun/bin, but that folder is not on PATH");
    expect(z.fix).toBe(`echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc   then open a new terminal`);
    expect(checkJarvisCommand({ ...o, shell: "/usr/bin/bash" }).fix).toContain("~/.bashrc");
    expect(checkJarvisCommand({ ...o, shell: "/usr/bin/fish" }).fix).toBe("echo 'fish_add_path ~/.bun/bin' >> ~/.config/fish/config.fish   then open a new terminal");
  });
  test("custom BUN_INSTALL names its own bin folder in the warning and the fix", () => {
    const o = { ...base, found: null, bunInstall: "/opt/bun", exists: (p: string) => p === "/opt/bun/bin/jarvis" };
    const z = checkJarvisCommand(o);
    expect(z.detail).toBe("jarvis is installed in /opt/bun/bin, but that folder is not on PATH");
    expect(z.fix).toBe(`echo 'export PATH="/opt/bun/bin:$PATH"' >> ~/.zshrc   then open a new terminal`);
    expect(checkJarvisCommand({ ...o, shell: "/usr/bin/fish" }).fix).toBe("echo 'fish_add_path /opt/bun/bin' >> ~/.config/fish/config.fish   then open a new terminal");
  });
  test("BUN_INSTALL equal to the default root keeps the ~/.bun/bin wording", () => {
    const c = checkJarvisCommand({ ...base, found: null, bunInstall: "/home/u/.bun", exists: (p: string) => p === "/home/u/.bun/bin/jarvis" });
    expect(c.detail).toBe("jarvis is installed in ~/.bun/bin, but that folder is not on PATH");
    expect(c.fix).toContain('$HOME/.bun/bin');
  });
  test("PATH jarvis runs a different copy", () => {
    const c = checkJarvisCommand({ ...base, found: "/usr/local/bin/jarvis", realpath: (p) => (p.endsWith("/jarvis") ? "/old/jarvis/src/cli.ts" : p) });
    expect(c).toMatchObject({ status: "warn", detail: "jarvis on PATH runs /old/jarvis, not /code/jarvis", fix: "cd /code/jarvis && bun link" });
  });
  test("another program called jarvis is named by its resolved path; Windows shim", () => {
    const c = checkJarvisCommand({ ...base, found: "/usr/local/bin/jarvis" });
    expect(c.detail).toBe("jarvis on PATH runs /usr/local/bin/jarvis, not /code/jarvis");
    expect(checkJarvisCommand({ ...base, found: "C:\\u\\.bun\\bin\\jarvis.exe", platform: "win32" }).status).toBe("ok");
  });
  test("doctor lists it and a warning keeps setup healthy", async () => {
    const r = await doctor({ coreOnly: true, which: (b) => (b === "jarvis" ? null : `/bin/${b}`), codeRepo: "/code/jarvis", home: "/nonexistent-home" });
    expect(r.checks.find((c) => c.name === "jarvis-command")!.status).toBe("warn");
    expect(r.checks.filter((c) => c.status === "fail").every((c) => c.name !== "jarvis-command")).toBe(true);
  });
});

describe("doctor: a Copilot model id the account refuses (jv-5el)", () => {
  const copilotRouter = (ids: string[]) =>
    createRouter({
      config: { preference: ["copilot"], models: ids.map((id) => ({ provider: "copilot" as const, id, quality: "high" as const, bestFor: [] })), source: "file" },
      factory: () => ({ name: "copilot", available: async () => true, complete: async () => "" }),
    });
  afterEach(() => setRouterForTests(null));

  test("a configured id missing from the Copilot catalog fails with an exact fix line", async () => {
    setRouterForTests(await copilotRouter(["gpt-4.1"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}`, copilotCatalog: async () => ["gpt-5-mini", "gpt-5.4"] });
    const c = r.checks.find((x) => x.name === "copilot-model");
    expect(c).toMatchObject({ status: "fail", detail: 'the Copilot CLI does not offer model "gpt-4.1"' });
    expect(c!.fix).toBe(`set id = "default" for gpt-4.1 in ${modelsPath()}   or   jarvis config preset <name>`);
    expect(r.summary.healthy).toBe(false);
    // Only refused ids: no line that says a model is reachable or that every task resolves.
    expect(r.checks.find((x) => x.name === "models-available")).toBeUndefined();
    expect(r.checks.find((x) => x.name === "models-tasks")).toBeUndefined();
  });

  test("beside an offered id, only the refused one is failed and the offered one is listed", async () => {
    setRouterForTests(await copilotRouter(["gpt-4.1", "gpt-5-mini"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}`, copilotCatalog: async () => ["gpt-5-mini"] });
    expect(r.checks.find((x) => x.name === "copilot-model")!.detail).toBe('the Copilot CLI does not offer model "gpt-4.1"');
    expect(r.checks.find((x) => x.name === "models-available")).toMatchObject({ status: "ok", detail: "copilot:gpt-5-mini" });
  });

  test("default, auto and catalog ids pass; an unreadable catalog checks nothing", async () => {
    setRouterForTests(await copilotRouter(["default", "auto", "gpt-5-mini"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}`, copilotCatalog: async () => ["gpt-5-mini"] });
    expect(r.checks.find((x) => x.name === "copilot-model")).toMatchObject({ status: "ok" });
    setRouterForTests(await copilotRouter(["gpt-4.1"]));
    const r2 = await doctor({ coreOnly: true, which: (b) => `/bin/${b}`, copilotCatalog: async () => null });
    expect(r2.checks.find((x) => x.name === "copilot-model")).toBeUndefined();
  });

  test("the catalog is read from `copilot help config`", () => {
    const help = ["  `logLevel`: log level", "", "  `model`: AI model to use for Copilot CLI; can be changed", '    - "claude-sonnet-5.5"', '    - "gpt-5-mini"', "", "  `contextTier`: context window tier", '    - "default"'].join("\n");
    expect(parseCopilotModelCatalog(help)).toEqual(["claude-sonnet-5.5", "gpt-5-mini"]);
    expect(parseCopilotModelCatalog("no such section")).toBeNull();
  });
  test("reading the catalog: missing CLI, failing CLI and a listed catalog", async () => {
    const out = (code: number) => async () => ({ code, stdout: '  `model`: AI model\n    - "gpt-5-mini"\n', stderr: "" });
    expect(await readCopilotModelCatalog(out(0), () => null)).toBeNull();
    expect(await readCopilotModelCatalog(out(1), () => "/bin/copilot")).toBeNull();
    expect(await readCopilotModelCatalog(out(0), () => "/bin/copilot")).toEqual(["gpt-5-mini"]);
  });
});

describe("doctor: an openai-compat model id the server refuses (jv-6sk)", () => {
  // A server that lists models fine (GET /models is 200) but refuses the configured id at chat time.
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-5-mini" }] });
        const { model } = (await req.json()) as { model: string };
        if (model === "gpt-5-mini") return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
        if (model === "thinker") return Response.json({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
        if (model === "flaky") return Response.json({ error: { message: "upstream overloaded" } }, { status: 503 });
        if (model === "slow") return new Promise<Response>((res) => setTimeout(() => res(Response.json({ choices: [{ message: { content: "ok" } }] })), 1000));
        if (model === "gone") return Response.json({ error: { message: "The model `gone` does not exist or you do not have access to it." } }, { status: 404 });
        return Response.json({ error: { message: `Model "${model}" is not available` } }, { status: 400 });
      },
    });
  });
  afterEach(() => {
    setRouterForTests(null);
    server.stop(true);
  });
  const compatRouter = (ids: string[]) =>
    createRouter({ config: { preference: ["openai-compat"], models: ids.map((id) => ({ provider: "openai-compat" as const, id, quality: "high" as const, bestFor: [], baseUrl: `http://127.0.0.1:${server.port}/v1` })), source: "file" } });

  test("a refused id fails with the model, the server's reason and an exact fix line", async () => {
    setRouterForTests(await compatRouter(["gpt-9"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    const c = r.checks.find((x) => x.name === "openai-model");
    expect(c).toMatchObject({ status: "fail", detail: 'the server refuses model "gpt-9": Model "gpt-9" is not available' });
    expect(c!.fix).toBe(`set id for gpt-9 in ${modelsPath()} to a model the server offers   or   jarvis config preset <name>`);
    expect(r.summary.healthy).toBe(false);
    expect(r.checks.find((x) => x.name === "models-available")).toBeUndefined();
  });

  test("beside an accepted id, only the refused one fails and the accepted one is listed", async () => {
    setRouterForTests(await compatRouter(["gpt-9", "gpt-5-mini"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(r.checks.find((x) => x.name === "openai-model")!.detail).toBe('the server refuses model "gpt-9": Model "gpt-9" is not available');
    expect(r.checks.find((x) => x.name === "models-available")).toMatchObject({ status: "ok", detail: "openai-compat:gpt-5-mini" });
  });

  test("a 404 'does not exist' is a refusal too, and sync points it at doctor", async () => {
    setRouterForTests(await compatRouter(["gone"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(r.checks.find((x) => x.name === "openai-model")).toMatchObject({ status: "fail", detail: 'the server refuses model "gone": The model `gone` does not exist or you do not have access to it.' });
    expect(stepFailure("enrich", 1, "openai-compat chat failed (404): The model `gone` does not exist or you do not have access to it.").doctor).toBe(true);
  });

  test("a server error or a timeout is a warning, not a refused id, and the model stays available", async () => {
    setRouterForTests(await compatRouter(["flaky", "slow"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}`, chatProbeTimeoutMs: 100 });
    const lines = r.checks.filter((x) => x.name === "openai-model");
    expect(lines.map((c) => [c.status, c.detail])).toEqual([
      ["warn", 'could not check model "flaky": upstream overloaded'],
      ["warn", 'could not check model "slow": no answer within 0.1 s'],
    ]);
    expect(lines.every((c) => !c.fix!.includes("models.toml"))).toBe(true);
    expect(lines.every((c) => !c.required)).toBe(true);
    expect(r.checks.find((x) => x.name === "models-available")).toMatchObject({ status: "ok", detail: "openai-compat:flaky, openai-compat:slow" });
  });

  test("an answer cut off by the probe's short budget counts as accepted", async () => {
    setRouterForTests(await compatRouter(["thinker"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(r.checks.find((x) => x.name === "openai-model")).toMatchObject({ status: "ok", detail: "thinker accepted by the server" });
  });

  test("an accepted id passes", async () => {
    setRouterForTests(await compatRouter(["gpt-5-mini"]));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(r.checks.find((x) => x.name === "openai-model")).toMatchObject({ status: "ok", detail: "gpt-5-mini accepted by the server" });
  });
});

describe("doctor: an openai-compat server that refuses connections (jv-asw)", () => {
  afterEach(() => setRouterForTests(null));
  // A port that was just served and stopped: connecting to it is refused.
  const closedBaseUrl = () => {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${s.port}/v1`;
    s.stop(true);
    return url;
  };

  test("models-available names the baseUrl, and its fix says to start the server there or change baseUrl", async () => {
    const baseUrl = closedBaseUrl();
    setRouterForTests(await createRouter({ config: { preference: ["openai-compat"], models: [{ provider: "openai-compat", id: "qwen3", quality: "high", bestFor: [], baseUrl }], source: "file" } }));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    const c = r.checks.find((x) => x.name === "models-available");
    expect(c).toMatchObject({ status: "warn", detail: `no configured model is reachable: nothing answers at ${baseUrl}` });
    expect(c!.fix).toBe(`start the server at ${baseUrl}   or   change baseUrl in ${modelsPath()}`);
  });

  test("a server that answers /models with an error is not called silent", async () => {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: "bad key" } }, { status: 401 }) });
    try {
      setRouterForTests(await createRouter({ config: { preference: ["openai-compat"], models: [{ provider: "openai-compat", id: "qwen3", quality: "high", bestFor: [], baseUrl: `http://127.0.0.1:${s.port}/v1` }], source: "file" } }));
      const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
      expect(r.checks.find((x) => x.name === "models-available")).toMatchObject({ status: "warn", detail: "no configured model is reachable", fix: "start Ollama / install the Copilot CLI / set OPENAI_API_KEY (or the key env named in models.toml)" });
    } finally {
      s.stop(true);
    }
  });

  test("beside another unreachable provider, the fix keeps the generic advice after the server's", async () => {
    const baseUrl = closedBaseUrl();
    const models = [
      { provider: "openai-compat" as const, id: "qwen3", quality: "high" as const, bestFor: [], baseUrl },
      { provider: "copilot" as const, id: "default", quality: "high" as const, bestFor: [] },
    ];
    setRouterForTests(await createRouter({ config: { preference: ["openai-compat", "copilot"], models, source: "file" }, factory: (e) => (e.provider === "copilot" ? { name: "copilot", available: async () => false, complete: async () => "" } : defaultProviderFactory(e)) }));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(r.checks.find((x) => x.name === "models-available")!.fix).toBe(`start the server at ${baseUrl}   or   change baseUrl in ${modelsPath()};   for the other models: start Ollama / install the Copilot CLI / set OPENAI_API_KEY (or the key env named in models.toml)`);
  });

  test("an entry whose key env is unset is a missing key, not a silent server", async () => {
    setRouterForTests(await createRouter({ config: { preference: ["openai-compat"], models: [{ provider: "openai-compat", id: "qwen3", quality: "high", bestFor: [], baseUrl: closedBaseUrl(), apiKeyEnv: "JARVIS_TEST_UNSET_KEY" }], source: "file" } }));
    const r = await doctor({ coreOnly: true, which: (b) => `/bin/${b}` });
    expect(r.checks.find((x) => x.name === "models-available")).toMatchObject({ status: "warn", detail: "no configured model is reachable", fix: "start Ollama / install the Copilot CLI / set OPENAI_API_KEY (or the key env named in models.toml)" });
  });
});

describe("init", () => {
  test("non-interactive init creates repo, config, preset and indexes existing docs", async () => {
    const data = join(t.dir, "content");
    mkdirSync(data, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: data });
    await ingest(data, { source: "note", title: "Existing", body: "the existing note", author: "x" });
    const res = await init({ yes: true, data, author: "me", preset: "copilot-only", embedding: "ollama", log: () => {} });
    expect(res).toMatchObject({ dataDir: data, author: "me", embedding: "ollama", preset: "copilot-only", smokeHits: 1 });
    expect(loadConfig()).toMatchObject({ dataDir: data, author: "me", embeddingProvider: "ollama", preset: "copilot-only" });
    expect(existsSync(join(home, "models.toml"))).toBe(true);
    expect(existsSync(join(data, "briefings"))).toBe(true);
    // second run with an existing models.toml and no --preset: default answer keeps it
    const res2 = await init({ yes: true, log: () => {} });
    expect(res2.preset).toBeNull();
    expect(res2.dataDir).toBe(data);
  });
  test("scripted answers: new folder, remote, preset overwrite declined", async () => {
    const data = join(t.dir, "fresh");
    writeFileSync(join(home, "models.toml"), 'preference = ["local"]\n');
    const answers: Record<string, string> = { "Path to the content repo": data, "Git remote URL": "https://example.test/team.git", "Your capture identity": "kim", "Embedding server": "ollama", "Preset to apply": "copilot-only", "overwrite with preset": "n" };
    const asked: string[] = [];
    const res = await init({ log: () => {}, ask: async (q, def) => { asked.push(q); const k = Object.keys(answers).find((k) => q.startsWith(k) || q.includes(k)); return k ? answers[k] : def; } });
    expect(res.dataDir).toBe(data);
    expect(res.author).toBe("kim");
    expect(res.preset).toBeNull();
    expect(readFileSync(join(home, "models.toml"), "utf8")).toBe('preference = ["local"]\n');
    expect(Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: data }).stdout.toString().trim()).toBe("https://example.test/team.git");
    expect(asked.some((q) => q.includes("overwrite"))).toBe(true);
  });
});
