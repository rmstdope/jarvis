/**
 * How the chat agent acts: it writes fenced `jarvis-action` blocks in its answer, each one JSON
 * `{"tool": "jarvis_…", "args": {…}, "as": "name"}`. This streaming filter hides the blocks from
 * the text the person reads and hands the parsed actions on. It also drops the `Info: …` lines the
 * Copilot CLI prints into its answer. No I/O, no knowledge of what a tool does.
 */

/** One action the agent asked for. `as` names the item it creates so later blocks can pass `"$name"`. */
export interface ParsedAction { tool: string; args: Record<string, unknown>; as?: string }

const FENCE = /^\s*```\s*(?:json\s*)?jarvis-action\s*$/;
const CLOSE = /^\s*```\s*$/;
const TOOL = /^jarvis_[a-z_]+$/;

function parse(lines: string[]): ParsedAction | null {
  try {
    const o = JSON.parse(lines.join("\n")) as { tool?: unknown; args?: unknown; as?: unknown };
    if (typeof o.tool !== "string" || !TOOL.test(o.tool)) return null;
    const args = o.args && typeof o.args === "object" && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {};
    return { tool: o.tool, args, ...(typeof o.as === "string" && o.as ? { as: o.as } : {}) };
  } catch {
    return null;
  }
}

/** Streaming filter: `push` a chunk of answer text, get the text safe to show and the actions completed so far. */
export class ActionFilter {
  private held = "";
  private block: string[] | null = null;
  private line(l: string, out: { text: string; actions: ParsedAction[] }): void {
    if (this.block) {
      if (CLOSE.test(l)) {
        const a = parse(this.block);
        if (a) out.actions.push(a);
        this.block = null;
      } else this.block.push(l);
    } else if (FENCE.test(l)) this.block = [];
    else if (!l.startsWith("Info: ")) out.text += l + "\n";
  }
  /** Feed one chunk. A partial last line is held while it could still become a fence or an `Info:` line. */
  push(chunk: string): { text: string; actions: ParsedAction[] } {
    const out = { text: "", actions: [] as ParsedAction[] };
    const parts = (this.held + chunk).split("\n");
    const tail = parts.pop()!;
    for (const l of parts) this.line(l, out);
    const hold = this.block !== null || tail.startsWith("```") || tail.startsWith("Info: ") || "Info: ".startsWith(tail) && tail !== "";
    if (hold) this.held = tail;
    else { out.text += tail; this.held = ""; }
    return out;
  }
  /** The turn is over: a held line is shown unless it was an `Info:` line; an unfinished block is dropped. */
  end(): { text: string; actions: ParsedAction[] } {
    const out = { text: "", actions: [] as ParsedAction[] };
    const t = this.held;
    this.held = "";
    if (this.block && CLOSE.test(t)) this.line(t, out);
    else if (!this.block && t && !t.startsWith("Info: ")) out.text = t;
    this.block = null;
    return out;
  }
}

/** Replace string args equal to `$name` (also inside arrays) with the id of the item an earlier block created `as` that name. */
export function resolveRefs(args: Record<string, unknown>, aliases: Record<string, string>): Record<string, unknown> {
  const one = (v: unknown): unknown => (typeof v === "string" && v.startsWith("$") && v.slice(1) in aliases ? aliases[v.slice(1)] : Array.isArray(v) ? v.map(one) : v);
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, one(v)]));
}
