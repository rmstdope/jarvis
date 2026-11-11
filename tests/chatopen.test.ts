import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenFilter } from "../src/chat/open.ts";
import { spawnBunAcp } from "../src/chat/acp.ts";
import { ChatService } from "../src/chat/sessions.ts";
import { ingest } from "../src/core/ingest.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

describe("OpenFilter", () => {
  test("strips a marker and reports its id", () => {
    const f = new OpenFilter();
    expect(f.push("I opened it. <<open:abc>> Done.")).toEqual({ text: "I opened it.  Done.", opens: ["abc"] });
  });
  test("a marker split across chunks never leaks", () => {
    const f = new OpenFilter();
    const a = f.push("See <<op"), b = f.push("en:x1"), c = f.push(">> ok");
    expect(a).toEqual({ text: "See ", opens: [] });
    expect(b).toEqual({ text: "", opens: [] });
    expect(c).toEqual({ text: " ok", opens: ["x1"] });
  });
  test("a lone << that is not a marker is released at the end", () => {
    const f = new OpenFilter();
    expect(f.push("a <<").text).toBe("a ");
    expect(f.end()).toBe("<<");
    expect(f.push("x < y").text).toBe("x < y");
  });
});

const FAKE = join(import.meta.dir, "fixtures", "fake-acp.ts");
let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { clearEmbedder(); t.cleanup(); });

describe("ChatService open events", () => {
  test("a marker in the answer becomes an open event for a real document; unknown ids are dropped", async () => {
    const r = await ingest(t.dir, { source: "note", title: "Pricing decision", body: "We chose plan B.", author: "mia" } as never);
    const svc = new ChatService(t.dir, { spawn: (_m, cwd) => spawnBunAcp(FAKE, cwd) });
    const s = await svc.create({ type: "jarvis", ids: [] });
    const ev: { type: string; [k: string]: unknown }[] = [];
    for await (const e of svc.send(s.id, `<<open:${r.id}>> <<open:nope>> hi`)) ev.push(e as never);
    await svc.shutdown();
    const text = ev.filter((e) => e.type === "message").map((e) => e.text).join("");
    expect(text).not.toContain("<<");
    const opens = ev.filter((e) => e.type === "open");
    expect(opens).toEqual([{ type: "open", docId: r.id, title: "Pricing decision", source: "note" }]);
  });
  test("a path-like id or a broken doc never throws out of the listener; the connection survives", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(t.dir, "docs"), { recursive: true });
    writeFileSync(join(t.dir, "docs", "broken.md"), "no frontmatter at all");
    writeFileSync(join(t.dir, "README.md"), "x");
    const svc = new ChatService(t.dir, { spawn: (_m, cwd) => spawnBunAcp(FAKE, cwd) });
    const s = await svc.create({ type: "jarvis", ids: [] });
    const ev: { type: string }[] = [];
    for await (const e of svc.send(s.id, "<<open:../README>> <<open:broken>> hi")) ev.push(e as never);
    expect(ev.some((e) => e.type === "open")).toBe(false);
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(ev.at(-1)!.type).toBe("done");
    await svc.shutdown();
  });
  test("a chat about a presentation can be created and grounds on its body", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(t.dir, "presentations", "deck-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.mdx"), "---\nid: 01HZZZZZZZZZZZZZZZZZZZZZZZ\nsource: presentation\ntitle: Deck one\nauthor: mia\ncreated_at: 2026-01-01\n---\n# Deck one\n\n<Presentation>\n\n## Slide 1\n\nzoom drift facts\n\n</Presentation>\n");
    const svc = new ChatService(t.dir, { spawn: (_m, cwd) => spawnBunAcp(FAKE, cwd) });
    const s = await svc.create({ type: "item", ids: ["deck-one"] });
    expect(s.sources[0]).toMatchObject({ docId: "deck-one", title: "Deck one", source: "presentation" });
    expect(svc.buildPrompt(s, "hi").prompt).toContain("zoom drift facts");
    await svc.shutdown();
  });
});
