import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parsePastedTranscript, parseTeamsVtt } from "../src/producers/transcript.ts";
import { parseJson3, parseVttPlain, youtubeVideoId, youtubeToPayload } from "../src/producers/youtube.ts";
import { pdfToPayload, PdfError } from "../src/producers/pdf.ts";
import { meetingToPayload } from "../src/producers/meeting.ts";
import { parseGlossary, whisperInitialPrompt, variantMap } from "../src/core/glossary.ts";
import { detectWhisperBackend } from "../src/producers/whisper.ts";
import { fileSourceUrl } from "../src/core/util.ts";

const fx = (f: string) => join(import.meta.dir, "fixtures", f);

describe("transcripts", () => {
  test("teams vtt coalesces same-speaker cues", () => {
    const out = parseTeamsVtt(require("node:fs").readFileSync(fx("teams.vtt"), "utf8"));
    expect(out.split("\n\n")).toEqual([
      "Anna Svensson: Hello everyone, welcome. Let's start with the firmware.",
      "Bob: Sure. The zoom drift is fixed in 11.8.",
      "Anna Svensson: Great.",
    ]);
  });
  test("pasted transcript recognises inline and next-line timestamps", () => {
    const out = parsePastedTranscript(require("node:fs").readFileSync(fx("pasted.txt"), "utf8"));
    const paras = out.split("\n\n");
    expect(paras[0]).toBe("Anna Svensson: Hello everyone, welcome. Let's start with the firmware.");
    expect(paras[1].startsWith("Bob: Sure. The zoom drift is fixed in 11.8. And tested on the X1656.")).toBe(true);
    expect(paras.length).toBe(2);
  });
  test("pasted transcript without structure is verbatim", () => {
    expect(parsePastedTranscript("just some notes.\nmore notes.")).toBe("just some notes.\nmore notes.");
  });
});

describe("youtube", () => {
  test("url parsing", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=abc123")).toBe("abc123");
    expect(youtubeVideoId("https://youtu.be/abc123")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/shorts/x")).toBeNull();
  });
  test("json3 and vtt parsing", () => {
    expect(parseJson3(JSON.stringify({ events: [{ segs: [{ utf8: "Hello " }, { utf8: "world" }] }, { segs: [{ utf8: "Hello world" }] }, { segs: [{ utf8: "\n" }] }] }))).toBe("Hello world");
    expect(parseVttPlain("WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:02.000\n<c>Hi</c> there\n\n00:00:02.000 --> 00:00:03.000\nHi there\n\nBye")).toBe("Hi there\nBye");
  });
  test("mocked yt-dlp yields a payload", async () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const run = (args: string[]) => {
      if (args.includes("--print")) return { code: 0, stdout: "A title\nA channel\n", stderr: "" };
      const outIdx = args.indexOf("-o");
      const base = args[outIdx + 1];
      mkdirSync(require("node:path").dirname(base), { recursive: true });
      writeFileSync(base + ".en.json3", JSON.stringify({ events: [{ segs: [{ utf8: "transcript text" }] }] }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const p = await youtubeToPayload("https://www.youtube.com/watch?v=xyz", { author: "me" }, { run });
    expect(p).toMatchObject({ source: "youtube", title: "A title", body: "transcript text", source_url: "https://www.youtube.com/watch?v=xyz" });
    expect(p!.metadata!.source_author).toBe("A channel");
    const fail = await youtubeToPayload("https://www.youtube.com/watch?v=xyz", {}, { run: () => ({ code: 1, stdout: "", stderr: "nope" }) });
    expect(fail).toBeNull();
  });
});

describe("pdf", () => {
  test("extracts text and metadata", async () => {
    const p = await pdfToPayload(fx("hello.pdf"));
    expect(p.source).toBe("pdf");
    expect(p.body).toContain("Hello PDF fixture");
    expect(p.title).toBe("Fixture Title");
    expect(p.source_url).toMatch(/^file:\//);
    expect(p.source_url).not.toContain("\\");
    expect(p.metadata).toMatchObject({ format: "pdf", filename: "hello.pdf", page_count: 1, extractor: "@opendocsg/pdf2md" });
  });
  test("rejects non-PDF", async () => {
    await expect(pdfToPayload(fx("teams.vtt"))).rejects.toThrow(PdfError);
  });
});

describe("file source urls", () => {
  test("POSIX paths keep their shape; Windows paths become forward-slashed file URLs", () => {
    expect(fileSourceUrl("/Users/anna/talk.pdf")).toBe("file:/Users/anna/talk.pdf");
    expect(fileSourceUrl("D:\\a\\jarvis\\hello.pdf")).toBe("file:/D:/a/jarvis/hello.pdf");
    expect(fileSourceUrl("\\\\server\\share\\m.vtt")).toBe("file://server/share/m.vtt");
  });
});

describe("meeting", () => {
  test("vtt and text files need no whisper", () => {
    const v = meetingToPayload(fx("teams.vtt"));
    expect(v.source).toBe("meeting");
    expect(v.title).toBe("Transcript: teams");
    expect(v.body).toContain("Bob: Sure.");
    expect(v.source_url).toMatch(/^file:.*teams\.vtt$/);
    const t = meetingToPayload(fx("pasted.txt"), { title: "Weekly", captureId: "c1" });
    expect(t.title).toBe("Weekly");
    expect(t.source_url).toMatch(/#capture=c1$/);
  });
  test("audio uses a mocked backend, glossary prompt and sibling vtt", () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "jv-meet-"));
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "glossary.toml"), '[products]\n# Misheard as: "a corn", "ay corn"\nAcorn = "Acorn Application Platform"\nStreamlite = "video compression"\n');
    writeFileSync(join(dir, "call.m4a"), "not really audio");
    writeFileSync(join(dir, "call.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Anna>Hi</v>\n");
    let seen: string[] = [];
    const run = (args: string[]) => {
      seen = args;
      const outDir = args[args.indexOf("--output-dir") + 1];
      writeFileSync(join(outDir, "call.txt"), "whisper says hello about a corn");
      return { code: 0, stdout: "", stderr: "" };
    };
    const p = meetingToPayload(join(dir, "call.m4a"), { title: "Acorn sync", dataDir: dir, backend: "mlx_whisper", run, lang: "sv" });
    expect(seen[0]).toBe("mlx_whisper");
    expect(seen).toContain("--initial-prompt");
    expect(seen[seen.indexOf("--initial-prompt") + 1]).toBe("Use these exact spellings when heard: Acorn.");
    expect(p.body).toContain("whisper says hello");
    expect(p.body).toContain("## Teams transcript (raw)");
    expect(p.body).toContain("Anna: Hi");
    expect(p.metadata).toMatchObject({ whisper_backend: "mlx_whisper", lang: "sv" });
  });
  test("no backend gives an actionable error", () => {
    const old = process.env.JARVIS_WHISPER;
    delete process.env.JARVIS_WHISPER;
    try {
      expect(detectWhisperBackend(() => ({ code: 0, stdout: "", stderr: "" }), () => null)).toBeNull();
      expect(detectWhisperBackend(() => ({ code: 0, stdout: "usage: whisper.cpp", stderr: "" }), (b) => (b === "main" ? "/usr/bin/main" : null))).toBe("whisper-cli");
    } finally {
      if (old) process.env.JARVIS_WHISPER = old;
    }
    expect(() => meetingToPayload("x.mp3", { run: () => ({ code: 0, stdout: "", stderr: "" }), backend: undefined })).toThrow();
  });
});

describe("glossary", () => {
  test("parses sections and misheard variants", () => {
    const g = parseGlossary('[abbreviations]\n# Misheard as: "arb", "a r b"\nARB = "Architecture Review Board"\n\n[people]\n"Kim Larsen" = "architect"\n');
    expect(g.entries.length).toBe(2);
    expect(g.entries[0]).toMatchObject({ term: "ARB", section: "abbreviations", variants: ["arb", "a r b"] });
    expect(g.entries[1]).toMatchObject({ term: "Kim Larsen", section: "people", variants: [] });
    expect(variantMap(g).get("a r b")).toBe("ARB");
    expect(whisperInitialPrompt(g, "ARB weekly with Kim Larsen")).toBe("Use these exact spellings when heard: Kim Larsen, ARB.");
    expect(whisperInitialPrompt(g, "nothing")).toBeUndefined();
  });
});
