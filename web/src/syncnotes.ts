/** What a sync has to tell the user, as cards for the sidebar (jv-5b3). DOM-free: the shell draws them. */
import type { SyncStepFailure } from "./api.ts";
import { delPref, getPref, KEY_SYNC_NOTES, setPref } from "./prefs.ts";

/** The fix a card offers: the sync's own words split around the command, so the shell can show it as code. */
export interface SyncFix { before: string; command: string; after: string }
/** One note from a sync: a plain heading, the sync's message unchanged, and a fix where there is one. */
export interface SyncCard { heading: string; body: string; fix?: SyncFix }

const STEP: Record<string, { label: string; unit: string; heading: string }> = {
  enrich: { label: "enrichment", unit: "item(s)", heading: "Some items weren't enriched" },
  refine: { label: "link refinement", unit: "batch(es)", heading: "Some links weren't refined" },
};

function headingFor(note: string): string {
  if (/could not be loaded|model steps skipped/.test(note)) return "AI steps skipped";
  if (note.startsWith("push failed")) return "Couldn't share your work";
  if (note.startsWith("pull failed")) return "Couldn't get teammates' changes";
  if (note.includes("source_url collision")) return "Duplicates found";
  if (/^(embedding server|ollama embed|omlx embed)/.test(note)) return "Search by meaning unavailable";
  return "Note from sync";
}
/** Split fix text around its command: the first backticked span, else the first `jarvis <word>`. */
function fixFrom(text: string): SyncFix | undefined {
  const m = /`([^`]+)`/.exec(text) ?? /\bjarvis [a-z][\w-]*/.exec(text);
  if (!m) return undefined;
  return { before: text.slice(0, m.index), command: m[1] ?? m[0], after: text.slice(m.index + m[0].length) };
}
function cardFromNote(note: string): SyncCard {
  const m = /\n?fix: (.*)$/s.exec(note);
  const body = m ? note.slice(0, m.index) : note;
  const fix = fixFrom(m ? m[1]! : body.slice(Math.max(0, body.indexOf("run `"))));
  return { heading: headingFor(body), body, ...(fix && (m || body.includes("run `")) ? { fix } : {}) };
}
/** The cards for a sync that went through: its notes in order, then each failed model step. */
export function cardsFromSync(r: { notes: string[]; failures?: SyncStepFailure[] }): SyncCard[] {
  const cards = r.notes.map(cardFromNote);
  for (const f of r.failures ?? []) {
    const s = STEP[f.step] ?? { label: f.step, unit: "time(s)", heading: "Note from sync" };
    const body = `${s.label} failed for ${f.failed} ${s.unit}${f.reason ? `: ${f.reason.replace(/\.$/, "")}` : ""}`;
    cards.push({ heading: s.heading, body, ...(f.doctor ? { fix: { before: "run ", command: "jarvis doctor", after: "" } } : {}) });
  }
  return cards;
}

const isCard = (c: unknown): c is SyncCard => !!c && typeof c === "object" && typeof (c as SyncCard).heading === "string" && typeof (c as SyncCard).body === "string";
/** The cards left open in this browser; none when nothing (or nonsense) is stored. */
export function loadCards(): SyncCard[] {
  try {
    const v: unknown = JSON.parse(getPref(KEY_SYNC_NOTES) ?? "[]");
    return Array.isArray(v) && v.every(isCard) ? v : [];
  } catch { return []; }
}
/** Remember the open cards so a reload still shows an unfixed problem; none forgets them. */
export function saveCards(cards: SyncCard[]): void {
  if (cards.length) setPref(KEY_SYNC_NOTES, JSON.stringify(cards)); else delPref(KEY_SYNC_NOTES);
}
