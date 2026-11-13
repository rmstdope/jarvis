import { beforeEach, describe, expect, test } from "bun:test";
import { installWebEnv } from "./webEnv.ts";
import { cardsFromSync, loadCards, saveCards } from "../web/src/syncnotes.ts";

const none = { failures: [] };
const one = (note: string) => cardsFromSync({ notes: [note], ...none })[0]!;

describe("cardsFromSync", () => {
  test("headings follow what the note is about", () => {
    expect(one("/a/models.toml could not be loaded: x; model steps skipped").heading).toBe("AI steps skipped");
    expect(one("push failed: rejected").heading).toBe("Couldn't share your work");
    expect(one("pull failed (offline); continuing local-only").heading).toBe("Couldn't get teammates' changes");
    expect(one("2 source_url collision(s): run `jarvis dedup`").heading).toBe("Duplicates found");
    expect(one("embedding server (ollama) is unreachable").heading).toBe("Search by meaning unavailable");
    expect(one("published projection mode: not implemented").heading).toBe("Note from sync");
  });
  test("a fix line leaves the body and becomes the Fix, with its command", () => {
    const c = one('/a/models.toml could not be loaded: line 4; model steps skipped\nfix: run jarvis doctor, which names the broken entry and how to fix it');
    expect(c.body).toBe("/a/models.toml could not be loaded: line 4; model steps skipped");
    expect(c.fix).toEqual({ before: "run ", command: "jarvis doctor", after: ", which names the broken entry and how to fix it" });
  });
  test("a note that names a command in backticks gets that command as its Fix, body unchanged", () => {
    const c = one("2 source_url collision(s): run `jarvis dedup`");
    expect(c.body).toBe("2 source_url collision(s): run `jarvis dedup`");
    expect(c.fix).toEqual({ before: "run ", command: "jarvis dedup", after: "" });
  });
  test("a fix naming several alternatives offers the first whole command, not a cut-off one", () => {
    const c = one("/a/m.toml could not be loaded: JARVIS_MODELS names it, and it does not exist; model steps skipped\nfix: jarvis config preset <name>   or   jarvis config redetect --write   or   unset JARVIS_MODELS");
    expect(c.fix?.command).toBe("jarvis config preset <name>");
    expect(c.body).toBe("/a/m.toml could not be loaded: JARVIS_MODELS names it, and it does not exist; model steps skipped");
  });
  test("only a line that starts with fix: is a fix line", () => expect(one("bad prefix: x").body).toBe("bad prefix: x"));
  test("a note with no fix has none", () => expect(one("push failed: x").fix).toBeUndefined());
  test("failed steps become cards after the notes, worded as the old toast", () => {
    const cards = cardsFromSync({ notes: ["push failed: x"], failures: [
      { step: "enrich", failed: 3, reason: "model timed out.", doctor: true },
      { step: "refine", failed: 2, reason: "", doctor: false },
    ] });
    expect(cards.map((c) => c.heading)).toEqual(["Couldn't share your work", "Some items weren't enriched", "Some links weren't refined"]);
    expect(cards[1]!.body).toBe("enrichment failed for 3 item(s): model timed out");
    expect(cards[1]!.fix).toEqual({ before: "run ", command: "jarvis doctor", after: "" });
    expect(cards[2]!.body).toBe("link refinement failed for 2 batch(es)");
    expect(cards[2]!.fix).toBeUndefined();
  });
  test("nothing to say is no cards", () => expect(cardsFromSync({ notes: [], ...none })).toEqual([]));
});

describe("stored cards", () => {
  beforeEach(() => { installWebEnv(1280); });
  test("round-trip; nonsense reads as none", () => {
    expect(loadCards()).toEqual([]);
    const c = [{ heading: "h", body: "b" }];
    saveCards(c);
    expect(loadCards()).toEqual(c);
    localStorage.setItem("jv.syncNotes", "{not json");
    expect(loadCards()).toEqual([]);
    localStorage.setItem("jv.syncNotes", '[{"x":1},"s"]');
    expect(loadCards()).toEqual([]);
    saveCards([]);
    expect(localStorage.getItem("jv.syncNotes")).toBeNull();
  });
});
