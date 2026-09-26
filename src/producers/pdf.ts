import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { sha256 } from "../core/util.ts";
import type { CapturePayload } from "../core/ingest.ts";

export class PdfError extends Error {}

/** Extract a text PDF to Markdown before capture. Binary never enters git or the index. */
export async function pdfToPayload(path: string, opts: { title?: string; author?: string } = {}): Promise<CapturePayload> {
  const abs = resolve(path);
  const bytes = readFileSync(abs);
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) throw new PdfError(`${path} is not a PDF (no %PDF- header in the first 1 KB)`);
  const { default: pdf2md } = (await import("@opendocsg/pdf2md")) as unknown as { default: (data: Uint8Array, cb?: unknown) => Promise<string> };
  let md: string;
  let pageCount = 0;
  let infoTitle: string | undefined;
  try {
    md = await pdf2md(new Uint8Array(bytes), {
      metadataParsed: (meta: { info?: { Title?: string; IsAcroFormPresent?: boolean }; metadata?: { get?: (k: string) => string | undefined } }) => {
        infoTitle = meta?.info?.Title || meta?.metadata?.get?.("dc:title") || undefined;
      },
      pageParsed: () => {
        pageCount++;
      },
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/password|encrypted/i.test(msg)) throw new PdfError(`${path} is encrypted; decrypt it before capture`);
    throw new PdfError(`${path} could not be parsed as a PDF: ${msg}`);
  }
  const text = md.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!text) throw new PdfError(`${path} contains no extractable text: image-only PDFs need OCR before capture`);
  const title = opts.title || (infoTitle && infoTitle.trim()) || basename(abs).replace(/\.pdf$/i, "");
  return {
    source: "pdf",
    title,
    body: text,
    author: opts.author,
    source_url: `file:${abs}`,
    metadata: { format: "pdf", filename: basename(abs), mime_type: "application/pdf", sha256: sha256(bytes), extractor: "@opendocsg/pdf2md", page_count: pageCount },
  };
}
