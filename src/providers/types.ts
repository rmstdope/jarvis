export type TaskKind = "tag" | "summary" | "entities" | "edge-judge" | "cleanup" | "synthesis";
export type Quality = "cheap" | "standard" | "high";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface TaskProfile {
  kind: TaskKind;
  minQuality?: Quality;
  lang?: string;
}
export interface CompleteOpts {
  json?: boolean;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Abort the call after this many milliseconds; providers default to `LLM_TIMEOUT_MS`. */
  timeoutMs?: number;
}
export interface ResolvedModel {
  id: string; // "provider:model"
  provider: string;
  model: string;
  complete(prompt: string, opts?: CompleteOpts): Promise<string>;
}
export interface Provider {
  name: string;
  available(modelId: string): Promise<boolean>;
  complete(modelId: string, prompt: string, opts?: CompleteOpts): Promise<string>;
}
/** Output cap hit. Deterministic: never retry the same call. */
export class TruncationError extends Error {
  constructor(message = "model output was truncated (length)") {
    super(message);
  }
}
export const QUALITY_RANK: Record<Quality, number> = { cheap: 0, standard: 1, high: 2 };
export const TASK_KINDS: TaskKind[] = ["tag", "summary", "entities", "edge-judge", "cleanup", "synthesis"];
export const DEFAULT_MIN_QUALITY: Record<TaskKind, Quality> = { tag: "cheap", entities: "cheap", summary: "standard", "edge-judge": "standard", cleanup: "high", synthesis: "high" };
export const REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Parse model JSON output: JSON.parse, else the first balanced {…} block. */
export function parseJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON object in model output");
}
