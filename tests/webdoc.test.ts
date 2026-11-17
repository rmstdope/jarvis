import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { renderDoc, splitSlides, type DocCtx } from "../web/src/docview.ts";

let env: WebEnv;
beforeEach(() => { env = installWebEnv(1280); document.body.innerHTML = ""; });
afterEach(() => env.restore());

const item = (over: Record<string, unknown> = {}) => ({ id: "n1", source: "note", title: "Pricing", author: "mia", created_at: "2026-01-01", updated_at: null, updated_by: null, source_url: null, starred: false, summary: null, tags: [], metadata: null, body: "Plan **B**.", proc_version: 1, file_path: null, ...over });
const serve = (it: unknown, edges: unknown[] = []) => env.routes.set("GET /api/item/n1", () => ({ json: { item: it, edges } }));
function ctx(over: Partial<DocCtx> = {}): DocCtx & { log: string[] } {
  const log: string[] = [];
  return { log, chat: { askAbout: (sc: { type: string }, t: string) => log.push(`ask ${sc.type} ${t}`) } as never, scroller: document.body, askAbout: (s, t) => log.push(`ask ${s.type} ${t}`), close: () => log.push("close"), loaded: (t, k) => log.push(`loaded ${k} ${t}`), ...over };
}
const open = async (ref: Parameters<typeof renderDoc>[0], c = ctx()) => { const v = renderDoc(ref, c); document.body.append(v.el); expect(v.el.textContent).toContain("Opening…"); await v.ready; return v.el; };
const txt = (el: Element, sel: string) => [...el.querySelectorAll(sel)].map((e) => e.textContent);

describe("note-like tabs", () => {
  test("a note: badge, title, Ask about this, rendered text and Links (n)", async () => {
    serve(item(), [{ otherId: "o", otherTitle: "Other", relation: "related", createdBy: "mia", weight: null, direction: "out" }]);
    const c = ctx();
    const el = await open({ type: "item", id: "n1" }, c);
    expect(txt(el, ".jv-dkind")).toEqual(["Note"]);
    expect(el.querySelector("h1")!.textContent).toBe("Pricing");
    expect(el.querySelector(".jv-text strong")!.textContent).toBe("B");
    expect(el.textContent).toContain("Links (1)");
    expect(el.querySelector(".edges a")!.getAttribute("href")).toBe("#/item/o");
    expect(c.log).toContain("loaded Note Pricing");
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Ask about this")!.click();
    expect(c.log).toContain("ask item Pricing");
  });
  test("a pasted body keeps its single line breaks (jv-g0z)", async () => {
    serve(item({ source: "web", body: "eggs\nmilk\nbread\n\nERROR 12:01 disk full\nWARN 12:02 retrying" }));
    const el = await open({ type: "item", id: "n1" });
    const ps = [...el.querySelectorAll(".jv-text p")];
    expect(ps.map((p) => p.querySelectorAll("br").length)).toEqual([2, 1]);
    expect(ps[0]!.innerHTML).toBe("eggs<br>milk<br>bread");
  });
  test("machine-wrapped bodies (YouTube captions, PDF text) still flow as paragraphs (jv-g0z)", async () => {
    for (const source of ["youtube", "pdf"]) {
      serve(item({ source, body: "so we decided\nto ship it on\nfriday" }));
      const el = await open({ type: "item", id: "n1" });
      expect(el.querySelector(".jv-text p")!.innerHTML).toBe("so we decided to ship it on friday");
    }
  });
  test("a pasted trace opens As written, exactly as stored, with the switch before Ask about this (jv-nln)", async () => {
    const body = "Checkout fails\njava.lang.IllegalStateException: cart is empty\n    at com.shop.Cart.checkout(Cart.java:88)\n    at com.shop.Api.post(Api.java:41)\n        ... 12 more\n- retry 1 failed\n# not a heading";
    serve(item({ source: "web", body }));
    const el = await open({ type: "item", id: "n1" });
    expect(el.querySelector("pre.jv-literal")!.textContent).toBe(body);
    expect(el.querySelector(".jv-text a, .jv-literal a, .jv-literal li, .jv-literal h1")).toBeNull();
    const btns = [...el.querySelectorAll(".jv-dhead button")].map((b) => b.textContent);
    expect(btns).toEqual(["Formatted", "As written", "Ask about this"]);
    const pressed = [...el.querySelectorAll(".jv-seg button")].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["false", "true"]);
  });
  test("a Markdown note opens Formatted; pressing As written shows its marks and keeps focus (jv-nln)", async () => {
    serve(item({ body: "## Plan\n- one\n- **two**" }));
    const el = await open({ type: "item", id: "n1" });
    expect(el.querySelector(".jv-text h2")).not.toBeNull();
    const lit = [...el.querySelectorAll(".jv-seg button")][1] as HTMLElement;
    lit.click();
    expect(el.querySelector("pre.jv-literal")!.textContent).toBe("## Plan\n- one\n- **two**");
    expect(el.querySelector(".jv-text")).toBeNull();
    expect(lit.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(lit);
  });
  test("the pressed side is remembered per item and wins over the guess (jv-nln)", async () => {
    serve(item({ body: "## Plan\n- one" }));
    let el = await open({ type: "item", id: "n1" });
    ([...el.querySelectorAll(".jv-seg button")][1] as HTMLElement).click();
    expect(localStorage.getItem("jv.text.n1")).toBe("literal");
    document.body.innerHTML = "";
    el = await open({ type: "item", id: "n1" });
    expect(el.querySelector("pre.jv-literal")).not.toBeNull();
    ([...el.querySelectorAll(".jv-seg button")][0] as HTMLElement).click();
    document.body.innerHTML = "";
    serve(item({ body: "a\n    at x.Y(F.java:1)\n    at x.Z(F.java:2)\n    at x.W(F.java:3)" }));
    el = await open({ type: "item", id: "n1" });
    expect(el.querySelector("pre.jv-literal")).toBeNull();
  });
  test("YouTube and PDF items get the switch, and blocked storage does not break it (jv-nln)", async () => {
    for (const source of ["youtube", "pdf"]) {
      serve(item({ source, body: "so we decided\nto ship" }));
      const el = await open({ type: "item", id: "n1" });
      expect(el.querySelectorAll(".jv-seg button").length).toBe(2);
      document.body.innerHTML = "";
    }
    serve(item());
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    const el = await open({ type: "item", id: "n1" });
    ([...el.querySelectorAll(".jv-seg button")][1] as HTMLElement).click();
    expect(el.querySelector("pre.jv-literal")).not.toBeNull();
  });
  test("an empty item and a meeting transcript get no switch and no Copy (jv-nln)", async () => {
    serve(item({ body: "" }));
    let el = await open({ type: "item", id: "n1" });
    expect(el.querySelector(".jv-seg, .jv-copy")).toBeNull();
    document.body.innerHTML = "";
    serve(item({ source: "meeting", body: "Ann: hi\n\nBo: hello" }));
    el = await open({ type: "item", id: "n1" });
    expect(el.querySelector(".jv-seg, .jv-copy")).toBeNull();
  });
  test("Copy copies the body exactly, reads Copied then Copy; a refusal reads Couldn't copy (jv-nln)", async () => {
    const body = "a\n    at x.Y(F.java:1)\n    at x.Z(F.java:2)";
    serve(item({ body }));
    const copied: string[] = [];
    let fail = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { if (fail) throw new Error("no"); copied.push(t); } } });
    const el = await open({ type: "item", id: "n1" }, ctx({ copiedMs: 20 } as never));
    const btn = el.querySelector(".jv-copy") as HTMLElement;
    expect(btn.textContent).toBe("Copy");
    btn.click(); await new Promise((r) => setTimeout(r, 5));
    expect(copied).toEqual([body]); expect(btn.textContent).toBe("Copied");
    await new Promise((r) => setTimeout(r, 40)); expect(btn.textContent).toBe("Copy");
    fail = true; btn.click(); await new Promise((r) => setTimeout(r, 5));
    expect(btn.textContent).toBe("Couldn't copy");
    await new Promise((r) => setTimeout(r, 40)); expect(btn.textContent).toBe("Copy");
  });
  test("empty body and no links", async () => {
    serve(item({ body: "" }));
    const el = await open({ type: "item", id: "n1" });
    expect(el.textContent).toContain("Nothing written here yet.");
    expect(el.textContent).toContain("Links (0)");
  });
  test("a PDF from a file shows the notice without the original link; from the web it adds it", async () => {
    serve(item({ source: "pdf", metadata: { filename: "q3.pdf" }, source_url: "file:///x/q3.pdf" }));
    let el = await open({ type: "item", id: "n1" });
    expect(txt(el, ".jv-dkind")).toEqual(["PDF"]);
    expect(el.querySelector(".jv-pdfnote")!.textContent).toBe("Text taken from q3.pdf — the original layout and images aren't kept.");
    document.body.innerHTML = "";
    serve(item({ source: "pdf", metadata: { filename: "q3.pdf" }, source_url: "https://x.test/q3.pdf" }));
    el = await open({ type: "item", id: "n1" });
    expect(el.querySelector(".jv-pdfnote")!.textContent).toBe("Text taken from q3.pdf — the original layout and images aren't kept. Open the original ↗");
  });
  test("a meeting transcript: a block per speaker turn, summary on top when there is one", async () => {
    serve(item({ source: "meeting", body: "Mia Laine: Hello.\n\nKim: Hi." }), [{ otherId: "b1", otherTitle: "Meeting summary", relation: "references", createdBy: "briefing", weight: 1, direction: "in" }]);
    env.routes.set("GET /api/briefing/b1", () => ({ json: { id: "b1", title: "Summary", tree: [{ type: "markdown", content: "We agreed." }], toc: null } }));
    const el = await open({ type: "item", id: "n1" });
    expect(txt(el, ".jv-dkind")).toEqual(["Meeting transcript"]);
    expect(txt(el, ".jv-who")).toEqual(["Mia Laine", "Kim"]);
    expect(el.querySelector(".jv-dsum")).not.toBeNull();
  });
  test("a transcript with no speakers is plain paragraphs and has no summary block", async () => {
    serve(item({ source: "meeting", body: "one thing\n\nanother thing" }));
    const el = await open({ type: "item", id: "n1" });
    expect(el.querySelectorAll(".jv-turn").length).toBe(2);
    expect(el.querySelector(".jv-who")).toBeNull();
    expect(el.querySelector(".jv-dsum")).toBeNull();
  });
});

describe("states", () => {
  test("not there any more: the words and Close tab", async () => {
    const c = ctx();
    const el = await open({ type: "item", id: "missing" }, c);
    expect(txt(el, ".jv-docstate h2, .jv-docstate p")).toEqual(["This document isn't here any more.", "It may have been removed, or renamed by a sync."]);
    expect(txt(el, ".jv-docstate button")).toEqual(["Close tab"]);
    el.querySelector<HTMLElement>(".jv-docstate button")!.click();
    expect(c.log).toContain("close");
  });
  test("couldn't open: Try again reloads this tab", async () => {
    let n = 0;
    env.routes.set("GET /api/item/n1", () => (n++ === 0 ? { status: 500, json: { error: "boom" } } : { json: { item: item(), edges: [] } }));
    const el = await open({ type: "item", id: "n1" });
    expect(txt(el, ".jv-docstate h2, .jv-docstate p")).toEqual(["Couldn't open this document.", "Something went wrong while loading it."]);
    expect(txt(el, ".jv-docstate button")).toEqual(["Try again", "Close tab"]);
    el.querySelector<HTMLElement>(".jv-docstate button")!.click();
    await env.tick();
    expect(el.querySelector("h1")!.textContent).toBe("Pricing");
  });
});

describe("briefing tab", () => {
  test("the briefing's own page inside the tab: Briefing badge, title, no trail, Ask about this", async () => {
    env.routes.set("GET /api/briefing/b1", () => ({ json: { id: "b1", title: "Decision", kind: "briefing", status: "draft", createdAt: "2026-01-01", updatedAt: "2026-01-01", frontmatter: {}, tree: [{ type: "markdown", content: "## Why\n\nBecause." }], toc: [{ level: 2, text: "Why", slug: "why" }] } }));
    env.routes.set("GET /api/briefing/b1/comments", () => ({ json: [] }));
    const c = ctx();
    const el = await open({ type: "briefing", id: "b1" }, c);
    expect(txt(el, ".jv-dkind")).toEqual(["Briefing"]);
    expect(el.querySelector(".jv-title")!.textContent).toBe("Decision");
    expect(el.querySelector(".jv-trail")).toBeNull();
    expect(c.log).toContain("loaded Briefing Decision");
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Ask about this")!.click();
    expect(c.log).toContain("ask briefing Decision");
  });
});

describe("presentation tab", () => {
  const pres = (body: string, slidecraft: unknown = { status: "not-running" }) => env.routes.set("GET /api/presentation/p1", () => ({ json: { id: "i", slug: "p1", title: "Deck", author: "mia", created_at: "2026-01-01", indexed: true, slidecraft, frontmatter: {}, body, filePath: "x" } }));
  test("splitSlides splits on --- or on ## headings", () => {
    expect(splitSlides("<Presentation>\n# A\n---\n# B\n</Presentation>")).toEqual(["# A", "# B"]);
    expect(splitSlides("<Presentation>\n\n## S1\n\nx\n\n## S2\n\ny\n\n</Presentation>")).toEqual(["## S1\n\nx", "## S2\n\ny"]);
    expect(splitSlides("<Presentation></Presentation>")).toEqual([]);
  });
  test("one slide at a time with ‹ › and i / n; Present only; no Slidecraft button", async () => {
    pres("<Presentation>\n# A\n---\n# B\n</Presentation>");
    const el = await open({ type: "presentation", id: "p1" });
    expect(txt(el, ".jv-dkind")).toEqual(["Presentation"]);
    expect(el.querySelector(".jv-count")!.textContent).toBe("1 / 2");
    expect(el.querySelector(".jv-slide h1")!.textContent).toBe("A");
    expect(txt(el, ".jv-dhead button")).toEqual(["Present", "Ask about this"]);
    (el.querySelector('[title="Next slide"]') as HTMLElement).click();
    expect(el.querySelector(".jv-count")!.textContent).toBe("2 / 2");
    expect(el.querySelector(".jv-slide h1")!.textContent).toBe("B");
    expect(el.querySelector('[title="Next slide"]')!.hasAttribute("disabled")).toBe(true);
  });
  test("Present fills the screen; Esc leaves; the Slidecraft button shows only when ready", async () => {
    pres("<Presentation>\n# A\n</Presentation>", { status: "ready", launchUrl: "http://deck/x" });
    const el = await open({ type: "presentation", id: "p1" });
    expect(txt(el, ".jv-dhead button")).toEqual(["Present", "Present in Slidecraft", "Ask about this"]);
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Present")!.click();
    expect(el.querySelector(".jv-stage")!.classList.contains("jv-presenting")).toBe(true);
    el.querySelector(".jv-stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(el.querySelector(".jv-stage")!.classList.contains("jv-presenting")).toBe(false);
  });
  test("no slides", async () => {
    pres("<Presentation></Presentation>");
    const el = await open({ type: "presentation", id: "p1" });
    expect(el.querySelector(".jv-slide")!.textContent).toBe("This presentation has no slides yet.");
  });
});
