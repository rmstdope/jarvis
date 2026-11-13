/**
 * Small block-level Markdown parser → HTML. Dependency-free, handles nested lists,
 * fenced code (mermaid renders as plain code), blockquotes, pipe tables, hr, headings,
 * paragraphs with lazy continuation, and inline code/emphasis/links/images/[[id]] citations.
 */
export interface MdOptions {
  slugFor?: (heading: string) => string | undefined;
  citationHref?: (id: string) => string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function safeUrl(u: string): string {
  const t = u.trim();
  if (/^https?:\/\//i.test(t) || t.startsWith("/") || t.startsWith("#")) return t;
  return "#";
}

export function renderInline(s: string, o: MdOptions = {}): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = escapeHtml(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${safeUrl(src)}">`);
  t = t.replace(/\[\[([0-9A-Z]{26})\]\]/g, (_, id) => `<a class="cite" href="${o.citationHref ? o.citationHref(id) : `#/item/${id}`}">[${id.slice(0, 8)}…]</a>`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const init = href.match(/^jarvis:\/\/initiative\/([0-9A-Za-z_-]+)$/); // an initiative mention opens its tab in this browser tab (jv-77m)
    return init ? `<a href="#/initiative/${init[1]}">${text}</a>` : `<a href="${safeUrl(href)}" target="_blank" rel="noopener">${text}</a>`;
  });
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  t = t.replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  t = t.replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "code"; lang: string; body: string }
  | { t: "quote"; lines: string[] }
  | { t: "hr" }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "list"; ordered: boolean; items: { text: string; children: Block[] }[] };

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", lang: fence[1], body: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      blocks.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", lines: q });
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ t: "table", header, rows });
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: { text: string; children: Block[] }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length === indent) {
          const text = [m[3]];
          i++;
          const sub: string[] = [];
          while (i < lines.length) {
            const l = lines[i];
            const mm = l.match(/^(\s*)([-*+]|\d+[.)])\s+/);
            if (mm && mm[1].length === indent) break;
            if (!l.trim()) {
              if (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && lines[i + 1].trim()) {
                sub.push("");
                i++;
                continue;
              }
              break;
            }
            if (mm && mm[1].length > indent) sub.push(l);
            else if (/^\s+/.test(l) && sub.length) sub.push(l);
            else if (/^\s+/.test(l) || (!mm && sub.length === 0)) text.push(l.trim()); // lazy continuation
            else break;
            i++;
          }
          const minIndent = Math.min(...sub.filter((s) => s.trim()).map((s) => s.match(/^\s*/)![0].length), 99);
          items.push({ text: text.join(" "), children: sub.length ? parseBlocks(sub.map((s) => s.slice(Math.min(minIndent, s.length)))) : [] });
        } else break;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    const p: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,6}\s|\s*>|\s*\||\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) p.push(lines[i++].trim());
    blocks.push({ t: "p", lines: p });
  }
  return blocks;
}

function renderBlocks(blocks: Block[], o: MdOptions): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "h": {
          const id = o.slugFor?.(b.text);
          return `<h${b.level}${id ? ` id="${id}"` : ""}>${renderInline(b.text, o)}</h${b.level}>`;
        }
        case "p":
          return `<p>${renderInline(b.lines.join(" "), o)}</p>`;
        case "code":
          return `<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ""}>${escapeHtml(b.body)}</code></pre>`;
        case "quote":
          return `<blockquote>${renderBlocks(parseBlocks(b.lines), o)}</blockquote>`;
        case "hr":
          return "<hr>";
        case "table":
          return `<table><thead><tr>${b.header.map((c) => `<th>${renderInline(c, o)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, o)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "list":
          return `<${b.ordered ? "ol" : "ul"}>${b.items.map((it) => `<li>${renderInline(it.text, o)}${it.children.length ? renderBlocks(it.children, o) : ""}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`;
      }
    })
    .join("\n");
}

export function renderMarkdown(src: string, o: MdOptions = {}): string {
  return renderBlocks(parseBlocks(src.split(/\r?\n/)), o);
}
export { parseBlocks as parseMarkdownBlocks };
export type { Block as MarkdownBlock };
