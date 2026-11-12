import { describe, expect, test } from "bun:test";
import { escapePath, findMention, headerFor, middleCut, narrow, splitPath } from "../web/src/atpath.ts";

describe("findMention", () => {
  test("opens at the start, after a space and after a new line", () => {
    expect(findMention("@", 1)).toEqual({ start: 0, end: 1, raw: "" });
    expect(findMention("look at @no", 11)).toEqual({ start: 8, end: 11, raw: "no" });
    expect(findMention("a\n@x", 4)).toEqual({ start: 2, end: 4, raw: "x" });
  });
  test("an @ inside a word never opens it", () => {
    expect(findMention("mail sam@team.io", 16)).toBeNull();
    expect(findMention("sam@", 4)).toBeNull();
  });
  test("a space closes it; an escaped space does not", () => {
    expect(findMention("@notes ", 7)).toBeNull();
    expect(findMention("@notes/on-call\\ han", 19)).toEqual({ start: 0, end: 19, raw: "notes/on-call\\ han" });
  });
  test("the token extends past the caret and the caret may sit inside it", () => {
    expect(findMention("@notes/oncall x", 4)).toEqual({ start: 0, end: 13, raw: "not" });
  });
});
describe("path helpers", () => {
  test("splitPath: dir up to the last slash, prefix after it, escapes undone", () => {
    expect(splitPath("")).toEqual({ dir: "", prefix: "" });
    expect(splitPath("no")).toEqual({ dir: "", prefix: "no" });
    expect(splitPath("notes/on\\ ca")).toEqual({ dir: "notes/", prefix: "on ca" });
    expect(splitPath("~/Down")).toEqual({ dir: "~/", prefix: "Down" });
    expect(splitPath("/Users/sam/")).toEqual({ dir: "/Users/sam/", prefix: "" });
  });
  test("escapePath puts a backslash before each space", () => {
    expect(escapePath("on-call handover checklist.md")).toBe("on-call\\ handover\\ checklist.md");
  });
  test("narrow: starts-with, ignoring case; dot names only after a typed dot", () => {
    const e = [{ name: ".git", dir: true }, { name: "Notes", dir: true }, { name: "notes.md", dir: false }, { name: "other", dir: false }];
    expect(narrow(e, "").map((x) => x.name)).toEqual(["Notes", "notes.md", "other"]);
    expect(narrow(e, "NOT").map((x) => x.name)).toEqual(["Notes", "notes.md"]);
    expect(narrow(e, ".").map((x) => x.name)).toEqual([".git"]);
    expect(narrow(e, "x")).toEqual([]);
  });
  test("headerFor", () => {
    expect(headerFor("")).toBe("Team content");
    expect(headerFor("notes/oncall/")).toBe("notes/oncall/");
  });
  test("middleCut keeps the start and the end", () => {
    expect(middleCut("short.md", 36)).toBe("short.md");
    const cut = middleCut("2026-03-14 quarterly planning meeting with everyone.md", 36);
    expect(cut.length).toBe(36);
    expect(cut.startsWith("2026-03-14")).toBe(true);
    expect(cut.endsWith("everyone.md")).toBe(true);
    expect(cut).toContain("…");
  });
});
