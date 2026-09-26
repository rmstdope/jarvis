import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturePayload } from "../core/ingest.ts";

export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname) || u.pathname !== "/watch") return null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

/** json3 → plain text: events[].segs[].utf8, one line per event. */
export function parseJson3(text: string): string {
  const j = JSON.parse(text) as { events?: { segs?: { utf8?: string }[] }[] };
  const lines: string[] = [];
  for (const ev of j.events ?? []) {
    const s = (ev.segs ?? []).map((x) => x.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (s && s !== lines[lines.length - 1]) lines.push(s);
  }
  return lines.join("\n");
}

/** .vtt → plain text: strip header, timestamps, tags, duplicates. */
export function parseVttPlain(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || /^WEBVTT/.test(line) || /^(Kind|Language):/.test(line) || /-->/.test(line) || /^\d+$/.test(line) || /^NOTE/.test(line)) continue;
    if (line !== out[out.length - 1]) out.push(line);
  }
  return out.join("\n");
}

function run(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: new TextDecoder().decode(p.stdout), stderr: new TextDecoder().decode(p.stderr) };
}

export interface YoutubeDeps {
  run?: typeof run;
}

/** Fetch metadata and an auto/manual subtitle track via yt-dlp. Returns null on any failure. */
export async function youtubeToPayload(url: string, opts: { author?: string } = {}, deps: YoutubeDeps = {}): Promise<CapturePayload | null> {
  const id = youtubeVideoId(url);
  if (!id) throw new Error("only youtube.com/watch?v= URLs are supported");
  const exec = deps.run ?? run;
  const meta = exec(["yt-dlp", "--print", "%(title)s\n%(channel)s", "--no-download", url]);
  if (meta.code !== 0) return null;
  const [title, channel] = meta.stdout.split("\n");
  const tmp = mkdtempSync(join(tmpdir(), "second-brain-yt-"));
  try {
    const subs = exec(["yt-dlp", "--write-subs", "--write-auto-subs", "--sub-lang", "en,en-US,en-GB,sv", "--sub-format", "json3", "--skip-download", "-o", join(tmp, `yt-${id}`), url]);
    if (subs.code !== 0) return null;
    const files = readdirSync(tmp);
    const json3 = files.find((f) => f.endsWith(".json3"));
    const vtt = files.find((f) => f.endsWith(".vtt"));
    let transcript: string | null = null;
    if (json3) transcript = parseJson3(readFileSync(join(tmp, json3), "utf8"));
    else if (vtt) transcript = parseVttPlain(readFileSync(join(tmp, vtt), "utf8"));
    if (!transcript) return null;
    return {
      source: "youtube",
      title: (title || `YouTube ${id}`).trim(),
      body: transcript,
      author: opts.author,
      source_url: `https://www.youtube.com/watch?v=${id}`,
      metadata: { source_author: channel?.trim() || undefined, video_id: id },
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
