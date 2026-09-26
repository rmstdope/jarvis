/**
 * Pure string builders emitting fully inline-styled SVG/HTML (with var(--x, fallback) pairs) so the
 * same markup works in the browser and inside a CSS-isolated Confluence HTML macro.
 */
import { escapeHtml } from "./markdown.ts";

export const ACCENTS: Record<string, string> = { teal: "#0f766e", red: "#b91c1c", gold: "#b45309", navy: "#1e3a8a", slate: "#475569", blue: "#2563eb", purple: "#7c3aed" };
export function accentColor(a: unknown, fallback = "teal"): string {
  if (typeof a === "string" && /^#[0-9a-fA-F]{6}$/.test(a)) return a;
  return ACCENTS[typeof a === "string" ? a : fallback] ?? ACCENTS[fallback];
}
const TEXT = "var(--text, #161b26)";
const MUTED = "var(--muted, #6b7280)";
const BORDER = "var(--border, #d9dee7)";
const PANEL = "var(--panel, #ffffff)";
const FONT = "font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

let markerCounter = 0;
export function nextMarkerId(): string {
  return `sb-arrow-${++markerCounter}`;
}
export function resetMarkerCounter(): void {
  markerCounter = 0;
}
function marker(id: string, color: string): string {
  return `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`;
}
export function wrapText(s: string, maxWidth: number, fontSize: number): string[] {
  const perChar = 0.52 * fontSize;
  const maxChars = Math.max(4, Math.floor(maxWidth / perChar));
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
function textLines(x: number, y: number, lines: string[], size: number, color: string, weight = 400, anchor = "middle"): string {
  return lines.map((l, i) => `<text x="${x}" y="${y + i * (size * 1.25)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${color}" style="${FONT}">${escapeHtml(l)}</text>`).join("");
}
export function figure(inner: string, caption?: unknown): string {
  const cap = typeof caption === "string" && caption ? `<figcaption style="margin-top:8px;font-size:13px;color:${MUTED};text-align:center;${FONT}">${escapeHtml(caption)}</figcaption>` : "";
  return `<figure class="sb-diagram" style="margin:20px 0;overflow-x:auto">${inner}${cap}</figure>`;
}
function svg(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="max-width:100%;height:auto;display:block;margin:0 auto">${inner}</svg>`;
}
function card(x: number, y: number, w: number, h: number, color: string, dashed = false, fill = PANEL): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="6 4"' : ""}/>`;
}
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// ---- StepFlow ----
export function stepFlow(props: Record<string, unknown>): string {
  const steps = arr<Record<string, unknown>>(props.steps);
  if (!steps.length) return figure(`<p style="color:${MUTED}">StepFlow: no steps</p>`);
  const arrows = str(props.arrows, "solid");
  let orientation = str(props.orientation, "auto");
  if (orientation === "auto") orientation = steps.length <= 4 ? "horizontal" : "vertical";
  const W = 200, H = 96, GAP = 48;
  const horiz = orientation === "horizontal";
  const w = horiz ? steps.length * W + (steps.length - 1) * GAP + 20 : W + 20;
  const h = horiz ? H + 20 : steps.length * H + (steps.length - 1) * GAP + 20;
  const mid = nextMarkerId();
  let out = marker(mid, ACCENTS.slate);
  steps.forEach((s, i) => {
    const x = horiz ? 10 + i * (W + GAP) : 10;
    const y = horiz ? 10 : 10 + i * (H + GAP);
    const color = accentColor(s.accent, "teal");
    out += card(x, y, W, H, color);
    let ty = y + 24;
    if (s.eyebrow) {
      out += textLines(x + W / 2, ty, [String(s.eyebrow).toUpperCase()], 10, MUTED, 600);
      ty += 16;
    }
    const tl = wrapText(str(s.title), W - 24, 14).slice(0, 2);
    out += textLines(x + W / 2, ty + 4, tl, 14, TEXT, 600);
    ty += 4 + tl.length * 17;
    if (s.meta) out += textLines(x + W / 2, ty + 2, [str(s.meta)].map((m) => m.slice(0, 32)), 11, MUTED);
    if (s.status) out += `<circle cx="${x + W - 14}" cy="${y + 14}" r="5" fill="${color}"/>`;
    if (i < steps.length - 1 && arrows !== "none") {
      const dash = arrows === "dashed" ? ' stroke-dasharray="6 4"' : "";
      if (horiz) out += `<line x1="${x + W + 4}" y1="${y + H / 2}" x2="${x + W + GAP - 4}" y2="${y + H / 2}" stroke="${ACCENTS.slate}" stroke-width="2" marker-end="url(#${mid})"${dash}/>`;
      else out += `<line x1="${x + W / 2}" y1="${y + H + 4}" x2="${x + W / 2}" y2="${y + H + GAP - 4}" stroke="${ACCENTS.slate}" stroke-width="2" marker-end="url(#${mid})"${dash}/>`;
    }
  });
  return figure(svg(w, h, out), props.caption);
}

// ---- CycleDiagram ----
export function cycleDiagram(props: Record<string, unknown>): string {
  const steps = arr<Record<string, unknown>>(props.steps);
  if (!steps.length) return figure(`<p style="color:${MUTED}">CycleDiagram: no steps</p>`);
  const mode = str(props.mode, "cycle");
  const r = 60;
  const R = steps.length >= 6 ? 186 : 168;
  const size = (R + r) * 2 + 40;
  const cx = size / 2, cy = size / 2;
  const arrowColor = accentColor(props.arrowAccent, "slate");
  const mid = nextMarkerId();
  let out = marker(mid, arrowColor);
  const n = steps.length;
  const pos = steps.map((_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a };
  });
  if (mode === "hub" || props.centerTitle) {
    const cc = accentColor(props.centerAccent, "navy");
    out += `<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="${PANEL}" stroke="${cc}" stroke-width="2"/>`;
    out += textLines(cx, cy - 2, wrapText(str(props.centerTitle, "Hub"), r * 1.7, 13).slice(0, 2), 13, TEXT, 700);
    if (props.centerSubtitle) out += textLines(cx, cy + 26, [str(props.centerSubtitle)], 10, MUTED);
  }
  pos.forEach((p, i) => {
    const s = steps[i];
    const color = accentColor(s.accent, "teal");
    if (mode === "hub") {
      const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
      const ux = dx / d, uy = dy / d;
      out += `<line x1="${cx + ux * (r + 8)}" y1="${cy + uy * (r + 8)}" x2="${p.x - ux * (r + 2)}" y2="${p.y - uy * (r + 2)}" stroke="${arrowColor}" stroke-width="2" marker-end="url(#${mid})"/>`;
    } else if (n > 1) {
      const next = pos[(i + 1) % n];
      const trim = Math.asin(r / R) + 10 / R;
      const a1 = p.a + trim, a2 = next.a - trim + (next.a <= p.a ? 2 * Math.PI : 0);
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1), x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
      const large = a2 - a1 > Math.PI ? 1 : 0;
      out += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${arrowColor}" stroke-width="2" marker-end="url(#${mid})"/>`;
    }
    const satellite = !!s.satellite;
    out += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${satellite ? r * 0.7 : r}" fill="${PANEL}" stroke="${color}" stroke-width="${satellite ? 1.5 : 2.5}"/>`;
    const tl = wrapText(str(s.title), r * 1.6, 12).slice(0, 3);
    out += textLines(p.x, p.y - ((tl.length - 1) * 7.5) + (s.meta ? -4 : 4), tl, 12, TEXT, 600);
    if (s.meta) out += textLines(p.x, p.y + tl.length * 8 + 10, [str(s.meta).slice(0, 22)], 10, MUTED);
  });
  return figure(svg(size, size, out), props.caption);
}

// ---- PyramidDiagram ----
export function pyramidDiagram(props: Record<string, unknown>): string {
  const layers = arr<Record<string, unknown>>(props.layers);
  if (!layers.length) return figure(`<p style="color:${MUTED}">PyramidDiagram: no layers</p>`);
  const W = 560, LH = 64, n = layers.length, pointed = props.pointed !== false;
  const h = n * LH + 20;
  let out = "";
  layers.forEach((l, i) => {
    const color = accentColor(l.accent, ["navy", "blue", "teal", "gold", "slate", "purple", "red"][i % 7]);
    const topW = pointed ? (W * i) / n : (W * (i + 1)) / (n + 1);
    const botW = (W * (i + 1)) / (pointed ? n : n + 1);
    const y = 10 + i * LH;
    const cx = W / 2 + 10;
    out += `<polygon points="${cx - topW / 2},${y} ${cx + topW / 2},${y} ${cx + botW / 2},${y + LH - 4} ${cx - botW / 2},${y + LH - 4}" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="2"/>`;
    out += textLines(cx, y + LH / 2 - (l.sub ? 4 : -4), [str(l.title)], 14, TEXT, 600);
    if (l.sub) out += textLines(cx, y + LH / 2 + 14, [str(l.sub)], 11, MUTED);
    if (l.meta) out += textLines(cx + botW / 2 + 12, y + LH / 2 + 4, [str(l.meta)], 11, MUTED, 400, "start");
  });
  return figure(svg(W + 140, h, out), props.caption);
}

// ---- StackDiagram ----
export function stackDiagram(props: Record<string, unknown>): string {
  const layers = arr<Record<string, unknown>>(props.layers);
  if (!layers.length) return figure(`<p style="color:${MUTED}">StackDiagram: no layers</p>`);
  const rows = layers
    .map((l, i) => {
      const color = accentColor(l.accent, ["navy", "blue", "teal", "gold", "slate"][i % 5]);
      const items = arr<string>(l.items).map((it) => `<span style="display:inline-block;margin:4px 6px 0 0;padding:2px 8px;border-radius:999px;font-size:12px;background:${color};color:#fff">${escapeHtml(String(it))}</span>`).join("");
      const arrow = props.arrows && i < layers.length - 1 ? `<div style="text-align:center;color:${MUTED};font-size:14px;line-height:1">↓</div>` : "";
      return `<div style="border:2px solid ${color};border-left-width:8px;border-radius:8px;padding:10px 14px;background:${PANEL};${FONT}"><div style="font-weight:600;color:${TEXT}">${escapeHtml(str(l.title))}</div>${l.sub ? `<div style="font-size:13px;color:${MUTED}">${escapeHtml(str(l.sub))}</div>` : ""}${items ? `<div>${items}</div>` : ""}</div>${arrow}`;
    })
    .join('<div style="height:8px"></div>');
  return figure(`<div style="display:flex;flex-direction:column;max-width:720px;margin:0 auto">${rows}</div>`, props.caption);
}

// ---- Timeline ----
export function timeline(props: Record<string, unknown>): string {
  const events = arr<Record<string, unknown>>(props.events);
  if (!events.length) return figure(`<p style="color:${MUTED}">Timeline: no events</p>`);
  const base = accentColor(props.accent, "blue");
  const GAP = 170, n = events.length, W = n * GAP + 40, H = 170;
  let out = `<line x1="20" y1="60" x2="${W - 20}" y2="60" stroke="${BORDER}" stroke-width="3"/>`;
  events.forEach((e, i) => {
    const x = 40 + i * GAP + GAP / 2 - 20;
    const color = accentColor(e.accent, undefined) === ACCENTS.teal && !e.accent ? base : accentColor(e.accent, "blue");
    if (e.deadline) out += `<polygon points="${x},44 ${x + 22},52 ${x},60" fill="${ACCENTS.red}"/><line x1="${x}" y1="44" x2="${x}" y2="76" stroke="${ACCENTS.red}" stroke-width="2"/>`;
    else out += `<circle cx="${x}" cy="60" r="8" fill="${color}"/>`;
    out += textLines(x, 32, [str(e.date)], 11, MUTED, 600);
    const tl = wrapText(str(e.title), GAP - 20, 13).slice(0, 2);
    out += textLines(x, 92, tl, 13, TEXT, 600);
    if (e.description) out += textLines(x, 92 + tl.length * 17, wrapText(str(e.description), GAP - 20, 11).slice(0, 2), 11, MUTED);
  });
  return figure(svg(W, H, out), props.caption);
}

// ---- SequenceDiagram ----
export function sequenceDiagram(props: Record<string, unknown>): string {
  const actors = arr<Record<string, unknown>>(props.actors);
  const messages = arr<Record<string, unknown>>(props.messages);
  if (!actors.length) return figure(`<p style="color:${MUTED}">SequenceDiagram: no actors</p>`);
  const COL = 180, spacing = num(props.messageSpacing, 44), top = 70;
  const W = actors.length * COL + 20, H = top + messages.length * spacing + 60;
  const xOf = new Map(actors.map((a, i) => [String(a.id), 10 + i * COL + COL / 2]));
  const mid = nextMarkerId();
  let out = marker(mid, ACCENTS.slate);
  actors.forEach((a) => {
    const x = xOf.get(String(a.id))!;
    const color = accentColor(a.accent, "navy");
    out += card(x - 70, 10, 140, 40, color);
    out += textLines(x, 35, [str(a.label, String(a.id))], 13, TEXT, 600);
    if (props.lifelines !== false) out += `<line x1="${x}" y1="50" x2="${x}" y2="${H - 20}" stroke="${BORDER}" stroke-width="2" stroke-dasharray="4 4"/>`;
  });
  messages.forEach((m, i) => {
    const y = top + i * spacing;
    const x1 = xOf.get(String(m.from)), x2 = xOf.get(String(m.to));
    if (x1 === undefined || x2 === undefined) return;
    const dash = m.dashed ? ' stroke-dasharray="6 4"' : "";
    if (x1 === x2) {
      out += `<path d="M${x1},${y} h30 v18 h-28" fill="none" stroke="${ACCENTS.slate}" stroke-width="2" marker-end="url(#${mid})"${dash}/>`;
      if (m.label) out += textLines(x1 + 36, y + 13, [str(m.label)], 11, TEXT, 400, "start");
    } else {
      const dir = x2 > x1 ? 1 : -1;
      out += `<line x1="${x1}" y1="${y}" x2="${x2 - dir * 4}" y2="${y}" stroke="${ACCENTS.slate}" stroke-width="2" marker-end="url(#${mid})"${dash}/>`;
      if (m.label) out += textLines((x1 + x2) / 2, y - 6, [str(m.label)], 11, TEXT);
    }
  });
  return figure(svg(W, H, out), props.caption);
}

// ---- Quadrants ----
export function quadrants(props: Record<string, unknown>): string {
  const xa = (props.xAxis ?? {}) as Record<string, unknown>, ya = (props.yAxis ?? {}) as Record<string, unknown>;
  const items = arr<Record<string, unknown>>(props.items);
  const S = 420, P = 50, W = S + 2 * P, H = S + 2 * P;
  let out = `<rect x="${P}" y="${P}" width="${S}" height="${S}" fill="${PANEL}" stroke="${BORDER}" stroke-width="2"/>`;
  out += `<line x1="${P + S / 2}" y1="${P}" x2="${P + S / 2}" y2="${P + S}" stroke="${BORDER}" stroke-width="1.5"/><line x1="${P}" y1="${P + S / 2}" x2="${P + S}" y2="${P + S / 2}" stroke="${BORDER}" stroke-width="1.5"/>`;
  const q = arr<string>(props.quadrants);
  const qpos = [[P + S * 0.25, P + 20], [P + S * 0.75, P + 20], [P + S * 0.25, P + S / 2 + 20], [P + S * 0.75, P + S / 2 + 20]];
  q.slice(0, 4).forEach((label, i) => (out += textLines(qpos[i][0], qpos[i][1], [String(label)], 11, MUTED, 600)));
  out += textLines(P + S / 2, H - 12, [str(xa.label, "x")], 12, TEXT, 600);
  out += textLines(P, H - 28, [str(xa.low)], 10, MUTED, 400, "start") + textLines(P + S, H - 28, [str(xa.high)], 10, MUTED, 400, "end");
  out += `<text x="14" y="${P + S / 2}" text-anchor="middle" font-size="12" font-weight="600" fill="${TEXT}" transform="rotate(-90 14 ${P + S / 2})" style="${FONT}">${escapeHtml(str(ya.label, "y"))}</text>`;
  out += textLines(34, P + S - 4, [str(ya.low)], 10, MUTED, 400, "end") + textLines(34, P + 10, [str(ya.high)], 10, MUTED, 400, "end");
  for (const it of items) {
    const x = P + Math.min(1, Math.max(0, num(it.x, 0.5))) * S, y = P + S - Math.min(1, Math.max(0, num(it.y, 0.5))) * S;
    const color = accentColor(it.accent, "blue");
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${color}"/>` + textLines(x + 10, y + 4, [str(it.label)], 11, TEXT, 500, "start");
  }
  return figure(svg(W, H, out), props.caption);
}

// ---- ActivityDiagram ----
export function activityDiagram(props: Record<string, unknown>): string {
  const nodes = arr<Record<string, unknown>>(props.nodes);
  const edges = arr<Record<string, unknown>>(props.edges);
  if (!nodes.length) return figure(`<p style="color:${MUTED}">ActivityDiagram: no nodes</p>`);
  const RS = num(props.rowSpacing, 92), CS = num(props.columnSpacing, 180);
  // auto grid: row = given or sequential, column = given or 0
  const placed: (Record<string, unknown> & { row: number; column: number })[] = nodes.map((n, i) => ({ ...n, row: num(n.row, i), column: num(n.column, 0) }));
  const maxR = Math.max(...placed.map((p) => p.row)), maxC = Math.max(...placed.map((p) => p.column));
  const W = (maxC + 1) * CS + 40, H = (maxR + 1) * RS + 40;
  const center = (p: { row: number; column: number }) => ({ x: 20 + p.column * CS + CS / 2, y: 20 + p.row * RS + RS / 2 });
  const mid = nextMarkerId();
  let out = marker(mid, ACCENTS.slate);
  const byId = new Map(placed.map((p) => [String(p.id), p]));
  for (const e of edges) {
    const a = byId.get(String(e.from)), b = byId.get(String(e.to));
    if (!a || !b) continue;
    const ca = center(a), cb = center(b);
    const dx = cb.x - ca.x, dy = cb.y - ca.y, d = Math.hypot(dx, dy) || 1;
    const ra = 30, rb = 34;
    const x1 = ca.x + (dx / d) * ra, y1 = ca.y + (dy / d) * ra, x2 = cb.x - (dx / d) * rb, y2 = cb.y - (dy / d) * rb;
    out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${ACCENTS.slate}" stroke-width="2" marker-end="url(#${mid})"/>`;
    if (e.label) {
      const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2 - 6;
      out += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="11" fill="${TEXT}" stroke="${PANEL}" stroke-width="4" paint-order="stroke" style="${FONT}">${escapeHtml(str(e.label))}</text>`;
    }
  }
  for (const p of placed) {
    const { x, y } = center(p);
    const type = str(p.type, "action");
    const label = str(p.label, String(p.id));
    if (type === "start") out += `<circle cx="${x}" cy="${y}" r="12" fill="${TEXT}"/>`;
    else if (type === "end") out += `<circle cx="${x}" cy="${y}" r="14" fill="none" stroke="${TEXT}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="9" fill="${TEXT}"/>`;
    else if (type === "decision") out += `<polygon points="${x},${y - 28} ${x + 40},${y} ${x},${y + 28} ${x - 40},${y}" fill="${PANEL}" stroke="${ACCENTS.gold}" stroke-width="2"/>` + textLines(x, y + 4, [label.slice(0, 14)], 11, TEXT, 600);
    else if (type === "fork" || type === "join") out += `<rect x="${x - 50}" y="${y - 4}" width="100" height="8" fill="${TEXT}"/>`;
    else out += card(x - 70, y - 24, 140, 48, ACCENTS.blue) + textLines(x, y + 4 - (wrapText(label, 120, 12).length - 1) * 7, wrapText(label, 120, 12).slice(0, 2), 12, TEXT, 500);
  }
  return figure(svg(W, H, out), props.caption);
}

// ---- BlockDiagram ----
export interface BlockNode {
  id: string;
  row: number;
  column: number;
  rowSpan?: number;
  title: string;
  sub?: string;
  kicker?: string;
  items?: string[];
  accent?: string;
  dashed?: boolean;
  emphasis?: boolean;
}
export interface BlockEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  accent?: string;
  fromSide?: "top" | "bottom" | "left" | "right";
  toSide?: "top" | "bottom" | "left" | "right";
  fromAt?: number;
  toAt?: number;
  curve?: boolean;
}
const BW = 200, BH = 88, BGX = 60, BGY = 50;
function blockRect(n: BlockNode) {
  return { x: 20 + n.column * (BW + BGX), y: 20 + n.row * (BH + BGY), w: BW, h: BH * (n.rowSpan ?? 1) + BGY * ((n.rowSpan ?? 1) - 1) };
}
function sidePoint(r: { x: number; y: number; w: number; h: number }, side: string, at: number) {
  switch (side) {
    case "top": return { x: r.x + r.w * at, y: r.y };
    case "bottom": return { x: r.x + r.w * at, y: r.y + r.h };
    case "left": return { x: r.x, y: r.y + r.h * at };
    default: return { x: r.x + r.w, y: r.y + r.h * at };
  }
}
/** Route an edge between two block rects: pick facing sides, offset opposite-direction pairs by ±30 px. */
export function routeBlockEdge(from: BlockNode, to: BlockNode, e: BlockEdge, opposite: boolean): { path: string; lx: number; ly: number } {
  const a = blockRect(from), b = blockRect(to);
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  let fromSide = e.fromSide, toSide = e.toSide;
  if (!fromSide || !toSide) {
    if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
      fromSide ??= bcx >= acx ? "right" : "left";
      toSide ??= bcx >= acx ? "left" : "right";
    } else {
      fromSide ??= bcy >= acy ? "bottom" : "top";
      toSide ??= bcy >= acy ? "top" : "bottom";
    }
  }
  const off = opposite ? 30 : 0;
  const vertical = fromSide === "top" || fromSide === "bottom";
  const p1 = sidePoint(a, fromSide, e.fromAt ?? 0.5), p2 = sidePoint(b, toSide, e.toAt ?? 0.5);
  if (opposite) {
    if (vertical) { p1.x += off; p2.x += off; } else { p1.y += off; p2.y += off; }
  }
  let path: string;
  if (e.curve) {
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const cx = vertical ? mx + (opposite ? 40 : 0) : mx, cy = vertical ? my : my + (opposite ? 40 : 0);
    path = `M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}`;
  } else if (vertical) {
    const my = (p1.y + p2.y) / 2;
    path = p1.x === p2.x ? `M${p1.x},${p1.y} L${p2.x},${p2.y}` : `M${p1.x},${p1.y} L${p1.x},${my} L${p2.x},${my} L${p2.x},${p2.y}`;
  } else {
    const mx = (p1.x + p2.x) / 2;
    path = p1.y === p2.y ? `M${p1.x},${p1.y} L${p2.x},${p2.y}` : `M${p1.x},${p1.y} L${mx},${p1.y} L${mx},${p2.y} L${p2.x},${p2.y}`;
  }
  return { path, lx: (p1.x + p2.x) / 2, ly: (p1.y + p2.y) / 2 - 6 };
}
export function blockDiagram(props: Record<string, unknown>): string {
  const nodes = arr<BlockNode>(props.nodes).filter((n) => n && n.id !== undefined);
  const edges = arr<BlockEdge>(props.edges);
  if (!nodes.length) return figure(`<p style="color:${MUTED}">BlockDiagram: no nodes</p>`);
  const rects = nodes.map((n) => ({ n, r: blockRect({ ...n, row: num(n.row, 0), column: num(n.column, 0) }) }));
  const W = Math.max(...rects.map((x) => x.r.x + x.r.w)) + 20, H = Math.max(...rects.map((x) => x.r.y + x.r.h)) + 20;
  const byId = new Map(nodes.map((n) => [String(n.id), { ...n, row: num(n.row, 0), column: num(n.column, 0) }]));
  const pairs = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
  const markers = new Map<string, string>();
  let out = "";
  for (const e of edges) {
    const a = byId.get(String(e.from)), b = byId.get(String(e.to));
    if (!a || !b) continue;
    const color = accentColor(e.accent, "slate");
    if (!markers.has(color)) {
      const id = nextMarkerId();
      markers.set(color, id);
      out += marker(id, color);
    }
    const opposite = pairs.has(`${e.to}\u0000${e.from}`) && String(e.from) > String(e.to);
    const { path, lx, ly } = routeBlockEdge(a, b, e, opposite);
    out += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"${e.dashed ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#${markers.get(color)})"/>`;
    if (e.label) out += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="11" fill="${TEXT}" stroke="${PANEL}" stroke-width="4" paint-order="stroke" style="${FONT}">${escapeHtml(String(e.label))}</text>`;
  }
  for (const { n, r } of rects) {
    const color = accentColor(n.accent, "navy");
    out += card(r.x, r.y, r.w, r.h, color, !!n.dashed, n.emphasis ? color : PANEL);
    const tc = n.emphasis ? "#ffffff" : TEXT, mc = n.emphasis ? "rgba(255,255,255,0.8)" : MUTED;
    let y = r.y + 22;
    if (n.kicker) { out += textLines(r.x + r.w / 2, y, [String(n.kicker).toUpperCase()], 10, mc, 600); y += 16; }
    const tl = wrapText(String(n.title ?? n.id), r.w - 24, 14).slice(0, 2);
    out += textLines(r.x + r.w / 2, y + 2, tl, 14, tc, 700);
    y += 2 + tl.length * 17;
    if (n.sub) { out += textLines(r.x + r.w / 2, y + 2, wrapText(String(n.sub), r.w - 24, 11).slice(0, 2), 11, mc); y += 14; }
    if (Array.isArray(n.items)) out += textLines(r.x + r.w / 2, y + 6, n.items.slice(0, 3).map((i) => `• ${String(i)}`), 11, mc);
  }
  return figure(svg(W, H, out), props.caption);
}
