import { ulid } from "ulid";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { AcpClient, spawnCopilotAcp, type AcpTransport, type McpServer } from "./acp.ts";
import { runTool } from "./actions.ts";
import { ChangeLog, type Change } from "./changes.ts";
import { loadConfig, loadTeamConfig, resolvePort } from "../core/config.ts";
import { ftsQuery, keywordSearchRaw } from "../core/search.ts";
import { openDb } from "../core/db.ts";
import { readDocFile } from "../core/docs.ts";
import { readBriefing } from "../briefings/store.ts";

export const CHAT_GROUNDED_BODY_CHARS = 60_000;
export const CHAT_SNIPPET_CHARS = 8_000;
export const CHAT_RESULTS = 6;
export const CHAT_MAX_TERMS = 8;
export const CHAT_IDLE_MS = 60 * 60_000;

export type ChatScope = { type: "jarvis" | "item" | "briefing"; ids: string[] };
export type ChatEvent =
  | { type: "source"; docId: string; title: string; source: string }
  | { type: "message"; text: string }
  | { type: "change"; change: Change }
  | { type: "status"; text: string }
  | { type: "usage"; used: number; size: number }
  | { type: "done"; stopReason?: string }
  | { type: "error"; error: string };

export const CHAT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHAT_FILE_EXT = [".txt", ".md", ".markdown", ".pdf", ".vtt"];
/** What the agent says when it captured a transcript it may not read. */
export const TRANSCRIPT_NOTICE = "I saved the transcript, but your team doesn't allow sending meeting transcripts to the model I'm using, so I can't read it to find the decisions.";
/** A file sent with a message. */
export interface ChatFile { name: string; bytes: Uint8Array }
/** The tool rules every conversation starts with. */
export const CHAT_RULES = "You can act on the knowledge base with the jarvis_* tools: capture notes, links and attached files; create and update tasks; create initiatives and file tasks under them; link items; draft briefings and presentations. When the user asks for a change, make it straight away without asking first; every change can be undone. Never publish or approve anything: a briefing or presentation you make is a draft, and you say so. Capture an attached file only when the user asks. If a tool fails, say so plainly in your answer. Report each item by title.";

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
  busy: boolean;
  /** Called with each change made during the turn in flight. */
  onChange?: (c: Change) => void;
  sources: { docId: string; title: string; source: string }[];
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
  /** Where the agent's tool server reaches this service. */
  serverUrl?: () => string;
  /** The command that starts the tool server (tests may point it elsewhere). */
  mcpCommand?: { command: string; args: string[] };
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
    if (!["jarvis", "item", "briefing"].includes(scope?.type)) throw new Error("scope.type must be jarvis|item|briefing");
    const ids = Array.isArray(scope.ids) ? scope.ids : [];
    if (scope.type !== "jarvis" && ids.length !== 1) throw new Error(`scope ${scope.type} requires exactly one id`);
    const sources: ChatSession["sources"] = [];
    if (scope.type === "item") {
      const d = readDocFile(this.dataDir, ids[0]);
      if (!d) throw new Error(`item ${ids[0]} not found`);
      sources.push({ docId: ids[0], title: d.frontmatter.title, source: d.frontmatter.source });
    } else if (scope.type === "briefing") {
      const b = readBriefing(this.dataDir, ids[0]);
      if (!b) throw new Error(`briefing ${ids[0]} not found`);
      sources.push({ docId: ids[0], title: b.title, source: "briefing" });
    }
    const agent = await this.agent();
    const id = ulid();
    const cmd = this.deps.mcpCommand ?? { command: process.execPath, args: ["run", join(import.meta.dir, "mcp.ts")] };
    const mcp: McpServer = { name: "jarvis", command: cmd.command, args: cmd.args, env: [{ name: "JARVIS_URL", value: (this.deps.serverUrl ?? (() => `http://127.0.0.1:${resolvePort()}`))() }, { name: "JARVIS_CHAT_SESSION", value: id }] };
    const acpSessionId = await agent.newSession(this.dataDir, [mcp]);
    new ChangeLog(this.dataDir, conversationId ?? id); // validates the id
    const s: ChatSession = { id, conversationId: conversationId ?? id, turn: "", attachments: {}, scope: { type: scope.type, ids }, acpSessionId, createdAt: this.now(), lastActive: this.now(), turns: 0, busy: false, sources };
    this.sessions.set(s.id, s);
    return s;
  }
  /** The prompt of a turn: tool rules on the first turn, the question, and a line per attached file. */
  buildPrompt(s: ChatSession, message: string, files: ChatFile[] = []): { prompt: string; sources: ChatSession["sources"] } {
    const r = this.buildQuestion(s, message);
    const readable = loadTeamConfig(this.dataDir).privacy.transcriptsToCloud;
    const lines = files.map((f) => {
      const ext = extname(f.name).toLowerCase();
      const size = `${f.bytes.length} bytes`;
      if (ext === ".pdf") return `- ${f.name} (PDF, ${size})`;
      if (ext === ".vtt" && !readable) return `- ${f.name} (meeting transcript, ${size}). You may not read it. If asked to capture it, call jarvis_capture_file with meeting=true, then tell the user exactly: "${TRANSCRIPT_NOTICE}"`;
      return `- ${f.name} (${size}):\n${new TextDecoder().decode(f.bytes).slice(0, CHAT_GROUNDED_BODY_CHARS)}`;
    });
    const attach = lines.length ? `\n\nAttached files (capture one only if asked; pass its name as attachment):\n${lines.join("\n")}` : "";
    const question = s.turns === 0 && !r.prompt.includes("User: ") ? `User: ${r.prompt}` : r.prompt;
    return { prompt: `${s.turns === 0 ? `${CHAT_RULES}\n\n` : ""}${question}${attach}`, sources: r.sources };
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
          const hits = keywordSearchRaw(db, terms.map((t) => ftsQuery(t)).join(" OR "), CHAT_RESULTS);
          for (const h of hits) {
            const part = `[${h.docId}] ${h.title} (${h.source})\n${h.snippet.replace(/[[\]]/g, "")}\n\n`;
            if (ctx.length + part.length > CHAT_SNIPPET_CHARS) break;
            ctx += part;
            sources.push({ docId: h.docId, title: h.title, source: h.source });
          }
        } finally {
          db.close();
        }
      }
      const prompt = ctx ? `You are discussing a team knowledge base. Relevant captured items (cite ids in square brackets when you use them):\n\n${ctx}\nUser: ${message}` : message;
      return { prompt, sources };
    }
    if (s.turns === 0) {
      const id = s.scope.ids[0];
      let title = "";
      let body = "";
      if (s.scope.type === "item") {
        const d = readDocFile(this.dataDir, id)!;
        title = d.frontmatter.title;
        body = d.body;
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
    s.turn = ulid();
    s.attachments = {};
    if (files.length) {
      const dir = join(this.dataDir, ".index", "chat", "uploads", s.turn);
      mkdirSync(dir, { recursive: true });
      for (const f of files) {
        const safe = f.name.replace(/[\\/]/g, "_");
        writeFileSync(join(dir, safe), f.bytes);
        s.attachments[f.name] = join(dir, safe);
      }
    }
    const queue: ChatEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (e: ChatEvent) => {
      queue.push(e);
      wake?.();
    };
    this.updateHandlers.set(s.acpSessionId, (u) => {
      const kind = String(u.sessionUpdate ?? "");
      if (kind === "agent_message_chunk") {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && c.text) push({ type: "message", text: c.text });
      } else if (kind === "usage_update") {
        const used = Number(u.used ?? (u.usage as { used?: number })?.used ?? 0), size = Number(u.size ?? (u.usage as { size?: number })?.size ?? 0);
        push({ type: "usage", used, size });
      } else if (kind === "tool_call" || kind === "tool_call_update") push({ type: "status", text: String(u.title ?? u.status ?? kind) });
      else if (kind === "agent_thought_chunk") push({ type: "status", text: "thinking" });
    });
    try {
      s.onChange = (change) => push({ type: "change", change });
      const { prompt, sources } = this.buildPrompt(s, message, files);
      for (const src of sources) push({ type: "source", ...src });
      const agent = await this.agent();
      let finished = false;
      const done = agent.prompt(s.acpSessionId, prompt).then((r) => { push({ type: "done", stopReason: r?.stopReason }); finished = true; }, (e: Error) => { push({ type: "error", error: e.message }); finished = true; });
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
      s.onChange = undefined;
      s.lastActive = this.now();
      this.updateHandlers.delete(s.acpSessionId);
    }
  }
  /** Run one tool call of the agent: make the change, record it, tell the turn in flight. */
  async act(id: string, tool: string, args: Record<string, unknown>): Promise<{ change: Change; text: string }> {
    const s = this.sessions.get(id);
    if (!s) throw new ChatError("session not found", 404);
    const r = await runTool(new ChangeLog(this.dataDir, s.conversationId), s.turn, tool, args, { dataDir: this.dataDir, attachments: s.attachments });
    s.onChange?.(r.change);
    return r;
  }
  /** The change log of a conversation (it outlives chat sessions). */
  changes(conversationId: string): ChangeLog {
    return new ChangeLog(this.dataDir, conversationId);
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
