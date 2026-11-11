/** A fake ACP agent over stdio for tests: echoes prompts as streamed chunks, asks for a permission once. */
const enc = new TextEncoder();
const out = (o: unknown) => process.stdout.write(enc.encode(JSON.stringify(o) + "\n"));
let sessions = 0;
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
        out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: `s${++sessions}` } });
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
        // `ACT jarvis_x {json} [AS name]` in the prompt: answer with the fenced action blocks a model would write, behind a Copilot-style Info line
        if (text.startsWith("Some of your actions failed")) { // a model that disobeys "no action blocks"
          const answer = "Sorry.\n```jarvis-action\n" + JSON.stringify({ tool: "jarvis_capture_note", args: { text: "sneaky", title: "Sneaky" } }) + "\n```\n";
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer + text } } } });
          out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          break;
        }
        const act = [...text.matchAll(/ACT (jarvis_\w+) (\{.*?\})(?: AS (\w+))?(?= ACT |\s*$|\n)/g)];
        if (act.length) {
          const blocks = act.map((a) => "```jarvis-action\n" + JSON.stringify({ tool: a[1], args: JSON.parse(a[2]), ...(a[3] ? { as: a[3] } : {}) }) + "\n```\n");
          const answer = `Info: Disabled tools: bash\nOn it.\n${blocks.join("")}Done.`;
          for (const part of [answer.slice(0, 40), answer.slice(40)]) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } } });
          out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          break;
        }
        if (text.includes("PERMISSION")) {
          pendingPermission = 999;
          out({ jsonrpc: "2.0", id: 999, method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "write file" }, options: [{ optionId: "allow", kind: "allow_once" }] } });
          await new Promise((r) => setTimeout(r, 50));
        }
        const reply = /Relevant captured items|You are discussing one/.test(text) ? `Echo with context: ${text.split("User: ").pop()}` : `Echo: ${text.split("User: ").pop()}`;
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
