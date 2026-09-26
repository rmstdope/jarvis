/** Bundle the browser extension (MV3) into extension/dist. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
export async function buildExtension(root = join(import.meta.dir, "..")): Promise<string> {
  const out = join(root, "extension", "dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const src = join(root, "extension", "src");
  const r = await Bun.build({ entrypoints: ["background", "content", "popup", "options"].map((n) => join(src, `${n}.ts`)), outdir: out, target: "browser", format: "esm", naming: "[name].[ext]", minify: false });
  if (!r.success) throw new Error(r.logs.map((l) => l.message).join("\n"));
  cpSync(join(root, "extension", "static"), out, { recursive: true });
  return out;
}
if (import.meta.main) console.log(`built extension → ${await buildExtension()}`);
