/** Transcript parsers shared by the meeting producer: Teams .vtt and pasted .md/.txt. */

interface Cue {
  speaker: string | null;
  text: string;
}

function coalesce(cues: Cue[]): string {
  const paras: string[] = [];
  let cur: Cue | null = null;
  for (const c of cues) {
    if (!c.text) continue;
    if (cur && cur.speaker === c.speaker) cur.text += " " + c.text;
    else {
      if (cur) paras.push(cur.speaker ? `${cur.speaker}: ${cur.text}` : cur.text);
      cur = { ...c };
    }
  }
  if (cur) paras.push(cur.speaker ? `${cur.speaker}: ${cur.text}` : cur.text);
  return paras.join("\n\n");
}

/** Teams .vtt: blocks split on blank lines; a block containing `-->` is a cue; `<v Speaker>text</v>` spans. */
export function parseTeamsVtt(text: string): string {
  const blocks = text.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const payload = lines.slice(i + 1).join(" ").trim();
    if (!payload) continue;
    const spans = [...payload.matchAll(/<v\s+([^>]*)>([\s\S]*?)(?:<\/v>|$)/g)];
    if (spans.length) {
      for (const s of spans) cues.push({ speaker: s[1].trim() || null, text: s[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() });
    } else cues.push({ speaker: null, text: payload.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() });
  }
  return coalesce(cues);
}

const TIMESTAMP = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?$/i;

function looksLikeSpeaker(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  if (/[.!?,;:]$/.test(t)) return false;
  const caps = words.filter((w) => /^[A-ZÅÄÖ]/.test(w)).length;
  return caps / words.length >= 0.5;
}

/**
 * Pasted transcript (.md/.txt): recognises `Name   1:23` or `Name` + next-line timestamp,
 * drops strays, coalesces same-speaker runs; no structure → verbatim text.
 */
export function parsePastedTranscript(text: string): string {
  const lines = text.split(/\r?\n/);
  const cues: Cue[] = [];
  let speaker: string | null = null;
  let buf: string[] = [];
  let found = false;
  const flush = () => {
    if (buf.length && speaker) cues.push({ speaker, text: buf.join(" ").replace(/\s+/g, " ").trim() });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const inline = line.match(/^(.+?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?)$/i);
    if (inline && looksLikeSpeaker(inline[1])) {
      flush();
      speaker = inline[1].trim();
      found = true;
      continue;
    }
    const next = lines[i + 1]?.trim() ?? "";
    if (looksLikeSpeaker(line) && TIMESTAMP.test(next)) {
      flush();
      speaker = line;
      found = true;
      i++;
      continue;
    }
    if (TIMESTAMP.test(line)) continue;
    if (speaker) buf.push(line);
  }
  flush();
  if (!found) return text.trim();
  return coalesce(cues);
}
