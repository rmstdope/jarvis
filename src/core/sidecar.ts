import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Relation } from "./constants.ts";

export interface EdgeLine {
  kind: "edge";
  src: string;
  dst: string;
  relation: Relation;
  created_by: "llm" | "manual";
  weight: number;
  author: string;
  created_at: string;
  model?: string;
}
export interface RejectionLine {
  kind: "rejection";
  src: string;
  dst: string;
  judged_by: "llm" | "manual";
  author: string;
  created_at: string;
  model?: string;
}
export type SidecarLine = EdgeLine | RejectionLine;

export function edgesDir(dataDir: string): string {
  return join(dataDir, "edges");
}
export function sidecarPath(dataDir: string, src: string): string {
  return join(edgesDir(dataDir), `${src}.jsonl`);
}
export function appendSidecar(dataDir: string, line: SidecarLine): void {
  mkdirSync(edgesDir(dataDir), { recursive: true });
  appendFileSync(sidecarPath(dataDir, line.src), JSON.stringify(line) + "\n");
}
export function readSidecar(dataDir: string, src: string): SidecarLine[] {
  const p = sidecarPath(dataDir, src);
  if (!existsSync(p)) return [];
  const out: SidecarLine[] = [];
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}
/** Every `src\tdst` key present in any sidecar as an edge or rejection (the refine idempotency marker). */
export function sidecarKeys(dataDir: string): Set<string> {
  const keys = new Set<string>();
  const dir = edgesDir(dataDir);
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o.src && o.dst) keys.add(`${o.src}\t${o.dst}`);
      } catch {}
    }
  }
  return keys;
}
