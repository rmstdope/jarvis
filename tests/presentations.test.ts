import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SlidecraftStatus, sharePresentation, promotePresentation, listPresentations, discoverSlidecraft, deckInSlidecraft, slidecraftGlob, SLIDECRAFT_CANDIDATES, parsePresentation } from "../src/core/presentations.ts";
import { ingest } from "../src/core/ingest.ts";
import { reindex } from "../src/core/reindex.ts";
import { search } from "../src/core/search.ts";
import { withDb } from "../src/core/db.ts";
import { draftMeetingSummary } from "../src/core/meetingSummary.ts";
import { scanInbox, classifyFolder, acquireLock, readState } from "../src/core/inbox.ts";
import { readBriefing, listBriefings } from "../src/briefings/store.ts";
import { readDocFile } from "../src/core/docs.ts";
import { handle } from "../src/server.ts";
import { fakeRouter, noRouter } from "./fakeRouter.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => { t = tmpDataDir(); useFakeEmbedder(); });
afterEach(() => { t.cleanup(); clearEmbedder(); });

const DECK = "# Zoom drift deck\n\n<Presentation>\n\n## Slide 1\n\nzoom drift facts\n\n</Presentation>\n";

describe("presentations", () => {
  test("share a bare file injects frontmatter; share a dir copies assets; validation", async () => {
    const src = join(t.dir, "src");
    mkdirSync(join(src, "assets"), { recursive: true });
    writeFileSync(join(src, "deck.mdx"), DECK);
    writeFileSync(join(src, "assets", "a.png"), "png");
    writeFileSync(join(src, "theme.css"), "body{}");
    const p = sharePresentation(t.dir, join(src, "deck.mdx"), { slug: "zoom-deck", author: "me" });
    expect(p.title).toBe("Zoom drift deck");
    expect(p.frontmatter.provenance?.imported_from).toContain("deck.mdx");
    const text = readFileSync(join(t.dir, "presentations", "zoom-deck", "index.mdx"), "utf8");
    expect(text).toMatch(/^---\nid: [0-9A-Z]{26}\nsource: presentation\ntitle: Zoom drift deck\nauthor: me\ncreated_at: /);
    expect(() => sharePresentation(t.dir, join(src, "deck.mdx"), { slug: "zoom-deck" })).toThrow(/already exists/);
    expect(() => sharePresentation(t.dir, join(src, "deck.mdx"), { slug: "Bad Slug" })).toThrow(/invalid slug/);
    const d = sharePresentation(t.dir, src, { slug: "dir-deck", author: "me", title: "Dir deck" });
    expect(d.title).toBe("Dir deck");
    expect(existsSync(join(t.dir, "presentations", "dir-deck", "assets", "a.png"))).toBe(true);
    expect(existsSync(join(t.dir, "presentations", "dir-deck", "theme.css"))).toBe(true);
    expect(existsSync(join(t.dir, "presentations", "dir-deck", "deck.mdx"))).toBe(false);
    // existing frontmatter preserved; duplicate id across slugs rejected
    const two = join(t.dir, "two");
    mkdirSync(two);
    writeFileSync(join(two, "index.mdx"), `---\nid: ${d.id}\ntitle: Dup\ntags: [x]\n---\n${DECK}`);
    expect(() => sharePresentation(t.dir, two, { slug: "dup", author: "me" })).toThrow(/already used/);
    writeFileSync(join(two, "index.mdx"), `---\ntitle: Kept title\ntags: [x]\n---\n${DECK}`);
    const k = sharePresentation(t.dir, two, { slug: "kept", author: "me" });
    expect(k.title).toBe("Kept title");
    expect(k.frontmatter.tags).toEqual(["x"]);
    // symlinks and non-decks rejected
    const bad = join(t.dir, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "index.mdx"), "no deck here");
    expect(() => sharePresentation(t.dir, bad, { slug: "bad" })).toThrow(/Presentation/);
    symlinkSync(join(src, "deck.mdx"), join(t.dir, "link.mdx"));
    expect(() => sharePresentation(t.dir, join(t.dir, "link.mdx"), { slug: "sym" })).toThrow(/symlink/);
    expect(listPresentations(t.dir).map((x) => x.slug)).toEqual(["dir-deck", "kept", "zoom-deck"]);
  });

  test("promote keeps the ULID and deletes the doc; index projection + search + reap", async () => {
    const doc = await ingest(t.dir, { source: "paste", title: "Pasted deck", body: DECK, author: "me" });
    const notDeck = await ingest(t.dir, { source: "note", title: "n", body: "plain", author: "me" });
    expect(() => promotePresentation(t.dir, notDeck.id, "nope")).toThrow(/not a deck/);
    const p = promotePresentation(t.dir, doc.id, "pasted");
    expect(p.id).toBe(doc.id);
    expect(p.frontmatter.provenance).toEqual({ promoted_from: `docs/${doc.id}.md`, original_source: "paste" });
    expect(readDocFile(t.dir, doc.id)).toBeNull();
    const r = await reindex(t.dir);
    expect(r.presentationsIndexed).toBe(1);
    const row = withDb(t.dir, (db) => db.query("SELECT source, file_path, metadata FROM documents WHERE id = ?").get(doc.id) as any);
    expect(row).toMatchObject({ source: "presentation", file_path: "presentations/pasted/index.mdx" });
    expect(JSON.parse(row.metadata).slug).toBe("pasted");
    const hits = await search(t.dir, "zoom drift facts", { mode: "keyword" });
    expect(hits[0]).toMatchObject({ docId: doc.id, source: "presentation" });
    expect((await reindex(t.dir)).presentationsIndexed).toBe(0); // unchanged hash skipped
    const { rmSync } = await import("node:fs");
    rmSync(join(t.dir, "presentations", "pasted"), { recursive: true });
    expect((await reindex(t.dir)).reaped).toBe(1);
    // duplicate ids across slugs throw
    for (const s of ["a", "b"]) { mkdirSync(join(t.dir, "presentations", s), { recursive: true }); writeFileSync(join(t.dir, "presentations", s, "index.mdx"), `---\nid: 01DUPDUPDUPDUPDUPDUPDUPDUP\nsource: presentation\ntitle: x\nauthor: a\ncreated_at: 2026-01-01T00:00:00Z\n---\n${DECK}`); }
    await expect(reindex(t.dir)).rejects.toThrow(/used by both/);
    expect(() => parsePresentation("---\nid: x\nsource: note\ntitle: t\nauthor: a\ncreated_at: 2026-01-01\n---\n<Presentation/>", "s")).toThrow(/source/);
  });

  test("Slidecraft discovery: default ports, app id, the content repo as a vault", async () => {
    const { realpathSync } = await import("node:fs");
    const real = realpathSync(t.dir);
    const deckGlob = ["*/index.mdx", "presentations/*/index.mdx"];
    const configFile = "/home/u/.config/slidecraft/config.json";
    // Fake Slidecraft instances keyed by base URL, each answering after `delay` ms; every other address refuses.
    type Fake = { health: unknown; vaults: unknown; delay?: number };
    const fakes = (servers: Record<string, Fake>) => (async (url: string) => {
      const base = Object.keys(servers).find((b) => url.startsWith(b));
      if (!base) throw new Error("refused");
      const f = servers[base];
      if (f.delay) await Bun.sleep(f.delay);
      if (url.endsWith("/api/health")) return new Response(JSON.stringify(f.health));
      if (url.endsWith("/api/vaults")) return new Response(typeof f.vaults === "string" ? f.vaults : JSON.stringify(f.vaults));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const slidecraft = { app: "slidecraft", port: 6110 };
    const vaults = (list: unknown[]) => ({ vaults: list, defaultVault: "work", configFile });
    const team = { id: "team", path: real, include: deckGlob, readOnly: false };
    const teamReady = (base: string): SlidecraftStatus => ({ status: "ready", base, vault: "team", include: deckGlob, readOnly: false, configFile });
    const saved = process.env.JARVIS_SLIDECRAFT_URL;
    try {
      // Without JARVIS_SLIDECRAFT_URL it looks where Slidecraft runs: the dev server, then the release.
      delete process.env.JARVIS_SLIDECRAFT_URL;
      expect(SLIDECRAFT_CANDIDATES()).toEqual(["http://localhost:6100", "http://localhost:6110"]);
      expect(await discoverSlidecraft(t.dir, fakes({ "http://localhost:6110": { health: slidecraft, vaults: vaults([team]) } }))).toEqual(teamReady("http://localhost:6110"));
      // Both answering: the dev server wins even when the release answers first.
      expect(await discoverSlidecraft(t.dir, fakes({ "http://localhost:6110": { health: slidecraft, vaults: vaults([team]) }, "http://localhost:6100": { health: slidecraft, vaults: vaults([team]), delay: 30 } })))
        .toEqual(teamReady("http://localhost:6100"));
      // The variable, when set, is the only place it looks.
      process.env.JARVIS_SLIDECRAFT_URL = "http://localhost:7000/";
      expect(SLIDECRAFT_CANDIDATES()).toEqual(["http://localhost:7000"]);
      expect(await discoverSlidecraft(t.dir, fakes({ "http://localhost:6110": { health: slidecraft, vaults: vaults([team]) } }))).toEqual({ status: "not-running" });

      process.env.JARVIS_SLIDECRAFT_URL = "http://localhost:6100";
      const at = (v: unknown, health: unknown = slidecraft) => discoverSlidecraft(t.dir, fakes({ "http://localhost:6100": { health, vaults: v } }));
      // Another app on the port is not Slidecraft.
      expect(await at(vaults([team]), { app: "deck-viewer" })).toEqual({ status: "not-running" });
      // Slidecraft runs, but the content repo is not one of its vaults.
      expect(await at(vaults([{ id: "work", path: "/elsewhere", include: deckGlob }]))).toEqual({ status: "no-vault", base: "http://localhost:6100" });
      // The vault is found by path whatever its include; whether a deck is listed is decided per deck.
      expect(await at(vaults([{ id: "team", path: real, include: ["*/index.mdx"], readOnly: true }])))
        .toEqual({ status: "ready", base: "http://localhost:6100", vault: "team", include: ["*/index.mdx"], readOnly: true, configFile } satisfies SlidecraftStatus);
      // Slidecraft answered but its vault list is unusable: it is running, the repo is just not found in it.
      expect(await at("not json")).toEqual({ status: "no-vault", base: "http://localhost:6100" });
      expect(await at(vaults([{ id: "odd", path: 42, include: deckGlob }, team]))).toEqual(teamReady("http://localhost:6100"));
    } finally {
      process.env.JARVIS_SLIDECRAFT_URL = saved;
    }
  });

  test("include globs mean what they mean to Slidecraft: *, **, ? and nothing else", () => {
    const m = (glob: string, path: string) => slidecraftGlob(glob).test(path);
    expect(m("presentations/*/index.mdx", "presentations/q3-review/index.mdx")).toBe(true);
    expect(m("presentations/*/index.mdx", "presentations/a/b/index.mdx")).toBe(false);
    expect(m("*/index.mdx", "presentations/q3/index.mdx")).toBe(false);
    expect(m("**/index.mdx", "presentations/q3/index.mdx")).toBe(true);
    expect(m("**/index.mdx", "index.mdx")).toBe(true);
    expect(m("presentations/**", "presentations/q3/index.mdx")).toBe(true);
    expect(m("presentations/????/index.mdx", "presentations/q3ab/index.mdx")).toBe(true);
    expect(m("presentations/????/index.mdx", "presentations/q3-review/index.mdx")).toBe(false);
    // Braces, classes and dots are literal to Slidecraft, so they are literal here.
    expect(m("{presentations,talks}/*/index.mdx", "presentations/q3/index.mdx")).toBe(false);
    expect(m("[p]resentations/*/index.mdx", "presentations/q3/index.mdx")).toBe(false);
    expect(m("presentations/*/index.mdx", "presentationsX/q3/indexXmdx")).toBe(false);
  });

  test("each deck is presentable on its own: the vault's include must list that deck", () => {
    const ready = { status: "ready" as const, base: "http://localhost:6100", vault: "team decks", include: ["presentations/????/index.mdx"], readOnly: false };
    expect(deckInSlidecraft(ready, "q3ab")).toEqual({ status: "ready", launchUrl: "http://localhost:6100/v/team%20decks/presentations/q3ab" });
    expect(deckInSlidecraft(ready, "q3-review")).toEqual({ status: "no-include" });
    expect(deckInSlidecraft({ status: "no-vault", base: "http://localhost:6100" }, "q3ab")).toEqual({ status: "no-vault" });
    expect(deckInSlidecraft({ status: "not-running" }, "q3ab")).toEqual({ status: "not-running" });
  });

  test("presentation routes report Slidecraft's status per deck", async () => {
    const src = join(t.dir, "deck.mdx");
    writeFileSync(src, DECK);
    const p = sharePresentation(t.dir, src, { slug: "deck", author: "me" });
    const call = (path: string) => handle(new Request(`http://127.0.0.1:7281${path}`), { dataDir: t.dir });
    const list = await (await call("/api/presentations")).json();
    expect(list[0]).toMatchObject({ slug: "deck", id: p.id, indexed: false, slidecraft: { status: "not-running" } });
    expect(list[0].viewer).toBeUndefined();
    await reindex(t.dir);
    const detail = await (await call(`/api/presentation/${p.id}`)).json();
    expect(detail).toMatchObject({ slug: "deck", indexed: true, filePath: "presentations/deck/index.mdx", slidecraft: { status: "not-running" } });
    expect(detail.body).toContain("<Presentation>");
    expect((await call("/api/presentation/nope")).status).toBe(404);
  });
});

describe("meeting summary", () => {
  test("drafts a meeting-summary briefing with the three sections", async () => {
    const doc = await ingest(t.dir, { source: "meeting", title: "Weekly", body: "Anna: we decided to ship.", author: "me", tags: ["weekly"] });
    await expect(draftMeetingSummary(t.dir, noRouter, doc.id)).rejects.toThrow(/synthesis/);
    let prompt = "";
    const b = await draftMeetingSummary(t.dir, fakeRouter((p) => { prompt = p; return "```markdown\n## Discussion\n\nShipping.\n\n## Decisions\n\n- Ship it.\n```"; }), doc.id);
    expect(prompt).toContain("## Action items");
    expect(prompt).toContain("Anna: we decided to ship.");
    expect(b).toMatchObject({ kind: "meeting-summary", status: "draft", title: "Meeting summary: Weekly" });
    expect(b.frontmatter.source_doc).toBe(doc.id);
    expect(b.body).toContain("## Action items\n\nNone.");
    expect(b.body).not.toContain("```");
    const c = await draftMeetingSummary(t.dir, fakeRouter(() => "## Discussion\n\nx\n\n## Decisions\n\nNone.\n\n## Action items\n\nNone."), doc.id, { commit: true });
    expect(c.status).toBe("approved");
  });
});

describe("inbox", () => {
  const old = (p: string) => utimesSync(p, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  function makeInbox() {
    const inbox = join(t.dir, "inbox");
    mkdirSync(inbox);
    return inbox;
  }
  test("classification", () => {
    const d = join(t.dir, "f");
    mkdirSync(d);
    expect(classifyFolder(d)).toEqual({ ok: false, reason: "empty folder" });
    writeFileSync(join(d, "call.m4a"), "a");
    writeFileSync(join(d, "notes.md"), "n");
    expect(classifyFolder(d)).toEqual({ ok: true, files: { primary: join(d, "call.m4a"), draft: join(d, "notes.md") } });
    writeFileSync(join(d, "other.m4a"), "a");
    expect((classifyFolder(d) as { ok: false; reason: string }).reason).toMatch(/ambiguous/);
    writeFileSync(join(d, "x.pdf"), "p");
    expect((classifyFolder(d) as { ok: false; reason: string }).reason).toMatch(/unrecognized/);
  });
  test("full pipeline over settled folders: transcribe → cleanup → summarize → archive; failures isolated; resume", async () => {
    const inbox = makeInbox();
    mkdirSync(join(t.dir, "config"));
    writeFileSync(join(t.dir, "config", "glossary.toml"), '[products]\n# Misheard as: "a corn"\nAcorn = "x"\n');
    // folder 1: text transcript only
    mkdirSync(join(inbox, "weekly"));
    writeFileSync(join(inbox, "weekly", "transcript.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Anna>we use a corn daily</v>\n");
    // folder 2: audio + draft, whisper mocked
    mkdirSync(join(inbox, "standup"));
    writeFileSync(join(inbox, "standup", "rec.m4a"), "audio");
    writeFileSync(join(inbox, "standup", "draft.txt"), "Bob   0:01\nhello");
    // folder 3: fresh (unsettled), folder 4: garbage, archive/ and dotfolders ignored
    mkdirSync(join(inbox, "fresh"));
    writeFileSync(join(inbox, "fresh", "t.md"), "x");
    mkdirSync(join(inbox, "junk"));
    writeFileSync(join(inbox, "junk", "a.pdf"), "x");
    mkdirSync(join(inbox, "archive", "old"), { recursive: true });
    mkdirSync(join(inbox, ".hidden"));
    for (const p of ["weekly", "weekly/transcript.vtt", "standup", "standup/rec.m4a", "standup/draft.txt"]) old(join(inbox, p));
    const run = (args: string[]) => { const out = args[args.indexOf("--output-dir") + 1]; writeFileSync(join(out, "rec.txt"), "whisper text"); return { code: 0, stdout: "", stderr: "" }; };
    const router = fakeRouter(() => "## Discussion\n\nd\n\n## Decisions\n\nNone.\n\n## Action items\n\nNone.");
    const dry = await scanInbox(t.dir, { inbox, dryRun: true, run, backend: "mlx_whisper", router });
    expect(dry.results.map((r) => `${r.slug}:${r.status}`)).toEqual(["fresh:unsettled", "junk:skipped", "standup:dry-run", "weekly:dry-run"]);
    const r = await scanInbox(t.dir, { inbox, run, backend: "mlx_whisper", router, log: () => {} });
    const by = Object.fromEntries(r.results.map((x) => [x.slug, x]));
    expect(by.weekly.status).toBe("archived");
    expect(by.standup.status).toBe("archived");
    expect(by.junk.status).toBe("skipped");
    expect(by.fresh.status).toBe("unsettled");
    expect(existsSync(join(inbox, "weekly"))).toBe(false);
    expect(existsSync(join(inbox, "archive", "weekly", "transcript.vtt"))).toBe(true);
    const doc = readDocFile(t.dir, by.weekly.docId!)!;
    expect(doc.frontmatter.title).toBe("Transcript: weekly");
    expect(doc.frontmatter.source_url).toMatch(/#capture=[0-9A-Z]{26}$/);
    expect(doc.body).toContain("Anna: we use Acorn daily");
    expect(doc.frontmatter.metadata!.cleanup_version).toBe(1);
    const b = readBriefing(t.dir, by.weekly.briefingId!)!;
    expect(b.kind).toBe("meeting-summary");
    expect(b.frontmatter.source_doc).toBe(by.weekly.docId);
    const standup = readDocFile(t.dir, by.standup.docId!)!;
    expect(standup.body).toContain("whisper text");
    expect(standup.body).toContain("## Draft transcript (raw)");
    expect(withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM documents WHERE source='meeting'").get() as any).c)).toBe(2);
    // a failing summary leaves state for resume; rerun completes
    mkdirSync(join(inbox, "retry"));
    writeFileSync(join(inbox, "retry", "t.txt"), "plain transcript");
    old(join(inbox, "retry")); old(join(inbox, "retry", "t.txt"));
    const r2 = await scanInbox(t.dir, { inbox, router: noRouter });
    const retry = r2.results.find((x) => x.slug === "retry")!;
    expect(retry.status).toBe("failed");
    expect(retry.reason).toMatch(/synthesis/);
    expect(readState(join(inbox, "retry"))).toMatchObject({ stage: "cleaned", docId: retry.docId });
    expect(existsSync(join(inbox, "retry", ".scan.lock"))).toBe(false);
    const r3 = await scanInbox(t.dir, { inbox, router });
    expect(r3.results.find((x) => x.slug === "retry")).toMatchObject({ status: "archived", docId: retry.docId });
    expect(listBriefings(t.dir).length).toBe(3);
    // lock held by a live pid on this host is respected
    mkdirSync(join(inbox, "busy"));
    writeFileSync(join(inbox, "busy", "t.txt"), "x");
    old(join(inbox, "busy")); old(join(inbox, "busy", "t.txt"));
    expect(acquireLock(join(inbox, "busy"))).toBe(true);
    expect((await scanInbox(t.dir, { inbox, router })).results.find((x) => x.slug === "busy")!.status).toBe("locked");
  });
});
