/**
 * A stdio MCP server that gives the chat agent J.A.R.V.I.S.'s tools. It holds no logic: every
 * `tools/call` is forwarded to the local service (`POST /api/chat/sessions/:id/actions`), which runs
 * the change and records it. Started by the agent from `session/new`; env `JARVIS_URL` and
 * `JARVIS_CHAT_SESSION` say where to forward.
 */
import { TOOLS } from "./actions.ts";

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown> };
/** Forward one tool call; resolves to the text the model reads and whether it failed. */
export type Forward = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

/** Answer one JSON-RPC message; `null` for notifications. */
export async function handleMcp(msg: Msg, forward: Forward): Promise<Record<string, unknown> | null> {
  if (msg.id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: (msg.params?.protocolVersion as string) ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "jarvis", version: "0.1.0" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required } })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const r = await forward(name, (msg.params?.arguments as Record<string, unknown>) ?? {}).catch((e: Error) => ({ text: e.message, isError: true }));
      return ok({ content: [{ type: "text", text: r.text }], isError: r.isError });
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } };
  }
}

/** The forwarder the real server process uses. */
export function httpForward(baseUrl: string, sessionId: string, fetchImpl: typeof fetch = fetch): Forward {
  return async (tool, args) => {
    const r = await fetchImpl(`${baseUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args }) });
    const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string; change?: { ok?: boolean } };
    return { text: j.text ?? j.error ?? `${r.status}`, isError: !r.ok || j.change?.ok === false };
  };
}

if (import.meta.main) {
  const forward = httpForward(process.env.JARVIS_URL ?? "http://127.0.0.1:7281", process.env.JARVIS_CHAT_SESSION ?? "");
  const td = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += td.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      void handleMcp(JSON.parse(line), forward).then((r) => r && process.stdout.write(JSON.stringify(r) + "\n"));
    }
  }
}
