import { readDocFile } from "./docs.ts";
import type { Doc, InitiativeBlock } from "./frontmatter.ts";

/**
 * An initiative reference that failed. `message` is the CLI's wording, ending in the jarvis command
 * that helps; {@link plain} words it for a surface where no command can be run, such as the web chat (jv-ltq).
 */
export class InitiativeRefError extends Error {
  override readonly name = "InitiativeRefError";
  constructor(message: string, private readonly plainWording: (named?: string) => string) {
    super(message);
  }
  /**
   * The failure without a jarvis command. `named` is the reference as the user gave it, for a
   * sentence that does not already name the initiative; without it the wording says "that name".
   */
  plain(named?: string): string {
    return this.plainWording(named);
  }
}

/** Reads an initiative doc, or throws the agreed error for an unknown id or a task id. */
export function requireInitiative(dataDir: string, id: string): { doc: Doc; block: InitiativeBlock } {
  const doc = readDocFile(dataDir, id);
  if (doc?.frontmatter.source === "task") throw new InitiativeRefError(`${id} is a task, not an initiative — jarvis task show ${id}`, (named) => `${named ?? "that"} is a task, not an initiative`);
  if (!doc || doc.frontmatter.source !== "initiative" || !doc.frontmatter.initiative) throw new InitiativeRefError(`no initiative ${id} — see them all: jarvis initiative list`, (named) => (named ? `no initiative called ${named}` : "no initiative by that name"));
  return { doc, block: doc.frontmatter.initiative };
}

/** Like {@link requireInitiative}, and refuses a closed initiative with the reopen line. */
export function requireOpenInitiative(dataDir: string, id: string): { doc: Doc; block: InitiativeBlock } {
  const r = requireInitiative(dataDir, id);
  if (r.block.status === "closed") throw new InitiativeRefError(`${r.doc.frontmatter.title} is closed. Reopen it first:\n  jarvis initiative reopen ${id}`, () => `${r.doc.frontmatter.title} is closed; reopen it first`);
  return r;
}

/** Title of the initiative a task belongs to, or null when the file is gone. */
export function initiativeTitle(dataDir: string, id: string): string | null {
  return readDocFile(dataDir, id)?.frontmatter.title ?? null;
}
