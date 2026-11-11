/** The control on a deck's page that presents it in Slidecraft, or says what is missing. */
import type { PresentationSummary } from "./api.ts";
import { h } from "./ui.ts";

const NOT_READY: Record<Exclude<PresentationSummary["slidecraft"]["status"], "ready">, string> = {
  "not-running": "Start Slidecraft to present this deck (jarvis doctor says how).",
  "no-vault": "Add this content repo as a Slidecraft vault to present this deck (jarvis doctor says how).",
  "no-include": "This content repo's Slidecraft vault does not list its decks yet (jarvis doctor says how).",
};

/**
 * A *Present in Slidecraft* link when Slidecraft is ready (opening in the same window inside the macOS
 * app, a new tab elsewhere), otherwise a muted line saying what to do. Never a link that cannot work.
 */
export function presentControl(s: PresentationSummary["slidecraft"], inApp: boolean): HTMLElement {
  if (s.status === "ready" && s.launchUrl)
    return h("a", { href: s.launchUrl, target: inApp ? "_self" : "_blank", rel: "noopener" }, h("button", { class: "primary" }, "Present in Slidecraft"));
  return h("span", { class: "muted small" }, s.status === "ready" ? NOT_READY["not-running"] : NOT_READY[s.status]);
}
