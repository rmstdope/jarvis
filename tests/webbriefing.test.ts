import { afterEach, describe, expect, test } from "bun:test";
import type { WebEnv } from "./webEnv.ts";
import { boot, button, go, q, qa, text, type } from "./webBoot.ts";

let env: WebEnv;
afterEach(() => env.restore());
const B = (over: Record<string, unknown> = {}) => ({ id: "B1", title: "Q3 plan", subtitle: "What we do", kind: "briefing", author: "mia", status: "draft", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z", frontmatter: {}, tree: [], toc: [{ level: 2, text: "Goals", slug: "goals" }, { level: 2, text: "Risks", slug: "risks" }], ...over });
const CM = { id: "c1", status: "open", author: "kim", comment: "Looks good", createdAt: "2026-01-06T00:00:00Z" };
function setup(opts: { b?: Record<string, unknown>; comments?: unknown[]; post?: () => { status?: number; json: unknown } } = {}) {
  return (e: WebEnv) => {
    e.routes.set("GET /api/briefing/B1", () => ({ json: B(opts.b) }));
    e.routes.set("GET /api/briefing/B1/comments", () => ({ json: opts.comments ?? [CM] }));
    if (opts.post) e.routes.set("POST /api/briefing/B1/comments", opts.post);
  };
}
const col = (c: string) => q(`.jv-col-${c}`);
const strip = (c: string) => q(`.jv-strip[data-col=${c}]`);
const foldBtn = (c: string) => q(`.jv-cfold[data-col=${c}]`);

describe("a briefing with no status field", () => {
  test("shows a draft pill on its card and on its page", async () => {
    env = await boot("#/briefings", { setup: (e) => { setup({ b: { status: undefined } })(e); e.routes.set("GET /api/briefings", () => ({ json: [{ id: "B3", title: "Fresh", kind: "briefing", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }] })); } });
    expect(q(".jv-card .jv-status")!.textContent).toBe("draft");
    await go(env, "#/briefing/B1");
    expect(q(".jv-titlerow .jv-status")!.textContent).toBe("draft");
  });
});

describe("Briefings list", () => {
  const list = [
    { id: "B1", title: "Q3 plan", subtitle: "What we do", kind: "briefing", author: "mia", status: "draft", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z", tags: ["plan"] },
    { id: "B2", title: "Alpha", kind: "briefing", status: "approved", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-05T00:00:00Z" },
  ];
  test("cards with status pills, Filter… with the cursor in it, sort words, and the no-match message", async () => {
    env = await boot("#/briefings", { setup: (e) => e.routes.set("GET /api/briefings", () => ({ json: list })) });
    expect(document.activeElement).toBe(q(".jv-filterbar input"));
    expect(q(".jv-filterbar input").getAttribute("placeholder")).toBe("Filter…");
    const sort = q(".jv-filterbar select") as HTMLSelectElement;
    expect([...sort.options].map((o) => o.textContent)).toEqual(["Sort: Last updated", "Sort: Newest", "Sort: Title"]);
    expect(qa(".jv-card .jv-ct").map((a) => a.textContent)).toEqual(["Alpha", "Q3 plan"]);
    expect(qa(".jv-card")[1].querySelector(".jv-m")!.textContent).toBe("briefing · mia · updated 2026-01-05 draft");
    expect(qa(".jv-card")[1].querySelector(".jv-s")!.textContent).toBe("What we do");
    expect(qa(".jv-card")[0].querySelector(".jv-status")!.textContent).toBe("approved");
    type(q(".jv-filterbar input"), "zzz");
    expect(text(".jv-empty")).toContain("No briefings match “zzz”.");
    expect(JSON.parse(localStorage.getItem("jv.briefList")!).filter).toBe("zzz");
    await go(env, "#/browse");
    await go(env, "#/briefings");
    expect((q(".jv-filterbar input") as HTMLInputElement).value).toBe("zzz");
    expect(text(".jv-empty")).toContain("No briefings match “zzz”.");
  });
  test("none yet names the command", async () => {
    env = await boot("#/briefings");
    expect(text(".jv-empty")).toContain("No briefings yet.");
    expect(text(".jv-empty code")).toBe("jarvis briefing create --title …");
  });
});

describe("a briefing", () => {
  test("trail, title row, three columns with counts and states", async () => {
    env = await boot("#/briefing/B1", { setup: setup() });
    expect(q(".jv-trail")).toBeNull(); // the tab is the whole page
    expect(text(".jv-titlerow .jv-title")).toBe("Q3 plan");
    expect(text(".jv-titlerow .jv-status")).toBe("draft");
    expect(button("Ask about this")).toBeTruthy();
    expect(qa(".jv-toc a").map((a) => a.textContent)).toEqual(["Goals", "Risks"]);
    expect(qa(".jv-toc a")[0].classList.contains("on")).toBe(true);
    qa(".jv-toc a")[1].click();
    expect(qa(".jv-toc a")[1].classList.contains("on")).toBe(true);
    expect(text(".jv-col-comments .jv-sh")).toBe("Comments · 1");
    expect(text(".jv-cmt")).toContain("kim · 2026-01-06");
    expect(text(".jv-cmt .jv-status")).toBe("open");
    expect(q(".jv-col-comments textarea").getAttribute("placeholder")).toBe("Add a comment…");
  });
  test("no comments says so; no headings leaves no Contents column and no strip", async () => {
    env = await boot("#/briefing/B1", { setup: setup({ comments: [], b: { toc: null } }) });
    expect(text(".jv-col-comments")).toContain("No comments yet — be the first.");
    expect(q(".jv-col-contents")).toBeNull();
    expect(q(".jv-strip[data-col=contents]")).toBeNull();
  });
  test("each side column hides on its own, leaves a strip, and the choice is remembered for all briefings", async () => {
    env = await boot("#/briefing/B1", { setup: setup() });
    expect(foldBtn("contents").title).toBe("Hide contents");
    expect(foldBtn("comments").title).toBe("Hide comments");
    expect(strip("contents").hidden).toBe(true);
    foldBtn("contents").click();
    expect(col("contents").hidden).toBe(true);
    expect(col("comments").hidden).toBe(false);
    expect(strip("contents").hidden).toBe(false);
    expect(strip("contents").title).toBe("Show contents");
    expect(strip("contents").textContent).toContain("Contents");
    expect(document.activeElement).toBe(strip("contents"));
    foldBtn("comments").click();
    expect(strip("comments").textContent).toContain("💬 1");
    expect(JSON.parse(localStorage.getItem("jv.briefCols")!)).toEqual({ contents: true, comments: true });
    await go(env, "#/browse");
    await go(env, "#/briefing/B1");
    expect(col("contents").hidden).toBe(true);
    expect(col("comments").hidden).toBe(true);
    strip("contents").click();
    expect(col("contents").hidden).toBe(false);
    expect(document.activeElement).toBe(foldBtn("contents"));
  });
  test("on a tablet-width window the side columns start as strips and open over the text; Esc, ✕ or a click on the text closes", async () => {
    env = await boot("#/briefing/B1", { width: 900, setup: setup() });
    expect(col("contents").hidden).toBe(true);
    expect(col("comments").hidden).toBe(true);
    strip("comments").click();
    expect(col("comments").hidden).toBe(false);
    expect(col("comments").classList.contains("jv-over")).toBe(true);
    expect(foldBtn("comments").textContent).toBe("✕");
    expect(foldBtn("comments").title).toBe("Hide comments");
    q(".jv-bwrap").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(col("comments").hidden).toBe(true);
    expect(document.activeElement).toBe(strip("comments"));
    strip("contents").click();
    q(".jv-brief").click();
    expect(col("contents").hidden).toBe(true);
    strip("contents").click();
    foldBtn("contents").click();
    expect(col("contents").hidden).toBe(true);
    env.setWidth(1280);
    expect(col("contents").hidden).toBe(false);
  });
  test("at phone width two buttons beside the title open the same slide-over", async () => {
    env = await boot("#/briefing/B1", { width: 500, setup: setup() });
    const [c, m] = qa(".jv-pbtn");
    expect(c.textContent).toBe("☰ Contents");
    expect(m.textContent).toBe("💬 Comments · 1");
    expect(strip("contents").hidden).toBe(true);
    m.click();
    expect(col("comments").hidden).toBe(false);
    foldBtn("comments").click();
    expect(col("comments").hidden).toBe(true);
    expect(document.activeElement).toBe(m);
  });
  test("posting a comment adds it with a message; a failure shows the reason and keeps the text", async () => {
    let fail = true;
    env = await boot("#/briefing/B1", { setup: setup({ post: () => (fail ? { status: 500, json: { error: "locked" } } : { json: CM }) }) });
    const ta = q(".jv-col-comments textarea") as HTMLTextAreaElement;
    ta.value = "Hello";
    q(".jv-col-comments form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    expect(text(".jv-col-comments .jv-cerr")).toBe("locked");
    expect((q(".jv-col-comments textarea") as HTMLTextAreaElement).value).toBe("Hello");
    fail = false;
    q(".jv-col-comments form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await env.tick(60);
    expect(text(".toast")).toBe("Comment added");
  });
});
