/** Capture: a blank page to write on. The draft is kept until it is captured. */
import { api } from "../api.ts";
import { h, toast } from "../ui.ts";
import { delPref, getJson, KEY_CAPTURE, setJson } from "../prefs.ts";
import { type Ctx, errorBox, heading, type Page } from "./common.ts";

/** The Capture page. */
export async function viewCapture(ctx: Ctx): Page {
  const draft = getJson(KEY_CAPTURE, { title: "", text: "" });
  const title = h("input", { type: "text", class: "jv-wt", placeholder: "Title", "aria-label": "Title", value: draft.title });
  const body = h("textarea", { class: "jv-wb", placeholder: "Paste or write anything…", "aria-label": "Text" });
  body.value = draft.text;
  const btn = h("button", { type: "submit", class: "primary" }, "Capture");
  const problem = h("div");
  const ready = () => !!title.value.trim() && !!body.value.trim();
  const paint = () => { btn.disabled = !ready(); };
  const remember = () => { setJson(KEY_CAPTURE, { title: title.value, text: body.value }); paint(); };
  title.addEventListener("input", remember);
  body.addEventListener("input", remember);
  async function submit(): Promise<void> {
    if (btn.disabled) return;
    const t = title.value.trim();
    btn.disabled = true; btn.textContent = "Capturing…"; problem.replaceChildren();
    try {
      const r = await api.capture(t, body.value);
      delPref(KEY_CAPTURE);
      toast(`Captured: ${t}`);
      location.hash = `#/item/${r.id}`;
    } catch (e) {
      problem.replaceChildren(errorBox("Couldn't capture this.", (e as Error).message, undefined, "Your text is still here."));
      btn.textContent = "Capture"; paint();
    }
  }
  const form = h("form", { class: "jv-write", onSubmit: (e: Event) => { e.preventDefault(); void submit(); }, onKeydown: (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } } },
    title, h("hr", {}), body, problem, h("div", { class: "jv-wfoot" }, h("span", { class: "jv-hint" }, "⌘/Ctrl+Enter to capture"), btn));
  paint();
  ctx.main.append(heading("Capture"), form);
  return () => title.focus();
}
