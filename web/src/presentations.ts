/** The control on a deck's tab that presents it in Slidecraft. */
import type { PresentationSummary } from "./api.ts";
import { h } from "./ui.ts";

/**
 * A *Present in Slidecraft* button when Slidecraft is ready for this deck (opening in the same window
 * inside the macOS app, a new tab elsewhere), otherwise nothing: never a link that cannot work.
 * `jarvis doctor` says why a deck is not ready.
 */
export function presentControl(s: PresentationSummary["slidecraft"], inApp: boolean): HTMLElement | null {
  if (s.status !== "ready" || !s.launchUrl) return null;
  return h("a", { href: s.launchUrl, target: inApp ? "_self" : "_blank", rel: "noopener" }, h("button", { class: "primary" }, "Present in Slidecraft"));
}
