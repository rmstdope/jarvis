import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { h, append, clear, toast, modal, metaLine } from "../web/src/ui.ts";

const win = new Window();
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ["document", "localStorage", "HTMLElement", "Node"]) {
    saved[k] = (globalThis as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = (win as unknown as Record<string, unknown>)[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v;
});

describe("web ui helpers under happy-dom", () => {
  test("h() sets class, attributes, html, listeners and nested children; append/clear", () => {
    let clicks = 0;
    const el = h("div", { class: "card", "data-x": "1", onClick: () => clicks++ }, "text", null, false, [h("span", { html: "<b>bold</b>" }), ["nested"]]);
    expect(el.className).toBe("card");
    expect(el.getAttribute("data-x")).toBe("1");
    expect(el.textContent).toBe("textboldnested");
    expect(el.querySelector("b")).not.toBeNull();
    el.dispatchEvent(new win.Event("click") as unknown as Event);
    expect(clicks).toBe(1);
    const input = h("input", { value: "v", checked: true });
    expect(input.value).toBe("v");
    expect(input.checked).toBe(true);
    append(el, [h("i", {}, "i")]);
    expect(el.querySelectorAll("i").length).toBe(1);
    clear(el);
    expect(el.childNodes.length).toBe(0);
  });
  test("toast replaces itself and modal wires actions", () => {
    toast("one");
    toast("two", "error");
    const toasts = document.querySelectorAll(".toast");
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toBe("two");
    expect(toasts[0].className).toContain("error");
    let ok = 0;
    const bg = modal("Title", h("p", {}, "body"), [{ label: "Cancel", onClick: () => {} }, { label: "Go", primary: true, onClick: () => ok++ }]);
    expect(document.querySelector(".modal h3")!.textContent).toBe("Title");
    const buttons = bg.querySelectorAll("button");
    expect(buttons[1].className).toBe("primary");
    buttons[1].dispatchEvent(new win.Event("click") as unknown as Event);
    expect(ok).toBe(1);
    expect(document.querySelector(".modal-bg")).toBeNull();
  });
  test("metaLine omits missing parts", () => {
    expect(metaLine({ source: "note", created_at: "2026-02-03T00:00:00Z", author: "a" })).toBe("note · added 2026-02-03 by a");
  });
});
