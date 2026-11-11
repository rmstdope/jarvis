import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GlossaryEntry {
  term: string;
  description: string;
  section: string;
  variants: string[]; // ASR misheard forms
}
export interface Glossary {
  entries: GlossaryEntry[];
  path?: string;
}
export const GLOSSARY_SECTIONS = ["abbreviations", "people", "products", "teams", "projects"];

/** Lookup order: JARVIS_GLOSSARY → <repo>/config/glossary.toml → ~/.config/jarvis/glossary.toml. Missing = empty. */
export function glossaryPath(dataDir?: string): string | undefined {
  const candidates = [process.env.JARVIS_GLOSSARY, dataDir ? join(dataDir, "config", "glossary.toml") : undefined, join(homedir(), ".config", "jarvis", "glossary.toml")];
  return candidates.find((p) => p && existsSync(p));
}

/**
 * Parse the glossary with the real TOML parser for values, plus a line scan for the
 * `# Misheard as: "foo", "bar"` comment convention (comments are lost by TOML parsers).
 */
export function parseGlossary(text: string): Glossary {
  const entries: GlossaryEntry[] = [];
  let parsed: Record<string, Record<string, unknown>> = {};
  try {
    parsed = Bun.TOML.parse(text) as Record<string, Record<string, unknown>>;
  } catch (e) {
    throw new Error(`glossary.toml is invalid TOML: ${(e as Error).message}`);
  }
  // Map key → variants by scanning lines: a Misheard comment applies to the next key line.
  const variantsByKey = new Map<string, string[]>();
  let pending: string[] | null = null;
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      pending = null;
      continue;
    }
    const mis = line.match(/^#\s*Misheard as:\s*(.*)$/i);
    if (mis) {
      pending = [...mis[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]).filter(Boolean);
      continue;
    }
    if (line.startsWith("#") || line === "") continue;
    const key = line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=/);
    if (key) {
      if (pending) variantsByKey.set(`${section}\u0000${key[1] ?? key[2] ?? key[3]}`, pending);
      pending = null;
    }
  }
  for (const [section, table] of Object.entries(parsed)) {
    if (typeof table !== "object" || table === null) continue;
    for (const [term, desc] of Object.entries(table)) {
      entries.push({ term, description: String(desc ?? ""), section, variants: variantsByKey.get(`${section}\u0000${term}`) ?? [] });
    }
  }
  return { entries };
}

export function loadGlossary(dataDir?: string): Glossary {
  const p = glossaryPath(dataDir);
  if (!p) return { entries: [] };
  const g = parseGlossary(readFileSync(p, "utf8"));
  g.path = p;
  return g;
}

/** variant (lowercased) → canonical term, for every misheard form. */
export function variantMap(g: Glossary): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of g.entries) for (const v of e.variants) m.set(v.trim().toLowerCase(), e.term);
  return m;
}

/** "Use these exact spellings when heard: …" for terms appearing in the title, longest first, ≤ maxChars. */
export function whisperInitialPrompt(g: Glossary, title: string, maxChars = 1200): string | undefined {
  const lower = title.toLowerCase();
  const terms = g.entries
    .map((e) => e.term)
    .filter((t) => t.length >= 2 && lower.includes(t.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return undefined;
  const prefix = "Use these exact spellings when heard: ";
  const chosen: string[] = [];
  let len = prefix.length;
  for (const t of terms) {
    const add = (chosen.length ? 2 : 0) + t.length;
    if (len + add + 1 > maxChars) break;
    chosen.push(t);
    len += add;
  }
  return `${prefix}${chosen.join(", ")}.`;
}
