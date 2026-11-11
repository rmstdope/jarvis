import { getComponent, type RenderContext } from "./components.ts";
import { renderMarkdown, escapeHtml } from "./markdown.ts";
import type { Node } from "./parser.ts";
import { headingSlugs } from "./toc.ts";

export interface RenderOptions {
  itemHref?: (id: string) => string;
}

/** Tree → HTML. Unknown component → visible placeholder, never a throw. */
export function renderBriefingHtml(nodes: Node[], opts: RenderOptions = {}): string {
  const slugs = headingSlugs(nodes);
  const ctx: RenderContext = { itemHref: opts.itemHref ?? ((id) => `#/item/${id}`), headingId: (t) => slugs.get(t) };
  const walk = (ns: Node[]): string =>
    ns
      .map((n) => {
        if (n.type === "markdown") return renderMarkdown(n.content, { slugFor: ctx.headingId, citationHref: ctx.itemHref });
        if (n.type === "raw") return n.content;
        const c = getComponent(n.name);
        const children = n.children.length === 1 && n.children[0].type === "raw" ? n.children[0].content : walk(n.children);
        if (!c) return `<div class="jv-unknown" style="margin:12px 0;padding:8px 12px;border:1px dashed #b91c1c;border-radius:8px;color:#b91c1c;font-size:13px">Unknown component &lt;${escapeHtml(n.name)}&gt; (line ${n.line})</div>${children}`;
        try {
          return c.render()(n.props, children, ctx);
        } catch (e) {
          return `<div class="jv-unknown" style="margin:12px 0;padding:8px 12px;border:1px dashed #b91c1c;border-radius:8px;color:#b91c1c;font-size:13px">&lt;${escapeHtml(n.name)}&gt; failed to render: ${escapeHtml((e as Error).message)}</div>`;
        }
      })
      .join("\n");
  return walk(nodes);
}

const TEXT_PROPS = ["title", "subtitle", "heading", "label", "text", "caption", "name", "summary"];
/** Indexed body = all markdown/raw content + string props among TEXT_PROPS + string array items, recursively. */
export function flattenText(nodes: Node[]): string {
  const out: string[] = [];
  const props = (v: unknown, depth = 0) => {
    if (depth > 6) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) props(x, depth + 1);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (TEXT_PROPS.includes(k) || Array.isArray(x) || (x && typeof x === "object")) props(x, depth + 1);
  };
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (n.type === "markdown" || n.type === "raw") out.push(n.content);
      else {
        props(n.props);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
