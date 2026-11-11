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
});
