import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listDir } from "../src/chat/paths.ts";
import { handle } from "../src/server.ts";
import { tmpDataDir } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => {
  t = tmpDataDir();
  mkdirSync(join(t.dir, "notes", "oncall"), { recursive: true });
  mkdirSync(join(t.dir, "Zeta"));
  mkdirSync(join(t.dir, ".hidden"));
  writeFileSync(join(t.dir, "readme.md"), "x");
  writeFileSync(join(t.dir, "Apple.md"), "x");
  writeFileSync(join(t.dir, "notes", "on-call handover.md"), "x");
});
afterEach(() => t.cleanup());

describe("listDir", () => {
  test("content root: folders first then files, A-Z ignoring case, dot names included", () => {
    const r = listDir(t.dir, "");
    expect(r.ok && r.entries.map((e) => (e.dir ? `${e.name}/` : e.name))).toEqual([".hidden/", "notes/", "Zeta/", "Apple.md", "readme.md"]);
  });
  test("relative sub folder and spaces in names", () => {
    const r = listDir(t.dir, "notes/");
    expect(r.ok && r.entries).toEqual([{ name: "oncall", dir: true }, { name: "on-call handover.md", dir: false }]);
  });
  test("absolute path reaches outside the content dir", () => {
    const r = listDir(t.dir, join(t.dir, "notes") + "/");
    expect(r.ok && r.entries.length).toBe(2);
  });
  test("~/ is the injected home folder", () => {
    const r = listDir("/nonexistent-content", "~/notes/", t.dir);
    expect(r.ok && r.entries.length).toBe(2);
  });
  test("missing, a file, and unreadable are not ok", () => {
    expect(listDir(t.dir, "nope/").ok).toBe(false);
    expect(listDir(t.dir, "readme.md").ok).toBe(false);
  });
});

describe("GET /api/chat/paths", () => {
  const get = (dir: string) => handle(new Request(`http://x/api/chat/paths?dir=${encodeURIComponent(dir)}`), { dataDir: t.dir });
  test("lists a folder", async () => {
    const r = await get("notes/");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { entries: unknown[] }).entries).toHaveLength(2);
  });
  test("404 for a folder that cannot be opened", async () => {
    expect((await get("nope/")).status).toBe(404);
  });
});
