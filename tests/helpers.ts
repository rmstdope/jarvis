import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEmbedderForTests, type Embedder } from "../src/core/embed.ts";
import { EMBEDDING_DIMS } from "../src/core/constants.ts";
import { normalizeVector } from "../src/core/util.ts";
import { setRouterForTests } from "../src/providers/index.ts";

// Keep every test hermetic: no live provider detection unless a test opts in.
setRouterForTests(null);

export function tmpDataDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "second-brain-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic bag-of-words hashing embedder so semantic tests need no server. */
export function fakeEmbedder(available = true): Embedder & { calls: number } {
  const e = {
    name: "fake",
    model: "fake",
    calls: 0,
    async available() {
      return available;
    },
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const v = new Array(1024).fill(0);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % 512] += 1;
        }
        return normalizeVector(v, EMBEDDING_DIMS);
      });
    },
  };
  return e;
}
export function useFakeEmbedder(available = true) {
  const e = fakeEmbedder(available);
  setEmbedderForTests(e);
  return e;
}
export function clearEmbedder() {
  setEmbedderForTests(null);
}
