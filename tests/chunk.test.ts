import { describe, expect, test } from "bun:test";
import { chunkDoc, chunkText } from "../src/core/chunk.ts";

const para = (n: number, w = "w") => Array.from({ length: n }, () => w).join(" ");

describe("chunk", () => {
  test("short body is one chunk", () => {
    expect(chunkText("hello world\n\nsecond para")).toEqual(["hello world\n\nsecond para"]);
  });
  test("packs paragraphs to the word budget and carries overlap", () => {
    const body = [para(300, "a"), para(300, "b"), para(100, "c")].join("\n\n");
    const chunks = chunkText(body);
    expect(chunks.length).toBe(2);
    expect(chunks[0].split(/\s+/).length).toBe(300);
    // overlap: the last 67 words of chunk 0 begin chunk 1
    const w = chunks[1].split(/\s+/);
    expect(w.slice(0, 67).every((x) => x === "a")).toBe(true);
    expect(w[67]).toBe("b");
  });
  test("oversized paragraph splits on sentences", () => {
    const sentences = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} has some words in it.`).join(" ");
    const chunks = chunkText(sentences);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
  });
  test("safety pass caps chars at 1600", () => {
    const chunks = chunkText("x".repeat(5000));
    expect(chunks.every((c) => c.length <= 1600)).toBe(true);
  });
  test("ids are content hashes; tail append churns only the last chunk", () => {
    const base = [para(300, "a"), para(300, "b"), para(300, "c")].join("\n\n");
    const a = chunkDoc("doc1", base);
    const b = chunkDoc("doc1", base + "\n\n" + para(50, "d"));
    expect(a[0].id).toBe(b[0].id);
    expect(a[1].id).toBe(b[1].id);
    expect(a[a.length - 1].id).not.toBe(b[b.length - 1].id);
    expect(chunkDoc("doc2", base)[0].id).not.toBe(a[0].id);
  });
});
