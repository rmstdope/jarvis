import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWeb } from "../scripts/build-web.ts";
import { parseRoute, itemHref, fmtDate } from "../web/src/ui.ts";

describe("web", () => {
  test("bundle builds with Bun and contains the 19 components", async () => {
    const out = await buildWeb();
    expect(existsSync(join(out, "index.html"))).toBe(true);
    const js = readFileSync(join(out, "app.js"), "utf8");
    for (const c of ["StepFlow", "BlockDiagram", "SequenceDiagram", "Callout", "ItemCard"]) expect(js).toContain(`"${c}"`);
    expect(js).not.toContain("bun:sqlite");
    const css = readFileSync(join(out, "app.css"), "utf8");
    expect(css).toMatch(/prefers-color-scheme: dark\) \{ :root:not\(\[data-theme=light\]\) \{[^}]*--nav-on-bg:#0f2a3c[^}]*--composer-shadow/);
    for (const token of ["--bg:#faf7f2", "--accent:#b4532a", "--bg:#0a1220", "--accent:#22d3ee"]) expect(css).toContain(token);
  }, 30000);
  test("helpers", () => {
    expect(parseRoute("")).toEqual({ name: "chat", id: undefined });
    expect(parseRoute("#/browse")).toEqual({ name: "browse", id: undefined });
    expect(parseRoute("#/item/01A")).toEqual({ name: "item", id: "01A" });
    expect(parseRoute("#/briefing/01B#slug")).toEqual({ name: "briefing", id: "01B#slug" });
    expect(itemHref({ id: "x", source: "briefing" })).toBe("#/briefing/x");
    expect(itemHref({ id: "x", source: "presentation" })).toBe("#/presentation/x");
    expect(itemHref({ id: "x", source: "web" })).toBe("#/item/x");
    expect(fmtDate("2026-01-02T03:04:05Z")).toBe("2026-01-02");
  });
});
