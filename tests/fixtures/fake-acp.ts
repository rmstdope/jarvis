/** A fake ACP agent over stdio for tests: echoes prompts as streamed chunks, asks for a permission once. */
const enc = new TextEncoder();
const out = (o: unknown) => process.stdout.write(enc.encode(JSON.stringify(o) + "\n"));
let sessions = 0;
const mcpBySession = new Map<string, { command: string; args: string[]; env: { name: string; value: string }[] }>();
/** Call one tool through the real MCP server the client handed us, the way an agent would. */
async function callTool(sid: string, tool: string, args: unknown): Promise<string> {
  const m = mcpBySession.get(sid)!;
  const p = Bun.spawn([m.command, ...m.args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...Object.fromEntries(m.env.map((e) => [e.name, e.value])) } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  p.stdin.flush();
  const reader = p.stdout.getReader();
  let acc = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const line = acc.split("\n").find((l) => l.includes('"id":2'));
    if (line) { p.kill(); return JSON.parse(line).result.content[0].text; }
  }
  return "no answer";
}
let pendingPermission: number | null = null;
const cancelled = new Set<string>();
const td = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += td.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    void handle(msg);
  }
}
async function handle(msg: any): Promise<void> {
  {
    if (msg.id !== undefined && msg.method === undefined) {
      // response to our permission request
      if (msg.id === pendingPermission) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call_update", title: `permission ${msg.result?.outcome?.outcome}` } } });
      return;
    }
    switch (msg.method) {
      case "initialize":
        out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        break;
      case "session/new":
        { const sid = `s${++sessions}`; if (msg.params.mcpServers?.[0]) mcpBySession.set(sid, msg.params.mcpServers[0]); out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } }); }
        break;
      case "session/cancel":
        cancelled.add(msg.params.sessionId);
        break;
      case "session/prompt": {
        const sid = msg.params.sessionId as string;
        const text = msg.params.prompt[0].text as string;
        if (text.includes("SLOW")) {
          await new Promise((r) => setTimeout(r, 300));
          out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: cancelled.has(sid) ? "cancelled" : "end_turn" } });
          break;
        }
        const act = [...text.matchAll(/ACT (jarvis_\w+) (\{.*?\})(?= ACT |\s*$|\n)/g)];
        if (act.length) {
          const said: string[] = [];
          for (const a of act) said.push(await callTool(sid, a[1], JSON.parse(a[2])));
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said.join(" | ") } } } });
          out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          break;
        }
        if (text.includes("PERMISSION")) {
          pendingPermission = 999;
          out({ jsonrpc: "2.0", id: 999, method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "write file" }, options: [{ optionId: "allow", kind: "allow_once" }] } });
          await new Promise((r) => setTimeout(r, 50));
        }
        const reply = text.includes("[") ? `Echo with context: ${text.split("User: ").pop()}` : `Echo: ${text.split("User: ").pop()}`;
        for (const part of [reply.slice(0, 5), reply.slice(5)]) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 1200, size: 128000 } } });
        out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      default:
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
    }
  }
}
export {};
