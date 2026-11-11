import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPresets, readPreset, recommendPreset, applyPreset } from "../src/core/presets.ts";
import { parseModelsToml } from "../src/providers/models.ts";
import { doctor, checkSqliteVec, formatDoctor } from "../src/core/doctor.ts";
import { init } from "../src/core/init.ts";
import { loadConfig, resetConfigCache } from "../src/core/config.ts";
import { ingest } from "../src/core/ingest.ts";
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
    expect(parseModelsToml(readPreset("copilot-only")).models[0]).toMatchObject({ provider: "copilot", id: "gpt-4.1", reasoningEffortByTask: { "edge-judge": "xhigh" } });
    expect(parseModelsToml(readPreset("mac-apple-silicon-32gb")).models.map((m) => m.id)).toEqual(["gemma4:26b", "qwen3:35b", "gpt-4.1"]);
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
