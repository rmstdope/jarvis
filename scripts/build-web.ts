/** Bundle the web UI with Bun into web/dist (served by `brain serve`). */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export async function buildWeb(root = join(import.meta.dir, "..")): Promise<string> {
  const out = join(root, "web", "dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = await Bun.build({ entrypoints: [join(root, "web", "src", "main.ts")], outdir: out, naming: "app.[ext]", target: "browser", minify: false, sourcemap: "linked" });
  if (!r.success) throw new Error(r.logs.map((l) => l.message).join("\n"));
  cpSync(join(root, "web", "index.html"), join(out, "index.html"));
  cpSync(join(root, "web", "src", "styles.css"), join(out, "app.css"));
  return out;
}
if (import.meta.main) {
  const out = await buildWeb();
  console.log(`built web UI → ${out}`);
}
