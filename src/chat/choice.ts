/**
 * Telling same-titled items apart for the user (jv-bt4): the one detail that distinguishes them
 * (date, time or first line), in the words of a button, a message and a source link. DOM-free.
 */

/** One item the user can choose; `detail` is the button's second line, `tail` follows the title in the message a press sends, `chip` follows " · " in a source link. */
export interface ChoiceOption { id: string; title: string; detail: string; tail: string; chip: string }

/** What the chat asks the user, recorded on a change row that waits for the answer. */
export interface ChangeAsk {
  /** The tool the chat could not run yet. */
  tool: string;
  /** The title the items share. */
  title: string;
  /** The kind (source) of the items. */
  source: string;
  /** Whether every item was created on one day. */
  sameDay: boolean;
  /** The items, newest first. */
  options: ChoiceOption[];
}

/** The refusal of a pick among same-titled items; `runTool` turns it into a waiting row. */
export class AmbiguousPick extends Error {
  constructor(public ask: ChangeAsk) {
    super(`${ask.options.length} items are called "${ask.title}"`);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/** "5 Nov", with the year when it is not `now`'s. */
const dateWords = (d: Date, now: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
/** The first non-empty line of a body, markdown heading marks removed; "" when there is none. */
export function firstLine(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^#{1,6}\s+/, "").trim();
}
/** At most 20 characters, cut at a word end, with "…" when cut. */
const cut = (s: string): string => {
  if (s.length <= 20) return s;
  const head = s.slice(0, 21);
  const at = head.lastIndexOf(" ");
  return `${(at > 0 ? head.slice(0, at) : s.slice(0, 20)).trimEnd()}…`;
};

/** The options for items sharing a title, newest first, each with the one detail kind that tells the whole group apart. */
export function distinguish(rows: { id: string; title: string; created_at: string; body: string }[], now: Date = new Date()): ChoiceOption[] {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => ({ r, at: new Date(r.created_at) }));
  const days = sorted.map((x) => dayKey(x.at));
  const times = sorted.map((x) => clock(x.at));
  const distinct = (xs: string[]): boolean => new Set(xs).size === xs.length;
  const mode = distinct(days) ? "date" : new Set(days).size === 1 && distinct(times) ? "time" : "line";
  return sorted.map(({ r, at }) => {
    if (mode === "date") { const w = dateWords(at, now); return { id: r.id, title: r.title, detail: `from ${w}`, tail: ` from ${w}`, chip: w }; }
    if (mode === "time") { const t = clock(at); return { id: r.id, title: r.title, detail: t, tail: ` at ${t}`, chip: t }; }
    const line = firstLine(r.body);
    if (!line) return { id: r.id, title: r.title, detail: "(empty)", tail: " — (empty)", chip: "(empty)" };
    return { id: r.id, title: r.title, detail: `“${line}”`, tail: ` — “${line}”`, chip: `“${cut(line)}”` };
  });
}
/** Whether all the items were created on one day (local time). */
export function onOneDay(rows: { created_at: string }[]): boolean {
  return new Set(rows.map((r) => dayKey(new Date(r.created_at)))).size === 1;
}
