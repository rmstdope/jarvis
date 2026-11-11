import YAML from "yaml";
import type { Source, EntityKind } from "./constants.ts";

export interface Mention {
  name: string;
  kind: EntityKind;
  entity?: string;
}
export interface TaskBlock {
  status: "open" | "done";
  owner: string;
  due?: string;
  completed_at?: string;
  completed_by?: string;
  /** Id of the initiative this task belongs to (at most one). */
  initiative?: string;
}
/** The `initiative:` block of a source "initiative" doc; the goal is the body, progress is never stored. */
export interface InitiativeBlock {
  status: "open" | "closed";
  owner: string;
  closed_at?: string;
  closed_by?: string;
}
export interface DocFrontmatter {
  id: string;
  source: Source;
  source_url?: string;
  title: string;
  author: string;
  created_at: string;
  updated_at?: string;
  updated_by?: string;
  starred?: boolean;
  metadata?: Record<string, unknown>;
  task?: TaskBlock;
  initiative?: InitiativeBlock;
  summary?: string;
  tags?: string[];
  mentions?: Mention[];
  proc_version?: number;
  [extra: string]: unknown;
}
export interface Doc {
  frontmatter: DocFrontmatter;
  body: string;
}

/** Fixed key order for serialization. */
const KEY_ORDER: (keyof DocFrontmatter)[] = [
  "id", "source", "source_url", "title", "author", "created_at", "updated_at", "updated_by",
  "starred", "metadata", "task", "initiative", "summary", "tags", "mentions", "proc_version",
];
const REQUIRED: (keyof DocFrontmatter)[] = ["id", "source", "title", "author", "created_at"];

export class FrontmatterError extends Error {}

/** Parse a doc file. Frontmatter ends at the first `---` line after the opening one. */
export function parseDoc(text: string): Doc {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new FrontmatterError("missing frontmatter opening ---");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new FrontmatterError("missing frontmatter closing ---");
  const yamlText = lines.slice(1, end).join("\n");
  let fm: unknown;
  try {
    fm = YAML.parse(yamlText) ?? {};
  } catch (e) {
    throw new FrontmatterError(`invalid YAML frontmatter: ${(e as Error).message}`);
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) throw new FrontmatterError("frontmatter is not a mapping");
  const obj = fm as Record<string, unknown>;
  for (const k of REQUIRED) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") throw new FrontmatterError(`frontmatter missing required key: ${k}`);
  }
  // YAML may parse dates as Date objects when unquoted; normalize to ISO strings.
  for (const k of ["created_at", "updated_at"] as const) {
    if (obj[k] instanceof Date) obj[k] = (obj[k] as Date).toISOString();
    else if (obj[k] !== undefined) obj[k] = String(obj[k]);
  }
  if (obj.task && typeof obj.task === "object") {
    const t = obj.task as Record<string, unknown>;
    for (const k of ["due", "completed_at"]) if (t[k] instanceof Date) t[k] = k === "due" ? (t[k] as Date).toISOString().slice(0, 10) : (t[k] as Date).toISOString();
  }
  if (obj.initiative && typeof obj.initiative === "object") {
    const i = obj.initiative as Record<string, unknown>;
    if (i.closed_at instanceof Date) i.closed_at = (i.closed_at as Date).toISOString();
  }
  obj.id = String(obj.id);
  obj.title = String(obj.title);
  obj.author = String(obj.author);
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter: obj as unknown as DocFrontmatter, body };
}

/** Serialize with keys in fixed order, only defined ones. */
export function serializeDoc(doc: Doc): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = doc.frontmatter[k];
    if (v !== undefined && v !== null) ordered[k] = v;
  }
  // Extra keys (e.g. presentation `provenance`) follow the fixed order and are preserved.
  for (const [k, v] of Object.entries(doc.frontmatter as unknown as Record<string, unknown>)) {
    if (!(k in ordered) && !KEY_ORDER.includes(k as keyof DocFrontmatter) && v !== undefined && v !== null) ordered[k] = v;
  }
  const yamlText = YAML.stringify(ordered, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }).trimEnd();
  const body = doc.body ?? "";
  return `---\n${yamlText}\n---\n${body.endsWith("\n") || body === "" ? body : body + "\n"}`;
}
