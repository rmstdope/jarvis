/**
 * The tools the chat agent acts with. Each runs the same core function the CLI uses, as the user,
 * and is recorded in the conversation's change log so it can be undone.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { briefingPath, createBriefing } from "../briefings/store.ts";
import { resolveAuthor } from "../core/config.ts";
import { LINK_RELATIONS, link } from "../core/links.ts";
import { withDb } from "../core/db.ts";
import { readDocFile } from "../core/docs.ts";
import { readSidecar, type EdgeLine } from "../core/sidecar.ts";
import { ingest, type CapturePayload } from "../core/ingest.ts";
import { addInitiative, moveTask } from "../core/initiatives.ts";
import { SLUG_RE, sharePresentation } from "../core/presentations.ts";
import { addTask, setTaskStatus, updateTask } from "../core/tasks.ts";
import type { Relation } from "../core/constants.ts";
import { meetingToPayload } from "../producers/meeting.ts";
import { pdfToPayload } from "../producers/pdf.ts";
import { createdOp, type Change, type ChangeItem, type ChangeKind, type ChangeLog, type Op } from "./changes.ts";

/** The tool names the agent sees, with a one-line description and JSON-schema properties each. */
export const TOOLS: { name: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [
  { name: "jarvis_capture_note", description: "Capture a note into the knowledge base.", properties: { text: { type: "string" }, title: { type: "string" } }, required: ["text"] },
  { name: "jarvis_capture_link", description: "Capture a web link (with the text of the page when known).", properties: { url: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, required: ["url", "title"] },
  { name: "jarvis_capture_file", description: "Capture a file the user attached to this message (by its name). Set meeting=true for a meeting transcript.", properties: { attachment: { type: "string" }, title: { type: "string" }, meeting: { type: "boolean" } }, required: ["attachment"] },
  { name: "jarvis_create_task", description: "Create a task; optionally with a due date (YYYY-MM-DD), owner, initiative id and ids of items to link.", properties: { title: { type: "string" }, body: { type: "string" }, due: { type: "string" }, owner: { type: "string" }, initiative: { type: "string" }, link: { type: "array", items: { type: "string" } } }, required: ["title"] },
  { name: "jarvis_update_task", description: "Change a task's due date (YYYY-MM-DD, empty clears) and/or owner.", properties: { task: { type: "string" }, due: { type: "string" }, owner: { type: "string" } }, required: ["task"] },
  { name: "jarvis_set_task_status", description: "Mark a task done or reopen it.", properties: { task: { type: "string" }, status: { enum: ["done", "open"] } }, required: ["task", "status"] },
  { name: "jarvis_move_task", description: "Put a task in an initiative, or take it out (omit initiative).", properties: { task: { type: "string" }, initiative: { type: "string" } }, required: ["task"] },
  { name: "jarvis_create_initiative", description: "Create an initiative: long-running work made of several tasks. A goal (what done looks like) is required.", properties: { title: { type: "string" }, goal: { type: "string" }, owner: { type: "string" } }, required: ["title", "goal"] },
  { name: "jarvis_link", description: `Link two items. relation is one of ${LINK_RELATIONS.join(", ")}.`, properties: { src: { type: "string" }, dst: { type: "string" }, relation: { type: "string" } }, required: ["src", "dst"] },
  { name: "jarvis_draft_briefing", description: "Draft a briefing (MDX body; never published or approved). sources = ids of the items it draws on.", properties: { title: { type: "string" }, body: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["title"] },
  { name: "jarvis_draft_presentation", description: "Draft a presentation as an MDX deck containing <Presentation> (never published). sources = ids it draws on.", properties: { title: { type: "string" }, mdx: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["title", "mdx"] },
];

/** Where the tools find what they act on. */
export interface ActionContext {
  dataDir: string;
  /** Files attached to this message: name → absolute path. */
  attachments: Record<string, string>;
}
/** What a tool did; `also` holds further rows the same call made (the links of a new task), each undone on its own. */
interface Done { kind: ChangeKind; items: ChangeItem[]; ops: Op[]; detail?: Change["detail"]; draft?: Change["draft"]; undoable?: boolean; also?: Done[] }
const str = (a: Record<string, unknown>, k: string): string | undefined => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
const need = (a: Record<string, unknown>, k: string): string => str(a, k) ?? (() => { throw new Error(`${k} is required`); })();
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const titleOf = (dataDir: string, id: string): string => readDocFile(dataDir, id)?.frontmatter.title ?? id;
const kindOfDoc = (dataDir: string, id: string): ChangeItem["kind"] => {
  const s = readDocFile(dataDir, id)?.frontmatter.source;
  return s === "task" ? "task" : s === "initiative" ? "initiative" : "doc";
};
const item = (dataDir: string, id: string): ChangeItem => ({ id, title: titleOf(dataDir, id), kind: kindOfDoc(dataDir, id) });
/** Kind words a person may put after an item's name when saying it ("the Weekly sync meeting"). */
const KIND_WORDS = "note|meeting|task|initiative|briefing|presentation|deck|doc|document|item|page|article|video|file|transcript";
/** The forms of a reference to try in turn: as given, without a trailing kind word, then also without a leading "the" ("The roadmap" stays findable as "the roadmap doc"). */
const titleForms = (ref: string): string[] => {
  const asGiven = ref.trim();
  const noKind = asGiven.replace(new RegExp(`\\s+(?:${KIND_WORDS})$`, "i"), "").trim();
  const strip = (s: string): string => s.replace(/^the\s+/i, "").trim();
  return [...new Set([asGiven, noKind, strip(noKind), strip(asGiven)])].filter(Boolean);
};
/**
 * The id an action's reference names: the reference itself when it is an id, else the one indexed
 * item of `source` (any source when omitted) whose title matches it, ignoring the case of ASCII
 * letters (SQLite NOCASE). A title is tried as given first, then as a person says it with "the" and
 * a kind word around it ("the Weekly sync meeting" finds "Weekly sync"), so a title that itself ends
 * in a kind word still wins. Several matches are refused, listing each id so the agent can choose. The agent sees
 * ids only for what retrieval put in its context, so it names everything else by title (jv-zyp).
 * No match leaves the reference as it is, for the action to report as not found.
 */
const resolveRef = (dataDir: string, ref: string, source?: string): string => {
  if (readDocFile(dataDir, ref)) return ref;
  for (const title of titleForms(ref)) {
    const found = withDb(dataDir, (db) =>
      db.query<{ id: string; title: string; created_at: string }, [string, string | null]>("SELECT id, title, created_at FROM documents WHERE title = ?1 COLLATE NOCASE AND (?2 IS NULL OR source = ?2) ORDER BY created_at DESC").all(title, source ?? null));
    if (found.length > 1) throw new Error(`more than one item is called "${title}": ${found.map((f) => `${f.title} [${f.id}] from ${f.created_at.slice(0, 10)}`).join(", ")}; pass one of these ids, or ask the user which`);
    if (found[0]) return found[0].id;
  }
  return ref;
};
const slugify = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "deck";

/** Verb after "Couldn't" for a failed row. */
const VERBS: Record<string, string> = {
  jarvis_capture_note: "capture note", jarvis_capture_link: "capture link", jarvis_capture_file: "capture file", jarvis_create_task: "create task",
  jarvis_update_task: "change task", jarvis_set_task_status: "update task", jarvis_move_task: "move task", jarvis_create_initiative: "create initiative",
  jarvis_link: "link", jarvis_draft_briefing: "draft briefing", jarvis_draft_presentation: "draft presentation",
};
const KIND_OF_TOOL: Record<string, ChangeKind> = {
  jarvis_capture_note: "capture.note", jarvis_capture_link: "capture.link", jarvis_capture_file: "capture.file", jarvis_create_task: "task.create",
  jarvis_update_task: "task.due", jarvis_set_task_status: "task.done", jarvis_move_task: "task.move", jarvis_create_initiative: "initiative.create",
  jarvis_link: "link", jarvis_draft_briefing: "draft.briefing", jarvis_draft_presentation: "draft.presentation",
};

/** The `created` op for the files of a new doc (its sidecar too, when it has one). */
const docOp = (dataDir: string, id: string): Op[] => { const op = createdOp(dataDir, [`docs/${id}.md`, `edges/${id}.jsonl`]); return op ? [op] : []; };

async function capture(dataDir: string, kind: ChangeKind, payload: CapturePayload): Promise<Done> {
  const value = await ingest(dataDir, payload);
  const created = value.status === "captured";
  return { kind, items: [{ id: value.id, title: value.title, kind: "doc" }], ops: created ? docOp(dataDir, value.id) : [], undoable: created };
}
/** Subtitle and transcript files: captured as meetings, never shown to a model the team has not allowed. */
export const isTranscriptFile = (name: string): boolean => [".vtt", ".srt"].includes(extname(name).toLowerCase());
/** The words `from`/`to` of an owner change: the user shows as "you". */
const you = (who: string | undefined, me: string): string | undefined => (who === me ? "you" : who);

async function perform(tool: string, a: Record<string, unknown>, ctx: ActionContext): Promise<Done> {
  const d = ctx.dataDir;
  const author = resolveAuthor();
  switch (tool) {
    case "jarvis_capture_note": {
      const text = need(a, "text");
      return capture(d, "capture.note", { source: "note", title: str(a, "title") ?? text.slice(0, 60), body: text, author });
    }
    case "jarvis_capture_link": {
      const url = need(a, "url");
      return capture(d, "capture.link", { source: "web", title: need(a, "title"), body: str(a, "text") ?? url, source_url: url, author });
    }
    case "jarvis_capture_file": {
      const name = need(a, "attachment");
      const path = ctx.attachments[name];
      if (!path) throw new Error(`there is no attached file called ${name}`);
      const ext = extname(name).toLowerCase();
      const meeting = a.meeting === true || a.meeting === "true" || isTranscriptFile(name);
      if (ext === ".pdf") return capture(d, "capture.file", await pdfToPayload(path, { title: str(a, "title"), author }));
      if (meeting) return capture(d, "capture.meeting", meetingToPayload(path, { title: str(a, "title") ?? basename(name, ext), author, dataDir: d }));
      const { readFileSync } = await import("node:fs");
      return capture(d, "capture.file", { source: "paste", title: str(a, "title") ?? name, body: readFileSync(path, "utf8"), author });
    }
    case "jarvis_create_task": {
      const links = ids(a.link).map((l) => resolveRef(d, l));
      const initiative = str(a, "initiative");
      const value = await addTask(d, { title: need(a, "title"), body: str(a, "body"), due: str(a, "due"), owner: str(a, "owner"), initiative: initiative && resolveRef(d, initiative, "initiative"), links, author });
      const task = item(d, value.id);
      const also: Done[] = readSidecar(d, value.id)
        .filter((l): l is EdgeLine => l.kind === "edge" && l.created_by === "manual" && links.includes(l.dst))
        .map((l) => ({ kind: "link", items: [task, item(d, l.dst)], detail: { relation: l.relation }, ops: [{ op: "edge", src: value.id, dst: l.dst, relation: l.relation }] }));
      return { kind: "task.create", items: [task], ops: docOp(d, value.id), also };
    }
    case "jarvis_update_task":
    case "jarvis_set_task_status":
    case "jarvis_move_task": {
      const id = resolveRef(d, need(a, "task"), "task");
      const before = readDocFile(d, id)?.frontmatter.task;
      if (!before) throw new Error("the task was not found");
      const beforeCopy = { ...before };
      let kind: ChangeKind = "task.due";
      let detail: Change["detail"];
      if (tool === "jarvis_set_task_status") {
        const given = need(a, "status");
        if (given !== "done" && given !== "open") throw new Error(`status must be "done" or "open", not "${given}"`);
        const status = given;
        setTaskStatus(d, id, status, author);
        kind = status === "done" ? "task.done" : "task.reopen";
      } else if (tool === "jarvis_move_task") {
        const given = str(a, "initiative");
        const target = given ? resolveRef(d, given, "initiative") : null;
        const r = await moveTask(d, id, target, author);
        kind = "task.move";
        detail = { from: r.from, to: r.to };
        if (r.status === "unchanged") throw new Error("it is already there");
      } else {
        const r = await updateTask(d, id, { due: a.due === "" ? null : str(a, "due"), owner: str(a, "owner"), author });
        if (r.due) { kind = "task.due"; detail = { from: r.due.from, to: r.due.to }; }
        else if (r.owner) { kind = "task.owner"; detail = { from: you(r.owner.from, author), to: you(r.owner.to, author) }; }
        else throw new Error("nothing to change");
      }
      const after = { ...readDocFile(d, id)!.frontmatter.task! };
      return { kind, items: [item(d, id)], detail, ops: [{ op: "task", id, before: beforeCopy, after }] };
    }
    case "jarvis_create_initiative": {
      const value = await addInitiative(d, { title: need(a, "title"), goal: need(a, "goal"), owner: str(a, "owner"), author });
      return { kind: "initiative.create", items: [item(d, value.id)], ops: docOp(d, value.id) };
    }
    case "jarvis_link": {
      const src = resolveRef(d, need(a, "src")), dst = resolveRef(d, need(a, "dst"));
      const relation = (str(a, "relation") ?? "related") as Relation;
      const r = link(d, src, [dst], { relation, author })[0];
      if (r.status === "member") throw new Error(`${r.title} is already a task in ${r.initiative}`);
      if (r.status === "exists") throw new Error("they are already linked");
      return { kind: "link", items: [item(d, src), item(d, dst)], detail: { relation }, ops: [{ op: "edge", src, dst, relation }] };
    }
    case "jarvis_draft_briefing": {
      const title = need(a, "title");
      const value = createBriefing(d, { title, body: str(a, "body"), status: "draft", author });
      const op = createdOp(d, [relative(d, briefingPath(d, value.id))]);
      const sections = [...value.body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
      return { kind: "draft.briefing", items: [{ id: value.id, title: value.title, kind: "briefing" }], draft: { kind: "briefing", sections, sources: ids(a.sources).length }, ops: op ? [op] : [] };
    }
    default: { // jarvis_draft_presentation
      const title = need(a, "title");
      const mdx = need(a, "mdx");
      let slug = slugify(title);
      if (!SLUG_RE.test(slug)) slug = "deck";
      const tmp = mkdtempSync(join(tmpdir(), "jarvis-deck-"));
      try {
        writeFileSync(join(tmp, "index.mdx"), mdx.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")); // the agent's own frontmatter (id, author, dates) is not trusted
        const { listPresentations } = await import("../core/presentations.ts");
        const taken = new Set(listPresentations(d).map((p) => p.slug));
        for (let n = 2; taken.has(slug); n++) slug = `${slugify(title)}-${n}`;
        const value = sharePresentation(d, join(tmp, "index.mdx"), { slug, title, author, importedFrom: "chat" });
        const op = createdOp(d, [`presentations/${slug}`]);
        const slides = (mdx.match(/<Slide\b/g) ?? []).length;
        const sections = [...mdx.matchAll(/^#{1,2}\s+(.+?)\s*$/gm)].map((m) => m[1]);
        return { kind: "draft.presentation", items: [{ id: value.slug, title: value.title, kind: "presentation" }], draft: { kind: "presentation", sections: sections.slice(0, slides || sections.length), sources: ids(a.sources).length, slides } as Change["draft"], ops: op ? [op] : [] };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
}

/**
 * Run one tool call and record it; a failure is recorded as a failed row, never thrown. Returns the
 * row, any further rows the call made (`more`: the links of a new task), and the text the model reads.
 */
export async function runTool(log: ChangeLog, turn: string, tool: string, args: Record<string, unknown>, ctx: ActionContext): Promise<{ change: Change | null; more: Change[]; text: string }> {
  if (!(tool in VERBS)) throw new Error(`unknown tool ${tool}`);
  try {
    const done = await perform(tool, args, ctx);
    const rec = (x: Done): Change => log.record({ turn, kind: x.kind, ok: true, items: x.items, detail: x.detail, draft: x.draft, undoable: x.undoable }, x.ops);
    const change = rec(done);
    const more = (done.also ?? []).map(rec);
    const said = (x: Done) => x.items.map((i) => `${i.title} [${i.id}]`).join(" → ");
    return { change, more, text: `Done: ${[done, ...(done.also ?? [])].map(said).join("; ")}` };
  } catch (e) {
    const error = (e as Error).message.replace(/\.$/, "");
    const subject = str(args, "title") ?? str(args, "task") ?? str(args, "src") ?? str(args, "attachment");
    const title = subject && /^[0-9A-Z]{26}$/.test(subject) ? titleOf(ctx.dataDir, subject) : subject;
    const change = log.record({ turn, kind: KIND_OF_TOOL[tool], ok: false, items: title ? [{ id: subject ?? "", title, kind: "doc" }] : [], error, verb: VERBS[tool] }, []);
    return { change, more: [], text: `Failed: could not ${VERBS[tool]} — ${error}.` };
  }
}
