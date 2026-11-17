import { describe, expect, test } from "bun:test";
import { looksLikeLog } from "../web/src/literal.ts";

const trace = `Checkout fails after the 14:02 deploy
java.lang.IllegalStateException: cart is empty
    at com.shop.Cart.checkout(Cart.java:88)
    at com.shop.Api.post(Api.java:41)
        ... 12 more
- retry 1 failed
# not a heading, just the log prefix`;

describe("looksLikeLog (jv-nln)", () => {
  test("a stack trace is a log", () => expect(looksLikeLog(trace)).toBe(true));
  test("timestamped and levelled lines are a log", () => {
    expect(looksLikeLog("2026-11-17T14:02:11Z ERROR a\n2026-11-17T14:02:12Z WARN b\n2026-11-17T14:02:13Z INFO c")).toBe(true);
    expect(looksLikeLog("ERROR disk full\nWARN retrying\nINFO done")).toBe(true);
  });
  test("a Markdown note is not", () => {
    expect(looksLikeLog("## Release checklist\n- Tag the build\n- **Announce** in the [channel](https://x.test)\n\n> done")).toBe(false);
  });
  test("prose, an empty body and a lone indented line are not", () => {
    expect(looksLikeLog("We met on Friday and agreed to ship.\n\nMore thoughts follow.")).toBe(false);
    expect(looksLikeLog("")).toBe(false);
    expect(looksLikeLog("Use this:\n    npm install\nthen run it.")).toBe(false);
  });
});
