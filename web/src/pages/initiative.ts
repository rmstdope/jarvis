/** One initiative: progress, its tasks, everything tied to it, suggestions, and close / reopen. */
import { api, type InitiativeDetail, type InitiativeSuggestion, type InitiativeTask, type TiedItem } from "../api.ts";
import { entryLine, fmtDate, h, itemHref, modal, toast } from "../ui.ts";
import { UNDO_MS } from "../tasks.ts";
import { emitInitiativeProgress } from "../initiativeBus.ts";
import type { DocCtx, DocPage } from "../docview.ts";
import { progress, statusPill } from "./common.ts";
import { openEditor, type Editor, type EditField } from "./initiativeEdit.ts";

/** How long a ticked row shows "Done · Undo"; tests shorten it. */
export const timing = { undoMs: UNDO_MS };
/** Tied boxes show this many rows before "Show all". */
export const SHOWN = 10;

type Suggest = { state: "loading" } | { state: "nomodel" } | { state: "ready"; items: InitiativeSuggestion[] };
type BoxKey = "through" | "direct" | "suggested";

/** The initiative's tab; a missing initiative throws the 404 the document view turns into its "isn't here any more" state. */
export async function initiativePage(id: string, ctx: DocCtx): Promise<DocPage> {
  let d: InitiativeDetail = await api.initiative(id);
  let suggest: Suggest = { state: "loading" };
  const expanded = new Set<BoxKey>();
  const undoable = new Map<string, ReturnType<typeof setTimeout>>();
  const accepting = new Set<string>();
  const host = h("div", { class: "jv-iread" });
  const counts = () => ({ done: d.tasks.filter((t) => t.status === "done").length, total: d.tasks.length });
  /** Made once: the redraws (suggestions arrive late) must not lose the focus the tab opened with. */
  const heading = h("h1", { class: "jv-dtitle", "data-doc-title": "", tabindex: "-1", title: d.initiative.title }, d.initiative.title);
  let editing: { field: EditField; editor: Editor } | null = null;
  let ownerNames: Promise<string[]> | undefined;
  const announce = () => emitInitiativeProgress(id, counts());

  /** What to focus after a redraw that keeps the cursor where it was (suggestions arrive on their own). */
  function focusKey(): string | undefined {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !host.contains(a)) return undefined;
    if (a === heading) return "title";
    if (a.getAttribute("data-edit")) return `edit:${a.getAttribute("data-edit")}`;
    return a.getAttribute("data-act") ?? (a.getAttribute("data-sug") ? `sug:${a.getAttribute("data-sug")}` : a.getAttribute("data-task") ? `task:${a.getAttribute("data-task")}` : undefined);
  }
  function draw(focus: string | undefined = focusKey()): void {
    const { done, total } = counts();
    const i = d.initiative;
    const closed = i.status === "closed";
    const allDone = !closed && total > 0 && done === total;
    const taskRow = (t: InitiativeTask) => {
      const cb = h("input", { type: "checkbox", checked: t.status === "done", "aria-label": `Mark done: ${t.title}`, "data-task": t.id, onChange: () => (cb.checked ? void tick(t) : void untick(t)) });
      return h("div", { class: `jv-irow${t.status === "done" ? " jv-irow-done" : ""}` }, cb,
        h("a", { href: `#/item/${encodeURIComponent(t.id)}`, title: t.title }, t.title),
        undoable.has(t.id) ? h("span", { class: "jv-idone" }, "Done · ", h("button", { class: "jv-iundo", onClick: () => void untick(t) }, "Undo")) : null,
        h("span", { class: "jv-tw" }, entryLine(t.due, t.owner)));
    };
    const tiedRow = (x: TiedItem, via: boolean) => h("div", { class: "jv-trow" },
      h("a", { href: itemHref({ id: x.id, source: x.source ?? "" }), title: x.title }, x.title),
      via && x.via.length ? h("span", { class: "jv-via" }, `← ${x.via.join(", ")}`) : null,
      via ? null : h("span", { class: "jv-via" }, entryLine(x.source, x.author, fmtDate(x.created_at))));
    const folded = (key: BoxKey, rows: HTMLElement[]) => {
      const more = rows.length > SHOWN;
      const all = expanded.has(key);
      return [...(more && !all ? rows.slice(0, SHOWN) : rows), more ? h("button", { class: "jv-showall", "data-act": `showall:${key}`, onClick: () => { if (all) expanded.delete(key); else expanded.add(key); draw(); } }, all ? "Show fewer" : `Show all ${rows.length}`) : null];
    };
    const ibox = (title: string, hint: string | null, ...body: (Node | null | (Node | null)[])[]) =>
      h("section", { class: "jv-ibox box" }, h("h4", { tabindex: "-1" }, title, hint ? h("span", { class: "jv-hint2" }, ` ${hint}`) : null), ...body);
    const empty = (t: string) => h("div", { class: "muted small jv-trow" }, t);
    const sugRows = suggest.state === "ready" ? suggest.items : [];
    const suggestBody = suggest.state === "loading"
      ? [h("div", { class: "jv-sk-rows" }, h("div", { class: "muted small" }, "Looking for captures that belong…"), h("div", { class: "jv-sk w90" }), h("div", { class: "jv-sk w60" }))]
      : suggest.state === "nomodel" ? [empty("No model is available, so nothing is suggested.")]
      : sugRows.length === 0 ? [empty("Nothing else seems to belong yet.")]
      : folded("suggested", sugRows.map((s) => h("div", { class: "jv-trow jv-sug" }, h("div", { class: "jv-sugmain" }, h("a", { href: itemHref(s), title: s.title }, s.title), h("div", { class: "jv-via" }, s.reason)),
        h("button", { class: "jv-accept", "data-sug": s.id, disabled: accepting.has(s.id) ? "" : null, onClick: () => void accept(s) }, accepting.has(s.id) ? "Accepting…" : "Accept"))));
    const ask = h("button", { onClick: () => ctx.askAbout({ type: "initiative", ids: [id] }, i.title) }, "Ask about this");
    const toggle = h("button", { "data-act": closed ? "reopen" : "close", onClick: () => void (closed ? reopen() : close()) }, closed ? "Reopen" : "Close initiative");
    const kind = h("span", { class: "jv-dkind" }, "Initiative");
    const tail = closed ? `closed ${fmtDate(i.closed_at)} by ${i.closed_by ?? "unknown"}` : entryLine(`started ${fmtDate(i.created_at)}`, i.updated_at ? `updated ${fmtDate(i.updated_at)}` : null);
    const ownerPiece = editing?.field === "owner" ? editing.editor.el : readPiece("owner", "span", "jv-owner", i.owner);
    const meta = h("div", { class: "muted small jv-meta" }, "Initiative · ", ownerPiece, ` · ${tail}`);
    const titlePiece = editing?.field === "title" ? editing.editor.el : readPiece("title", "h2", "jv-title", i.title);
    const goalPiece = editing?.field === "goal" ? editing.editor.el : readPiece("goal", "div", "jv-goal", i.goal);
    const refocusEditor = !!editing && editing.editor.el.contains(document.activeElement);
    host.replaceChildren(
      h("div", { class: "jv-dhead" }, kind, heading, statusPill(closed ? "closed" : "open", "n"), h("span", { class: "jv-igrow" }), toggle, ask),
      h("div", { class: "jv-dbody" },
        h("header", { class: "jv-ihead" },
          titlePiece,
          meta,
          progress(done, total),
          goalPiece,
          closed ? h("div", { class: "jv-closednote muted small" }, `Closed ${fmtDate(i.closed_at)} by ${i.closed_by ?? "unknown"}.`) : null,
          allDone ? h("div", { class: "jv-allnote" }, "✓ All tasks are done. It stays open until someone closes it, since more tasks may come.") : null),
        h("div", { class: "jv-iboxes" },
          ibox(`Tasks · ${total}`, null, total === 0 ? h("div", { class: "jv-empty" }, h("b", {}, "No tasks yet."), h("div", {}, "Add one with ", h("code", {}, `jarvis task add “<title>” --initiative ${id}`))) : h("div", { class: "jv-tasklist" }, ...d.tasks.map(taskRow))),
          ibox(`Through its tasks · ${d.through.total}`, null, ...(d.through.items.length ? folded("through", d.through.items.map((x) => tiedRow(x, true))) : [empty("Nothing is tied to it through its tasks yet.")])),
          ibox(`Linked directly · ${d.direct.total}`, null, ...(d.direct.items.length ? folded("direct", d.direct.items.map((x) => tiedRow(x, false))) : [empty("Nothing is linked to it directly yet.")])),
          ibox(suggest.state === "loading" ? "Suggested" : `Suggested · ${sugRows.length}`, "— not part of it until you accept", ...suggestBody))));
    if (refocusEditor) editing!.editor.focus();
    else if (focus?.startsWith("edit:")) (host.querySelector(`[data-edit="${focus.slice(5)}"]`) as HTMLElement | null)?.focus();
    else if (focus === "title") heading.focus();
    else if (focus === "reopen" || focus === "close") (host.querySelector(`[data-act="${focus}"]`) as HTMLElement | null)?.focus();
    else if (focus?.startsWith("showall:")) (host.querySelector(`[data-act="${focus}"]`) as HTMLElement | null)?.focus();
    else if (focus?.startsWith("sug:")) (host.querySelector(`[data-sug="${focus.slice(4)}"]`) as HTMLElement | null)?.focus();
    else if (focus === "suggested") ([...host.querySelectorAll("h4")].find((x) => x.textContent!.startsWith("Suggested")) as HTMLElement | undefined)?.focus();
    else if (focus?.startsWith("task:")) (host.querySelector(`[data-task="${focus.slice(5)}"]`) as HTMLElement | null)?.focus();
  }

  /** Title, owner or goal as text that opens its editor on click, Enter or Space; the pencil and tooltip come from the styles and the title attribute. */
  function readPiece<K extends "h2" | "span" | "div">(field: EditField, tag: K, cls: string, text: string): HTMLElementTagNameMap[K] {
    return h(tag, { class: `${cls} jv-editable`, "data-edit": field, tabindex: "0", role: "button", title: `Edit ${field}`,
      onClick: () => void startEdit(field),
      onKeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (k === "Enter" || k === " ") { e.preventDefault(); void startEdit(field); } } }, text);
  }
  /** Names that already own an initiative or a task, read the first time an owner is edited. */
  function namesOnce(): Promise<string[]> {
    ownerNames ??= Promise.all([api.initiatives("all"), api.allTasks()]).then(([ini, tasks]) =>
      [...new Set([...ini.initiatives.map((x) => x.owner), ...tasks.tasks.map((x) => x.owner)].filter(Boolean))].sort((a, b) => a.localeCompare(b)), () => []);
    return ownerNames;
  }
  async function saveField(field: EditField, value: string): Promise<void> {
    await api.editInitiative(id, { [field]: value });
    d.initiative = { ...d.initiative, [field]: value, updated_at: new Date().toISOString() };
    if (field === "title") {
      heading.textContent = value;
      heading.title = value;
      ctx.loaded(value, "Initiative");
    }
  }
  /** Open the editor for `field`; one at a time, so an open one is saved first (and stays if it cannot be). */
  async function startEdit(field: EditField): Promise<void> {
    if (editing?.field === field) return;
    if (editing && !(await editing.editor.commit())) return;
    if (editing) return;
    const editor = openEditor({
      field, value: d.initiative[field], save: (v) => saveField(field, v), names: field === "owner" ? namesOnce : undefined,
      done: () => {
        const a = document.activeElement;
        const mine = !a || a === document.body || editor.el.contains(a);
        editing = null;
        draw(mine ? `edit:${field}` : undefined);
      },
    });
    editing = { field, editor };
    draw();
    editor.focus();
  }

  async function setTask(t: InitiativeTask, to: "open" | "done"): Promise<boolean> {
    const was = t.status;
    t.status = to;
    draw(`task:${t.id}`);
    announce();
    try {
      await (to === "done" ? api.taskDone(t.id) : api.taskReopen(t.id));
      return true;
    } catch {
      t.status = was;
      undoable.delete(t.id);
      draw(`task:${t.id}`);
      announce();
      toast(to === "done" ? "Couldn't mark the task done." : "Couldn't reopen the task.", "error");
      return false;
    }
  }
  async function tick(t: InitiativeTask): Promise<void> {
    const timer = setTimeout(() => { undoable.delete(t.id); draw(); }, timing.undoMs);
    undoable.set(t.id, timer);
    if (!(await setTask(t, "done"))) clearTimeout(timer);
  }
  async function untick(t: InitiativeTask): Promise<void> {
    clearTimeout(undoable.get(t.id));
    undoable.delete(t.id);
    await setTask(t, "open");
  }
  async function accept(s: InitiativeSuggestion): Promise<void> {
    accepting.add(s.id);
    draw();
    try {
      await api.link(id, s.id);
      let next: InitiativeSuggestion | undefined;
      if (suggest.state === "ready") {
        const at = suggest.items.findIndex((x) => x.id === s.id);
        const rest = suggest.items.filter((x) => x.id !== s.id);
        next = rest[at] ?? rest[at - 1]; // the one that followed, else the one before
        suggest = { state: "ready", items: rest };
      }
      d.direct = { total: d.direct.total + 1, items: [{ id: s.id, title: s.title, source: s.source, author: s.author ?? null, created_at: new Date().toISOString(), via: [] }, ...d.direct.items] };
      accepting.delete(s.id);
      draw(next ? `sug:${next.id}` : "suggested");
      toast(`Linked to ${d.initiative.title}`);
    } catch {
      accepting.delete(s.id);
      draw();
      toast("Couldn't accept this suggestion.", "error");
    }
  }
  async function doClose(anyway: boolean): Promise<void> {
    try {
      await api.closeInitiative(id, anyway);
    } catch {
      toast("Couldn't close this initiative.", "error");
      return;
    }
    // The close worked: a failed re-read only costs the exact "closed by", never a false error.
    d = await api.initiative(id).catch(() => ({ ...d, initiative: { ...d.initiative, status: "closed" as const, closed_at: new Date().toISOString() } }));
    draw("reopen");
    toast(`Closed: ${d.initiative.title}`);
  }
  function close(): void {
    const { done, total } = counts();
    if (done === total) return void doClose(false);
    modal(`Close “${d.initiative.title}”?`, h("p", {}, `${total - done} of its ${total} tasks are still open. They stay open and stay in the initiative.`), [
      { label: "Cancel", onClick: () => {} },
      { label: "Close anyway", primary: true, onClick: () => void doClose(true) },
    ], "Cancel");
  }
  async function reopen(): Promise<void> {
    try {
      await api.reopenInitiative(id);
    } catch {
      toast("Couldn't reopen this initiative.", "error");
      return;
    }
    d = await api.initiative(id).catch(() => ({ ...d, initiative: { ...d.initiative, status: "open" as const, closed_at: undefined, closed_by: undefined } }));
    draw("close");
    toast(`Reopened: ${d.initiative.title}`);
  }

  draw();
  void api.initiativeSuggest(id).then((r) => { suggest = r.model ? { state: "ready", items: r.suggestions } : { state: "nomodel" }; draw(); }, () => { suggest = { state: "ready", items: [] }; draw(); });
  return { el: host, title: d.initiative.title, kind: "Initiative" };
}
