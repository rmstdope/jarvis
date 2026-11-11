/** Pure helpers for the document tabs: speaker turns of a transcript and the badge of a source. */

/** The agreed kind badge for a stored source (`briefing` and `presentation` included). */
export function kindLabel(source: string): string {
  switch (source) {
    case "task": return "Task";
    case "web": return "Web page";
    case "youtube": return "Video transcript";
    case "meeting": return "Meeting transcript";
    case "pdf": return "PDF";
    case "briefing": return "Briefing";
    case "presentation": return "Presentation";
    default: return "Note";
  }
}

/** A short capitalised name: at most six words, no sentence punctuation (as the transcript producers write them). */
function looksLikeSpeaker(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 60 || /[.!?,;:]$/.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length <= 6 && words.filter((w) => /^[A-ZÅÄÖ]/.test(w)).length / words.length >= 0.5;
}

/** Split a transcript body into one block per paragraph, with the speaker when the paragraph starts "Name: ". */
export function speakerTurns(body: string): { speaker?: string; text: string }[] {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":");
    if (i > 0 && looksLikeSpeaker(p.slice(0, i))) return { speaker: p.slice(0, i).trim(), text: p.slice(i + 1).trim() };
    return { text: p };
  });
}
