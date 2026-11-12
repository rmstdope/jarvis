/** Pure logic of the chat box's `@path` completion: finding the mention, splitting and narrowing paths. */
export interface Mention { start: number; end: number; raw: string }
export interface DirEntry { name: string; dir: boolean }

const isSpace = (c: string): boolean => /\s/.test(c);
/** True when the character at `i` is a space escaped by a backslash. */
const escaped = (t: string, i: number): boolean => i > 0 && t[i - 1] === "\\" && t[i] === " ";

/**
 * The `@path` the caret is in: an `@` at the start of a word (start of text or after white space) and the
 * rest of that word, where a backslash-escaped space belongs to the word. `raw` is the text between the `@`
 * and the caret (still escaped); `end` is where the word ends.
 */
export function findMention(text: string, caret: number): Mention | null {
  let s = caret;
  while (s > 0 && (!isSpace(text[s - 1]) || escaped(text, s - 1))) s--;
  if (s >= caret || text[s] !== "@") return null;
  let end = caret;
  while (end < text.length && (!isSpace(text[end]) || escaped(text, end))) end++;
  return { start: s, end, raw: text.slice(s + 1, caret) };
}
/** Split what follows the `@` into the folder (up to the last `/`) and the typed name part, escapes undone. */
export function splitPath(raw: string): { dir: string; prefix: string } {
  const i = raw.lastIndexOf("/") + 1;
  const un = (s: string): string => s.replace(/\\ /g, " ");
  return { dir: un(raw.slice(0, i)), prefix: un(raw.slice(i)) };
}
/** A backslash before each space. */
export function escapePath(s: string): string {
  return s.replace(/ /g, "\\ ");
}
/** Entries whose name starts with `prefix`, ignoring case; dot names only when `prefix` itself starts with a dot. */
export function narrow(entries: DirEntry[], prefix: string): DirEntry[] {
  const p = prefix.toLowerCase();
  return entries.filter((e) => (p.startsWith(".") || !e.name.startsWith(".")) && e.name.toLowerCase().startsWith(p));
}
/** The panel header: `Team content` at the top of the content, else the path so far. */
export function headerFor(dir: string): string {
  return dir === "" ? "Team content" : dir;
}
/** Cut a long name in the middle with `…`, keeping the start and the tail (date, extension). */
export function middleCut(name: string, max: number): string {
  if (name.length <= max) return name;
  const tail = Math.ceil((max - 1) * 0.45), head = max - 1 - tail;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}
