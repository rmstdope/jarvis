/** The "As written" view of a text item: the guess of which side to open on, and the per-item choice (jv-nln). */
import { getPref, setPref } from "./prefs.ts";

/** The two sides of an item's text switch. */
export type TextSide = "formatted" | "literal";

const SIGNALS: RegExp[] = [
  /^\s+at\s+\S.*\(.*:\d+\)\s*$/, // a stack frame: `at pkg.Fn(File.java:88)`
  /^\s+at\s+\S+\s+\(.*:\d+(:\d+)?\)\s*$/, // `at fn (file.js:1:2)`
  /^\s+at\s+\S+:\d+(:\d+)?\s*$/, // `at /app/a.js:10:5`
  /^\s*\.\.\. \d+ (more|common frames omitted)\s*$/,
  /^\s*(\d{4}-\d\d-\d\d[T ]|\[?\d\d:\d\d:\d\d)/, // a timestamp
  /^\s*\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/, // a log level
  /^\s*File ".*", line \d+/, // a Python frame
];

const INDENTED = /^(\t| {4})\s*(?![-*+>] |\d+[.)] |$)\S/; // deeply indented and not a nested list item

/** True when `body` looks like a log or stack trace: a run of two indented lines, at least three signal lines, or two stack frames. */
export function looksLikeLog(body: string): boolean {
  let hits = 0, frames = 0, run = 0;
  for (const line of body.split("\n")) {
    const i = SIGNALS.findIndex((r) => r.test(line));
    const frame = i === 0 || i === 1 || i === 2 || i === 6;
    run = INDENTED.test(line) || frame ? run + 1 : 0; // a frame line counts as indented: a one-frame Python traceback is `File` + one code line
    if (run >= 2) return true;
    if (i < 0) continue;
    hits++;
    if (frame) frames++;
  }
  return hits >= 3 || frames >= 2;
}

const key = (id: string): string => `jv.text.${id}`;
/** The side the person last pressed for this item in this browser, or null when they never did. */
export function textSidePref(id: string): TextSide | null {
  const v = getPref(key(id));
  return v === "formatted" || v === "literal" ? v : null;
}
/** Remember the side pressed for this item in this browser. */
export function setTextSidePref(id: string, side: TextSide): void { setPref(key(id), side); }
