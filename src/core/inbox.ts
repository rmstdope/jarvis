import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { extname, join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "./config.ts";
import { INBOX_SETTLE_MS } from "./constants.ts";
import { cleanup } from "./cleanup.ts";
import { ingest } from "./ingest.ts";
import { draftMeetingSummary } from "./meetingSummary.ts";
import { reindex } from "./reindex.ts";
import { AUDIO_EXT, TEXT_EXT, meetingToPayload } from "../producers/meeting.ts";
import type { Runner, WhisperBackend } from "../producers/whisper.ts";
import type { Router } from "../providers/router.ts";
import { nowIso } from "./util.ts";

export type Stage = "started" | "transcribed" | "cleaned" | "summarized";
export interface InboxState {
  stage: Stage;
  captureId: string;
  docId?: string;
  briefingId?: string;
  error?: string;
}
export interface FolderResult {
  slug: string;
  status: "archived" | "skipped" | "failed" | "locked" | "unsettled" | "dry-run";
  reason?: string;
  docId?: string;
  briefingId?: string;
  archivedTo?: string;
}
export interface ScanOpts {
  inbox?: string;
  llm?: boolean;
  commit?: boolean;
  dryRun?: boolean;
  limit?: number;
  settleMs?: number;
  router?: Router | null;
  backend?: WhisperBackend;
  run?: Runner;
  now?: () => number;
  log?: (s: string) => void;
}

export function resolveInboxDir(explicit?: string): string {
  return explicit ?? process.env.SECOND_BRAIN_INBOX ?? loadConfig().inboxDir ?? join(homedir(), ".second-brain", "inbox");
}

interface Classified {
  primary: string;
  draft?: string;
}
/** Exactly one audio + ≤ 1 text draft, or one text alone; anything else is unrecognized/ambiguous. */
export function classifyFolder(dir: string): { ok: true; files: Classified } | { ok: false; reason: string } {
  const entries = readdirSync(dir).filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile());
  const audio = entries.filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()));
  const text = entries.filter((f) => TEXT_EXT.includes(extname(f).toLowerCase()));
  const other = entries.filter((f) => !audio.includes(f) && !text.includes(f));
  if (other.length) return { ok: false, reason: `unrecognized file(s): ${other.join(", ")}` };
  if (audio.length === 1 && text.length <= 1) return { ok: true, files: { primary: join(dir, audio[0]), draft: text[0] ? join(dir, text[0]) : undefined } };
  if (audio.length === 0 && text.length === 1) return { ok: true, files: { primary: join(dir, text[0]) } };
  if (audio.length === 0 && text.length === 0) return { ok: false, reason: "empty folder" };
  return { ok: false, reason: `ambiguous: ${audio.length} audio, ${text.length} text file(s)` };
}

const statePath = (dir: string) => join(dir, ".state.json");
const lockDir = (dir: string) => join(dir, ".scan.lock");
export function readState(dir: string): InboxState | null {
  try {
    return JSON.parse(readFileSync(statePath(dir), "utf8"));
  } catch {
    return null;
  }
}
export function writeState(dir: string, s: InboxState): void {
  const tmp = join(dir, `.state.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, statePath(dir));
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** Atomic mkdir lock; reclaimed only for a dead pid on the same host. */
export function acquireLock(dir: string): boolean {
  const ld = lockDir(dir);
  const owner = join(ld, "owner");
  try {
    mkdirSync(ld);
  } catch {
    try {
      const o = JSON.parse(readFileSync(owner, "utf8")) as { pid: number; host: string };
      if (o.host === hostname() && !pidAlive(o.pid)) {
        rmSync(ld, { recursive: true, force: true });
        mkdirSync(ld);
      } else return false;
    } catch {
      return false;
    }
  }
  writeFileSync(owner, JSON.stringify({ pid: process.pid, host: hostname(), at: nowIso() }));
  return true;
}
export function releaseLock(dir: string): void {
  rmSync(lockDir(dir), { recursive: true, force: true });
}
function settled(dir: string, files: Classified, hasState: boolean, settleMs: number, now: number): boolean {
  const paths = [files.primary, files.draft, hasState ? undefined : dir].filter((p): p is string => !!p);
  return paths.every((p) => now - statSync(p).mtimeMs >= settleMs);
}
function archive(inbox: string, dir: string, slug: string): string {
  const arch = join(inbox, "archive");
  mkdirSync(arch, { recursive: true });
  let dest = join(arch, slug);
  if (existsSync(dest)) dest = `${dest}-${Date.now()}`;
  releaseLock(dir);
  renameSync(dir, dest);
  return dest;
}

/** Process every settled meeting folder in the inbox; one folder's failure never blocks the others. */
export async function scanInbox(dataDir: string, opts: ScanOpts = {}): Promise<{ inbox: string; results: FolderResult[] }> {
  const inbox = resolveInboxDir(opts.inbox);
  const log = opts.log ?? (() => {});
  const results: FolderResult[] = [];
  if (!existsSync(inbox)) return { inbox, results };
  const settleMs = opts.settleMs ?? INBOX_SETTLE_MS;
  const now = opts.now ?? (() => Date.now());
  let processed = 0;
  let touched = false;
  for (const slug of readdirSync(inbox).sort()) {
    if (slug === "archive" || slug.startsWith(".")) continue;
    const dir = join(inbox, slug);
    if (!statSync(dir).isDirectory()) continue;
    if (opts.limit !== undefined && processed >= opts.limit) break;
    const cls = classifyFolder(dir);
    if (!cls.ok) {
      results.push({ slug, status: "skipped", reason: cls.reason });
      continue;
    }
    const prior = readState(dir);
    // A lock left by another live process wins before anything else (creating it bumps the folder mtime).
    const hadLock = existsSync(lockDir(dir));
    if (hadLock && !opts.dryRun && !acquireLock(dir)) {
      results.push({ slug, status: "locked" });
      continue;
    }
    if (!settled(dir, cls.files, !!prior || hadLock, settleMs, now())) {
      if (hadLock && !opts.dryRun) releaseLock(dir);
      results.push({ slug, status: "unsettled" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ slug, status: "dry-run", reason: `${cls.files.primary}${cls.files.draft ? ` + draft ${cls.files.draft}` : ""}` });
      continue;
    }
    if (!hadLock && !acquireLock(dir)) {
      results.push({ slug, status: "locked" });
      continue;
    }
    processed++;
    let state: InboxState = prior ?? { stage: "started", captureId: ulid() };
    try {
      if (state.stage === "started") {
        log(`${slug}: transcribing`);
        const draft = cls.files.draft ? readFileSync(cls.files.draft, "utf8") : undefined;
        const payload = meetingToPayload(cls.files.primary, { title: `Transcript: ${slug}`, dataDir, draft, captureId: state.captureId, backend: opts.backend, run: opts.run });
        const r = await ingest(dataDir, payload, { embed: false });
        touched = true;
        state = { ...state, stage: "transcribed", docId: r.id };
        writeState(dir, state);
      }
      if (state.stage === "transcribed") {
        log(`${slug}: cleanup`);
        await cleanup(dataDir, opts.router ?? null, { docIds: [state.docId!], llm: opts.llm });
        touched = true;
        state = { ...state, stage: "cleaned" };
        writeState(dir, state);
      }
      if (state.stage === "cleaned") {
        log(`${slug}: summary`);
        const b = await draftMeetingSummary(dataDir, opts.router ?? null, state.docId!, { commit: opts.commit });
        touched = true;
        state = { ...state, stage: "summarized", briefingId: b.id };
        writeState(dir, state);
      }
      const archivedTo = archive(inbox, dir, slug);
      results.push({ slug, status: "archived", docId: state.docId, briefingId: state.briefingId, archivedTo });
    } catch (e) {
      const msg = (e as Error).message;
      results.push({ slug, status: "failed", reason: msg, docId: state.docId, briefingId: state.briefingId });
      try {
        writeState(dir, { ...state, error: msg });
      } catch {}
      releaseLock(dir);
    }
  }
  if (touched) await reindex(dataDir);
  return { inbox, results };
}
