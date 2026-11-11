import { describe, expect, test } from "bun:test";
import { kindLabel, speakerTurns } from "../web/src/transcript.ts";

describe("speakerTurns", () => {
  test("splits 'Name: text' paragraphs into turns", () => {
    expect(speakerTurns("Mia Laine: Hello all.\n\nKim: Hi. Agenda: first.\n\nMia Laine: Go.")).toEqual([
      { speaker: "Mia Laine", text: "Hello all." }, { speaker: "Kim", text: "Hi. Agenda: first." }, { speaker: "Mia Laine", text: "Go." },
    ]);
  });
  test("a transcript with no speakers is plain paragraphs", () => {
    expect(speakerTurns("we did a thing.\n\nand then another: yes.")).toEqual([{ text: "we did a thing." }, { text: "and then another: yes." }]);
  });
});
describe("kindLabel", () => {
  test("maps the stored source to the agreed badge", () => {
    expect(["note", "paste", "task", "web", "youtube", "meeting", "pdf", "other"].map(kindLabel)).toEqual(["Note", "Note", "Task", "Web page", "Video transcript", "Meeting transcript", "PDF", "Note"]);
    expect([kindLabel("briefing"), kindLabel("presentation")]).toEqual(["Briefing", "Presentation"]);
  });
});
