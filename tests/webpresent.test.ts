import { afterEach, describe, expect, test } from "bun:test";
import type { WebEnv } from "./webEnv.ts";
import { boot, button, go, q, qa, text } from "./webBoot.ts";

let env: WebEnv;
afterEach(() => env.restore());
const P = { id: "p1", slug: "q3-kickoff", title: "Q3 kickoff", author: "mia", created_at: "2026-02-03T00:00:00Z", indexed: true, viewer: { status: "ready", launchUrl: "http://deck/x" }, frontmatter: {}, body: "# Slide one", filePath: "x" };

describe("Presentations", () => {
  test("cards with a status pill; the page; none yet; not available", async () => {
    env = await boot("#/presentations", { setup: (e) => e.routes.set("GET /api/presentations", () => ({ json: [P, { ...P, id: "p2", slug: "b", title: "B", indexed: false }] })) });
    expect(text(".jv-pt")).toBe("Presentations");
    const cards = qa(".jv-card");
    expect(cards[0].querySelector(".jv-m")!.textContent).toContain("q3-kickoff · mia · 2026-02-03");
    expect(cards[0].querySelector(".jv-status")!.textContent).toBe("in search");
    expect(cards[1].querySelector(".jv-status")!.textContent).toBe("not yet in search");
    await env.restore();
    env = await boot("#/presentations");
    expect(text(".jv-empty")).toContain("No presentations yet.");
    env.restore();
    env = await boot("#/presentations", { setup: (e) => e.routes.set("GET /api/presentations", () => ({ status: 404, json: { error: "nope" } })) });
    expect(text(".jv-empty")).toContain("Presentations aren't available in this version of J.A.R.V.I.S. yet.");
  });
  test("a presentation: trail, title, sentence, folded source, Present and In search", async () => {
    env = await boot("#/presentation/p1", { setup: (e) => e.routes.set("GET /api/presentation/p1", () => ({ json: P })) });
    expect(text(".jv-trail")).toBe("Presentations › Q3 kickoff");
    expect(text(".jv-meta")).toBe("q3-kickoff · added 2026-02-03 by mia");
    expect(text(".jv-view")).toContain("Press Present to show it full screen in the deck viewer.");
    expect(q(".jv-code").hidden).toBe(true);
    const fold = button("▸ Show source")!;
    fold.click();
    expect(q(".jv-code").hidden).toBe(false);
    expect(q(".jv-code").textContent).toContain("# Slide one");
    expect(button("▾ Hide source")).toBeTruthy();
    const present = q(".jv-panel a") as HTMLAnchorElement;
    expect(present.textContent).toBe("▶ Present");
    expect(present.getAttribute("href")).toBe("http://deck/x");
    expect(text(".jv-panel")).toContain("In search");
    expect(text(".jv-panel")).toContain("yes");
  });
  test("when the deck viewer is not ready a plain sentence replaces Present", async () => {
    env = await boot("#/presentation/p1", { setup: (e) => e.routes.set("GET /api/presentation/p1", () => ({ json: { ...P, indexed: false, viewer: { status: "not-running" } } })) });
    expect(text(".jv-panel")).toContain("The deck viewer isn't running.");
    expect(text(".jv-panel")).toContain("not yet");
    expect(q(".jv-panel a")).toBeNull();
    await go(env, "#/presentations");
  });
});
