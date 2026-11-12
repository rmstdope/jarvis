import { ulid } from "ulid";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { AcpClient, spawnCopilotAcp, type AcpTransport } from "./acp.ts";
import { ActionFilter, resolveRefs, type ParsedAction } from "./action-blocks.ts";
import { TOOLS, isTranscriptFile, runTool } from "./actions.ts";
import { ChangeLog, type Change } from "./changes.ts";
import { loadConfig, loadTeamConfig } from "../core/config.ts";
import { ftsQuery, keywordSearchRaw } from "../core/search.ts";
import { openDb } from "../core/db.ts";
import { readDocFile } from "../core/docs.ts";
import { readInitiative } from "../core/initiatives.ts";
import { requireInitiative } from "../core/initiativeRef.ts";
import { formatInitiativeShow, PLAIN } from "../core/initiativeView.ts";
import { readBriefing } from "../briefings/store.ts";
import { readPresentation } from "../core/presentations.ts";
import { OpenFilter } from "./open.ts";

export const CHAT_GROUNDED_BODY_CHARS = 60_000;
export const CHAT_SNIPPET_CHARS = 8_000;
export const CHAT_RESULTS = 6;
export const CHAT_MAX_TERMS = 8;
export const CHAT_IDLE_MS = 60 * 60_000;

export type ChatScope = { type: "jarvis" | "item" | "briefing" | "initiative"; ids: string[] };
export type ChatEvent =
  | { type: "source"; docId: string; title: string; source: string }
  | { type: "open"; docId: string; title: string; source: string }
  | { type: "message"; text: string }
  | { type: "change"; change: Change }
  | { type: "status"; text: string }
  | { type: "usage"; used: number; size: number }
  | { type: "done"; stopReason?: string }
  | { type: "error"; error: string };

export const CHAT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHAT_FILE_EXT = [".txt", ".md", ".markdown", ".pdf", ".vtt", ".srt"];
/** Text that reads like a transcript (timestamped lines), whatever the file is called. */
export function looksLikeTranscript(text: string): boolean {
  return (text.match(/^\s*\[?\(?\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?\]?\)?\s/gm) ?? []).length >= 3;
}
/** What the agent says when it captured a transcript it may not read. */
export const TRANSCRIPT_NOTICE = "I saved the transcript, but your team doesn't allow sending meeting transcripts to the model I'm using, so I can't read it to find the decisions.";
/** A file sent with a message. */
export interface ChatFile { name: string; bytes: Uint8Array }
/** The action block format and the actions the agent may write, as the prompt shows them. */
const sample = (p: unknown): unknown => {
  const d = p as { type?: string; enum?: string[] };
  return d.enum ? d.enum.join("|") : d.type === "array" ? ["…"] : d.type === "boolean" ? true : "…";
};
export const ACTION_REFERENCE = TOOLS.map((t) => `${t.name} ${JSON.stringify(Object.fromEntries(Object.entries(t.properties).map(([k, p]) => [t.required.includes(k) ? k : `${k}?`, sample(p)])))} — ${t.description}`).join("\n");
/** The rules every conversation starts with. */
export const CHAT_RULES = `You can act on the knowledge base by writing action blocks in your answer: capture notes, links and attached files; create and update tasks; create and edit initiatives and file tasks under them; link items; draft briefings and presentations. A block is a fenced code block whose info string is jarvis-action, holding one JSON object {"tool": …, "args": {…}, "as": "name"} (as is optional):

\`\`\`jarvis-action
{"tool": "jarvis_create_task", "args": {"title": "Ring the vendor", "due": "2026-11-13"}, "as": "t1"}
\`\`\`

Later blocks of the same answer may pass "$t1" wherever an id is needed (for example link or initiative). Ids of existing items are in square brackets in the context; for an existing item whose id you do not have, pass its exact title instead. When several items of one kind in the context share the name the user said, ask which one they mean instead of choosing. Actions (a key ending in ? is optional; write it without the ?):
${ACTION_REFERENCE}

When the user asks for a change, write its block straight away without asking first; every change can be undone. Write one block per change. After the blocks run you are told what happened; if something failed, say so plainly. The blocks are removed from what the person reads and a card in your answer, where the first block ran, shows what was done or failed, so do not claim a result and do not repeat the block's content. Word what you write before an action as what you are about to do ("I'll link Weekly sync to Q4 planning."), never as already happening or done ("I'm linking…", "Linked…"); explain any failure after the results, in a sentence or two. Never publish or approve anything: a briefing or presentation you make is a draft, and you say so. Capture an attached file only when the user asks. To open a document for the user in a tab beside the chat, write <<open:ID>> with its id in your answer.`;

export interface ChatSession {
  id: string;
  /** The browser's conversation; the change log is keyed by it so Undo outlives this session. */
  conversationId: string;
  /** The answer being written now; changes made during it share this id. */
  turn: string;
  /** Files of the message in flight: name → saved path. */
  attachments: Record<string, string>;
  scope: ChatScope;
  acpSessionId: string;
  createdAt: number;
  lastActive: number;
  turns: number;
  /** What the agent's actions did in its previous answer (titles and ids), told to it with the next question. */
  lastResults: string[];
  busy: boolean;
  sources: { docId: string; title: string; source: string }[];
  /** Titles the user has been asked to choose between in this session (jv-6c1); see `ActionContext.asked`. */
  asked: Set<string>;
}

/** The configured chat model id (`JARVIS_CHAT_MODEL`, else config `chatModel`); undefined lets Copilot pick its default. */
export function chatModel(): string | undefined {
  return process.env.JARVIS_CHAT_MODEL || (loadConfig() as { chatModel?: string }).chatModel || undefined;
}

const STOP = new Set("a an the and or of to in on for with is are was were be been it this that these those i you we they he she what which who whom how why when where do does did can could should would will shall may might about from by as at into over under not no yes me my our your their its than then there here up down out off just so if but".split(" "));
/** ≤ 8 unique keyword terms from a message, stop words removed. */
export function retrievalTerms(message: string): string[] {
  const out: string[] = [];
  for (const w of message.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= CHAT_MAX_TERMS) break;
  }
  return out;
}

export interface ChatDeps {
  spawn?: (model: string | undefined, cwd: string) => AcpTransport;
  now?: () => number;
}

/** One shared ACP process; one ACP session per chat session; ephemeral, never written to the content repo. */
export class ChatService {
  private client: AcpClient | null = null;
  private clientInit: Promise<AcpClient> | null = null;
  /** The agent spawned by a pending clientInit, until its initialize settles. */
  private starting: AcpClient | null = null;
  private sessions = new Map<string, ChatSession>();
  private updateHandlers = new Map<string, (u: Record<string, unknown>) => void>();
  private now: () => number;
  constructor(private dataDir: string, private deps: ChatDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }
  private async agent(): Promise<AcpClient> {
    if (this.client && !this.client.isClosed) return this.client;
    if (this.clientInit) return this.clientInit;
    this.clientInit = (async () => {
      const spawn = this.deps.spawn ?? spawnCopilotAcp;
      const c = new AcpClient(spawn(chatModel(), this.dataDir));
      this.starting = c;
      try {
        await c.initialize();
      } catch (e) {
        await c.close();
        throw e;
      } finally {
        this.starting = null;
      }
      c.onUpdate((u) => this.updateHandlers.get(u.sessionId)?.(u.update));
      this.client = c;
      return c;
    })().finally(() => (this.clientInit = null));
    return this.clientInit;
  }
  expire(): void {
    for (const [id, s] of this.sessions) if (!s.busy && this.now() - s.lastActive > CHAT_IDLE_MS) this.delete(id);
  }
  list(): ChatSession[] {
    return [...this.sessions.values()];
  }
  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }
  async create(scope: ChatScope, conversationId?: string): Promise<ChatSession> {
    this.expire();
    if (!["jarvis", "item", "briefing", "initiative"].includes(scope?.type)) throw new Error("scope.type must be jarvis|item|briefing|initiative");
    const ids = Array.isArray(scope.ids) ? scope.ids : [];
    if (scope.type !== "jarvis" && ids.length !== 1) throw new Error(`scope ${scope.type} requires exactly one id`);
    const sources: ChatSession["sources"] = [];
    if (scope.type === "item") {
      const d = this.readItem(ids[0]);
      if (!d) throw new Error(`item ${ids[0]} not found`);
      sources.push({ docId: ids[0], title: d.title, source: d.source });
    } else if (scope.type === "initiative") {
      try { requireInitiative(this.dataDir, ids[0]); } catch { throw new Error(`initiative ${ids[0]} not found`); }
      sources.push({ docId: ids[0], title: readDocFile(this.dataDir, ids[0])!.frontmatter.title, source: "initiative" });
    } else if (scope.type === "briefing") {
      const b = readBriefing(this.dataDir, ids[0]);
      if (!b) throw new Error(`briefing ${ids[0]} not found`);
      sources.push({ docId: ids[0], title: b.title, source: "briefing" });
    }
    const agent = await this.agent();
    const id = ulid();
    const acpSessionId = await agent.newSession(this.dataDir);
    new ChangeLog(this.dataDir, conversationId ?? id); // validates the id
    const s: ChatSession = { id, conversationId: conversationId ?? id, turn: "", attachments: {}, scope: { type: scope.type, ids }, acpSessionId, createdAt: this.now(), lastActive: this.now(), turns: 0, lastResults: [], busy: false, sources, asked: new Set() };
    this.sessions.set(s.id, s);
    return s;
  }
  /** An item the chat can be about: a captured doc, or a presentation (kept as a bundle, not under docs/). */
  private readItem(id: string): { title: string; body: string; source: string } | null {
    const d = readDocFile(this.dataDir, id);
    if (d) return { title: d.frontmatter.title, body: d.body, source: d.frontmatter.source };
    const p = readPresentation(this.dataDir, id);
    return p ? { title: p.frontmatter.title, body: p.body, source: "presentation" } : null;
  }
  /** The prompt of a turn: tool rules on the first turn, the question, and a line per attached file. */
  buildPrompt(s: ChatSession, message: string, files: ChatFile[] = []): { prompt: string; sources: ChatSession["sources"] } {
    const r = this.buildQuestion(s, message);
    const readable = loadTeamConfig(this.dataDir).privacy.transcriptsToCloud;
    const lines = files.map((f) => {
      const ext = extname(f.name).toLowerCase();
      const size = `${f.bytes.length} bytes`;
      if (ext === ".pdf") return `- ${f.name} (PDF, ${size})`;
      const text = new TextDecoder().decode(f.bytes).slice(0, CHAT_GROUNDED_BODY_CHARS);
      if (!readable && (isTranscriptFile(f.name) || looksLikeTranscript(text))) return `- ${f.name} (meeting transcript, ${size}). You may not read it. If asked to capture it, write a jarvis_capture_file action with meeting true, then tell the user exactly: "${TRANSCRIPT_NOTICE}"`;
      return `- ${f.name} (${size}):\n${text}`;
    });
    const attach = lines.length ? `\n\nAttached files (capture one only if asked; pass its name as attachment):\n${lines.join("\n")}` : "";
    const question = s.turns === 0 && !r.prompt.includes("User: ") ? `User: ${r.prompt}` : r.prompt;
    const prev = s.lastResults.length ? `Results of your actions in your previous answer:\n${s.lastResults.map((r) => `- ${r}`).join("\n")}\n\n` : "";
    return { prompt: `${s.turns === 0 ? `${CHAT_RULES}\n\n` : ""}${prev}${question}${attach}`, sources: r.sources };
  }
  /** Grounded body on the first turn for item/briefing; retrieval snippets every turn for jarvis. */
  private buildQuestion(s: ChatSession, message: string): { prompt: string; sources: ChatSession["sources"] } {
    const sources: ChatSession["sources"] = [];
    if (s.scope.type === "jarvis") {
      const terms = retrievalTerms(message);
      let ctx = "";
      if (terms.length) {
        const db = openDb(this.dataDir);
        try {
          const hits = keywordSearchRaw(db, terms.map((t) => ftsQuery(t)).join(" OR "), CHAT_RESULTS * 2);
          const allowed = loadTeamConfig(this.dataDir).privacy.transcriptsToCloud;
          for (const h of hits.slice(0, CHAT_RESULTS)) {
            // a transcript the team keeps off cloud models never reaches the prompt; the meeting's id and title do, so it can be linked
            const text = allowed || h.source !== "meeting" ? `${h.snippet.replace(/[[\]]/g, "")}\n` : "";
            const part = `[${h.docId}] ${h.title} (${h.source})\n${text}\n`;
            if (ctx.length + part.length > CHAT_SNIPPET_CHARS) break;
            ctx += part;
            sources.push({ docId: h.docId, title: h.title, source: h.source });
          }
        } finally {
          db.close();
        }
      }
      const prompt = ctx ? `You are discussing a team knowledge base. Relevant captured items (cite ids in square brackets when you use them; to open one for the user write <<open:ID>> after it):\n\n${ctx}\nUser: ${message}` : message;
      return { prompt, sources };
    }
    if (s.turns === 0) {
      const id = s.scope.ids[0];
      let title = "";
      let body = "";
      if (s.scope.type === "item") {
        const d = this.readItem(id)!;
        title = d.title;
        body = d.body;
      } else if (s.scope.type === "initiative") {
        const d = readInitiative(this.dataDir, id, { all: true });
        title = d.initiative.title;
        body = formatInitiativeShow(d, null, PLAIN);
      } else {
        const b = readBriefing(this.dataDir, id)!;
        title = b.title;
        body = b.body;
      }
      return { prompt: `You are discussing one ${s.scope.type} from a team knowledge base. Answer from its content; say when it does not cover the question.\n\n[${id}] ${title}\n\n${body.slice(0, CHAT_GROUNDED_BODY_CHARS)}\n\n---\nUser: ${message}`, sources: s.sources };
    }
    return { prompt: message, sources: [] };
  }
  /** Stream one turn. Exactly one in-flight prompt per session. */
  async *send(id: string, message: string, files: ChatFile[] = []): AsyncGenerator<ChatEvent> {
    const s = this.sessions.get(id);
    if (!s) throw new ChatError("session not found", 404);
    if (s.busy) throw new ChatError("a prompt is already in flight for this session", 409);
    if (!message || !message.trim()) throw new ChatError("message is required", 400);
    for (const f of files) {
      if (!CHAT_FILE_EXT.includes(extname(f.name).toLowerCase())) throw new ChatError(`${f.name} — can't capture this kind of file`, 400);
      if (f.bytes.length > CHAT_MAX_FILE_BYTES) throw new ChatError(`${f.name} — larger than 25 MB`, 400);
    }
    s.busy = true;
    s.lastActive = this.now();
    const turn = (s.turn = ulid());
    s.attachments = {};
    const attachments = s.attachments;
    const names: ChatFile[] = [];
    if (files.length) {
      const dir = join(this.dataDir, ".index", "chat", "uploads", s.turn);
      mkdirSync(dir, { recursive: true });
      for (const f of files) {
        let safe = f.name.replace(/[\\/]/g, "_");
        for (let n = 2; safe in s.attachments; n++) safe = `${basename(f.name, extname(f.name))}-${n}${extname(f.name)}`;
        writeFileSync(join(dir, safe), f.bytes);
        s.attachments[safe] = join(dir, safe);
        names.push({ ...f, name: safe });
      }
    }
    const queue: ChatEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (e: ChatEvent) => {
      queue.push(e);
      wake?.();
    };
    const actions = new ActionFilter();
    const filter = new OpenFilter();
    const aliases: Record<string, string> = {};
    let chain: Promise<void> = Promise.resolve();
    const results: string[] = [];
    const failed: string[] = [];
    let seen: ChatSession["sources"] = [];
    const asking = new Set<string>(); // a refusal this turn counts from the next one, once the user has been asked
    /** Run the agent's actions in order, each recorded and pushed as a `change` event. */
    const act = (list: { tool: string; args: Record<string, unknown>; as?: string }[]) => {
      for (const a of list) {
        chain = chain.then(async () => {
          try {
            const r = await runTool(new ChangeLog(this.dataDir, s.conversationId), turn, a.tool, resolveRefs(a.args, aliases), { dataDir: this.dataDir, attachments, seen, asked: s.asked, asking });
            results.push(r.text);
            if (r.change && !r.change.ok) failed.push(r.text);
            if (r.change) {
              push({ type: "change", change: r.change });
              for (const m of r.more) push({ type: "change", change: m });
              if (a.as && r.change.ok && r.change.items[0]) aliases[a.as] = r.change.items[0].id;
            }
          } catch { /* an unknown tool: nothing was attempted, so there is nothing to show */ }
        });
      }
    };
    let textOnly = false; // the follow-up about failures may speak but never act
    const feed = (chunk: string) => {
      route(actions.push(chunk));
    };
    /** Text and actions in the order the agent wrote them, so a change is sent where its block stood. */
    const route = (r: { parts: ({ text: string } | { action: ParsedAction })[] }) => {
      for (const p of r.parts) {
        if ("action" in p) { if (!textOnly) act([p.action]); }
        else pushText(filter.push(p.text));
      }
    };
    /** Send after every action queued so far has reported its change. */
    // Progress events (status, usage, source) bypass the chain on purpose: they only feed the steps list.
    const emit = (e: ChatEvent) => { chain = chain.then(() => push(e)); };
    const finishText = () => {
      route(actions.end());
      const rest = filter.end();
      if (rest) emit({ type: "message", text: rest });
    };
    const opened = new Set<string>();
    const pushText = (r: { text: string; opens: string[] }) => {
      if (r.text) emit({ type: "message", text: r.text });
      for (const id of r.opens) {
        if (opened.has(id)) continue;
        const doc = this.resolveDoc(id);
        if (doc) { opened.add(id); emit({ type: "open", ...doc }); }
      }
    };
    this.updateHandlers.set(s.acpSessionId, (u) => {
      const kind = String(u.sessionUpdate ?? "");
      if (kind === "agent_message_chunk") {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && c.text) feed(c.text);
      } else if (kind === "usage_update") {
        const used = Number(u.used ?? (u.usage as { used?: number })?.used ?? 0), size = Number(u.size ?? (u.usage as { size?: number })?.size ?? 0);
        push({ type: "usage", used, size });
      } else if (kind === "tool_call" || kind === "tool_call_update") push({ type: "status", text: String(u.title ?? u.status ?? kind) });
      else if (kind === "agent_thought_chunk") push({ type: "status", text: "thinking" });
    });
    try {
      const { prompt, sources } = this.buildPrompt(s, message, names);
      seen = sources;
      for (const src of sources) push({ type: "source", ...src });
      const agent = await this.agent();
      let finished = false;
      const done = agent.prompt(s.acpSessionId, prompt).then(async (r) => {
        finishText();
        await chain;
        if (failed.length && r?.stopReason !== "cancelled") { // the agent says so in its answer: one more prompt, with what failed
          textOnly = true;
          push({ type: "message", text: "\n\n" });
          await agent.prompt(s.acpSessionId, `Some of your actions failed:\n${failed.map((f) => `- ${f}`).join("\n")}\nTell the user plainly, in one or two sentences, what did not work and why. Do not write action blocks.`).catch(() => null);
          finishText();
          await chain; // the follow-up's last text goes out before done
        }
        push({ type: "done", stopReason: r?.stopReason }); finished = true; }, async (e: Error) => { finishText(); await chain; push({ type: "error", error: e.message }); finished = true; });
      while (!finished || queue.length) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      await done;
      s.turns++;
    } finally {
      s.busy = false;
      if (files.length) rmSync(join(this.dataDir, ".index", "chat", "uploads", turn), { recursive: true, force: true }); // captured files were copied into the content repo
      s.lastResults = results;
      for (const k of asking) s.asked.add(k);
      s.attachments = {};
      s.lastActive = this.now();
      this.updateHandlers.delete(s.acpSessionId);
    }
  }
  /** The change log of a conversation (it outlives chat sessions). */
  changes(conversationId: string): ChangeLog {
    return new ChangeLog(this.dataDir, conversationId);
  }
  /** The document an `<<open:ID>>` marker names, or null when there is none. */
  private resolveDoc(id: string): { docId: string; title: string; source: string } | null {
    try { return this.lookupDoc(id); } catch { return null; } // a broken file must never take the agent connection down
  }
  private lookupDoc(id: string): { docId: string; title: string; source: string } | null {
    const d = readDocFile(this.dataDir, id);
    if (d) return { docId: id, title: d.frontmatter.title, source: d.frontmatter.source };
    const b = readBriefing(this.dataDir, id);
    if (b) return { docId: id, title: b.title, source: "briefing" };
    const p = readPresentation(this.dataDir, id);
    return p ? { docId: p.slug, title: p.frontmatter.title, source: "presentation" } : null;
  }
  async cancel(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new ChatError("session not found", 404);
    if (s.busy && this.client) await this.client.cancel(s.acpSessionId);
  }
  delete(id: string): void {
    this.sessions.delete(id);
    this.updateHandlers.delete(this.sessions.get(id)?.acpSessionId ?? "");
  }
  /**
   * Drop every session and stop the agent, including one still starting; resolves once its
   * process has exited.
   */
  async shutdown(): Promise<void> {
    const clients = [this.client, this.starting];
    this.client = null;
    this.sessions.clear();
    await Promise.all(clients.map((c) => c?.close()));
  }
}
export class ChatError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
