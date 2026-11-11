import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileSourceUrl } from "../core/util.ts";
import { loadGlossary, whisperInitialPrompt } from "../core/glossary.ts";
import type { CapturePayload } from "../core/ingest.ts";
import { parsePastedTranscript, parseTeamsVtt } from "./transcript.ts";
import { siblingVtt, transcribeAudio, type Runner, type WhisperBackend } from "./whisper.ts";

export const AUDIO_EXT = [".mp3", ".m4a", ".wav", ".mp4", ".mov", ".aac", ".flac", ".ogg", ".webm", ".wma", ".m4v"];
export const TEXT_EXT = [".vtt", ".md", ".txt", ".markdown", ".text"];

export interface MeetingOpts {
  title?: string;
  lang?: string;
  author?: string;
  dataDir?: string;
  /** Raw draft transcript text appended as "## Draft transcript (raw)" (inbox drafts). */
  draft?: string;
  backend?: WhisperBackend;
  run?: Runner;
  captureId?: string;
}

/** Build a meeting capture payload from a Teams .vtt, a pasted transcript, or an audio/video file. */
export function meetingToPayload(file: string, opts: MeetingOpts = {}): CapturePayload {
  const abs = resolve(file);
  const ext = extname(abs).toLowerCase();
  const stem = basename(abs, ext);
  const title = opts.title ?? `Transcript: ${stem}`;
  const metadata: Record<string, unknown> = {};
  let body: string;
  if (ext === ".vtt") {
    body = parseTeamsVtt(readFileSync(abs, "utf8"));
    metadata.transcript_format = "teams-vtt";
  } else if (TEXT_EXT.includes(ext)) {
    body = parsePastedTranscript(readFileSync(abs, "utf8"));
    metadata.transcript_format = "pasted";
  } else if (AUDIO_EXT.includes(ext)) {
    const glossary = loadGlossary(opts.dataDir);
    const initialPrompt = whisperInitialPrompt(glossary, title);
    const { text, backend } = transcribeAudio(abs, { lang: opts.lang, initialPrompt, backend: opts.backend, run: opts.run });
    body = text;
    metadata.whisper_backend = backend;
    if (initialPrompt) metadata.whisper_initial_prompt = initialPrompt;
    const vtt = siblingVtt(abs);
    if (vtt) body += `\n\n## Teams transcript (raw)\n\n${parseTeamsVtt(readFileSync(vtt, "utf8"))}`;
    else if (opts.draft) body += `\n\n## Draft transcript (raw)\n\n${opts.draft.trim()}`;
  } else {
    throw new Error(`unsupported meeting file type ${ext}; expected audio (${AUDIO_EXT.join(" ")}) or text (${TEXT_EXT.join(" ")})`);
  }
  if (!body.trim()) throw new Error(`${file} produced an empty transcript`);
  if (opts.lang) metadata.lang = opts.lang;
  return {
    source: "meeting",
    title,
    body,
    author: opts.author,
    source_url: `${fileSourceUrl(abs)}${opts.captureId ? `#capture=${opts.captureId}` : ""}`,
    metadata,
  };
}
