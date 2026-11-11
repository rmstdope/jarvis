/**
 * Minimal Agent Client Protocol client: JSON-RPC 2.0 over newline-delimited stdio.
 * The client advertises no filesystem or terminal capabilities. It answers a permission request
 * for one of J.A.R.V.I.S.'s own tools (`jarvis_*`, which record every change so it can be undone)
 * "allow once", and every other request "cancelled".
 */
export interface AcpUpdate {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate?: string };
}
export interface AcpTransport {
  stdin: WritableStream<Uint8Array> | { write(s: string): unknown };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
  exited: Promise<number>;
}
/** A stdio MCP server the agent may start for a session (ACP `session/new`). */
export interface McpServer { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Our own tools are allowed once; anything else is cancelled. */
export function permissionOutcome(params: Record<string, unknown>): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const title = String((params.toolCall as { title?: unknown } | undefined)?.title ?? "");
  const options = (params.options as { optionId: string; kind?: string }[] | undefined) ?? [];
  const allow = options.find((o) => o.kind === "allow_once");
  return /^(?:[\w.-]+[-:./])?jarvis_[a-z_]+$/.test(title.trim()) && allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
}

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private listeners = new Set<(u: AcpUpdate) => void>();
  private closed = false;
  readonly ready: Promise<void>;
  constructor(private t: AcpTransport, private log: (s: string) => void = () => {}) {
    if ("getWriter" in t.stdin) this.writer = (t.stdin as WritableStream<Uint8Array>).getWriter();
    this.ready = this.readLoop();
    t.exited.then(() => this.fail(new Error("ACP agent exited")));
  }
  onUpdate(fn: (u: AcpUpdate) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private async send(obj: unknown): Promise<void> {
    const line = JSON.stringify(obj) + "\n";
    if (this.writer) await this.writer.write(new TextEncoder().encode(line));
    else (this.t.stdin as { write(s: string): unknown }).write(line);
  }
  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ACP client closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  }
  notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error("ACP client closed"));
    return this.send({ jsonrpc: "2.0", method, params });
  }
  private async readLoop(): Promise<void> {
    const reader = this.t.stdout.getReader();
    const td = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += td.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.handle(line);
        }
      }
    } catch (e) {
      this.log(`acp read error: ${(e as Error).message}`);
    }
    this.fail(new Error("ACP stream closed"));
  }
  private handle(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`acp: non-JSON line ${line.slice(0, 120)}`);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error((msg.error as { message?: string }).message ?? "ACP error"));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (msg.id !== undefined) {
        // agent → client request: never grant anything
        if (msg.method === "session/request_permission") this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: permissionOutcome(params) } });
        else this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
        return;
      }
      if (msg.method === "session/update") for (const l of this.listeners) l(params as unknown as AcpUpdate);
    }
  }
  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
  get isClosed(): boolean {
    return this.closed;
  }
  /**
   * Stop the agent and resolve once its process has exited. Callers that remove the agent's
   * working directory must await this: on Windows a live child keeps its cwd busy (EBUSY).
   */
  close(): Promise<void> {
    this.fail(new Error("ACP client closed"));
    try { this.writer?.close().catch(() => {}); } catch {}
    try { this.t.kill(); } catch {}
    return this.t.exited.then(() => {}, () => {});
  }
  // ---- protocol helpers ----
  async initialize(): Promise<unknown> {
    return this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "jarvis", version: "0.1.0" } }, 30_000);
  }
  async newSession(cwd: string, mcpServers: McpServer[] = []): Promise<string> {
    const r = await this.request<{ sessionId: string }>("session/new", { cwd, mcpServers }, 30_000);
    return r.sessionId;
  }
  prompt(sessionId: string, text: string): Promise<{ stopReason?: string }> {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 600_000);
  }
  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }
}

/**
 * The Copilot CLI command line for ACP mode with built-in tools off and only J.A.R.V.I.S.'s own `jarvis_*` tools on. With no model the
 * CLI picks its own default, and no reasoning effort is forced: Copilot refuses to open a
 * session when the model does not support one (e.g. gpt-4.1).
 */
export function copilotAcpArgs(model: string | undefined): string[] {
  return ["copilot", "--acp", ...(model ? ["--model", model] : []), "--available-tools=jarvis_*,jarvis-jarvis_*", "--disable-builtin-mcps", "--no-custom-instructions", "--no-auto-update"];
}

/** Spawn the Copilot CLI in ACP mode (see `copilotAcpArgs`). */
export function spawnCopilotAcp(model: string | undefined, cwd: string): AcpTransport {
  const p = Bun.spawn(copilotAcpArgs(model), { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  return { stdin: p.stdin as unknown as WritableStream<Uint8Array>, stdout: p.stdout as ReadableStream<Uint8Array>, kill: () => p.kill(), exited: p.exited };
}
export function spawnBunAcp(script: string, cwd: string): AcpTransport {
  const p = Bun.spawn(["bun", "run", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  return { stdin: p.stdin as unknown as WritableStream<Uint8Array>, stdout: p.stdout as ReadableStream<Uint8Array>, kill: () => p.kill(), exited: p.exited };
}
