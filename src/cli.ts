#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { flagBool, flagInt, flagStr, parseArgs } from "./core/args.ts";
import { resolveDataDir } from "./core/config.ts";
import type { Source } from "./core/constants.ts";
import { ingest } from "./core/ingest.ts";
import { reindex } from "./core/reindex.ts";
import { search, type SearchMode } from "./core/search.ts";

type Handler = (ctx: { dataDir: () => string; positional: string[]; flags: Record<string, string | boolean> }) => Promise<void> | void;

export const commands: Record<string, { help: string; run: Handler }> = {};
export function register(name: string, help: string, run: Handler): void {
  commands[name] = { help, run };
}

register("note", 'note "<text>" [--title --author --task <id>]', async ({ dataDir, positional, flags }) => {
  const text = positional.join(" ");
  if (!text) throw new Error("usage: jarvis note \"<text>\"");
  const title = flagStr(flags, "title") ?? text.slice(0, 60);
  const r = await ingest(dataDir(), { source: "note", title, body: text, author: flagStr(flags, "author") });
  printIngest(r);
  await linkToTask(dataDir(), r.id, flagStr(flags, "task"), flagStr(flags, "author"));
});

register("ingest", "ingest --file <path|-|x.pdf> [--source --title --url --author --task <id>]", async ({ dataDir, flags }) => {
  const file = flagStr(flags, "file");
  if (!file) throw new Error("usage: jarvis ingest --file <path|->");
  if (file !== "-" && file.toLowerCase().endsWith(".pdf")) {
    const payload = await pdfToPayload(file, { title: flagStr(flags, "title"), author: flagStr(flags, "author") });
    const pr = await ingest(dataDir(), payload);
    printIngest(pr);
    await linkToTask(dataDir(), pr.id, flagStr(flags, "task"), flagStr(flags, "author"));
    return;
  }
  const body = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8");
  const title = flagStr(flags, "title") ?? (file === "-" ? body.split("\n")[0].slice(0, 60) || "stdin" : basename(file));
  const r = await ingest(dataDir(), {
    source: (flagStr(flags, "source") as Source) ?? "paste",
    title, body, author: flagStr(flags, "author"), source_url: flagStr(flags, "url"),
  });
  printIngest(r);
  await linkToTask(dataDir(), r.id, flagStr(flags, "task"), flagStr(flags, "author"));
});

register("reindex", "reindex [--full]", async ({ dataDir, flags }) => {
  const r = await reindex(dataDir(), { full: flagBool(flags, "full") });
  console.log(`indexed ${r.docsIndexed} doc(s), skipped ${r.docsSkipped}, malformed ${r.docsMalformed}, reaped ${r.reaped}, embedded ${r.chunksEmbedded} chunk(s)`);
  if (r.edgesMirrored || r.rejectionsMirrored) console.log(`mirrored ${r.edgesMirrored} edge(s), ${r.rejectionsMirrored} rejection(s)`);
  if (r.embedError) console.log(`⚠ ${r.embedError}`);
  for (const w of r.warnings) console.log(`⚠ ${w}`);
});

register("search", 'search "<q>" [--mode hybrid|semantic|keyword --limit]', async ({ dataDir, positional, flags }) => {
  const q = positional.join(" ");
  if (!q) throw new Error('usage: jarvis search "<query>"');
  const hits = await search(dataDir(), q, { mode: (flagStr(flags, "mode") as SearchMode) ?? "hybrid", limit: flagInt(flags, "limit", 10) });
  if (hits.length === 0) console.log("no results");
  for (const h of hits) console.log(`${h.docId}  ${h.score.toFixed(4)}  [${h.source}] ${h.title}\n    ${h.snippet.replace(/\s+/g, " ").slice(0, 200)}`);
});

function printIngest(r: { id: string; status: string; title: string; chunks: number; embedded: number; embedError?: string }) {
  console.log(`${r.status} ${r.id}  ${r.title}  (${r.chunks} new chunk(s), ${r.embedded} embedded)`);
  if (r.embedError) console.log(`⚠ ${r.embedError} — run \`jarvis reindex\` later to embed`);
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  if (!cmd || cmd === "help" || flagBool(flags, "help")) {
    console.log("usage: jarvis <command> [--data <dir>]\n");
    for (const [n, c] of Object.entries(commands).sort()) if (c.help) console.log(`  ${c.help}`);
    return 0;
  }
  const c = commands[cmd];
  if (!c) {
    console.error(`unknown command: ${cmd}`);
    return 1;
  }
  try {
    await c.run({ dataDir: () => resolveDataDir(flagStr(flags, "data")), positional: rest, flags });
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}


// ---- M2: service, sync, process, dedup ----
import { join as _join } from "node:path";
import { existsSync as _exists } from "node:fs";
import { resolvePort } from "./core/config.ts";
import { dedupScan, processContent, sync } from "./core/sync.ts";
import { startServer } from "./server.ts";

register("serve", "serve [--port]", async ({ dataDir, flags }) => {
  const dir = dataDir();
  const port = resolvePort(flagStr(flags, "port"));
  const dist = _join(import.meta.dir, "..", "web", "dist");
  const server = startServer({ dataDir: dir }, port, _exists(dist) ? dist : undefined);
  console.log(`jarvis service on http://127.0.0.1:${server.port}  (content repo: ${dir})`);
  console.log("routes: /api/health /api/capture /api/search /api/browse /api/recent /api/item/:id /api/sync /api/filters …");
  await new Promise(() => {});
});

register("sync", "sync [--no-push]", async ({ dataDir, flags }) => {
  const r = await sync(dataDir(), { push: !flagBool(flags, "no-push") });
  if (r.conflicted.length) {
    console.log(`Sync stopped: resolve ${r.conflicted.length} merge conflict(s):\n  ${r.conflicted.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`committed ${r.committed} capture(s), ${r.committedEnriched} enrichment file(s); pulled=${r.pulled} pushed=${r.pushed} remote=${r.remote}`);
  if (r.reindexed) console.log(`indexed ${r.reindexed.docsIndexed} doc(s), embedded ${r.reindexed.chunksEmbedded} chunk(s)`);
  for (const [k, v] of Object.entries(r.counts)) console.log(`${k}: ${JSON.stringify(v)}`);
  for (const c of r.collisions) console.log(`⚠ collision ${c.source_url}: ${c.ids.join(", ")}`);
  for (const n of r.notes) console.log(`note: ${n}`);
});

const processCmd: Parameters<typeof register>[2] = async ({ dataDir }) => {
  const r = await processContent(dataDir());
  console.log(`indexed ${r.reindexed.docsIndexed} doc(s), embedded ${r.reindexed.chunksEmbedded + (r.reindexedAgain?.chunksEmbedded ?? 0)} chunk(s)`);
  for (const [k, v] of Object.entries(r.counts)) console.log(`${k}: ${JSON.stringify(v)}`);
  for (const c of r.collisions) console.log(`⚠ collision ${c.source_url}: ${c.ids.join(", ")}`);
  for (const n of r.notes) console.log(`note: ${n}`);
};
register("process", "process | pipeline  (local passes without git)", processCmd);
register("pipeline", "", processCmd);

register("dedup", "dedup  (source_url collision scan; exit 1 on collisions)", async ({ dataDir }) => {
  const c = dedupScan(dataDir());
  if (c.length === 0) {
    console.log("no source_url collisions");
    return;
  }
  for (const x of c) console.log(`${x.source_url}\n  ${x.ids.join("\n  ")}`);
  process.exitCode = 1;
});


// ---- M2.5: capture producers ----
import { pdfToPayload } from "./producers/pdf.ts";
import { youtubeToPayload } from "./producers/youtube.ts";
import { meetingToPayload } from "./producers/meeting.ts";

register("youtube", "youtube <url> [--author]", async ({ dataDir, positional, flags }) => {
  const url = positional[0];
  if (!url) throw new Error("usage: jarvis youtube <url>");
  const payload = await youtubeToPayload(url, { author: flagStr(flags, "author") });
  if (!payload) throw new Error("could not fetch a transcript for that video (is yt-dlp installed and does the video have subtitles?)");
  printIngest(await ingest(dataDir(), payload));
});

register("meeting", "meeting <file> [--title --lang --author]", async ({ dataDir, positional, flags }) => {
  const file = positional[0];
  if (!file) throw new Error("usage: jarvis meeting <audio|.vtt|.md|.txt>");
  const dir = dataDir();
  const payload = meetingToPayload(file, { title: flagStr(flags, "title"), lang: flagStr(flags, "lang"), author: flagStr(flags, "author"), dataDir: dir });
  printIngest(await ingest(dir, payload));
});

// ---- M3: router, enrich, edges, refine, cleanup, entities, ask, models ----
import "./core/passes.ts";
import { getRouter } from "./providers/index.ts";
import { unresolvedKinds } from "./providers/router.ts";
import { detectModels, serializeModelsToml, writeModelsConfig } from "./providers/models.ts";
import { enrich } from "./core/enrich.ts";
import { computeEdges } from "./core/edges.ts";
import { refine } from "./core/refine.ts";
import { cleanup } from "./core/cleanup.ts";
import { dedupEntities } from "./core/entities.ts";
import { ask } from "./core/ask.ts";

register("enrich", "enrich [--limit --dry-run]", async ({ dataDir, flags }) => {
  const r = await enrich(dataDir(), await getRouter(), { limit: flagInt(flags, "limit"), dryRun: flagBool(flags, "dry-run") });
  console.log(`enriched ${r.enriched}, skipped ${r.skipped}, failed ${r.failed}, stubs ${r.stubsCreated}${r.model ? ` (model ${r.model})` : ""}`);
  for (const d of r.details) if (d.status !== "enriched") console.log(`  ${d.id} ${d.status}${d.reason ? `: ${d.reason}` : ""}`);
});
register("edges", "edges  (derive backlink/auto/entity/embedding edges)", async ({ dataDir }) => {
  const r = computeEdges(dataDir());
  console.log(`edged ${r.docs} doc(s): backlink ${r.backlink}, auto ${r.auto}, entity ${r.entity}, embedding ${r.embedding}`);
});
register("refine", "refine [--limit --dry-run]", async ({ dataDir, flags }) => {
  const r = await refine(dataDir(), await getRouter(), { limit: flagInt(flags, "limit"), dryRun: flagBool(flags, "dry-run") });
  if (r.skipped) console.log(`${r.candidates} candidate(s); ${r.skipped}`);
  else console.log(`${r.candidates} candidate(s): kept ${r.kept}, dropped ${r.dropped}, malformed batches ${r.malformedBatches}, hallucinated ${r.hallucinated}${r.model ? ` (model ${r.model})` : ""}`);
});
register("cleanup", "cleanup [--limit --llm --doc id,id --dry-run]", async ({ dataDir, flags }) => {
  const doc = flagStr(flags, "doc");
  const r = await cleanup(dataDir(), await getRouter(), { limit: flagInt(flags, "limit"), llm: flagBool(flags, "llm"), dryRun: flagBool(flags, "dry-run"), docIds: doc ? doc.split(",").map((s) => s.trim()).filter(Boolean) : undefined });
  console.log(`cleaned ${r.cleaned}, skipped ${r.skipped}, failed ${r.failed}${r.model ? ` (model ${r.model})` : ""}`);
  for (const d of r.details) console.log(`  ${d.id}: ${d.fixes.length ? d.fixes.join(", ") : "no deterministic fixes"}${d.llm ? " + llm" : ""}${d.reason ? ` (${d.reason})` : ""}`);
});
register("entities", "entities dedup [--dry-run]", async ({ dataDir, positional, flags }) => {
  if (positional[0] !== "dedup") throw new Error("usage: jarvis entities dedup [--dry-run]");
  const r = dedupEntities(dataDir(), { dryRun: flagBool(flags, "dry-run") });
  if (r.merged.length === 0) console.log("no duplicate entities");
  for (const m of r.merged) console.log(`${m.survivor} ← ${m.into.join(", ")}`);
  if (r.merged.length && !flagBool(flags, "dry-run")) await reindex(dataDir());
});
register("ask", 'ask "<question>" [--mode --limit]', async ({ dataDir, positional, flags }) => {
  const q = positional.join(" ");
  if (!q) throw new Error('usage: jarvis ask "<question>"');
  const r = await ask(dataDir(), await getRouter(), q, { mode: flagStr(flags, "mode") as SearchMode | undefined, limit: flagInt(flags, "limit") });
  console.log(r.answer);
  if (r.citations.length) console.log("\nSources:\n" + r.citations.map((c) => `  [${c.docId}] ${c.title}`).join("\n"));
  console.log(`\n(model: ${r.model})`);
});
register("models", "models  (configured models and availability)", async () => {
  const router = await getRouter();
  if (!router) throw new Error("no router");
  console.log(`config: ${router.config.source === "file" ? router.config.path : "detected (no models.toml)"}; preference ${router.config.preference.join(" → ")}`);
  if (router.entries.length === 0) console.log("  no models configured (Tier 0)");
  for (const e of router.entries) console.log(`  ${e.available ? "✓" : "✗"} ${e.entry.provider}:${e.entry.id}  quality=${e.entry.quality}${e.entry.bestFor ? ` bestFor=${e.entry.bestFor.join(",")}` : ""}${e.entry.langs ? ` langs=${e.entry.langs.join(",")}` : ""}`);
  const missing = unresolvedKinds(router);
  if (missing.length) console.log(`tasks with no model: ${missing.join(", ")}`);
});
register("config", "config show | preset [name --show] | redetect [--write] | set-author <n> | set-data <p> | set-data-root <p> | set-port <n> | set-role consumer|publisher | set-embedding ollama|omlx | set-inbox <p> | set-chat-model <id>", async ({ positional, flags }) => {
  const { loadConfig, updateConfig, configPath } = await import("./core/config.ts");
  const [sub, val] = positional;
  switch (sub) {
    case undefined:
    case "show":
      console.log(`${configPath()}\n${JSON.stringify(loadConfig(), null, 2)}`);
      return;
    case "redetect": {
      const cfg = await detectModels();
      if (flagBool(flags, "write")) console.log(`wrote ${writeModelsConfig(cfg)}`);
      else process.stdout.write(serializeModelsToml(cfg));
      return;
    }
    case "set-author": updateConfig({ author: val }); break;
    case "set-data": updateConfig({ dataDir: val }); break;
    case "set-data-root": updateConfig({ dataRoot: val }); break;
    case "set-port": updateConfig({ port: Number(val) }); break;
    case "set-role":
      if (val !== "consumer" && val !== "publisher") throw new Error("role must be consumer|publisher");
      updateConfig({ projectionRole: val });
      break;
    case "set-embedding":
      if (val !== "ollama" && val !== "omlx") throw new Error("embedding must be ollama|omlx");
      updateConfig({ embeddingProvider: val });
      break;
    case "set-inbox": updateConfig({ inboxDir: val }); break;
    case "set-chat-model": updateConfig({ chatModel: val }); break;
    case "preset": {
      const { listPresets, applyPreset, readPreset, recommendPreset, detectHardware } = await import("./core/presets.ts");
      if (!val) {
        console.log(`presets: ${listPresets().join(", ")}\nrecommended here: ${recommendPreset(detectHardware())}`);
        return;
      }
      if (flagBool(flags, "show")) { process.stdout.write(readPreset(val)); return; }
      console.log(`wrote ${applyPreset(val)} from preset ${val}`);
      updateConfig({ preset: val });
      return;
    }
    default:
      throw new Error(`unknown config subcommand ${sub}`);
  }
  console.log(`updated ${configPath()}`);
});

// ---- M4: briefings ----
import "./briefings/index.ts";
import { approveBriefing, addComment as addBriefingComment, createBriefing, listBriefings, readBriefing, readComments } from "./briefings/store.ts";
import { listComponents } from "./briefings/components.ts";
import { publishBriefing } from "./briefings/confluence.ts";
import type { BriefingKind } from "./briefings/frontmatter.ts";

register("briefing", "briefing create --title [--kind --trail --author] | components [--search --verbose] | list | show <id> | comment <id> \"<text>\" | approve <id> | publish <id> [--dry-run --allow-draft]", async ({ dataDir, positional, flags }) => {
  const [sub, id, ...rest] = positional;
  switch (sub) {
    case "create": {
      const title = flagStr(flags, "title");
      if (!title) throw new Error("usage: jarvis briefing create --title <t> [--kind briefing|lesson|meeting-summary --trail <id> --author <a>]");
      const b = createBriefing(dataDir(), { title, kind: flagStr(flags, "kind") as BriefingKind | undefined, trail: flagStr(flags, "trail"), author: resolveAuthorFlag(flags) });
      console.log(`created ${b.id}  briefings/${b.id}.brief.mdx`);
      await reindex(dataDir(), { embed: false });
      return;
    }
    case "components": {
      const verbose = flagBool(flags, "verbose");
      for (const c of listComponents(flagStr(flags, "search"))) {
        console.log(`${c.id}  [${c.category}]  ${c.description}`);
        if (verbose) {
          for (const pr of c.props) console.log(`    ${pr.name}${pr.required ? "*" : ""}: ${pr.type} — ${pr.description}`);
          console.log(`    use: ${c.useCases.join("; ")}\n    ${c.snippet.split("\n").join("\n    ")}`);
        }
      }
      return;
    }
    case "list":
      for (const b of listBriefings(dataDir())) console.log(`${b.id}  ${b.kind.padEnd(15)} ${(b.status ?? "").padEnd(9)} ${b.updatedAt.slice(0, 10)}  ${b.title}`);
      return;
    case "show": {
      const b = id && readBriefing(dataDir(), id);
      if (!b) throw new Error(`briefing ${id} not found`);
      console.log(`${b.title}${b.subtitle ? ` — ${b.subtitle}` : ""}\nkind: ${b.kind}  status: ${b.status ?? "-"}  updated: ${b.updatedAt}\n`);
      if (b.toc) console.log("TOC:\n" + b.toc.map((t) => `${"  ".repeat(t.level - 1)}- ${t.text} (#${t.slug})`).join("\n") + "\n");
      console.log(b.body);
      const comments = readComments(dataDir(), b.id);
      if (comments.length) console.log(`\n${comments.length} comment(s):\n` + comments.map((c) => `  [${c.status}] ${c.author ?? "anon"}: ${c.comment}`).join("\n"));
      return;
    }
    case "comment": {
      const text = rest.join(" ");
      if (!id || !text) throw new Error('usage: jarvis briefing comment <id> "<text>"');
      const c = addBriefingComment(dataDir(), id, { comment: text, author: resolveAuthorFlag(flags) });
      console.log(`comment ${c.id} added to ${id}`);
      return;
    }
    case "approve": {
      if (!id) throw new Error("usage: jarvis briefing approve <id>");
      approveBriefing(dataDir(), id);
      console.log(`approved ${id}`);
      return;
    }
    case "publish": {
      const b = id && readBriefing(dataDir(), id);
      if (!b) throw new Error(`briefing ${id} not found`);
      const r = await publishBriefing(dataDir(), b, { dryRun: flagBool(flags, "dry-run"), allowDraft: flagBool(flags, "allow-draft") });
      if (r.action === "dry-run") console.log(r.storage);
      else console.log(`${r.action} Confluence page ${r.pageId} "${r.title}"${r.url ? `\n${r.url}` : ""}`);
      return;
    }
    default:
      throw new Error("usage: jarvis briefing create|components|list|show|comment|approve|publish");
  }
});
function resolveAuthorFlag(flags: Record<string, string | boolean>): string {
  return flagStr(flags, "author") ?? resolveAuthorCore();
}
import { resolveAuthor as resolveAuthorCore } from "./core/config.ts";

// ---- M6: onboarding ----
import { init } from "./core/init.ts";
import { doctor, formatDoctor } from "./core/doctor.ts";

register("init", "init [--yes --repo <url> --data <path> --data-root <path> --author --preset --embedding ollama|omlx --pull]", async ({ flags }) => {
  await init({ yes: flagBool(flags, "yes"), repo: flagStr(flags, "repo"), data: flagStr(flags, "data"), dataRoot: flagStr(flags, "data-root"), author: flagStr(flags, "author"), preset: flagStr(flags, "preset"), embedding: flagStr(flags, "embedding") as "ollama" | "omlx" | undefined, pull: flags.pull === undefined ? undefined : flagBool(flags, "pull") });
});
register("doctor", "doctor [--json --core-only --port]", async ({ flags }) => {
  const r = await doctor({ coreOnly: flagBool(flags, "core-only"), port: flagInt(flags, "port"), dataDir: flagStr(flags, "data") });
  console.log(flagBool(flags, "json") ? JSON.stringify(r, null, 2) : formatDoctor(r));
  if (!r.summary.healthy) process.exitCode = 1;
});

// ---- M7: tasks + manual links ----
import { addTask, listTasks, showTask, setTaskStatus, suggestLinks, type TaskItem } from "./core/tasks.ts";
import { addInitiative, closeInitiative, editInitiative, initiativeSuggestions, listInitiatives, moveTask, reopenInitiative, showInitiative } from "./core/initiatives.ts";
import { ANSI, PLAIN, formatInitiativeList, formatInitiativeShow, lastTaskNotice, memberLinkLine, suggestionLines, taskListLine, type Style } from "./core/initiativeView.ts";
import { link as linkItems, LINK_RELATIONS } from "./core/links.ts";
import type { Relation } from "./core/constants.ts";

/** `note … --task <id>` and `ingest … --task <id>`: capture and link (task → new doc) in one step. */
async function linkToTask(dir: string, docId: string, taskId: string | undefined, author?: string): Promise<void> {
  if (!taskId) return;
  const r = linkItems(dir, taskId, [docId], { relation: "references", author });
  console.log(`linked task ${taskId} → ${docId} (${r[0].status})`);
}
const style = (): Style => (process.stdout.isTTY ? ANSI : PLAIN);
function printTasks(tasks: TaskItem[]): void {
  if (tasks.length === 0) return console.log("no tasks");
  for (const t of tasks) console.log(taskListLine(t, style()));
}
register("task", 'task add "<title>" [--body --due YYYY-MM-DD --link id[,id] --relation --owner --initiative <id>] | list [--status open|done|all --owner name|all --initiative <id>] | show <id> | done <id> | reopen <id> | move <task> --initiative <id> | --none | suggest <id> [--limit]', async ({ dataDir, positional, flags }) => {
  const [sub, ...rest] = positional;
  const dir = dataDir();
  switch (sub) {
    case "add": {
      const title = rest.join(" ");
      if (!title) throw new Error('usage: jarvis task add "<title>"');
      const links = flagStr(flags, "link")?.split(",").map((s) => s.trim()).filter(Boolean);
      const initiative = flagStr(flags, "initiative");
      const r = await addTask(dir, { title, body: flagStr(flags, "body"), due: flagStr(flags, "due"), owner: flagStr(flags, "owner"), author: flagStr(flags, "author"), links, relation: flagStr(flags, "relation") as Relation | undefined, initiative });
      let where = "";
      if (initiative) {
        const i = listInitiatives(dir, { status: "all" }).find((x) => x.id === initiative)!;
        where = `  in ${i.title} (${i.total - i.done} of ${i.total} tasks)`;
      }
      console.log(`task ${r.id}  ${title}${where}${r.linked ? `  (${r.linked} link(s))` : ""}`);
      const sug = await suggestLinks(dir, r.id, { limit: 3 });
      if (sug.length) console.log("link suggestions:\n" + sug.map((s) => `  jarvis link ${r.id} ${s.id}   # ${s.title} — ${s.reason}`).join("\n"));
      return;
    }
    case "list":
      return printTasks(listTasks(dir, { status: (flagStr(flags, "status") as "open" | "done" | "all") ?? "open", owner: flagStr(flags, "owner"), initiative: flagStr(flags, "initiative") }));
    case "show": {
      const d = showTask(dir, rest[0]);
      console.log(`${d.task.title}\nstatus: ${d.task.status}  owner: ${d.task.owner}${d.task.due ? `  due: ${d.task.due}` : ""}${d.task.completed_at ? `  completed: ${d.task.completed_at} by ${d.task.completed_by ?? ""}` : ""}${d.task.initiative ? `\ninitiative: ${d.task.initiative.id}  ${d.task.initiative.title}` : ""}\n\n${d.body.trim()}\n`);
      console.log(`linked (${d.linked.length}):` + (d.linked.length ? "\n" + d.linked.map((l) => `  ${l.direction === "out" ? "→" : "←"} ${l.id}  ${l.title ?? ""}  [${l.relation}, ${l.createdBy}]`).join("\n") : " none"));
      console.log(`derived (${d.derived.length}):` + (d.derived.length ? "\n" + d.derived.map((l) => `  ${l.direction === "out" ? "→" : "←"} ${l.id}  ${l.title ?? ""}  [${l.relation}, ${l.createdBy}]`).join("\n") : " none"));
      return;
    }
    case "done":
    case "reopen": {
      if (!rest[0]) throw new Error(`usage: jarvis task ${sub} <id>`);
      const t = setTaskStatus(dir, rest[0], sub === "done" ? "done" : "open", flagStr(flags, "author"));
      console.log(`${t.status === "done" ? "✓ done" : "○ reopened"}: ${t.title}`);
      if (t.initiativeCompleted) console.log(lastTaskNotice(t.initiativeCompleted));
      return;
    }
    case "move": {
      const target = flagStr(flags, "initiative");
      if (!rest[0] || (!target && !flagBool(flags, "none"))) throw new Error("usage: jarvis task move <task> --initiative <id> | --none");
      const r = await moveTask(dir, rest[0], target ?? null, flagStr(flags, "author"));
      if (r.status === "unchanged") console.log(r.to ? `${rest[0]}  ${r.title}  is already in ${r.to}` : `${rest[0]}  ${r.title}  is not in an initiative`);
      else console.log(`${rest[0]}  ${r.title}  → ${r.to ?? "no initiative"}${r.from ? `${r.to ? "  " : " "}(was ${r.from})` : ""}`);
      return;
    }
    case "suggest": {
      if (!rest[0]) throw new Error("usage: jarvis task suggest <id>");
      const s = await suggestLinks(dir, rest[0], { limit: flagInt(flags, "limit", 5) });
      if (!s.length) console.log("no suggestions");
      for (const x of s) console.log(`${x.id}  [${x.source}] ${x.title}  — ${x.reason}`);
      return;
    }
    default:
      throw new Error("usage: jarvis task add|list|show|done|reopen|move|suggest");
  }
});
register("tasks", "tasks  (open tasks for the current user) [--initiative <id>]", async ({ dataDir, flags }) => {
  printTasks(listTasks(dataDir(), { status: "open", owner: resolveAuthorCore(flagStr(flags, "author")), initiative: flagStr(flags, "initiative") }));
});
register("initiative", 'initiative add "<title>" --goal "<what done looks like>" [--owner] | edit <id> [--title --goal --owner] | list [--status open|closed|all] | show <id> [--all] | suggest <id> | close <id> [--anyway] | reopen <id>', async ({ dataDir, positional, flags }) => {
  const [sub, ...rest] = positional;
  const dir = dataDir();
  const id = rest[0];
  const need = (): string => {
    if (!id) throw new Error(`usage: jarvis initiative ${sub} <id>`);
    return id;
  };
  switch (sub) {
    case "add": {
      const title = rest.join(" ");
      const r = await addInitiative(dir, { title, goal: flagStr(flags, "goal") ?? "", owner: flagStr(flags, "owner"), author: flagStr(flags, "author") });
      console.log(`initiative ${r.id}  ${r.title}  (owner ${r.owner})`);
      return;
    }
    case "edit": {
      const r = await editInitiative(dir, need(), { title: flagStr(flags, "title"), goal: flagStr(flags, "goal"), owner: flagStr(flags, "owner"), author: flagStr(flags, "author") });
      console.log(`updated: ${r.title}` + (r.changes.length ? "  " + style().dim(r.changes.join(", ")) : ""));
      return;
    }
    case "list": {
      const status = (flagStr(flags, "status") ?? "open") as "open" | "closed" | "all";
      if (!["open", "closed", "all"].includes(status)) throw new Error("--status must be open|closed|all");
      console.log(formatInitiativeList(listInitiatives(dir, { status }), style(), status));
      return;
    }
    case "show": {
      const d = await showInitiative(dir, need(), { all: flagBool(flags, "all") });
      const sug = await initiativeSuggestions(dir, id!, { router: await getRouter(), limit: 5 });
      console.log(formatInitiativeShow(d, sug.model ? sug.suggestions : null, style()));
      return;
    }
    case "suggest": {
      const d = await showInitiative(dir, need());
      const sug = await initiativeSuggestions(dir, id!, { router: await getRouter() });
      if (!sug.model) console.log("no suggestions: no model is available (jarvis doctor shows why)");
      else if (!sug.suggestions.length) console.log("no suggestions");
      else console.log(`suggestions for ${d.initiative.title}:\n` + suggestionLines(id!, sug.suggestions, style()).join("\n"));
      return;
    }
    case "close": {
      const r = await closeInitiative(dir, need(), { anyway: flagBool(flags, "anyway"), author: flagStr(flags, "author") });
      console.log(`closed: ${r.title}  ${r.done} of ${r.total} done${r.left ? `, ${r.left} left open` : ""}`);
      return;
    }
    case "reopen": {
      const r = await reopenInitiative(dir, need(), flagStr(flags, "author"));
      console.log(`○ reopened: ${r.title}`);
      return;
    }
    default:
      throw new Error("usage: jarvis initiative add|edit|list|show|suggest|close|reopen");
  }
});
register("link", `link <src> <dst[,dst]> [--relation ${LINK_RELATIONS.join("|")} --author]`, async ({ dataDir, positional, flags }) => {
  const [src, dsts] = positional;
  if (!src || !dsts) throw new Error("usage: jarvis link <src> <dst[,dst]> [--relation]");
  for (const r of linkItems(dataDir(), src, dsts.split(",").map((s) => s.trim()).filter(Boolean), { relation: flagStr(flags, "relation") as Relation | undefined, author: flagStr(flags, "author") })) {
    if (r.status === "member") {
      console.log(memberLinkLine(r, style()));
    } else console.log(`${r.status}: ${r.src} → ${r.dst} [${r.relation}]`);
  }
});

// ---- M8: presentations, inbox, meeting summaries ----
import { promotePresentation, sharePresentation } from "./core/presentations.ts";
import { scanInbox } from "./core/inbox.ts";
import { draftMeetingSummary } from "./core/meetingSummary.ts";

register("presentation", "presentation share <file-or-dir> --slug <slug> [--title --author] | promote <docId> --slug <slug>", async ({ dataDir, positional, flags }) => {
  const [sub, target] = positional;
  const slug = flagStr(flags, "slug");
  if (!slug || !target) throw new Error("usage: jarvis presentation share <path> --slug <slug> | promote <docId> --slug <slug>");
  if (sub === "share") {
    const p = sharePresentation(dataDir(), target, { slug, title: flagStr(flags, "title"), author: flagStr(flags, "author") });
    console.log(`shared ${p.id}  presentations/${p.slug}/index.mdx  "${p.title}"`);
  } else if (sub === "promote") {
    const p = promotePresentation(dataDir(), target, slug);
    console.log(`promoted ${p.id} → presentations/${p.slug}/index.mdx`);
  } else throw new Error("usage: jarvis presentation share|promote");
  await reindex(dataDir(), { embed: false });
});
register("scan-inbox", "scan-inbox [--inbox <dir> --llm --commit --dry-run --limit]", async ({ dataDir, flags }) => {
  const r = await scanInbox(dataDir(), { inbox: flagStr(flags, "inbox"), llm: flagBool(flags, "llm"), commit: flagBool(flags, "commit"), dryRun: flagBool(flags, "dry-run"), limit: flagInt(flags, "limit"), router: await getRouter(), log: (s) => console.log(s) });
  console.log(`inbox ${r.inbox}: ${r.results.length} folder(s)`);
  for (const x of r.results) console.log(`  ${x.slug}: ${x.status}${x.reason ? ` (${x.reason})` : ""}${x.docId ? `  doc ${x.docId}` : ""}${x.briefingId ? `  briefing ${x.briefingId}` : ""}`);
});
register("summarize", "summarize <docId> [--commit]", async ({ dataDir, positional, flags }) => {
  if (!positional[0]) throw new Error("usage: jarvis summarize <docId> [--commit]");
  const b = await draftMeetingSummary(dataDir(), await getRouter(), positional[0], { commit: flagBool(flags, "commit"), author: flagStr(flags, "author") });
  console.log(`${b.status} briefing ${b.id}  "${b.title}"`);
  await reindex(dataDir(), { embed: false });
});

// ---- M10: agent instructions ----
register("skill", "skill  (print the agent instructions; `jarvis skill > AGENTS.md`)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const codeRepo = _join(import.meta.dir, "..");
  process.stdout.write(rf(_join(codeRepo, "docs", "AGENT-INSTRUCTIONS.md"), "utf8").replaceAll("<code repo>", codeRepo));
});

// ---- entrypoint (must stay last so every register() above has run) ----
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
