import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_WORDS, CHUNK_TARGET_WORDS } from "./constants.ts";
import { sha256 } from "./util.ts";

export interface Chunk {
  id: string;
  docId: string;
  seq: number;
  text: string;
}

const WORD_BUDGET = 534; // 400 tokens at 0.75 tokens/word
const OVERLAP = 67; // 50 tokens
void CHUNK_TARGET_WORDS;
void CHUNK_OVERLAP_WORDS;

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}
function wordCount(s: string): number {
  return words(s).length;
}
function lastWords(s: string, n: number): string {
  const w = words(s);
  return w.slice(Math.max(0, w.length - n)).join(" ");
}

function splitSentences(p: string): string[] {
  const m = p.match(/[^.!?]+[.!?]+\s*/g);
  if (m && m.length > 0 && m.join("").trim().length >= p.trim().length * 0.9) return m.map((s) => s.trim()).filter(Boolean);
  // fallback: 534-word windows
  const w = words(p);
  const out: string[] = [];
  for (let i = 0; i < w.length; i += WORD_BUDGET) out.push(w.slice(i, i + WORD_BUDGET).join(" "));
  return out;
}

/** Deterministic paragraph packing with overlap carry. See spec §7.3. */
export function chunkText(body: string): string[] {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  let carry = "";

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n\n");
    chunks.push(text);
    carry = lastWords(text, OVERLAP);
    current = carry ? [carry] : [];
    currentWords = carry ? wordCount(carry) : 0;
  };

  const push = (piece: string) => {
    const wc = wordCount(piece);
    if (currentWords + wc > WORD_BUDGET && current.length > 0 && !(current.length === 1 && current[0] === carry && currentWords + wc <= WORD_BUDGET)) {
      flush();
    }
    if (wc > WORD_BUDGET) {
      // paragraph over budget: flush what we have, then pack sentences
      if (current.length > 0 && !(current.length === 1 && current[0] === carry)) flush();
      for (const s of splitSentences(piece)) {
        const swc = wordCount(s);
        if (currentWords + swc > WORD_BUDGET && current.length > 0) flush();
        current.push(s);
        currentWords += swc;
      }
      return;
    }
    current.push(piece);
    currentWords += wc;
  };

  for (const p of paragraphs) push(p);
  if (current.length > 0 && !(current.length === 1 && current[0] === carry && chunks.length > 0)) {
    chunks.push(current.join("\n\n"));
  }

  // safety pass: max chars
  const safe: string[] = [];
  for (const c of chunks) {
    let rest = c;
    while (rest.length > CHUNK_MAX_CHARS) {
      const window = rest.slice(0, CHUNK_MAX_CHARS);
      let cut = window.lastIndexOf(" ");
      if (cut < CHUNK_MAX_CHARS * 0.85) cut = CHUNK_MAX_CHARS;
      safe.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) safe.push(rest);
  }
  return safe;
}

export function chunkDoc(docId: string, body: string): Chunk[] {
  return chunkText(body).map((text, seq) => ({ id: sha256(docId + seq + text), docId, seq, text }));
}
