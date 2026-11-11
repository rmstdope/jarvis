import { ASK_CONTEXT_CHARS, ASK_DEFAULT_LIMIT, ASK_MAX_CONTEXT_CHARS, ASK_MAX_LIMIT, ASK_MAX_TOKENS } from "./constants.ts";
import { readDocFile } from "./docs.ts";
import { askPrompt } from "./prompts.ts";
import { search, type SearchMode } from "./search.ts";
import type { Router } from "../providers/router.ts";

export interface AskResult {
  answer: string;
  model: string;
  citations: { docId: string; title: string; source: string }[];
}
export const NO_CONTEXT_ANSWER = "I couldn't find anything in J.A.R.V.I.S. that answers that.";

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
  if (!model) throw new Error("no synthesis model available (configure ~/.jarvis/models.toml or install a chat model)");
  const answer = await model.complete(askPrompt(question, parts.join("\n\n---\n\n")), { maxTokens: ASK_MAX_TOKENS });
  return { answer: answer.trim(), model: model.id, citations };
}
