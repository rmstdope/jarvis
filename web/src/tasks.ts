/** The "Your open tasks" box on the first screen: five rows, tick to finish with a short Undo. */
import { api, type InitiativeRef, type TaskRow } from "./api.ts";
import { append, h, toast } from "./ui.ts";
import { initiativeLabel } from "./pages/common.ts";

export const TASKS_SHOWN = 5;
export const UNDO_MS = 5000;

interface Row { id: string; title: string; done: boolean; initiative?: InitiativeRef; timer?: ReturnType<typeof setTimeout> }
export interface Tasks {
  el: HTMLElement;
  /** Fetch the open tasks (the user's own when a name is known) and redraw. */
  load(owner?: string): Promise<void>;
}

/** Build the box; `undoMs` is how long a ticked row stays visible with "Done · Undo". */
export function createTasks(opts: { undoMs?: number } = {}): Tasks {
  const undoMs = opts.undoMs ?? UNDO_MS;
  const el = h("section", { class: "jv-tasks box" });
  let rows: Row[] = [];
  const draw = () => {
    el.replaceChildren();
    const rowEls = rows.slice(0, TASKS_SHOWN).map((r) => {
      const cb = h("input", { type: "checkbox", checked: r.done, "aria-label": `Mark done: ${r.title}`, onChange: () => (cb.checked ? tick(r) : undo(r)) });
      return h("div", { class: `jv-task${r.done ? " jv-done" : ""}` }, cb,
        h("a", { href: `#/item/${encodeURIComponent(r.id)}`, title: r.title }, r.title),
        r.initiative ? initiativeLabel(r.initiative) : null,
        r.done ? h("span", { class: "jv-donemsg" }, "Done · ", h("button", { class: "jv-undo", onClick: () => undo(r) }, "Undo")) : null);
    });
    append(el, [
      h("h4", {}, `Your open tasks · ${rows.length}`, h("a", { class: "jv-tasks-all", href: "#/tasks" }, "All tasks →")),
      ...(rows.length ? rowEls : [h("p", { class: "muted small" }, "Nothing open — you're all caught up.")]),
      rows.length > TASKS_SHOWN ? h("a", { class: "jv-tasks-more small", href: "#/tasks" }, `+ ${rows.length - TASKS_SHOWN} more`) : null,
    ]);
  };
  function scheduleRemoval(r: Row): void {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => { rows = rows.filter((x) => x !== r); draw(); }, undoMs);
  }
  async function tick(r: Row): Promise<void> {
    r.done = true;
    draw();
    try {
      await api.taskDone(r.id);
      if (r.done) scheduleRemoval(r);
    } catch {
      r.done = false;
      draw();
      toast("Couldn't mark the task done.", "error");
    }
  }
  async function undo(r: Row): Promise<void> {
    if (!r.done) return;
    clearTimeout(r.timer);
    try {
      await api.taskReopen(r.id);
      r.done = false;
    } catch {
      toast("Couldn't reopen the task.", "error");
      scheduleRemoval(r);
    }
    draw();
  }
  return {
    el,
    async load(owner) {
      try {
        const { tasks } = await api.tasks(owner);
        for (const r of rows) clearTimeout(r.timer);
        rows = tasks.map((t: TaskRow) => ({ id: t.id, title: t.title, done: false, initiative: t.initiative }));
      } catch { rows = []; }
      draw();
    },
  };
}
