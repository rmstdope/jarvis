import { describe, expect, test } from "bun:test";
import { ActionFilter, resolveRefs } from "../src/chat/action-blocks.ts";

const block = (o: unknown) => "```jarvis-action\n" + JSON.stringify(o) + "\n```\n";
/** Feed chunks, collect the visible text and the actions. */
function run(chunks: string[]): { text: string; actions: { tool: string; args: Record<string, unknown>; as?: string }[] } {
  const f = new ActionFilter();
  let text = "";
  const actions: { tool: string; args: Record<string, unknown>; as?: string }[] = [];
  for (const c of [...chunks]) { const r = f.push(c); text += r.text; actions.push(...r.actions); }
  const e = f.end();
  return { text: text + e.text, actions: [...actions, ...e.actions] };
}

describe("ActionFilter (jv-oya.4)", () => {
  test("a block is parsed, hidden, and the text around it kept", () => {
    const r = run(["Sure.\n" + block({ tool: "jarvis_create_task", args: { title: "A" }, as: "t1" }) + "Done."]);
    expect(r.text).toBe("Sure.\nDone.");
    expect(r.actions).toEqual([{ tool: "jarvis_create_task", args: { title: "A" }, as: "t1" }]);
  });
  test("parts keep the text and the actions in the order they were written (jv-de8)", () => {
    const f = new ActionFilter();
    const r = f.push("Before.\n" + block({ tool: "jarvis_link", args: {} }) + "After.\n" + block({ tool: "jarvis_create_task", args: {} }) + "End");
    expect(r.parts).toEqual([{ text: "Before.\n" }, { action: { tool: "jarvis_link", args: {} } }, { text: "After.\n" }, { action: { tool: "jarvis_create_task", args: {} } }, { text: "End" }]);
  });
  test("a block split across chunks is held until its closing fence", () => {
    const full = "Hi\n" + block({ tool: "jarvis_link", args: { src: "a", dst: "b" } }) + "Bye";
    for (let n = 1; n < full.length; n++) {
      const r = run([full.slice(0, n), full.slice(n)]);
      expect(r.text).toBe("Hi\nBye");
      expect(r.actions).toHaveLength(1);
    }
    const f = new ActionFilter();
    expect(f.push("```jarvis-act").text).toBe("");
  });
  test("a fence split inside its backticks, or indented, is still a fence (token-sized chunks)", () => {
    const full = "Hi\n  " + block({ tool: "jarvis_link", args: {} }).slice(0, -1) + "\nBye";
    const r = run(full.split(/(?<=[`\n])|(?=[`])/));
    expect(r.text).toBe("Hi\nBye");
    expect(r.actions).toHaveLength(1);
  });
  test("Info lines are dropped, even split across chunks", () => {
    const r = run(["Info: Disabled tools: bash\nInfo: Unknown tool", " name\nHello"]);
    expect(r.text).toBe("Hello");
    expect(run(["Information is key"]).text).toBe("Information is key");
    expect(run(["Inf", "o: x\nok"]).text).toBe("ok");
  });
  test("unterminated, invalid and unknown blocks are dropped; an ordinary code fence is untouched", () => {
    expect(run(["a\n```jarvis-action\n{\"tool\":\"jarvis_link\""]).actions).toEqual([]);
    expect(run(["```jarvis-action\nnot json\n```\nz"])).toEqual({ text: "z", actions: [] });
    expect(run([block({ tool: "rm_rf", args: {} }) + "z"])).toEqual({ text: "z", actions: [] });
    const code = "```ts\nconst a = 1;\n```\n";
    expect(run([code]).text).toBe(code);
  });
  test("a json hint on the fence is accepted and args default to {}", () => {
    const r = run(["```json jarvis-action\n{\"tool\":\"jarvis_capture_note\"}\n```\n"]);
    expect(r.actions).toEqual([{ tool: "jarvis_capture_note", args: {} }]);
  });
});

describe("resolveRefs", () => {
  test("replaces $name strings, also inside arrays, and leaves unknown ones", () => {
    expect(resolveRefs({ initiative: "$i1", link: ["$t1", "x", "$nope"], n: 3 }, { i1: "ID1", t1: "ID2" })).toEqual({ initiative: "ID1", link: ["ID2", "x", "$nope"], n: 3 });
  });
});
