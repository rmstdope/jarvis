import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWeb } from "../scripts/build-web.ts";
import { metaLine, parseRoute, itemHref, fmtDate } from "../web/src/ui.ts";
import { ndjsonDecoder } from "../web/src/discuss.ts";

describe("web", () => {
  test("bundle builds with Bun and contains the 19 components", async () => {
    const out = await buildWeb();
    expect(existsSync(join(out, "index.html"))).toBe(true);
    const js = readFileSync(join(out, "app.js"), "utf8");
    for (const c of ["StepFlow", "BlockDiagram", "SequenceDiagram", "Callout", "ItemCard"]) expect(js).toContain(`"${c}"`);
    expect(js).not.toContain("bun:sqlite");
    expect(readFileSync(join(out, "app.css"), "utf8")).toContain("--accent:#2563eb");
  }, 30000);
  test("helpers", () => {
    expect(parseRoute("")).toEqual({ name: "browse", id: undefined });
    expect(parseRoute("#/item/01A")).toEqual({ name: "item", id: "01A" });
    expect(parseRoute("#/briefing/01B#slug")).toEqual({ name: "briefing", id: "01B#slug" });
    expect(itemHref({ id: "x", source: "briefing" })).toBe("#/briefing/x");
    expect(itemHref({ id: "x", source: "presentation" })).toBe("#/presentation/x");
    expect(itemHref({ id: "x", source: "web" })).toBe("#/item/x");
    expect(fmtDate("2026-01-02T03:04:05Z")).toBe("2026-01-02");
    expect(metaLine({ source: "web", created_at: "2026-01-01T00:00:00Z", author: "mia", updated_at: "2026-01-02T00:00:00Z", updated_by: "kim", metadata: { source_author: "Jane" } })).toBe("web · added 2026-01-01 by mia · updated 2026-01-02 by kim · source by Jane");
  });
  test("ndjson decoder splits across chunk boundaries", () => {
    const events: unknown[] = [];
    const d = ndjsonDecoder((e) => events.push(e));
    d('{"type":"message","text":"he');
    d('llo"}\n{"type":"usage","used":1,"size":2}\n{"type":"do');
    d('ne"}', true);
    expect(events).toEqual([{ type: "message", text: "hello" }, { type: "usage", used: 1, size: 2 }, { type: "done" }]);
  });
});
