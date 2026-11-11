/**
 * The component registry: metadata eagerly, renderer as a thunk. Shared by the web renderer,
 * the CLI (`jarvis briefing components`) and the Confluence publisher.
 */
import { activityDiagram, blockDiagram, cycleDiagram, figure, pyramidDiagram, quadrants, sequenceDiagram, stackDiagram, stepFlow, timeline, accentColor, ACCENTS } from "./diagrams.ts";
import { escapeHtml } from "./markdown.ts";

export interface PropMeta {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}
export interface ComponentMeta {
  id: string;
  name: string;
  category: "layout" | "content" | "diagram";
  description: string;
  props: PropMeta[];
  snippet: string;
  keywords: string[];
  useCases: string[];
}
/** Renders a component to HTML. `children` is the rendered inner HTML (or raw text for raw components). */
export type Renderer = (props: Record<string, unknown>, children: string, ctx: RenderContext) => string;
export interface RenderContext {
  itemHref: (id: string) => string;
  headingId?: (text: string) => string | undefined;
}
interface Entry {
  meta: ComponentMeta;
  render: () => Renderer;
}
const registry = new Map<string, Entry>();
export function registerComponent(meta: ComponentMeta, render: () => Renderer): void {
  registry.set(meta.id, { meta, render });
}
export function getComponent(name: string): Entry | undefined {
  return registry.get(name);
}
export function listComponents(search?: string): ComponentMeta[] {
  const all = [...registry.values()].map((e) => e.meta);
  if (!search) return all;
  const q = search.toLowerCase();
  return all.filter((m) => [m.id, m.description, ...m.keywords, ...m.useCases].some((s) => s.toLowerCase().includes(q)));
}
export function componentNames(): string[] {
  return [...registry.keys()];
}

const TEXT = "var(--text, #161b26)";
const MUTED = "var(--muted, #6b7280)";
const BORDER = "var(--border, #d9dee7)";
const FONT = "font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);

const VARIANTS: Record<string, { bg: string; border: string; label: string }> = {
  accent: { bg: "#eef4ff", border: ACCENTS.blue, label: "Note" },
  warn: { bg: "#fff7e6", border: ACCENTS.gold, label: "Warning" },
  good: { bg: "#e8f8ef", border: "#14a05c", label: "Good" },
  bad: { bg: "#fdecec", border: ACCENTS.red, label: "Problem" },
  neutral: { bg: "#f3f4f6", border: ACCENTS.slate, label: "" },
  investigate: { bg: "#f3eefe", border: ACCENTS.purple, label: "Investigate" },
};
const PILL: Record<string, string> = { neutral: ACCENTS.slate, good: "#14a05c", warn: ACCENTS.gold, bad: ACCENTS.red };

registerComponent(
  { id: "Section", name: "Section", category: "layout", description: "A titled section (h2) that feeds the table of contents.", props: [{ name: "title", type: "string", required: true, description: "Heading text" }, { name: "id", type: "string", description: "Anchor id override" }], snippet: '<Section title="Overview">\n\n…\n\n</Section>', keywords: ["section", "heading", "toc"], useCases: ["structure a briefing into navigable parts"] },
  () => (p, children, ctx) => {
    const id = s(p.id) || ctx.headingId?.(s(p.title)) || s(p.title).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `<section class="jv-section" id="${escapeHtml(id)}" style="margin:28px 0"><h2 style="margin:0 0 12px;font-size:22px;color:${TEXT};${FONT}">${escapeHtml(s(p.title))}</h2><div class="jv-section-body">${children}</div></section>`;
  },
);
registerComponent(
  { id: "Callout", name: "Callout", category: "content", description: "A tinted framed panel for summaries, warnings and findings.", props: [{ name: "variant", type: "accent|warn|good|bad|neutral|investigate", description: "Tint" }, { name: "title", type: "string", description: "Panel title" }], snippet: '<Callout variant="accent" title="Summary">\n\n…\n\n</Callout>', keywords: ["callout", "panel", "note", "warning", "summary"], useCases: ["executive summary at the top", "highlight a risk"] },
  () => (p, children) => {
    const v = VARIANTS[s(p.variant, "accent")] ?? VARIANTS.accent;
    const title = s(p.title) || v.label;
    return `<aside class="jv-callout jv-callout-${escapeHtml(s(p.variant, "accent"))}" style="margin:16px 0;padding:12px 16px;border-left:4px solid ${v.border};border-radius:8px;background:${v.bg};color:${TEXT};${FONT}">${title ? `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(title)}</div>` : ""}${children}</aside>`;
  },
);
registerComponent(
  { id: "Grid2", name: "Grid2", category: "layout", description: "Two-column grid that collapses under 720 px.", props: [{ name: "gap", type: "number", description: "Gap in px" }], snippet: "<Grid2>\n\n<Callout>…</Callout>\n\n<Callout>…</Callout>\n\n</Grid2>", keywords: ["grid", "columns", "layout"], useCases: ["side-by-side comparison of two panels"] },
  () => (p, children) => `<div class="jv-grid2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:${typeof p.gap === "number" ? p.gap : 16}px;margin:16px 0">${children}</div>`,
);
registerComponent(
  { id: "FlowDiagram", name: "FlowDiagram", category: "diagram", description: "A framed monospace ASCII block for hand-drawn flows.", props: [{ name: "caption", type: "string", description: "Caption" }], snippet: "<FlowDiagram caption=\"…\">\nA --> B --> C\n</FlowDiagram>", keywords: ["ascii", "flow", "monospace"], useCases: ["quick text flow without SVG"] },
  () => (p, children) => figure(`<pre style="margin:0;padding:14px;border:1px solid ${BORDER};border-radius:8px;background:#f8fafc;font-size:13px;line-height:1.45;overflow-x:auto;color:${TEXT}">${escapeHtml(children.replace(/^\n+|\n+$/g, ""))}</pre>`, p.caption),
);
registerComponent(
  { id: "TagPill", name: "TagPill", category: "content", description: "Inline status pill.", props: [{ name: "variant", type: "neutral|good|warn|bad", description: "Colour" }], snippet: '<TagPill variant="good">Done</TagPill>', keywords: ["pill", "tag", "badge", "status"], useCases: ["inline status marker"] },
  () => (p, children) => `<span class="jv-pill" style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:${PILL[s(p.variant, "neutral")] ?? PILL.neutral};${FONT}">${children.replace(/<\/?p>/g, "").trim()}</span>`,
);
registerComponent(
  { id: "ProConList", name: "ProConList", category: "content", description: "Rows of pros, cons and nuances with coloured tags.", props: [{ name: "items", type: "[{kind:'pro'|'con'|'nuance', text}]", required: true, description: "Rows" }], snippet: "<ProConList items={[{kind:'pro', text:'…'},{kind:'con', text:'…'}]} />", keywords: ["pros", "cons", "tradeoffs"], useCases: ["weigh an option"] },
  () => (p) => {
    const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
    const color: Record<string, string> = { pro: "#14a05c", con: ACCENTS.red, nuance: ACCENTS.gold };
    return `<ul class="jv-procon" style="list-style:none;padding:0;margin:12px 0;${FONT}">${items.map((it) => `<li style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid ${BORDER}"><span style="flex:none;min-width:64px;text-align:center;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:${color[s(it.kind)] ?? ACCENTS.slate}">${escapeHtml(s(it.kind, "note"))}</span><span style="color:${TEXT}">${escapeHtml(s(it.text))}</span></li>`).join("")}</ul>`;
  },
);
registerComponent(
  { id: "ComparisonTable", name: "ComparisonTable", category: "content", description: "Table with optional highlighted row.", props: [{ name: "headers", type: "string[]", required: true, description: "Column headers" }, { name: "rows", type: "(string[] | {cells, highlight?})[]", required: true, description: "Rows" }, { name: "caption", type: "string", description: "Caption" }], snippet: "<ComparisonTable headers={['Option','Cost']} rows={[['A','low'],{cells:['B','high'],highlight:true}]} />", keywords: ["table", "compare", "matrix"], useCases: ["compare options across criteria"] },
  () => (p) => {
    const headers = Array.isArray(p.headers) ? (p.headers as unknown[]) : [];
    const rows = Array.isArray(p.rows) ? (p.rows as unknown[]) : [];
    const body = rows.map((r) => {
      const cells = Array.isArray(r) ? r : Array.isArray((r as { cells?: unknown[] })?.cells) ? (r as { cells: unknown[] }).cells : [];
      const hl = !Array.isArray(r) && !!(r as { highlight?: boolean })?.highlight;
      return `<tr${hl ? ' style="background:#e3fcef"' : ""}>${cells.map((c) => `<td style="padding:6px 10px;border:1px solid ${BORDER}">${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`;
    }).join("");
    return figure(`<table style="border-collapse:collapse;width:100%;font-size:14px;color:${TEXT};${FONT}"><thead><tr>${headers.map((h) => `<th style="text-align:left;padding:6px 10px;border:1px solid ${BORDER};background:#f3f4f6">${escapeHtml(String(h))}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`, p.caption);
  },
);
registerComponent(
  { id: "ItemCard", name: "ItemCard", category: "content", description: "Clickable card linking to a captured item.", props: [{ name: "itemId", type: "string", required: true, description: "Doc ULID" }, { name: "label", type: "string", description: "Label" }, { name: "item", type: "{title, source}", description: "Pre-resolved item metadata" }], snippet: '<ItemCard itemId="01J…" label="Source" />', keywords: ["item", "card", "link", "source"], useCases: ["link a briefing to its evidence"] },
  () => (p, _c, ctx) => {
    const item = (p.item ?? {}) as Record<string, unknown>;
    const title = s(item.title) || `item ${s(p.itemId).slice(0, 10)}… (not loaded)`;
    return `<a class="jv-itemcard" href="${escapeHtml(ctx.itemHref(s(p.itemId)))}" style="display:block;margin:10px 0;padding:10px 14px;border:1px solid ${BORDER};border-radius:8px;text-decoration:none;color:${TEXT};${FONT}">${p.label ? `<div style="font-size:11px;text-transform:uppercase;color:${MUTED}">${escapeHtml(s(p.label))}</div>` : ""}<div style="font-weight:600">${escapeHtml(title)}</div>${item.source ? `<div style="font-size:12px;color:${MUTED}">${escapeHtml(s(item.source))}</div>` : ""}</a>`;
  },
);
registerComponent(
  { id: "SvgDiagram", name: "SvgDiagram", category: "diagram", description: "Verbatim SVG escape hatch (Mermaid is deliberately unsupported).", props: [{ name: "caption", type: "string", description: "Caption" }], snippet: '<SvgDiagram caption="…">\n<svg viewBox="0 0 200 100">…</svg>\n</SvgDiagram>', keywords: ["svg", "custom", "diagram"], useCases: ["any diagram the generative components cannot express"] },
  () => (p, children) => figure(`<div style="text-align:center">${sanitizeSvg(children)}</div>`, p.caption),
);
registerComponent(
  { id: "Legend", name: "Legend", category: "content", description: "Swatch row explaining colours.", props: [{ name: "items", type: "[{color,label}]", description: "Swatches" }, { name: "title", type: "string", description: "Title" }], snippet: "<Legend items={[{color:'teal', label:'Now'},{color:'gold', label:'Later'}]} />", keywords: ["legend", "colors", "key"], useCases: ["explain diagram colours"] },
  () => (p) => {
    const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
    return `<div class="jv-legend" style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:10px 0;font-size:13px;color:${TEXT};${FONT}">${p.title ? `<strong>${escapeHtml(s(p.title))}</strong>` : ""}${items.map((it) => `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:3px;background:${accentColor(it.color, "slate")}"></span>${escapeHtml(s(it.label))}</span>`).join("")}</div>`;
  },
);
const diagramMeta = (id: string, description: string, props: PropMeta[], snippet: string, keywords: string[], useCases: string[]): ComponentMeta => ({ id, name: id, category: "diagram", description, props: [...props, { name: "caption", type: "string", description: "Caption" }], snippet, keywords, useCases });
registerComponent(diagramMeta("StepFlow", "Cards joined by arrows, horizontal (≤ 4) or vertical.", [{ name: "steps", type: "[{eyebrow?,title,status?,meta?,accent?}]", required: true, description: "Steps" }, { name: "arrows", type: "solid|dashed|none", description: "Arrow style" }, { name: "orientation", type: "horizontal|vertical|auto", description: "Layout" }], "<StepFlow steps={[{title:'Capture'},{title:'Understand'},{title:'Use'}]} />", ["steps", "process", "pipeline", "flow"], ["a linear process"]), () => (p) => stepFlow(p));
registerComponent(diagramMeta("CycleDiagram", "Ring with clockwise arcs, or a hub with spokes.", [{ name: "mode", type: "cycle|hub", description: "Layout" }, { name: "steps", type: "[{title,meta?,accent?,satellite?}]", required: true, description: "Nodes" }, { name: "centerTitle", type: "string", description: "Hub title" }, { name: "centerSubtitle", type: "string", description: "Hub subtitle" }, { name: "centerAccent", type: "accent", description: "Hub colour" }, { name: "arrowAccent", type: "accent", description: "Arrow colour" }], "<CycleDiagram steps={[{title:'Plan'},{title:'Do'},{title:'Check'},{title:'Act'}]} />", ["cycle", "loop", "hub", "spokes"], ["a repeating loop", "a hub with satellites"]), () => (p) => cycleDiagram(p));
registerComponent(diagramMeta("PyramidDiagram", "Layered pyramid, apex first.", [{ name: "layers", type: "[{title,sub?,meta?,accent?}]", required: true, description: "Apex-first layers" }, { name: "pointed", type: "boolean", description: "Pointed apex" }], "<PyramidDiagram layers={[{title:'Vision'},{title:'Strategy'},{title:'Tactics'}]} />", ["pyramid", "hierarchy", "levels"], ["a hierarchy of concerns"]), () => (p) => pyramidDiagram(p));
registerComponent(diagramMeta("StackDiagram", "Full-width bands with chips, top-down.", [{ name: "layers", type: "[{title,sub?,items?,accent?}]", required: true, description: "Top-down layers" }, { name: "arrows", type: "boolean", description: "Arrows between layers" }], "<StackDiagram layers={[{title:'UI', items:['web','app']},{title:'Core'},{title:'Storage'}]} />", ["stack", "layers", "architecture"], ["a layered architecture"]), () => (p) => stackDiagram(p));
registerComponent(diagramMeta("Timeline", "Horizontal timeline; deadlines as flags.", [{ name: "events", type: "[{date,title,description?,accent?,deadline?}]", required: true, description: "Events" }, { name: "accent", type: "accent", description: "Default colour" }], "<Timeline events={[{date:'2026-10', title:'Kickoff'},{date:'2026-12', title:'GA', deadline:true}]} />", ["timeline", "roadmap", "milestones", "dates"], ["a roadmap"]), () => (p) => timeline(p));
registerComponent(diagramMeta("SequenceDiagram", "UML sequence with lifelines; self-calls supported.", [{ name: "actors", type: "[{id,label,accent?}]", required: true, description: "Actors" }, { name: "messages", type: "[{from,to,label?,dashed?}]", required: true, description: "Messages in order" }, { name: "lifelines", type: "boolean", description: "Show lifelines" }, { name: "messageSpacing", type: "number", description: "Vertical spacing" }], "<SequenceDiagram actors={[{id:'a', label:'App'},{id:'b', label:'API'}]} messages={[{from:'a', to:'b', label:'GET'},{from:'b', to:'a', label:'200', dashed:true}]} />", ["sequence", "uml", "interaction", "messages"], ["ordered interactions between systems"]), () => (p) => sequenceDiagram(p));
registerComponent(diagramMeta("Quadrants", "2×2 matrix with items positioned in [0,1].", [{ name: "xAxis", type: "{label,low?,high?}", required: true, description: "X axis" }, { name: "yAxis", type: "{label,low?,high?}", required: true, description: "Y axis" }, { name: "items", type: "[{label,x,y,accent?}]", description: "Points" }, { name: "quadrants", type: "string[]", description: "Four labels" }], "<Quadrants xAxis={{label:'Effort'}} yAxis={{label:'Value'}} items={[{label:'A', x:0.2, y:0.8}]} />", ["quadrant", "matrix", "prioritize", "2x2"], ["prioritisation"]), () => (p) => quadrants(p));
registerComponent(diagramMeta("ActivityDiagram", "UML activity flowchart on a grid.", [{ name: "nodes", type: "[{id,type:start|end|action|decision|fork|join,label?,row?,column?}]", required: true, description: "Nodes" }, { name: "edges", type: "[{from,to,label?}]", required: true, description: "Edges" }, { name: "rowSpacing", type: "number", description: "Default 92" }, { name: "columnSpacing", type: "number", description: "Default 180" }], "<ActivityDiagram nodes={[{id:'s', type:'start'},{id:'a', type:'action', label:'Do'},{id:'e', type:'end'}]} edges={[{from:'s', to:'a'},{from:'a', to:'e'}]} />", ["activity", "flowchart", "decision", "uml"], ["a process with decisions"]), () => (p) => activityDiagram(p));
registerComponent(diagramMeta("BlockDiagram", "Architecture boxes with auto-routed labelled edges.", [{ name: "nodes", type: "[{id,row,column,rowSpan?,title,sub?,kicker?,items?,accent?,dashed?,emphasis?}]", required: true, description: "Boxes on a grid" }, { name: "edges", type: "[{from,to,label?,dashed?,accent?,fromSide?,toSide?,fromAt?,toAt?,curve?}]", description: "Connections" }], "<BlockDiagram nodes={[{id:'cli', row:0, column:0, title:'CLI'},{id:'core', row:0, column:1, title:'Core'}]} edges={[{from:'cli', to:'core', label:'calls'}]} />", ["block", "architecture", "topology", "boxes", "system"], ["system topologies", "component relationships"]), () => (p) => blockDiagram(p));

/** Allowlist-based SVG sanitizer: drop scripts, event handlers and foreignObject. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "");
}
export const COMPONENT_COUNT = 19;
