/** One initiative: progress, its tasks, everything tied to it, suggestions, and close / reopen. */
import { api, type InitiativeDetail, type InitiativeSuggestion, type InitiativeTask, type TiedItem } from "../api.ts";
import { entryLine, fmtDate, h, itemHref, modal, toast } from "../ui.ts";
import { UNDO_MS } from "../tasks.ts";
import { type Ctx, type Page, progress, statusPill, trail } from "./common.ts";

/** How long a ticked row shows "Done · Undo"; tests shorten it. */
export const timing = { undoMs: UNDO_MS };
/** Tied boxes show this many rows before "Show all". */
export const SHOWN = 10;

type Suggest = { state: "loading" } | { state: "nomodel" } | { state: "ready"; items: InitiativeSuggestion[] };
type BoxKey = "through" | "direct" | "suggested";

/** The initiative page; a missing initiative throws the 404 the router turns into the "couldn't find that" box. */
export async function viewInitiative(ctx: Ctx, id: string, from?: string): Page {
  let d: InitiativeDetail = await api.initiative(id);
  let suggest: Suggest = { state: "loading" };
  const expanded = new Set<BoxKey>();
  const undoable = new Map<string, ReturnType<typeof setTimeout>>();
  const accepting = new Set<string>();
  const host = h("div", { class: "jv-read jv-iread" });
  const wrap = h("div", {}, trail(from === "browse" ? "Browse & search" : "Initiatives", from === "browse" ? "#/browse" : "#/initiatives", d.initiative.title), host);
  ctx.main.append(wrap);

  const counts = () => ({ done: d.tasks.filter((t) => t.status === "done").length, total: d.tasks.length });

  /** What to focus after a redraw that keeps the cursor where it was (suggestions arrive on their own). */
  function focusKey(): string | undefined {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !host.contains(a)) return undefined;
    return a.getAttribute("data-act") ?? (a.getAttribute("data-task") ? `task:${a.getAttribute("data-task")}` : undefined);
  }
  function draw(focus: string | undefined = focusKey()): void {
    const { done, total } = counts();
    const i = d.initiative;
    const closed = i.status === "closed";
    const allDone = !closed && total > 0 && done === total;
    const taskRow = (t: InitiativeTask) => {
      const cb = h("input", { type: "checkbox", checked: t.status === "done", "aria-label": `Mark done: ${t.title}`, "data-task": t.id, onChange: () => (cb.checked ? void tick(t) : void untick(t)) });
      return h("div", { class: `jv-irow${t.status === "done" ? " jv-irow-done" : ""}` }, cb,
        h("a", { href: `#/item/${encodeURIComponent(t.id)}?from=${encodeURIComponent(id)}`, title: t.title }, t.title),
        undoable.has(t.id) ? h("span", { class: "jv-idone" }, "Done · ", h("button", { class: "jv-iundo", onClick: () => void untick(t) }, "Undo")) : null,
        h("span", { class: "jv-tw" }, entryLine(t.due, t.owner)));
    };
    const tiedRow = (x: TiedItem, via: boolean) => h("div", { class: "jv-trow" },
      h("a", { href: itemHref({ id: x.id, source: x.source ?? "" }), title: x.title }, x.title),
      via && x.via.length ? h("span", { class: "jv-via" }, `← ${x.via.join(", ")}`) : null,
      via ? null : h("span", { class: "jv-via" }, entryLine(x.source, fmtDate(x.created_at))));
    const folded = (key: BoxKey, rows: HTMLElement[]) => {
      const more = rows.length > SHOWN;
      const all = expanded.has(key);
      return [...(more && !all ? rows.slice(0, SHOWN) : rows), more ? h("button", { class: "jv-showall", onClick: () => { if (all) expanded.delete(key); else expanded.add(key); draw(); } }, all ? "Show fewer" : `Show all ${rows.length}`) : null];
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
    const status = closed ? `closed ${fmtDate(i.closed_at)} by ${i.closed_by ?? "unknown"}` : `open · started ${fmtDate(i.created_at)}`;
    const ask = h("button", { class: "primary jv-wide", onClick: () => ctx.chat.askAbout({ type: "initiative", ids: [id] }, i.title) }, "Ask about this");
    const blk = (name: string, ...body: (Node | string)[]) => h("div", { class: "jv-blk" }, h("h5", {}, name), ...body);
    const toggle = h("button", { class: "jv-wide jv-closebtn", "data-act": closed ? "reopen" : "close", onClick: () => void (closed ? reopen() : close()) }, closed ? "Reopen" : "Close initiative");
    const panel = h("aside", { class: "jv-panel" }, ask, blk("Owner", i.owner), blk("Status", status), blk("Progress", progress(done, total, { small: true })), h("div", { class: "jv-blk" }, toggle));
    host.replaceChildren(
      h("article", {},
        h("h1", { class: "jv-title" }, i.title),
        h("div", { class: "jv-meta" }, `${entryLine("initiative", i.owner)} · `, statusPill(closed ? "closed" : "open", closed ? "n" : "g")),
        progress(done, total),
        h("div", { class: "jv-goal" }, i.goal),
        closed ? h("div", { class: "jv-closednote muted small" }, `Closed ${fmtDate(i.closed_at)} by ${i.closed_by ?? "unknown"}.`) : null,
        allDone ? h("div", { class: "jv-allnote" }, "✓ All tasks are done. It stays open until someone closes it, since more tasks may come.") : null,
        ibox(`Tasks · ${total}`, null, total === 0 ? h("div", { class: "jv-empty" }, h("b", {}, "No tasks yet."), h("div", {}, "Add one with ", h("code", {}, `jarvis task add “<title>” --initiative ${id}`))) : h("div", { class: "jv-tasklist" }, ...d.tasks.map(taskRow))),
        ibox(`Through its tasks · ${d.through.total}`, null, ...(d.through.items.length ? folded("through", d.through.items.map((x) => tiedRow(x, true))) : [empty("Nothing is tied to it through its tasks yet.")])),
        ibox(`Linked directly · ${d.direct.total}`, null, ...(d.direct.items.length ? folded("direct", d.direct.items.map((x) => tiedRow(x, false))) : [empty("Nothing is linked to it directly yet.")])),
        ibox(suggest.state === "loading" ? "Suggested" : `Suggested · ${sugRows.length}`, "— not part of it until you accept", ...suggestBody)),
      panel);
    if (focus === "reopen" || focus === "close") (host.querySelector(`[data-act="${focus}"]`) as HTMLElement | null)?.focus();
    else if (focus === "suggested") (host.querySelector(".jv-accept:not([disabled])") as HTMLElement ?? [...host.querySelectorAll("h4")].find((x) => x.textContent!.startsWith("Suggested")))?.focus();
    else if (focus?.startsWith("task:")) (host.querySelector(`[data-task="${focus.slice(5)}"]`) as HTMLElement | null)?.focus();
  }

  async function setTask(t: InitiativeTask, to: "open" | "done"): Promise<boolean> {
    const was = t.status;
    t.status = to;
    draw(`task:${t.id}`);
    try {
      await (to === "done" ? api.taskDone(t.id) : api.taskReopen(t.id));
      return true;
    } catch {
      t.status = was;
      undoable.delete(t.id);
      draw(`task:${t.id}`);
      toast(to === "done" ? "Couldn't mark the task done." : "Couldn't reopen the task.", "error");
      return false;
    }
  }
  async function tick(t: InitiativeTask): Promise<void> {
    undoable.set(t.id, setTimeout(() => { undoable.delete(t.id); draw(); }, timing.undoMs));
    if (!(await setTask(t, "done"))) clearTimeout(undoable.get(t.id));
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
      if (suggest.state === "ready") suggest = { state: "ready", items: suggest.items.filter((x) => x.id !== s.id) };
      d.direct = { total: d.direct.total + 1, items: [{ id: s.id, title: s.title, source: s.source, created_at: new Date().toISOString(), via: [] }, ...d.direct.items] };
      accepting.delete(s.id);
      draw("suggested");
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
      d = await api.initiative(id);
      draw("reopen");
      toast(`Closed: ${d.initiative.title}`);
    } catch {
      toast("Couldn't close this initiative.", "error");
    }
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
      d = await api.initiative(id);
      draw("close");
      toast(`Reopened: ${d.initiative.title}`);
    } catch {
      toast("Couldn't reopen this initiative.", "error");
    }
  }

  draw();
  void api.initiativeSuggest(id).then((r) => { suggest = r.model ? { state: "ready", items: r.suggestions } : { state: "nomodel" }; draw(); }, () => { suggest = { state: "ready", items: [] }; draw(); });
}
