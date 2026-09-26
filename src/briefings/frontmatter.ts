import YAML from "yaml";

export type BriefingKind = "briefing" | "lesson" | "meeting-summary";
export type BriefingStatus = "draft" | "approved";
export interface BriefingFrontmatter {
  title: string;
  subtitle?: string;
  tags?: string[];
  date?: string;
  created_at?: string;
  updated_at?: string;
  kind?: BriefingKind;
  status?: BriefingStatus;
  trail?: string;
  source_doc?: string;
  author?: string;
  toc?: boolean;
  [key: string]: unknown;
}

const KEY_ORDER = ["title", "subtitle", "kind", "status", "author", "date", "created_at", "updated_at", "tags", "trail", "source_doc", "toc"];

/** Split optional frontmatter (between --- fences) from the body. Uses the real YAML parser; unknown keys preserved. */
export function splitBriefing(text: string): { frontmatter: BriefingFrontmatter; body: string; raw: string } {
  const t = text.replace(/^﻿/, "");
  const lines = t.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: { title: "" }, body: t, raw: "" };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") {
    end = i;
    break;
  }
  if (end < 0) return { frontmatter: { title: "" }, body: t, raw: "" };
  const raw = lines.slice(1, end).join("\n");
  let fm: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
  } catch {
    // YAML-lite fallback: one key: value per line
    for (const l of raw.split("\n")) {
      const m = l.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m) fm[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
    }
  }
  for (const k of ["date", "created_at", "updated_at"]) if (fm[k] instanceof Date) fm[k] = (fm[k] as Date).toISOString();
  if (typeof fm.tags === "string") fm.tags = (fm.tags as string).replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fm.toc !== undefined) fm.toc = fm.toc === true || fm.toc === "true";
  fm.title = fm.title === undefined ? "" : String(fm.title);
  return { frontmatter: fm as BriefingFrontmatter, body: lines.slice(end + 1).join("\n"), raw };
}

export function serializeBriefing(fm: BriefingFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (fm[k] !== undefined && fm[k] !== null) ordered[k] = fm[k];
  for (const [k, v] of Object.entries(fm)) if (!(k in ordered) && v !== undefined && v !== null) ordered[k] = v;
  const y = YAML.stringify(ordered, { lineWidth: 0 }).trimEnd();
  return `---\n${y}\n---\n${body.startsWith("\n") ? "" : "\n"}${body.endsWith("\n") ? body : body + "\n"}`;
}
