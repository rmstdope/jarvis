import { describe, expect, test } from "bun:test";
import { distinguish } from "../src/chat/choice.ts";

const now = new Date(2026, 10, 12, 15, 0, 0);
const row = (id: string, y: number, mo: number, d: number, h: number, mi: number, body = "text") => ({ id, title: "Weekly sync", created_at: new Date(y, mo - 1, d, h, mi).toISOString(), body });

describe("distinguish", () => {
  test("same day: times, newest first", () => {
    const o = distinguish([row("a", 2026, 11, 12, 9, 0), row("b", 2026, 11, 12, 14, 30)], now);
    expect(o.map((x) => [x.id, x.detail, x.tail, x.chip])).toEqual([["b", "14:30", " at 14:30", "14:30"], ["a", "09:00", " at 09:00", "09:00"]]);
  });
  test("different days: dates, year only when not this year", () => {
    const o = distinguish([row("a", 2026, 11, 5, 9, 0), row("b", 2025, 11, 12, 9, 0)], now);
    expect(o.map((x) => [x.id, x.detail, x.tail, x.chip])).toEqual([["a", "from 5 Nov", " from 5 Nov", "5 Nov"], ["b", "from 12 Nov 2025", " from 12 Nov 2025", "12 Nov 2025"]]);
  });
  test("same minute: first lines in curly quotes, chip cut short", () => {
    const o = distinguish([row("a", 2026, 11, 12, 9, 0, "\n# Agenda: Q4 hiring plan\nmore"), row("b", 2026, 11, 12, 9, 0, "Release freeze and the ledger cutover")], now);
    const by = Object.fromEntries(o.map((x) => [x.id, x]));
    expect(by.a.detail).toBe("“Agenda: Q4 hiring plan”");
    expect(by.a.tail).toBe(" — “Agenda: Q4 hiring plan”");
    expect(by.a.chip).toBe("“Agenda: Q4 hiring…”");
    expect(by.b.chip).toBe("“Release freeze and…”");
  });
  test("no text at all reads (empty)", () => {
    const o = distinguish([row("a", 2026, 11, 12, 9, 0, ""), row("b", 2026, 11, 12, 9, 0, "  \n")], now);
    expect(o.map((x) => x.detail)).toEqual(["(empty) · 09:00 (1 of 2)", "(empty) · 09:00 (2 of 2)"]);
  });
  test("identical first lines are still told apart: by the time, then by position", () => {
    const o = distinguish([row("a", 2026, 11, 12, 9, 0, "same"), row("b", 2026, 11, 12, 9, 0, "same"), row("c", 2026, 11, 12, 10, 0, "same")], now);
    expect(o.map((x) => x.detail)).toEqual(["“same” · 10:00", "“same” · 09:00 (1 of 2)", "“same” · 09:00 (2 of 2)"]);
    expect(new Set(o.map((x) => x.tail)).size).toBe(3);
  });
  test("a mix of same and different days falls back to first lines", () => {
    const o = distinguish([row("a", 2026, 11, 5, 9, 0, "one"), row("b", 2026, 11, 12, 9, 0, "two"), row("c", 2026, 11, 12, 10, 0, "three")], now);
    expect(o.map((x) => x.detail)).toEqual(["“three”", "“two”", "“one”"]);
  });
});
