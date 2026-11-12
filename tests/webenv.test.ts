import { test, expect } from "bun:test";
import { installWebEnv } from "./webEnv.ts";
// jv-m9l: a test that boots twice leaked the fake fetch into every later file in the process.
test("nested install then one restore leaves the real fetch", () => {
  const real = globalThis.fetch;
  installWebEnv(); const b = installWebEnv(); b.restore();
  expect(globalThis.fetch).toBe(real);
});
