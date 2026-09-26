import type { Database } from "bun:sqlite";
import { createBriefing, type Briefing } from "../briefings/store.ts";
import { MEETING_SUMMARY_MAX_TOKENS } from "./constants.ts";
import { readDocFile } from "./docs.ts";
import { meetingSummaryPrompt } from "./prompts.ts";
import type { Router } from "../providers/router.ts";

const SECTIONS = ["## Discussion", "## Decisions", "## Action items"];

/** Ask a synthesis model for Discussion/Decisions/Action items and store it as a meeting-summary briefing. */
export async function draftMeetingSummary(dataDir: string, router: Router | null, docId: string, opts: { commit?: boolean; author?: string; db?: Database } = {}): Promise<Briefing> {
  const doc = readDocFile(dataDir, docId);
  if (!doc) throw new Error(`doc ${docId} not found`);
  const model = router?.resolve({ kind: "synthesis", minQuality: "high" });
  if (!model) throw new Error("no synthesis model available for meeting summaries (Tier 0)");
  let md = (await model.complete(meetingSummaryPrompt(doc.frontmatter.title, doc.body), { maxTokens: MEETING_SUMMARY_MAX_TOKENS })).trim();
  md = md.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  for (const s of SECTIONS) if (!md.includes(s)) md += `\n\n${s}\n\nNone.`;
  void opts.db;
  return createBriefing(dataDir, { title: `Meeting summary: ${doc.frontmatter.title}`, kind: "meeting-summary", status: opts.commit ? "approved" : "draft", source_doc: docId, author: opts.author ?? doc.frontmatter.author, body: md + "\n", tags: doc.frontmatter.tags });
}
