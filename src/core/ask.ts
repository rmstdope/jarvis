import { ASK_CONTEXT_CHARS, ASK_DEFAULT_LIMIT, ASK_MAX_CONTEXT_CHARS, ASK_MAX_LIMIT, ASK_MAX_TOKENS } from "./constants.ts";
import { readDocFile } from "./docs.ts";
import { askPrompt } from "./prompts.ts";
import { search, type SearchMode } from "./search.ts";
import { modelsPath } from "../providers/models.ts";
import type { Router } from "../providers/router.ts";

/** What `ask` returns: the answer, the model that wrote it ("none" when none did), and the items it drew on. */
export interface AskResult {
  answer: string;
  model: string;
  citations: { docId: string; title: string; source: string }[];
  /** Set when no chat model could synthesize an answer: the fix line, naming the models file in use. */
  skipped?: string;
}
export const NO_CONTEXT_ANSWER = "I couldn't find anything in J.A.R.V.I.S. that answers that.";
export const NO_MODEL_ANSWER = "No chat model is available, so J.A.R.V.I.S. skipped the answer; these items match your question.";

/**
 * Answer a question from the content repo: retrieve the matching items, then synthesize an answer
 * with a high-quality model. With no such model the synthesis is skipped, not failed: the matching
 * items come back with a fix line.
 */

export async function ask(dataDir: string, router: Router | null, question: string, opts: { mode?: SearchMode; limit?: number; contextChars?: number } = {}): Promise<AskResult> {
  const limit = Math.min(ASK_MAX_LIMIT, Math.max(1, opts.limit ?? ASK_DEFAULT_LIMIT));
  const maxChars = Math.min(ASK_MAX_CONTEXT_CHARS, Math.max(1000, opts.contextChars ?? ASK_CONTEXT_CHARS));
  const hits = await search(dataDir, question, { mode: opts.mode ?? "hybrid", limit });
  const parts: string[] = [];
  const citations: AskResult["citations"] = [];
  let used = 0;
  for (const h of hits) {
    const doc = readDocFile(dataDir, h.docId);
    if (!doc) continue;
    const part = `[${h.docId}] ${doc.frontmatter.title}\n${doc.body}`;
    if (used + part.length > maxChars) {
      const room = maxChars - used;
      if (room < 200) break;
      parts.push(part.slice(0, room));
      citations.push({ docId: h.docId, title: h.title, source: h.source });
      break;
    }
    parts.push(part);
    citations.push({ docId: h.docId, title: h.title, source: h.source });
    used += part.length;
  }
  if (parts.length === 0) return { answer: NO_CONTEXT_ANSWER, model: "none", citations: [] };
  const model = router?.resolve({ kind: "synthesis", minQuality: "high" });
  if (!model) return { answer: NO_MODEL_ANSWER, model: "none", citations, skipped: `add a [[model]] with quality = "high" to ${modelsPath()}, or run jarvis doctor` };
  const answer = await model.complete(askPrompt(question, parts.join("\n\n---\n\n")), { maxTokens: ASK_MAX_TOKENS });
  return { answer: answer.trim(), model: model.id, citations };
}
