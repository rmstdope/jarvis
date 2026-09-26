/** Confluence storage-format renderer + REST v1 publisher, keyed by page title in the space. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getComponent, sanitizeSvg } from "./components.ts";
import { escapeHtml, parseMarkdownBlocks, renderInline, type MarkdownBlock } from "./markdown.ts";
import type { Node } from "./parser.ts";
import { buildToc } from "./toc.ts";
import type { Briefing } from "./store.ts";

export interface ConfluenceConfig {
  baseUrl: string;
  spaceKey: string;
  parentPageId?: string;
}
export function readConfluenceConfig(dataDir: string): ConfluenceConfig | null {
  const p = join(dataDir, "config", "confluence.json");
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (!j.baseUrl || !j.spaceKey) throw new Error("config/confluence.json needs baseUrl and spaceKey");
  return { baseUrl: String(j.baseUrl).replace(/\/$/, ""), spaceKey: String(j.spaceKey), parentPageId: j.parentPageId ? String(j.parentPageId) : undefined };
}
export function confluenceAuthHeader(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CONFLUENCE_PAT) return `Bearer ${env.CONFLUENCE_PAT}`;
  if (env.CONFLUENCE_EMAIL && env.CONFLUENCE_API_TOKEN) return `Basic ${Buffer.from(`${env.CONFLUENCE_EMAIL}:${env.CONFLUENCE_API_TOKEN}`).toString("base64")}`;
  return null;
}

const cdata = (s: string) => `<![CDATA[${s.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
const macro = (name: string, params: Record<string, string>, body?: string, plain = false) =>
  `<ac:structured-macro ac:name="${name}">${Object.entries(params).map(([k, v]) => `<ac:parameter ac:name="${k}">${escapeHtml(v)}</ac:parameter>`).join("")}${body !== undefined ? (plain ? `<ac:plain-text-body>${cdata(body)}</ac:plain-text-body>` : `<ac:rich-text-body>${body}</ac:rich-text-body>`) : ""}</ac:structured-macro>`;

function mdBlocks(blocks: MarkdownBlock[]): string {
  const inline = (s: string) => renderInline(s, { citationHref: (id) => `#${id}` }).replace(/<img alt="([^"]*)" src="([^"]+)">/g, '<ac:image ac:alt="$1"><ri:url ri:value="$2"/></ac:image>').replace(/ target="_blank" rel="noopener"/g, "");
  return blocks
    .map((b) => {
      switch (b.t) {
        case "h": return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
        case "p": return `<p>${inline(b.lines.join(" "))}</p>`;
        case "code": return macro("code", b.lang && b.lang !== "mermaid" ? { language: b.lang } : {}, b.body, true);
        case "quote": return `<blockquote>${mdBlocks(parseMarkdownBlocks(b.lines))}</blockquote>`;
        case "hr": return "<hr/>";
        case "table": return `<table><tbody><tr>${b.header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "list": return `<${b.ordered ? "ol" : "ul"}>${b.items.map((it) => `<li>${inline(it.text)}${it.children.length ? mdBlocks(it.children) : ""}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`;
      }
    })
    .join("");
}
export function markdownToStorage(md: string): string {
  return mdBlocks(parseMarkdownBlocks(md.split(/\r?\n/)));
}

const CALLOUT_MACRO: Record<string, string> = { accent: "info", neutral: "note", good: "tip", warn: "warning", bad: "warning", investigate: "note" };
const PANEL_COLOR: Record<string, string> = { accent: "#eef4ff", neutral: "#f3f4f6", good: "#e8f8ef", warn: "#fff7e6", bad: "#fdecec", investigate: "#f3eefe" };
const GENERATIVE = new Set(["StepFlow", "CycleDiagram", "PyramidDiagram", "StackDiagram", "Timeline", "SequenceDiagram", "Quadrants", "ActivityDiagram", "BlockDiagram"]);

export function renderStorage(nodes: Node[], inGrid = false): string {
  const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  return nodes
    .map((n) => {
      if (n.type === "markdown") return markdownToStorage(n.content);
      if (n.type === "raw") return n.content;
      const children = n.children.length === 1 && n.children[0].type === "raw" ? n.children[0].content : renderStorage(n.children, n.name === "Grid2");
      switch (n.name) {
        case "Section": return `<h2>${escapeHtml(s(n.props.title))}</h2>${children}`;
        case "Callout": {
          const v = s(n.props.variant, "accent");
          const title = s(n.props.title);
          if (inGrid) return macro("panel", { bgColor: PANEL_COLOR[v] ?? PANEL_COLOR.accent, ...(title ? { title } : {}) }, children);
          return macro(CALLOUT_MACRO[v] ?? "info", title ? { title } : {}, children);
        }
        case "Grid2": {
          const cells = n.children.filter((c) => c.type !== "markdown" || c.content.trim());
          return `<table><tbody><tr>${cells.map((c) => `<td>${renderStorage([c], true)}</td>`).join("")}</tr></tbody></table>`;
        }
        case "FlowDiagram": return macro("code", {}, children.replace(/^\n+|\n+$/g, ""), true);
        case "TagPill": return macro("status", { colour: { good: "Green", warn: "Yellow", bad: "Red" }[s(n.props.variant)] ?? "Grey", title: children.replace(/<[^>]+>/g, "").trim() });
        case "ProConList": {
          const items = Array.isArray(n.props.items) ? (n.props.items as Record<string, unknown>[]) : [];
          return `<table><tbody>${items.map((it) => `<tr><td>${macro("status", { colour: { pro: "Green", con: "Red", nuance: "Yellow" }[s(it.kind)] ?? "Grey", title: s(it.kind) })}</td><td>${escapeHtml(s(it.text))}</td></tr>`).join("")}</tbody></table>`;
        }
        case "ComparisonTable": {
          const headers = Array.isArray(n.props.headers) ? (n.props.headers as unknown[]) : [];
          const rows = Array.isArray(n.props.rows) ? (n.props.rows as unknown[]) : [];
          const body = rows.map((r) => {
            const cells = Array.isArray(r) ? r : ((r as { cells?: unknown[] })?.cells ?? []);
            const hl = !Array.isArray(r) && !!(r as { highlight?: boolean })?.highlight;
            return `<tr>${cells.map((c) => `<td${hl ? ' data-highlight-colour="#e3fcef"' : ""}>${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`;
          }).join("");
          return `<table><tbody><tr>${headers.map((h) => `<th>${escapeHtml(String(h))}</th>`).join("")}</tr>${body}</tbody></table>${n.props.caption ? `<p><em>${escapeHtml(s(n.props.caption))}</em></p>` : ""}`;
        }
        case "ItemCard": return `<p><strong>${escapeHtml(s(n.props.label, "Item"))}:</strong> ${escapeHtml(s(n.props.itemId))}</p>`;
        case "Legend": return renderStorageHtmlMacro(n);
        case "SvgDiagram": return macro("html", {}, `<div style="text-align:center">${sanitizeSvg(children)}</div>${n.props.caption ? `<p style="text-align:center;font-size:13px;color:#6b7280">${escapeHtml(s(n.props.caption))}</p>` : ""}`, true);
        default:
          if (GENERATIVE.has(n.name)) return renderStorageHtmlMacro(n);
          return `<p><em>[unsupported component ${escapeHtml(n.name)}]</em></p>`;
      }
    })
    .join("");
}
function renderStorageHtmlMacro(n: Extract<Node, { type: "component" }>): string {
  const c = getComponent(n.name);
  const html = c ? c.render()(n.props, "", { itemHref: (id) => `#${id}` }) : "";
  return macro("html", {}, html, true);
}

export function briefingToStorage(b: Briefing): string {
  const toc = buildToc(b.tree, b.frontmatter.toc);
  const head = toc ? macro("toc", { minLevel: "1", maxLevel: "3" }) : "";
  const sub = b.subtitle ? `<p><em>${escapeHtml(b.subtitle)}</em></p>` : "";
  return head + sub + renderStorage(b.tree);
}

export interface PublishResult {
  action: "created" | "updated" | "dry-run";
  pageId?: string;
  title: string;
  url?: string;
  storage?: string;
}
export type Fetch = typeof fetch;

export async function publishBriefing(dataDir: string, b: Briefing, opts: { dryRun?: boolean; allowDraft?: boolean; fetchImpl?: Fetch; env?: NodeJS.ProcessEnv } = {}): Promise<PublishResult> {
  if (b.status === "draft" && !opts.allowDraft) throw new Error(`briefing ${b.id} is a draft; approve it (\`brain briefing approve ${b.id}\`) or pass --allow-draft`);
  const storage = briefingToStorage(b);
  if (opts.dryRun) return { action: "dry-run", title: b.title, storage };
  const cfg = readConfluenceConfig(dataDir);
  if (!cfg) throw new Error("config/confluence.json missing in the content repo ({ baseUrl, spaceKey, parentPageId? })");
  const auth = confluenceAuthHeader(opts.env ?? process.env);
  if (!auth) throw new Error("set CONFLUENCE_PAT, or CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN");
  const f = opts.fetchImpl ?? fetch;
  const headers = { authorization: auth, "content-type": "application/json", accept: "application/json" };
  const q = new URLSearchParams({ spaceKey: cfg.spaceKey, title: b.title, type: "page", expand: "version", limit: "1" });
  const found = await f(`${cfg.baseUrl}/rest/api/content?${q}`, { headers });
  if (!found.ok) throw new Error(`Confluence lookup failed: ${found.status} ${await found.text()}`);
  const existing = ((await found.json()) as { results?: { id: string; version: { number: number } }[] }).results?.[0];
  const bodyObj: Record<string, unknown> = { type: "page", title: b.title, space: { key: cfg.spaceKey }, body: { storage: { value: storage, representation: "storage" } } };
  if (cfg.parentPageId && !existing) bodyObj.ancestors = [{ id: cfg.parentPageId }];
  let r: Response;
  if (existing) {
    bodyObj.version = { number: existing.version.number + 1 };
    r = await f(`${cfg.baseUrl}/rest/api/content/${existing.id}`, { method: "PUT", headers, body: JSON.stringify(bodyObj) });
  } else r = await f(`${cfg.baseUrl}/rest/api/content`, { method: "POST", headers, body: JSON.stringify(bodyObj) });
  if (!r.ok) throw new Error(`Confluence ${existing ? "update" : "create"} failed: ${r.status} ${await r.text()}`);
  const page = (await r.json()) as { id: string; _links?: { webui?: string; base?: string } };
  return { action: existing ? "updated" : "created", pageId: page.id, title: b.title, url: page._links?.webui ? `${page._links.base ?? cfg.baseUrl}${page._links.webui}` : undefined };
}
