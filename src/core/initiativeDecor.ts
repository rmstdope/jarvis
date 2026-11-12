import { readDocFile } from "./docs.ts";
import { listInitiatives } from "./initiatives.ts";
import { listTasks } from "./tasks.ts";
import { withDb } from "./db.ts";

/** What a card or task row needs to show its initiative; present only for tasks in an initiative. */
export interface InitiativeRef { id: string; title: string }
/** Progress and facts an initiative card shows, present only on initiative rows. */
export interface InitiativeProgress { done: number; total: number; owner: string; status: "open" | "closed"; closed_at?: string; goal: string; updated_at?: string }

/**
 * Adds `initiative` to task rows and `progress` to initiative rows, so the web cards can show them.
 * Scans the task files (twice at most, for the initiatives' progress) and only when the list holds a task or an initiative; callers pass the whole page of rows in one call.
 */
export function decorateItems<T extends { source: string }>(dataDir: string, items: T[], idOf: (i: T) => string): (T & { initiative?: InitiativeRef; progress?: InitiativeProgress })[] {
  if (!items.some((i) => i.source === "task" || i.source === "initiative")) return items;
  return withDb(dataDir, (db) => {
    const tasks = new Map(listTasks(dataDir, { status: "all", owner: "all", db }).map((t) => [t.id, t]));
    const inis = items.some((i) => i.source === "initiative") ? new Map(listInitiatives(dataDir, { status: "all", db }).map((s) => [s.id, s])) : new Map();
    return items.map((i) => {
      const id = idOf(i);
      if (i.source === "task") {
        const ref = tasks.get(id)?.initiative;
        return ref ? { ...i, initiative: ref } : i;
      }
      const s = i.source === "initiative" ? inis.get(id) : undefined;
      if (!s) return i;
      const doc = readDocFile(dataDir, id);
      return { ...i, progress: { done: s.done, total: s.total, owner: s.owner, status: s.status, closed_at: s.closed_at, goal: doc?.body.trim() ?? "", updated_at: doc ? doc.frontmatter.updated_at ?? doc.frontmatter.created_at : undefined } };
    });
  });
}

/** The initiative of a task with its progress, for the line above a task's title on its tab. */
export function initiativeOfTask(dataDir: string, taskId: string): { id: string; title: string; done: number; total: number } | undefined {
  return withDb(dataDir, (db) => {
    const ref = listTasks(dataDir, { status: "all", owner: "all", db }).find((t) => t.id === taskId)?.initiative;
    if (!ref) return undefined;
    const s = listInitiatives(dataDir, { status: "all", db }).find((x) => x.id === ref.id);
    return s ? { id: s.id, title: s.title, done: s.done, total: s.total } : undefined;
  });
}
