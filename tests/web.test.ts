import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWeb } from "../scripts/build-web.ts";
import { parseRoute, itemHref, fmtDate } from "../web/src/ui.ts";

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("web", () => {
  test("bundle builds with Bun and contains the 19 components", async () => {
    const out = await buildWeb();
    expect(existsSync(join(out, "index.html"))).toBe(true);
    const js = readFileSync(join(out, "app.js"), "utf8");
    for (const c of ["StepFlow", "BlockDiagram", "SequenceDiagram", "Callout", "ItemCard"]) expect(js).toContain(`"${c}"`);
    expect(js).not.toContain("bun:sqlite");
    const css = readFileSync(join(out, "app.css"), "utf8");
    expect(css).toMatch(/prefers-color-scheme: dark\) \{ :root:not\(\[data-theme=light\]\) \{[^}]*--nav-on-bg:#0f2a3c[^}]*--composer-shadow/);
    const tints = ["--jv-tint-accent", "--jv-tint-warn", "--jv-tint-good", "--jv-tint-bad", "--jv-tint-neutral", "--jv-tint-investigate", "--jv-code-bg", "--jv-head-bg", "--jv-row-hl"];
    const darkBlocks = [css.match(/:root\[data-theme=dark\] \{[^}]*--jv-tint-accent[^}]*\}/)?.[0], css.match(/prefers-color-scheme: dark\) \{ :root:not\(\[data-theme=light\]\) \{[^}]*--jv-tint-accent[^}]*\}/)?.[0]];
    for (const block of darkBlocks) {
      expect(block).toBeDefined();
      for (const t of tints) {
        const bg = new RegExp(`${t}:(#[0-9a-f]{6})`).exec(block!)?.[1];
        expect(bg).toBeDefined();
        expect(contrast("#d6e6f5", bg!)).toBeGreaterThanOrEqual(4.5);
      }
    }
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
