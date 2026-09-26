export function enrichPrompt(title: string, body: string): string {
  return `You extract structured metadata from a captured document. Respond with ONLY a JSON object of exactly this shape (no prose, no code fences):
{"items":[{"summary": "2-3 sentence summary", "tags": ["3-8 concrete searchable topics"], "mentions": [{"name": "entity name as written", "kind": "person|team|product|service|concept"}]}]}
Write the summary and tags in English, even if the document is in another language. Extract exactly one item for the document. Only include mentions that are genuine named people/teams/products/services/concepts — not generic words. The document's own primary subject — the thing named in the title — counts as a mention even if named only once.

Title: ${title}
---
${body}`;
}
export function enrichSummaryOnlyPrompt(title: string, body: string): string {
  return `You extract structured metadata from a captured document. Respond with ONLY a JSON object of exactly this shape (no prose, no code fences):
{"items":[{"summary": "2-3 sentence summary", "tags": ["3-8 concrete searchable topics"]}]}
Write the summary and tags in English, even if the document is in another language. Extract exactly one item for the document.

Title: ${title}
---
${body}`;
}
export interface RefineCandidate {
  src: string;
  srcTitle: string;
  srcBlurb: string;
  dst: string;
  dstTitle: string;
  dstBlurb: string;
}
export function refinePrompt(cands: RefineCandidate[]): string {
  const list = cands.map((c, i) => `[${i + 1}] SOURCE ${c.src} "${c.srcTitle}": ${c.srcBlurb}\n    TARGET ${c.dst} "${c.dstTitle}": ${c.dstBlurb}`).join("\n\n");
  return `You judge candidate links between documents in a knowledge base. Each candidate links a SOURCE document to a TARGET document. For each candidate decide whether to keep it and, if kept, the relation: EXACTLY one of same_topic (same subject), supplements (SOURCE adds to/extends TARGET), references (SOURCE refers to/points at TARGET). Respond with ONLY a JSON object. Put "reasoning" FIRST in every result object, then echo the candidate's src and dst ids EXACTLY:
{"results":[{"reasoning":"one short sentence","src":"<src id>","dst":"<dst id>","keep":true,"relation":"same_topic"}]}
Return exactly one result per candidate below.

${list}`;
}
export function cleanupPrompt(glossaryLines: string[], piece: string): string {
  return `You are a strict copy-editor for a meeting transcript produced by speech recognition. Fix ONLY garbled occurrences of the known terms listed below, replacing the misheard form with the canonical spelling. Add nothing, remove nothing, reorder nothing. Preserve negations exactly (e.g. "hadn't", "inte", "not"). Keep "Name:" speaker labels and paragraph structure exactly. Output ONLY the corrected transcript, no commentary.

Known terms:
${glossaryLines.join("\n")}

Transcript:
${piece}`;
}
export function meetingSummaryPrompt(title: string, transcript: string): string {
  return `Summarize the following meeting transcript as GitHub-flavored Markdown with exactly these sections: "## Discussion", "## Decisions", "## Action items". Write "None." under a section when it is empty. Invent nothing that is not in the transcript. Output only the document.

Meeting: ${title}

${transcript}`;
}
export function askPrompt(question: string, context: string): string {
  return `Answer the question using ONLY the provided context documents. Cite the documents you rely on by their ids in square brackets, e.g. [01ABC…]. If the context is insufficient, say so plainly.

Context:
${context}

Question: ${question}`;
}
