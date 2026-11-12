import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** One entry of a folder listing for the chat box's `@` completion. */
export interface PathEntry { name: string; dir: boolean }
export type DirListing = { ok: true; entries: PathEntry[] } | { ok: false };

/**
 * List the folder `dir` names: "" is the top of the content directory, `/x/` is absolute, `~/x/` is under
 * the home folder, anything else is relative to the content directory. Folders come first, then files,
 * each A-Z ignoring case; dot names are included (the client hides them). A folder that does not exist,
 * is not readable or is a file gives `{ ok: false }`.
 */
export function listDir(dataDir: string, dir: string, home: string = homedir()): DirListing {
  const base = dir === "~" || dir.startsWith("~/") ? join(home, dir.slice(1)) : isAbsolute(dir) ? dir : join(dataDir, dir);
  try {
    const entries = readdirSync(base, { withFileTypes: true }).map((e): PathEntry => {
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = statSync(join(base, e.name)).isDirectory(); } catch { /* dangling link: a file */ } }
      return { name: e.name, dir: isDir };
    });
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : 1));
    return { ok: true, entries };
  } catch {
    return { ok: false };
  }
}
