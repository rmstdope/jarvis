import type { Node } from "./parser.ts";

export interface TocEntry {
  level: number;
  text: string;
  slug: string;
}

export function slugify(s: string, seen: Map<string, number>): string {
  let base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  if (n > 0) base = `${base}-${n + 1}`;
  return base;
}

/** Headings = Section titles (level 2) + Markdown #–###### outside code fences; levels ≤ 3. */
export function collectHeadings(nodes: Node[]): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (n.type === "markdown") {
        let inFence = false;
        for (const line of n.content.split("\n")) {
          if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
          }
          if (inFence) continue;
          const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
          if (m && m[1].length <= 3) out.push({ level: m[1].length, text: m[2].trim() });
        }
      } else if (n.type === "component") {
        if (n.name === "Section" && typeof n.props.title === "string") out.push({ level: 2, text: n.props.title });
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

export function buildToc(nodes: Node[], toc?: boolean): TocEntry[] | null {
  const heads = collectHeadings(nodes);
  const enabled = toc === true ? heads.length >= 2 : toc === false ? false : heads.length >= 4;
  if (!enabled) return null;
  const seen = new Map<string, number>();
  return heads.map((h) => ({ ...h, slug: slugify(h.text, seen) }));
}

/** Deterministic slugs for every heading (used by renderers to anchor ids even without a TOC). */
export function headingSlugs(nodes: Node[]): Map<string, string> {
  const seen = new Map<string, number>();
  const m = new Map<string, string>();
  for (const h of collectHeadings(nodes)) if (!m.has(h.text)) m.set(h.text, slugify(h.text, seen));
  return m;
}
