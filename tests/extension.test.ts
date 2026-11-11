import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RULES, hostBlockPattern, isBlocked } from "../extension/src/blocklist.ts";
import { buildExtension } from "../scripts/build-extension.ts";

describe("extension", () => {
  test("blocklist globs, allow overrides, scheme-insensitive", () => {
    expect(isBlocked("https://www.google.com/search?q=x")).toBe(true);
    expect(isBlocked("https://mail.google.com/mail/u/0")).toBe(true);
    expect(isBlocked("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isBlocked("https://www.youtube.com/shorts/abc")).toBe(true);
    expect(isBlocked("http://localhost:7281/")).toBe(true);
    expect(isBlocked("https://open.spotify.com/track/1")).toBe(true);
    expect(isBlocked("chrome://extensions")).toBe(true);
    expect(isBlocked("https://docs.example.com/page")).toBe(false);
    expect(isBlocked("https://EXAMPLE.com/x", [{ pattern: "*example.com/*", action: "block" }])).toBe(true);
    expect(isBlocked("https://example.com/keep", [{ pattern: "*example.com/*", action: "block" }, { pattern: "*example.com/keep", action: "allow" }])).toBe(false);
    expect(hostBlockPattern("https://www.example-news.test/story/1")).toBe("*example-news.test/*");
    expect(DEFAULT_RULES.every((r) => r.action === "block")).toBe(true);
  });
  test("bundle builds with a single blocklist module and manifest", async () => {
    const out = await buildExtension();
    for (const f of ["background.js", "content.js", "popup.js", "options.js", "popup.html", "options.html", "manifest.json"]) expect(existsSync(join(out, f))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toContain("http://localhost:7281/*");
    expect(manifest.name).toBe("J.A.R.V.I.S. capture");
    expect(readFileSync(join(out, "content.js"), "utf8")).toContain("Readability");
    expect(readFileSync(join(out, "background.js"), "utf8")).toContain("isBlocked");
  }, 30000);
  test("agent instructions ship with the repo", () => {
    const doc = readFileSync(join(import.meta.dir, "..", "docs", "AGENT-INSTRUCTIONS.md"), "utf8");
    expect(doc).toContain("jarvis tasks");
  });
});
