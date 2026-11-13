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

describe("sync notes (jv-5b3)", () => {
  const card = (n: number, fix = false) => ({ heading: `Heading ${n}`, body: `Body ${n}`, ...(fix ? { fix: { before: "run ", command: "jarvis doctor", after: ", which helps" } } : {}) });
  const line = () => document.querySelector(".jv-syncline")!;
  const heads = () => texts(".jv-note h4");
  const mountN = (extra: { onNotes?: (c: unknown[]) => void; copiedMs?: number } = {}) => {
    const s = createShell({ onNewChat: () => {}, onSync: () => {}, now: () => 1_000_000_000_000, ...extra } as Parameters<typeof createShell>[0]);
    document.body.append(s.el);
    s.setSync({ kind: "ok", at: 1_000_000_000_000 });
    return s;
  };
  test("one card per note above the Sync line, with the count in amber (not the error red)", () => {
    const s = mountN();
    expect(line().textContent).toBe("Synced just now");
    s.setNotes([card(1, true)]);
    expect(heads()).toEqual(["Heading 1"]);
    expect(texts(".jv-note p")).toEqual(["Body 1"]);
    expect(document.querySelector(".jv-note .jv-fix")!.textContent).toBe("Fix: run jarvis doctor, which helps Copy");
    expect(document.querySelector(".jv-note code")!.textContent).toBe("jarvis doctor");
    expect(line().textContent).toBe("Synced just now · 1 note");
    expect(line().classList.contains("jv-warn")).toBe(true);
    expect(line().classList.contains("jv-err")).toBe(false);
    s.setNotes([card(1), card(2)]);
    expect(line().textContent).toBe("Synced just now · 2 notes");
    expect(document.querySelector(".jv-notes")!.nextElementSibling).toBe(line());
    expect(document.querySelectorAll(".jv-note .jv-fix").length).toBe(0);
    s.setNotes([]);
    expect(line().textContent).toBe("Synced just now");
    expect(document.querySelector(".jv-sync-dot")).toBeNull();
  });
  test("more than three: the first three, then Show N more / Show fewer", () => {
    const s = mountN();
    s.setNotes([1, 2, 3, 4, 5].map((n) => card(n)));
    expect(heads()).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(line().textContent).toBe("Synced just now · 5 notes");
    const more = () => document.querySelector(".jv-notes-more") as HTMLElement;
    expect(more().textContent).toBe("Show 2 more");
    more().click();
    expect(heads().length).toBe(5);
    expect(more().textContent).toBe("Show fewer");
    more().click();
    expect(heads().length).toBe(3);
  });
  test("a later sync's cards start collapsed even after Show more was used", () => {
    const s = mountN();
    s.setNotes([1, 2, 3, 4, 5].map((n) => card(n)));
    (document.querySelector(".jv-notes-more") as HTMLElement).click();
    s.setNotes([1, 2, 3, 4, 5].map((n) => card(n)));
    expect(heads().length).toBe(3);
  });
  test("× is Close note, closes that card only, tells the owner, and moves focus on", () => {
    const seen: unknown[][] = [];
    const s = mountN({ onNotes: (c) => seen.push(c) });
    s.setNotes([card(1), card(2)]);
    const xs = () => [...document.querySelectorAll(".jv-note .jv-note-x")] as HTMLElement[];
    expect(xs()[0]!.getAttribute("aria-label")).toBe("Close note");
    xs()[0]!.click();
    expect(heads()).toEqual(["Heading 2"]);
    expect(line().textContent).toBe("Synced just now · 1 note");
    expect(seen.at(-1)).toEqual([card(2)]);
    expect(document.activeElement).toBe(xs()[0]!);
    xs()[0]!.click();
    expect(line().textContent).toBe("Synced just now");
    expect(seen.at(-1)).toEqual([]);
    expect(document.activeElement).toBe(document.querySelector(".jv-sync"));
  });
  test("Copy puts the command on the clipboard and reads Copied for a moment", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
    const s = mountN({ copiedMs: 20 });
    s.setNotes([card(1, true)]);
    const btn = document.querySelector(".jv-note .jv-copy") as HTMLElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(copied).toEqual(["jarvis doctor"]);
    expect(btn.textContent).toBe("Copied");
    await new Promise((r) => setTimeout(r, 40));
    expect(btn.textContent).toBe("Copy");
  });
  test("a folded sidebar shows an amber dot on Sync while a card is open", () => {
    const s = mountN();
    s.setNotes([card(1)]);
    expect(document.querySelector(".jv-sync .jv-sync-dot")).not.toBeNull();
  });
});
