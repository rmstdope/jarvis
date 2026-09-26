import { describe, expect, test } from "bun:test";
import { parseArgs, flagInt } from "../src/core/args.ts";

describe("args", () => {
  test("parses flags and positionals", () => {
    const p = parseArgs(["search", "hello", "world", "--mode", "keyword", "--full", "--limit=5"]);
    expect(p.positional).toEqual(["search", "hello", "world"]);
    expect(p.flags).toEqual({ mode: "keyword", full: true, limit: "5" });
    expect(flagInt(p.flags, "limit")).toBe(5);
    expect(() => flagInt({ limit: "abc" }, "limit")).toThrow();
  });
});
