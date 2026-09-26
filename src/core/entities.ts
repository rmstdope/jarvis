import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Database } from "bun:sqlite";
import { ENTITY_COSINE_THRESHOLD, ENTITY_KINDS, type EntityKind } from "./constants.ts";
import { getEmbedder, type Embedder } from "./embed.ts";
import { variantMap, type Glossary } from "./glossary.ts";
import { nowIso } from "./util.ts";

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  canonical: string;
  aliases: string[];
  stub: boolean;
  created_by: string;
  created_at: string;
}

export function entitiesDir(dataDir: string): string {
  return join(dataDir, "entities");
}
export function readEntities(dataDir: string): Entity[] {
  const dir = entitiesDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (e.id && e.name) out.push({ aliases: [], stub: false, canonical: e.id, created_by: "unknown", created_at: "", ...e });
    } catch {}
  }
  return out;
}
export function writeEntity(dataDir: string, e: Entity): void {
  mkdirSync(entitiesDir(dataDir), { recursive: true });
  writeFileSync(join(entitiesDir(dataDir), `${e.id}.json`), JSON.stringify(e, null, 2) + "\n");
}
export function mirrorEntity(db: Database, e: Entity): void {
  db.run("INSERT OR REPLACE INTO entities (id, name, kind, canonical, aliases, stub) VALUES (?, ?, ?, ?, ?, ?)", [e.id, e.name, e.kind, e.canonical, JSON.stringify(e.aliases), e.stub ? 1 : 0]);
}
export const norm = (s: string) => s.trim().toLowerCase();

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are normalized
}

/** Resolves mentions against the registry, creating stubs. Reused across docs in one run. */
export class EntityResolver {
  private entities: Entity[];
  private vecCache = new Map<string, Float32Array>();
  created: Entity[] = [];
  constructor(private dataDir: string, private glossary: Glossary, private author: string, private embedder: Embedder | null = getEmbedder(), private db?: Database) {
    this.entities = readEntities(dataDir);
  }
  private live(): Entity[] {
    return this.entities.filter((e) => e.canonical === e.id);
  }
  private async vec(text: string): Promise<Float32Array | null> {
    if (!this.embedder) return null;
    const k = norm(text);
    const c = this.vecCache.get(k);
    if (c) return c;
    try {
      const [v] = await this.embedder.embed([text]);
      this.vecCache.set(k, v);
      return v;
    } catch {
      this.embedder = null;
      return null;
    }
  }
  /** `createdBy` = the doc author for stubs created on its behalf. */
  async resolve(name: string, kind: EntityKind, createdBy: string = this.author): Promise<Entity> {
    const n = norm(name);
    const live = this.live();
    // 1. exact (kind, name)
    let hit = live.find((e) => e.kind === kind && norm(e.name) === n);
    if (hit) return hit;
    // 2. glossary variant → canonical → exact (kind, canonical)
    const canon = variantMap(this.glossary).get(n);
    if (canon) hit = live.find((e) => e.kind === kind && norm(e.name) === norm(canon));
    if (hit) return hit;
    // 3. (kind, alias)
    hit = live.find((e) => e.kind === kind && e.aliases.some((a) => norm(a) === n));
    if (hit) return hit;
    // 4. cosine ≥ 0.85 against same-kind entity names
    const qv = await this.vec(name);
    if (qv) {
      let best: { e: Entity; s: number } | null = null;
      for (const e of live.filter((e) => e.kind === kind)) {
        const ev = await this.vec(e.name);
        if (!ev) break;
        const s = cosine(qv, ev);
        if (s >= ENTITY_COSINE_THRESHOLD && (!best || s > best.s)) best = { e, s };
      }
      if (best) return best.e;
    }
    // 5. same term owned by exactly one entity of any kind (kind-drift guard)
    const owners = live.filter((e) => norm(e.name) === n || e.aliases.some((a) => norm(a) === n));
    if (owners.length === 1) return owners[0];
    // 6. stub
    const id = ulid();
    const stub: Entity = { id, name: name.trim(), kind, canonical: id, aliases: [], stub: true, created_by: createdBy, created_at: nowIso() };
    writeEntity(this.dataDir, stub);
    if (this.db) mirrorEntity(this.db, stub);
    this.entities.push(stub);
    this.created.push(stub);
    return stub;
  }
}

export function isEntityKind(k: unknown): k is EntityKind {
  return ENTITY_KINDS.includes(k as EntityKind);
}

/** Union-find over (kind, normalizedTerm); survivor = smallest ULID; others rewritten with canonical → survivor. */
export function dedupEntities(dataDir: string, opts: { dryRun?: boolean } = {}): { merged: { survivor: string; into: string[] }[] } {
  const all = readEntities(dataDir).filter((e) => e.canonical === e.id);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const owner = new Map<string, string>();
  for (const e of all) {
    for (const term of [e.name, ...e.aliases]) {
      const key = `${e.kind}\u0000${norm(term)}`;
      const o = owner.get(key);
      if (o) union(e.id, o);
      else owner.set(key, e.id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const e of all) {
    const r = find(e.id);
    groups.set(r, [...(groups.get(r) ?? []), e.id]);
  }
  const merged: { survivor: string; into: string[] }[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    const survivor = sorted[0];
    const into = sorted.slice(1);
    merged.push({ survivor, into });
    if (!opts.dryRun) {
      for (const id of into) {
        const e = all.find((x) => x.id === id)!;
        writeEntity(dataDir, { ...e, canonical: survivor });
      }
    }
  }
  return { merged };
}
