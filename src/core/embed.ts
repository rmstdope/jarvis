import type { Database } from "bun:sqlite";
import {
  EMBEDDING_DIMS, EMBED_BATCH_SIZE, EMBED_CONCURRENCY, OLLAMA_EMBED_MODEL, OLLAMA_URL, OMLX_EMBED_MODEL, OMLX_URL, PROBE_TIMEOUT_MS,
} from "./constants.ts";
import { loadConfig, resolveEmbeddingProvider } from "./config.ts";
import { normalizeVector, vecToJson } from "./util.ts";

export class EmbeddingUnavailableError extends Error {}

export interface Embedder {
  name: string;
  model: string;
  available(): Promise<boolean>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export function ollamaEmbedder(base = OLLAMA_URL, model = OLLAMA_EMBED_MODEL): Embedder {
  return {
    name: "ollama",
    model,
    async available() {
      try {
        const r = await fetch(`${base}/api/tags`, { signal: withTimeout(PROBE_TIMEOUT_MS) });
        return r.ok;
      } catch {
        return false;
      }
    },
    async embed(texts) {
      const r = await fetch(`${base}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts, truncate: true }),
      });
      if (!r.ok) throw new EmbeddingUnavailableError(`ollama embed failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { embeddings: number[][] };
      if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new EmbeddingUnavailableError("ollama embed: count mismatch");
      return j.embeddings.map((v) => normalizeVector(v, EMBEDDING_DIMS));
    },
  };
}

export function omlxEmbedder(base = OMLX_URL, model = OMLX_EMBED_MODEL): Embedder {
  const key = process.env.OMLX_API_KEY ?? loadConfig().omlxApiKey;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  return {
    name: "omlx",
    model,
    async available() {
      try {
        const r = await fetch(`${base}/models`, { headers, signal: withTimeout(PROBE_TIMEOUT_MS) });
        return r.ok;
      } catch {
        return false;
      }
    },
    async embed(texts) {
      const r = await fetch(`${base}/embeddings`, { method: "POST", headers, body: JSON.stringify({ model, input: texts }) });
      if (!r.ok) throw new EmbeddingUnavailableError(`omlx embed failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { data: { index: number; embedding: number[] }[] };
      const data = [...(j.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== texts.length) throw new EmbeddingUnavailableError("omlx embed: count mismatch");
      return data.map((d) => normalizeVector(d.embedding, EMBEDDING_DIMS));
    },
  };
}

let override: Embedder | null = null;
/** Tests inject a fake embedder here. */
export function setEmbedderForTests(e: Embedder | null): void {
  override = e;
}
export function getEmbedder(): Embedder {
  if (override) return override;
  if (process.env.SECOND_BRAIN_EMBED_FAKE === "1") return fakeHashEmbedder();
  return resolveEmbeddingProvider() === "omlx" ? omlxEmbedder() : ollamaEmbedder();
}

/** Deterministic bag-of-words embedder for tests and offline demos (SECOND_BRAIN_EMBED_FAKE=1). */
export function fakeHashEmbedder(): Embedder {
  return {
    name: "fake",
    model: "fake-hash",
    async available() {
      return true;
    },
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array(EMBEDDING_DIMS).fill(0);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % EMBEDDING_DIMS] += 1;
        }
        return normalizeVector(v, EMBEDDING_DIMS);
      });
    },
  };
}

/** Embed a single query string through the same truncate+normalize path as chunks. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const e = getEmbedder();
  const [v] = await e.embed([text]);
  return v;
}

export interface EmbedResult {
  embedded: number;
  skipped?: string;
}

/** Embed every chunk with embedded = 0 in batches; one transaction per batch. */
export async function embedPending(db: Database, opts: { batchSize?: number; concurrency?: number } = {}): Promise<EmbedResult> {
  const batchSize = opts.batchSize ?? EMBED_BATCH_SIZE;
  const concurrency = Math.max(1, opts.concurrency ?? EMBED_CONCURRENCY);
  const pending = db.query("SELECT id, text FROM chunks WHERE embedded = 0 ORDER BY doc_id, seq").all() as { id: string; text: string }[];
  if (pending.length === 0) return { embedded: 0 };
  const embedder = getEmbedder();
  if (!(await embedder.available())) throw new EmbeddingUnavailableError(`embedding server (${embedder.name}) is unreachable`);

  const batches: { id: string; text: string }[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));

  const insertVec = db.prepare("INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)");
  const markDone = db.prepare("UPDATE chunks SET embedded = 1 WHERE id = ?");
  const store = db.transaction((rows: { id: string; vec: Float32Array }[]) => {
    for (const r of rows) {
      insertVec.run(r.id, vecToJson(r.vec));
      markDone.run(r.id);
    }
  });

  let embedded = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const vecs = await embedder.embed(batch.map((b) => b.text));
      store(batch.map((b, i) => ({ id: b.id, vec: vecs[i] })));
      embedded += batch.length;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return { embedded };
}
