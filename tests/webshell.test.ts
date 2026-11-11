import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installWebEnv, type WebEnv } from "./webEnv.ts";
import { createShell } from "../web/src/shell.ts";
import { applyTheme, getTheme, setTheme } from "../web/src/prefs.ts";
import { ago, modal, h } from "../web/src/ui.ts";

let env: WebEnv;
beforeEach(() => { env = installWebEnv(1280); document.body.innerHTML = ""; });
afterEach(() => env.restore());
const mount = (extra: { onNewChat?: () => void; onSync?: () => void; now?: () => number } = {}) => {
  const s = createShell({ onNewChat: extra.onNewChat ?? (() => {}), onSync: extra.onSync ?? (() => {}), now: extra.now });
  document.body.append(s.el);
  return s;
};
const texts = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.textContent);

describe("look", () => {
  test("Auto removes the override, Light and Dark set it, and the choice is remembered", () => {
    expect(getTheme()).toBe("auto");
    setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getTheme()).toBe("dark");
    setTheme("auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("jv.theme")).toBeNull();
    localStorage.setItem("jv.theme", "light");
    applyTheme(getTheme());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
  test("the switch shows Auto / Light / Dark and applies the click", () => {
    mount();
    expect(texts(".jv-themebtn")).toEqual(["Auto", "Light", "Dark"]);
    (document.querySelector('[data-theme-choice="dark"]') as HTMLElement).click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelector('[data-theme-choice="dark"]')!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("sidebar", () => {
  test("has the agreed words, in order", () => {
    mount();
    expect(document.querySelector(".jv-side .jv-brand .jv-name")!.textContent).toBe("J.A.R.V.I.S.");
    expect(document.querySelector(".jv-new .lbl")!.textContent).toBe(" New chat");
    expect(document.querySelector(".jv-sec")!.textContent).toBe("Your knowledge");
    expect(texts(".jv-nav .lbl")).toEqual(["Chat", "Browse & search", "Initiatives", "Capture", "Briefings", "Presentations"]);
    expect(texts(".jv-nav .rl")).toEqual(["Chat", "Browse", "Initiatives", "Capture", "Briefings", "Slides"]);
    expect(document.querySelector(".jv-new .rl")!.textContent).toBe("New");
    expect(document.querySelector(".jv-sync .rl")!.textContent).toBe("Sync");
    expect(document.querySelector(".jv-sync .lbl")!.textContent).toBe("Sync");
  });
  test("every entry is a link or button, reachable by Tab", () => {
    mount();
    for (const e of document.querySelectorAll(".jv-side a, .jv-side button")) expect(e.getAttribute("tabindex")).not.toBe("-1");
  });
  test("setActive lights the entry a route belongs to", () => {
    const s = mount();
    s.setActive("item");
    expect(document.querySelector(".jv-nav.active")!.getAttribute("data-route")).toBe("browse");
    s.setActive("briefing");
    expect(document.querySelector(".jv-nav.active")!.getAttribute("data-route")).toBe("briefings");
    s.setActive("chat");
    expect(document.querySelector(".jv-nav.active")!.getAttribute("data-route")).toBe("chat");
  });
  test("the Chat dot shows only when asked and says why on hover", () => {
    const s = mount();
    const dot = document.querySelector(".jv-dot") as HTMLElement;
    expect(dot.hidden).toBe(true);
    s.setChatDot(true);
    expect(dot.hidden).toBe(false);
    expect(dot.title).toBe("Conversation in progress");
  });
  test("New chat button runs the action", () => {
    let n = 0;
    mount({ onNewChat: () => n++ });
    (document.querySelector(".jv-new") as HTMLElement).click();
    expect(n).toBe(1);
  });
});

describe("folding and widths", () => {
  test("fold button folds to the rail, changes hover text and is remembered", () => {
    const s = mount();
    const btn = document.querySelector(".jv-fold") as HTMLElement;
    expect(btn.textContent).toBe("⇤");
    expect(btn.title).toMatch(/^Collapse sidebar \((⌘⇧S|Ctrl\+Shift\+S)\)$/);
    btn.click();
    expect(s.isFolded()).toBe(true);
    expect(btn.textContent).toBe("⇥");
    expect(btn.title).toMatch(/^Expand sidebar/);
    expect(localStorage.getItem("jv.folded")).toBe("1");
    document.body.innerHTML = "";
    expect(mount().isFolded()).toBe(true); // a reload
  });
  test("tablet width folds by itself and widening restores the saved choice", () => {
    const s = mount();
    expect(s.isFolded()).toBe(false);
    env.setWidth(800);
    expect(s.isFolded()).toBe(true);
    env.setWidth(1280);
    expect(s.isFolded()).toBe(false);
  });
  test("phone width: no rail, ☰ opens the full sidebar, and it closes on Esc-equivalent, backdrop and choosing", () => {
    const s = mount();
    env.setWidth(390);
    expect(s.el.classList.contains("jv-phone")).toBe(true);
    expect(s.isFolded()).toBe(false);
    expect(document.querySelector(".jv-phonebar .jv-name")!.textContent).toBe("J.A.R.V.I.S.");
    const burger = document.querySelector(".jv-menu") as HTMLElement;
    burger.click();
    expect(s.menuOpen()).toBe(true);
    expect(burger.getAttribute("aria-expanded")).toBe("true");
    s.closeMenu();
    expect(s.menuOpen()).toBe(false);
    expect(document.activeElement).toBe(burger);
    burger.click();
    (document.querySelector(".jv-backdrop") as HTMLElement).click();
    expect(s.menuOpen()).toBe(false);
    burger.click();
    (document.querySelector('.jv-nav[data-route="capture"]') as HTMLElement).click();
    expect(s.menuOpen()).toBe(false);
    expect(document.activeElement).toBe(burger);
  });
  test("the phone ＋ starts a new chat", () => {
    let n = 0;
    mount({ onNewChat: () => n++ });
    (document.querySelector(".jv-pnew") as HTMLElement).click();
    expect(n).toBe(1);
  });
});

describe("sync line", () => {
  test("shows each state in the agreed words", () => {
    let t = 1_000_000_000_000;
    const s = mount({ now: () => t });
    const line = () => document.querySelector(".jv-syncline")!.textContent;
    const btn = document.querySelector(".jv-sync") as HTMLButtonElement;
    expect(line()).toBe("Not synced yet");
    s.setSync({ kind: "syncing" });
    expect(line()).toBe("Syncing…");
    expect(btn.hasAttribute("disabled")).toBe(true);
    s.setSync({ kind: "ok", at: t - 5 * 60000 });
    expect(line()).toBe("Synced 5 min ago");
    expect(btn.hasAttribute("disabled")).toBe(false);
    s.setSync({ kind: "failed" });
    expect(line()).toBe("Sync failed");
    expect(document.querySelector(".jv-syncline")!.classList.contains("jv-err")).toBe(true);
  });
  test("ago()", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(90_000)).toBe("1 min ago");
    expect(ago(3 * 3600_000)).toBe("3 h ago");
    expect(ago(2 * 86400_000)).toBe("2 d ago");
  });
});

describe("modal focus", () => {
  test("starts on the named button, Esc closes, focus returns to where it was", () => {
    const opener = h("button", {}, "open");
    document.body.append(opener);
    opener.focus();
    let cancelled = 0;
    modal("Start a new chat?", h("p", {}, "x"), [{ label: "Cancel", onClick: () => cancelled++ }, { label: "New chat", primary: true, onClick: () => {} }], "New chat");
    expect((document.activeElement as HTMLElement).textContent).toBe("New chat");
    document.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    expect(document.querySelector(".modal-bg")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(cancelled).toBe(0);
  });
});
