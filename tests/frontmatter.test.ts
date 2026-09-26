import { describe, expect, test } from "bun:test";
import { parseDoc, serializeDoc, FrontmatterError } from "../src/core/frontmatter.ts";

describe("frontmatter", () => {
  test("round trip with fixed key order", () => {
    const text = serializeDoc({
      frontmatter: { id: "01ABC", source: "note", title: "Hello: world", author: "me", created_at: "2026-01-01T00:00:00.000Z", starred: false, tags: ["a", "b"] },
      body: "body text\n\n---\nnot frontmatter",
    });
    expect(text.startsWith("---\nid: 01ABC\nsource: note\ntitle:")).toBe(true);
    const doc = parseDoc(text);
    expect(doc.frontmatter.title).toBe("Hello: world");
    expect(doc.frontmatter.tags).toEqual(["a", "b"]);
    expect(doc.body).toBe("body text\n\n---\nnot frontmatter\n");
    expect(doc.frontmatter.created_at).toBe("2026-01-01T00:00:00.000Z");
  });
  test("missing required key throws", () => {
    expect(() => parseDoc("---\nid: x\n---\nbody")).toThrow(FrontmatterError);
  });
  test("undefined keys are omitted", () => {
    const text = serializeDoc({ frontmatter: { id: "x", source: "note", title: "t", author: "a", created_at: "2026-01-01T00:00:00Z", summary: undefined }, body: "" });
    expect(text).not.toContain("summary");
  });
});
