/** In-place editing of one piece of an initiative (title, owner or goal): the field, its hint, its error, and the save rules. */
import { h } from "../ui.ts";

/** The three editable pieces. */
export type EditField = "title" | "owner" | "goal";

const NOUN: Record<EditField, string> = { title: "title", owner: "owner", goal: "goal" };
const isMac = (): boolean => /Mac/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "");
/** The words under the field, for each piece. */
const HINT = (f: EditField): string => (f === "goal" ? `${isMac() ? "⌘↵" : "Ctrl+Enter"} saves · Esc cancels` : "Enter saves · Esc cancels");
/** Most names the owner list shows. */
export const MAX_SUGGESTIONS = 8;

/** What the page gives an editor. */
export interface EditorOpts {
  field: EditField;
  /** The text now saved. */
  value: string;
  /** Persists the new (trimmed) text; rejects when it could not be saved. */
  save(value: string): Promise<void>;
  /** Owner only: the names to suggest. */
  names?: () => Promise<string[]>;
  /** The editor is gone (saved or cancelled); `saved` says which. */
  done(saved: boolean): void;
}
/** An open editor. */
export interface Editor {
  el: HTMLElement;
  /** Focus the input (after a redraw moved it). */
  focus(): void;
  /** Save as if the person clicked away: true when the editor closed, false when it stays open (empty text or a failed save). */
  commit(): Promise<boolean>;
}

/** Build the editor for one piece: a one-line field (title, owner) or a multi-line box with Save and Cancel (goal). */
export function openEditor(o: EditorOpts): Editor {
  const goal = o.field === "goal";
  const input = (goal ? h("textarea", { class: "jv-ed-in jv-ed-goal", rows: 4 }) : h("input", { class: `jv-ed-in jv-ed-${o.field}`, type: "text", autocomplete: "off" })) as HTMLInputElement;
  input.value = o.value;
  input.setAttribute("aria-label", `Edit ${NOUN[o.field]}`);
  const hint = h("span", { class: "jv-ed-hint muted small" }, HINT(o.field));
  const err = h("div", { class: "jv-ed-err small", role: "alert" });
  const list = h("div", { class: "jv-ed-list", role: "listbox" });
  let names: string[] = [];
  let active = -1;
  let saving: Promise<boolean> | null = null;
  let closed = false;
  /** The list shows only once the person has typed, never for the text the field opened with or a name just picked. */
  let typed = false;

  const showError = (msg: string) => { input.classList.add("jv-ed-bad"); input.setAttribute("aria-invalid", "true"); err.textContent = msg; };
  const clearError = () => { input.classList.remove("jv-ed-bad"); input.removeAttribute("aria-invalid"); err.textContent = ""; };
  const options = (): string[] => {
    const q = input.value.trim().toLowerCase();
    return o.field !== "owner" || !typed || !q ? [] : names.filter((n) => n.toLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
  };
  const paintList = () => {
    const opts = options();
    if (active >= opts.length) active = opts.length - 1;
    list.replaceChildren(...opts.map((n, i) => h("div", { class: `jv-ed-opt${i === active ? " on" : ""}`, role: "option", id: `jv-ed-opt-${i}`, "aria-selected": i === active ? "true" : "false",
      onMousedown: (e: Event) => { e.preventDefault(); pick(n); } }, n)));
    list.hidden = opts.length === 0;
    if (active >= 0) input.setAttribute("aria-activedescendant", `jv-ed-opt-${active}`); else input.removeAttribute("aria-activedescendant");
  };
  const pick = (n: string) => { input.value = n; typed = false; active = -1; paintList(); input.focus(); };
  const close = (saved: boolean) => { closed = true; o.done(saved); };

  function commit(): Promise<boolean> {
    if (closed) return Promise.resolve(true);
    if (saving) return saving;
    const text = input.value.trim();
    if (!text) { showError(`An initiative needs ${o.field === "owner" ? "an" : "a"} ${NOUN[o.field]}.`); input.focus(); return Promise.resolve(false); }
    if (text === o.value.trim()) { close(false); return Promise.resolve(true); }
    clearError();
    input.readOnly = true;
    hint.textContent = "Saving…";
    list.hidden = true;
    saving = o.save(text).then(
      () => { saving = null; close(true); return true; },
      () => {
        saving = null;
        input.readOnly = false;
        hint.textContent = HINT(o.field);
        showError(`Couldn’t save the ${NOUN[o.field]}. Press ${goal ? "Save" : "Enter"} to try again.`);
        input.focus();
        return false;
      });
    return saving;
  }
  const cancel = () => { if (!saving) close(false); };

  input.addEventListener("input", () => { typed = true; active = -1; if (err.textContent && !saving) clearError(); paintList(); });
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (saving) { k.preventDefault(); return; }
    const opts = options();
    if (k.key === "Escape") { k.preventDefault(); cancel(); }
    else if (o.field === "owner" && opts.length && (k.key === "ArrowDown" || k.key === "ArrowUp")) {
      k.preventDefault();
      active = k.key === "ArrowDown" ? Math.min(active + 1, opts.length - 1) : Math.max(active - 1, 0);
      paintList();
    } else if (k.key === "Enter") {
      if (goal) { if (k.ctrlKey || k.metaKey) { k.preventDefault(); void commit(); } return; } // Enter alone is a new line
      k.preventDefault();
      if (active >= 0 && opts[active] !== undefined) pick(opts[active]!);
      else void commit();
    }
  });
  input.addEventListener("blur", () => { if (!saving && !closed) void commit(); });

  const buttons = goal
    ? h("div", { class: "jv-ed-acts" },
      h("button", { class: "primary", onMousedown: (e: Event) => e.preventDefault(), onClick: () => void commit() }, "Save"),
      h("button", { onMousedown: (e: Event) => e.preventDefault(), onClick: cancel }, "Cancel"), hint)
    : null;
  const el = h("div", { class: `jv-ed jv-ed-w-${o.field}` }, input, o.field === "owner" ? list : null, err, buttons ?? hint);
  list.hidden = true;
  if (o.names) void o.names().then((n) => { names = n; paintList(); }, () => {});
  return { el, focus: () => { input.focus(); }, commit };
}
