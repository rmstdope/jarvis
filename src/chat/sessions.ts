import { ulid } from "ulid";
import { AcpClient, spawnCopilotAcp, type AcpTransport } from "./acp.ts";
import { loadConfig } from "../core/config.ts";
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
  | { type: "status"; text: string }
  | { type: "usage"; used: number; size: number }
  | { type: "done"; stopReason?: string }
  | { type: "error"; error: string };

export interface ChatSession {
  id: string;
  scope: ChatScope;
  acpSessionId: string;
  createdAt: number;
  lastActive: number;
  turns: number;
  busy: boolean;
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
  async create(scope: ChatScope): Promise<ChatSession> {
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
    const acpSessionId = await agent.newSession(this.dataDir);
    const s: ChatSession = { id: ulid(), scope: { type: scope.type, ids }, acpSessionId, createdAt: this.now(), lastActive: this.now(), turns: 0, busy: false, sources };
    this.sessions.set(s.id, s);
    return s;
  }
  /** Build the prompt: grounded body on the first turn for item/briefing; retrieval snippets every turn for jarvis. */
  buildPrompt(s: ChatSession, message: string): { prompt: string; sources: ChatSession["sources"] } {
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
  async *send(id: string, message: string): AsyncGenerator<ChatEvent> {
    const s = this.sessions.get(id);
    if (!s) throw new ChatError("session not found", 404);
    if (s.busy) throw new ChatError("a prompt is already in flight for this session", 409);
    if (!message || !message.trim()) throw new ChatError("message is required", 400);
    s.busy = true;
    s.lastActive = this.now();
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
      const { prompt, sources } = this.buildPrompt(s, message);
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
      s.lastActive = this.now();
      this.updateHandlers.delete(s.acpSessionId);
    }
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
