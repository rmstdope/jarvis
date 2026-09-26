/**
 * Briefing body parser: Markdown interleaved with PascalCase component tags.
 * Hand-rolled recursive descent, pure and DOM-free (runs in CLI, server and browser).
 */
export type Node =
  | { type: "markdown"; content: string }
  | { type: "raw"; content: string }
  | { type: "component"; name: string; props: Record<string, unknown>; children: Node[]; selfClosing?: boolean; line: number };

export class BriefingParseError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

const RAW_CHILDREN = new Set(["SvgDiagram", "FlowDiagram"]);

/** Lenient JSON: unquoted keys, trailing commas, single-quoted strings. No JS expressions. */
export function parseLenientJson(src: string): unknown {
  let i = 0;
  const err = (m: string) => new Error(`${m} at offset ${i} in {${src}}`);
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const str = (q: string): string => {
    i++;
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        i++;
        const c = src[i];
        out += c === "n" ? "\n" : c === "t" ? "\t" : c;
      } else out += src[i];
      i++;
    }
    if (src[i] !== q) throw err("unterminated string");
    i++;
    return out;
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === "}") {
          i++;
          return o;
        }
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = str(src[i]);
        else {
          const m = src.slice(i).match(/^[A-Za-z_$][\w$-]*/);
          if (!m) throw err("expected key");
          key = m[0];
          i += m[0].length;
        }
        ws();
        if (src[i] !== ":") throw err("expected :");
        i++;
        o[key] = value();
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") throw err("expected , or }");
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") {
          i++;
          return a;
        }
        a.push(value());
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") throw err("expected , or ]");
      }
    }
    if (c === '"' || c === "'") return str(c);
    const m = src.slice(i).match(/^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/);
    if (!m) throw err("unexpected token");
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    if (m[0] === "null") return null;
    return Number(m[0]);
  };
  const v = value();
  ws();
  if (i !== src.length) throw err("trailing characters");
  return v;
}

interface Tag {
  name: string;
  props: Record<string, unknown>;
  selfClosing: boolean;
  closing: boolean;
  end: number; // index after '>'
}

function lineCol(src: string, idx: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      last = i;
    }
  }
  return { line, column: idx - last };
}

/** Try to read a tag at `pos` (src[pos] === '<'). Returns null when it is not a component tag. */
function readTag(src: string, pos: number): Tag | null {
  let i = pos + 1;
  let closing = false;
  if (src[i] === "/") {
    closing = true;
    i++;
  }
  const m = src.slice(i).match(/^[A-Z][A-Za-z0-9]*/);
  if (!m) return null;
  const name = m[0];
  i += name.length;
  const props: Record<string, unknown> = {};
  const { line, column } = lineCol(src, pos);
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) throw new BriefingParseError(`unterminated <${name}> tag`, line, column);
    if (src[i] === ">") return { name, props, selfClosing: false, closing, end: i + 1 };
    if (src[i] === "/" && src[i + 1] === ">") return { name, props, selfClosing: true, closing, end: i + 2 };
    if (closing) throw new BriefingParseError(`closing tag </${name}> cannot have attributes`, line, column);
    const am = src.slice(i).match(/^[A-Za-z_][\w-]*/);
    if (!am) throw new BriefingParseError(`bad attribute in <${name}>`, line, column);
    const attr = am[0];
    i += attr.length;
    while (i < src.length && /[ \t]/.test(src[i])) i++;
    if (src[i] !== "=") {
      props[attr] = true;
      continue;
    }
    i++;
    while (i < src.length && /[ \t]/.test(src[i])) i++;
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      if (end < 0) throw new BriefingParseError(`unterminated attribute ${attr} in <${name}>`, line, column);
      props[attr] = src.slice(i + 1, end);
      i = end + 1;
    } else if (q === "{") {
      let depth = 0;
      let j = i;
      let inStr: string | null = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (inStr) {
          if (c === "\\") j++;
          else if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'") inStr = c;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new BriefingParseError(`unterminated {…} for attribute ${attr} in <${name}>`, line, column);
      try {
        props[attr] = parseLenientJson(src.slice(i + 1, j));
      } catch (e) {
        throw new BriefingParseError(`invalid JSON for attribute ${attr} in <${name}>: ${(e as Error).message}`, line, column);
      }
      i = j + 1;
    } else throw new BriefingParseError(`attribute ${attr} in <${name}> needs a quoted or {json} value`, line, column);
  }
}

export function parseBriefingBody(src: string): Node[] {
  let pos = 0;
  const parseChildren = (parent: Tag | null, parentStart: number): { nodes: Node[]; closed: boolean } => {
    const nodes: Node[] = [];
    let text = "";
    const flushText = () => {
      if (text.trim()) nodes.push({ type: "markdown", content: text });
      text = "";
    };
    while (pos < src.length) {
      const lt = src.indexOf("<", pos);
      const fence = src.indexOf("```", pos);
      if (fence >= 0 && (lt < 0 || fence < lt)) {
        const close = src.indexOf("```", fence + 3);
        const end = close < 0 ? src.length : close + 3;
        text += src.slice(pos, end);
        pos = end;
        continue;
      }
      if (lt < 0) {
        text += src.slice(pos);
        pos = src.length;
        break;
      }
      text += src.slice(pos, lt);
      const tag = readTag(src, lt);
      if (!tag) {
        text += "<";
        pos = lt + 1;
        continue;
      }
      if (tag.closing) {
        if (parent && parent.name === tag.name) {
          flushText();
          pos = tag.end;
          return { nodes, closed: true };
        }
        text += src.slice(lt, tag.end); // stray closer passes through as Markdown
        pos = tag.end;
        continue;
      }
      flushText();
      const { line, column } = lineCol(src, lt);
      pos = tag.end;
      if (tag.selfClosing) {
        nodes.push({ type: "component", name: tag.name, props: tag.props, children: [], selfClosing: true, line });
        continue;
      }
      if (RAW_CHILDREN.has(tag.name)) {
        const closeTag = `</${tag.name}>`;
        const close = src.indexOf(closeTag, pos);
        if (close < 0) throw new BriefingParseError(`unclosed <${tag.name}>`, line, column);
        nodes.push({ type: "component", name: tag.name, props: tag.props, children: [{ type: "raw", content: src.slice(pos, close) }], line });
        pos = close + closeTag.length;
        continue;
      }
      const inner = parseChildren(tag, lt);
      if (!inner.closed) throw new BriefingParseError(`unclosed <${tag.name}>`, line, column);
      nodes.push({ type: "component", name: tag.name, props: tag.props, children: inner.nodes, line });
    }
    flushText();
    if (parent) {
      const { line, column } = lineCol(src, parentStart);
      throw new BriefingParseError(`unclosed <${parent.name}>`, line, column);
    }
    return { nodes, closed: false };
  };
  return parseChildren(null, 0).nodes;
}
