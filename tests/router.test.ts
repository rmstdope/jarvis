import { describe, expect, test } from "bun:test";
import { createRouter } from "../src/providers/router.ts";
import { parseModelsToml, serializeModelsToml, detectModels } from "../src/providers/models.ts";
import { parseJsonObject, TruncationError, type Provider } from "../src/providers/types.ts";
import { parseCopilotOutput, copilotProvider, type Spawn } from "../src/providers/copilot.ts";
import { listPresets, readPreset } from "../src/core/presets.ts";
import { TASK_KINDS } from "../src/providers/types.ts";
import type { ModelsConfig } from "../src/providers/models.ts";

const toml = `
preference = ["copilot", "local"]

[[model]]
provider = "local"
id = "gemma4:26b"
quality = "high"
langs = ["sv", "en"]
bestFor = ["cleanup"]

[[model]]
provider = "local"
id = "qwen3:8b"
quality = "standard"

[[model]]
provider = "copilot"
id = "gpt-4.1"
quality = "high"
bestFor = ["summary", "edge-judge"]
reasoningEffort = "high"
reasoningEffortByTask = { edge-judge = "xhigh" }

[[model]]
id = "dropped-no-provider"

[[model]]
provider = "openai-compat"
id = "Qwen3-x"
baseUrl = "http://127.0.0.1:8000/v1"
apiKeyEnv = "OMLX_API_KEY"
extraBody = { chat_template_kwargs = { enable_thinking = false } }
`;

function fakeFactory(avail: Record<string, boolean>, log: { model: string; opts: unknown }[] = []) {
  return (entry: { provider: string }): Provider => ({
    name: entry.provider,
    async available(id) {
      return avail[`${entry.provider}:${id}`] ?? false;
    },
    async complete(id, _p, opts) {
      log.push({ model: `${entry.provider}:${id}`, opts });
      return "{}";
    },
  });
}

describe("models.toml", () => {
  test("parses entries, drops incomplete, validates effort, round-trips", () => {
    const cfg = parseModelsToml(toml);
    expect(cfg.preference).toEqual(["copilot", "local"]);
    expect(cfg.models.map((m) => m.id)).toEqual(["gemma4:26b", "qwen3:8b", "gpt-4.1", "Qwen3-x"]);
    expect(cfg.models[2].reasoningEffortByTask).toEqual({ "edge-judge": "xhigh" });
    expect(cfg.models[3].extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(() => parseModelsToml('[[model]]\nprovider="copilot"\nid="x"\nreasoningEffort="bogus"\n')).toThrow(/reasoningEffort/);
    const again = parseModelsToml(serializeModelsToml(cfg));
    expect(again).toEqual(cfg);
    expect(parseModelsToml("").preference).toEqual(["local", "openai-compat", "copilot"]);
  });
  test("detection synthesizes a config", async () => {
    const cfg = await detectModels({ ollama: async () => ["qwen3-embedding:0.6b", "gemma4:26b", "qwen3:14b", "llama3:8b"], omlxModels: async () => ["Qwen3-30B"], copilotOnPath: () => true, openaiKey: () => true });
    expect(cfg.models.map((m) => `${m.provider}:${m.id}:${m.quality}`)).toEqual(["local:gemma4:26b:high", "local:qwen3:14b:high", "local:llama3:8b:standard", "openai-compat:Qwen3-30B:high", "copilot:default:high", "openai-compat:gpt-4o:high"]);
    expect(cfg.models[5]).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
    expect(cfg.models[0].bestFor).toEqual(["cleanup"]);
    expect(cfg.models[4].reasoningEffort).toBeUndefined();
    expect(cfg.models[4].reasoningEffortByTask).toBeUndefined();
    const none = await detectModels({ ollama: async () => [], omlxModels: async () => [], copilotOnPath: () => false, openaiKey: () => false });
    expect(none.models).toEqual([]);
  });
});

describe("router.resolve", () => {
  const config = { ...parseModelsToml(toml), source: "file" as const };
  test("quality floor, bestFor affinity, preference order, lang filter, effort injection", async () => {
    const log: { model: string; opts: unknown }[] = [];
    const r = await createRouter({ config, factory: fakeFactory({ "local:gemma4:26b": true, "local:qwen3:8b": true, "copilot:gpt-4.1": true, "openai-compat:Qwen3-x": false }, log) });
    expect(r.resolve({ kind: "cleanup", minQuality: "high" })!.id).toBe("local:gemma4:26b"); // bestFor restricts
    expect(r.resolve({ kind: "summary" })!.id).toBe("copilot:gpt-4.1"); // bestFor summary
    expect(r.resolve({ kind: "tag", minQuality: "cheap" })!.id).toBe("copilot:gpt-4.1"); // preference copilot first
    expect(r.resolve({ kind: "synthesis", minQuality: "high", lang: "de" })!.id).toBe("copilot:gpt-4.1"); // gemma excluded by lang
    expect(r.resolve({ kind: "cleanup", minQuality: "high", lang: "sv" })!.id).toBe("local:gemma4:26b");
    const m = r.resolve({ kind: "edge-judge" })!;
    await m.complete("p", { json: true });
    expect(log[0]).toEqual({ model: "copilot:gpt-4.1", opts: { json: true, reasoningEffort: "xhigh" } });
    await r.resolve({ kind: "summary" })!.complete("p");
    expect((log[1].opts as { reasoningEffort: string }).reasoningEffort).toBe("high");
  });
  test("cheapest sufficient within same provider; null when nothing available", async () => {
    const r = await createRouter({ config: { ...config, preference: ["local"] }, factory: fakeFactory({ "local:gemma4:26b": true, "local:qwen3:8b": true }) });
    expect(r.resolve({ kind: "tag", minQuality: "cheap" })!.id).toBe("local:qwen3:8b");
    expect(r.resolve({ kind: "synthesis", minQuality: "high" })!.id).toBe("local:gemma4:26b");
    const none = await createRouter({ config, factory: fakeFactory({}) });
    expect(none.resolve({ kind: "summary" })).toBeNull();
  });
});

describe("provider helpers", () => {
  test("parseJsonObject handles fences and prose", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Sure! {"a":{"b":"}"}} trailing')).toEqual({ a: { b: "}" } });
    expect(() => parseJsonObject("nothing")).toThrow();
  });
  test("copilot NDJSON parsing and CLI args", async () => {
    const nd = '{"type":"tool.call"}\n{"type":"assistant.message","data":{"content":"{\\"x\\":1}"}}\n{"type":"assistant.message","data":{"content":"{\\"x\\":2}"}}\n';
    expect(parseCopilotOutput(nd)).toBe('{"x":2}');
    expect(parseCopilotOutput('garbage {"y":3} more')).toBe('{"y":3}');
    let seen: string[] = [];
    const p = copilotProvider(async (args) => {
      seen = args;
      return { code: 0, stdout: nd, stderr: "" };
    }, () => "/usr/bin/copilot");
    expect(await p.available("gpt")).toBe(true);
    expect(await p.complete("gpt-4.1", "hello", { reasoningEffort: "xhigh" })).toBe('{"x":2}');
    expect(seen).toEqual(["copilot", "-p", "hello", "--model", "gpt-4.1", "--silent", "--output-format", "json", "--no-color", "--disable-builtin-mcps", "--no-custom-instructions", "--reasoning-effort", "xhigh"]);
    expect(seen).not.toContain("--allow-all-tools");
  });
  test("TruncationError is an Error", () => {
    expect(new TruncationError()).toBeInstanceOf(Error);
  });
});

describe("copilot model steps on live detection and the shipped presets (jv-zdv)", () => {
  /** Copilot CLI 1.0.105: gpt-4.1 refuses any --reasoning-effort, as the real CLI does. */
  const copilot1105: Spawn = async (args) => {
    const model = args[args.indexOf("--model") + 1];
    if (model === "gpt-4.1" && args.includes("--reasoning-effort")) return { code: 1, stdout: "", stderr: "Error: Model 'gpt-4.1' does not support reasoning effort configuration" };
    return { code: 0, stdout: '{"type":"assistant.message","data":{"content":"{\\"ok\\":true}"}}\n', stderr: "" };
  };
  /** Only the Copilot CLI is present: every other provider is unavailable. */
  const onlyCopilot = (entry: { provider: string }): Provider =>
    entry.provider === "copilot" ? copilotProvider(copilot1105, () => "/usr/bin/copilot") : { name: entry.provider, available: async () => false, complete: async () => { throw new Error("unavailable"); } };
  const completesEveryCopilotStep = async (config: ModelsConfig) => {
    const r = await createRouter({ config, factory: onlyCopilot });
    let routed = 0;
    for (const kind of TASK_KINDS) {
      const m = r.resolve({ kind, minQuality: "cheap" });
      if (!m || m.provider !== "copilot") continue;
      routed++;
      expect(`${kind}: ${await m.complete("p", { json: true }).catch((e: Error) => e.message)}`).toBe(`${kind}: {"ok":true}`);
    }
    expect(routed > 0).toBe(config.models.some((m) => m.provider === "copilot"));
  };
  test("no models.toml: live detection's Copilot entry answers every task kind", async () => {
    const detected = await detectModels({ ollama: async () => [], omlxModels: async () => [], copilotOnPath: () => true, openaiKey: () => false });
    expect(detected.models.map((m) => `${m.provider}:${m.id}`)).toEqual(["copilot:default"]);
    await completesEveryCopilotStep({ ...detected, source: "detected" });
  });
  for (const name of listPresets()) {
    test(`preset ${name}: its Copilot entry answers the steps routed to it`, async () => {
      await completesEveryCopilotStep({ ...parseModelsToml(readPreset(name)), source: "file" });
    });
  }
});

describe("copilot model steps on an account that does not offer gpt-4.1 (jv-l1q)", () => {
  /** Copilot CLI 1.0.105 on the navigator's account: only gpt-5.6-luna by name, or Copilot's own default with no --model. */
  const offered = new Set(["gpt-5.6-luna"]);
  const copilotWithoutGpt41: Spawn = async (args) => {
    const i = args.indexOf("--model");
    if (i >= 0 && !offered.has(args[i + 1]!)) return { code: 1, stdout: "", stderr: `Error: Model "${args[i + 1]}" from --model flag is not available.` };
    return { code: 0, stdout: '{"type":"assistant.message","data":{"content":"{\\"ok\\":true}"}}\n', stderr: "" };
  };
  const onlyCopilot = (entry: { provider: string }): Provider =>
    entry.provider === "copilot" ? copilotProvider(copilotWithoutGpt41, () => "/usr/bin/copilot") : { name: entry.provider, available: async () => false, complete: async () => { throw new Error("unavailable"); } };
  const completesEveryCopilotStep = async (config: ModelsConfig) => {
    const r = await createRouter({ config, factory: onlyCopilot });
    let routed = 0;
    for (const kind of TASK_KINDS) {
      const m = r.resolve({ kind, minQuality: "cheap" });
      if (!m || m.provider !== "copilot") continue;
      routed++;
      expect(`${kind}: ${await m.complete("p", { json: true }).catch((e: Error) => e.message)}`).toBe(`${kind}: {"ok":true}`);
    }
    expect(routed > 0).toBe(config.models.some((m) => m.provider === "copilot"));
  };
  test("no models.toml: live detection lets Copilot pick its default model", async () => {
    const detected = await detectModels({ ollama: async () => [], omlxModels: async () => [], copilotOnPath: () => true, openaiKey: () => false });
    await completesEveryCopilotStep({ ...detected, source: "detected" });
  });
  for (const name of listPresets()) {
    test(`preset ${name}: its Copilot entry lets Copilot pick its default model`, async () => {
      await completesEveryCopilotStep({ ...parseModelsToml(readPreset(name)), source: "file" });
    });
  }
  test("JARVIS_COPILOT_MODEL names the detected id; empty falls back to default", async () => {
    const saved = process.env.JARVIS_COPILOT_MODEL;
    const detect = () => detectModels({ ollama: async () => [], omlxModels: async () => [], copilotOnPath: () => true, openaiKey: () => false });
    try {
      process.env.JARVIS_COPILOT_MODEL = "gpt-5.6-luna";
      expect((await detect()).models[0]!.id).toBe("gpt-5.6-luna");
      process.env.JARVIS_COPILOT_MODEL = "";
      expect((await detect()).models[0]!.id).toBe("default");
    } finally {
      if (saved === undefined) delete process.env.JARVIS_COPILOT_MODEL;
      else process.env.JARVIS_COPILOT_MODEL = saved;
    }
  });
  test("a configured model id the account offers is still passed with --model", async () => {
    await completesEveryCopilotStep({ preference: ["copilot"], models: [{ provider: "copilot", id: "gpt-5.6-luna", quality: "high", bestFor: [...TASK_KINDS] }], source: "file" });
  });
});
