import type { InitiativeDetail, InitiativeSummary, TiedSection } from "./initiatives.ts";
import type { Suggestion, TaskItem } from "./tasks.ts";

/** Text styling; plain by default so piped and agent output carries no escape codes. */
export interface Style {
  dim(s: string): string;
  bold(s: string): string;
}
export const PLAIN: Style = { dim: (s) => s, bold: (s) => s };
export const ANSI: Style = { dim: (s) => `\x1b[2m${s}\x1b[22m`, bold: (s) => `\x1b[1m${s}\x1b[22m` };

const BAR_CELLS = 9;
/** Nine-cell progress bar; started-but-unfinished work never reads as empty or full. */
export function progressBar(done: number, total: number): string {
  if (total === 0) return "░".repeat(BAR_CELLS);
  let filled = Math.round((done / total) * BAR_CELLS);
  if (done > 0 && done < total) filled = Math.min(BAR_CELLS - 1, Math.max(1, filled));
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/** One task line, shared by `task list`, `tasks` and `initiative show`. */
export function taskLine(t: TaskItem): string {
  return `${t.id}  ${t.status === "done" ? "✓" : "○"} ${t.due ? `due ${t.due} ` : ""}${t.title}  (${t.owner})${t.links === 0 ? "  ⚠ no links" : ""}`;
}
export function taskListLine(t: TaskItem, s: Style): string {
  return taskLine(t) + (t.initiative ? "  " + s.dim(`· ${t.initiative.title}`) : "");
}

/** The `jarvis link` line for an initiative and its own task: nothing was linked, and the whole explanation is dim. */
export function memberLinkLine(r: { task?: string; title?: string; initiative?: string }, s: Style): string {
  return `${r.task}  ${r.title}  ${s.dim(`is already a task in ${r.initiative} — nothing linked`)}`;
}

const day = (iso?: string): string => (iso ?? "").slice(0, 10);

/** `jarvis initiative list` output. */
export function formatInitiativeList(list: InitiativeSummary[], s: Style, status: "open" | "closed" | "all" = "open"): string {
  if (list.length === 0 && status === "closed") return "no closed initiatives";
  if (list.length === 0 && status === "all") return 'no initiatives — start one: jarvis initiative add "<title>" --goal "<what done looks like>"';
  if (list.length === 0) return 'no open initiatives — start one: jarvis initiative add "<title>" --goal "<what done looks like>"';
  return list
    .map((i) => {
      let line = `${i.id}  ${progressBar(i.done, i.total)}  ${`${i.done}/${i.total}`.padEnd(4)}  ${i.title}  (${i.owner})`;
      if (i.status === "closed") return s.dim(`${line}  closed ${day(i.closed_at)}`);
      if (i.total === 0) line += "  " + s.dim("no tasks yet");
      else if (i.done === i.total) line += "  ✓ all tasks done — close it?";
      return line;
    })
    .join("\n");
}

function tied(name: string, sec: TiedSection, id: string, s: Style, withVia: boolean): string[] {
  if (sec.total === 0) return [`${name} — none`];
  const out = [`${name} (${sec.total})`];
  for (const i of sec.items) out.push(`  ${i.id}  ${i.title}` + (withVia && i.via.length ? "  " + s.dim(`← ${i.via.join(", ")}`) : ""));
  if (sec.total > sec.items.length) out.push("  " + s.dim(`… and ${sec.total - sec.items.length} more — jarvis initiative show ${id} --all`));
  return out;
}

/** `jarvis initiative suggest` lines: ready `jarvis link` commands with a dim comment. */
export function suggestionLines(id: string, sug: Suggestion[], s: Style): string[] {
  return sug.map((x) => `  jarvis link ${id} ${x.id}   ` + s.dim(`# ${x.title} — ${x.reason}`));
}

/** `jarvis initiative show` output; `suggested` is null when no model is available. */
export function formatInitiativeShow(d: InitiativeDetail, suggested: Suggestion[] | null, s: Style): string {
  const i = d.initiative;
  const bar = progressBar(i.done, i.total);
  const progress = i.total === 0 ? "no tasks yet" : `${bar} ${i.done} of ${i.total} done`;
  const status = i.status === "closed" ? `closed ${day(i.closed_at)} by ${i.closed_by ?? "unknown"}` : "open";
  const out = [s.bold(i.title), `${status}  owner: ${i.owner}  progress: ${progress}`];
  if (i.status === "open" && i.total > 0 && i.done === i.total) out.push(`✓ all tasks done — close it with: jarvis initiative close ${i.id}`);
  out.push("", i.goal, "");
  out.push(d.tasks.length ? `tasks (${d.tasks.length})` : `tasks — none yet: jarvis task add "<title>" --initiative ${i.id}`);
  for (const t of d.tasks) out.push(`  ${taskLine(t)}`);
  out.push("", ...tied("through its tasks", d.through, i.id, s, true), "", ...tied("linked directly", d.direct, i.id, s, false), "");
  if (suggested === null) out.push("suggested — none: no model is available, so nothing is suggested (jarvis doctor shows why)");
  else if (suggested.length === 0) out.push("suggested — none found");
  else out.push(`suggested (${suggested.length})  ` + s.dim("— not part of it until you accept"), ...suggestionLines(i.id, suggested, s));
  return out.join("\n");
}

/** The three lines after `✓ done:` when the last open task of an initiative was finished. */
export function lastTaskNotice(c: { id: string; title: string; done: number; total: number }): string {
  return `  That was the last open task in ${c.title} (${c.done} of ${c.total} done).\n  It stays open until someone closes it:\n    jarvis initiative close ${c.id}`;
}
