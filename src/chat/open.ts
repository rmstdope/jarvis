/** The agent opens a document by writing `<<open:ID>>`; this strips those markers from the streamed answer. */

const MARKER = /<<open:([A-Za-z0-9_-]{1,80})>>/g;

/** Streaming filter: `push` a chunk, get the text safe to show and the ids opened so far; `end` flushes a held tail. */
export class OpenFilter {
  private held = "";
  /** Feed one chunk of answer text. A trailing partial marker is held back until the next chunk. */
  push(chunk: string): { text: string; opens: string[] } {
    const s = this.held + chunk;
    const cut = s.lastIndexOf("<<");
    let tail = "";
    let body = s;
    if (cut >= 0 && !s.slice(cut).includes(">>") && s.length - cut <= 128) { body = s.slice(0, cut); tail = s.slice(cut); }
    else if (s.endsWith("<")) { body = s.slice(0, -1); tail = "<"; }
    this.held = tail;
    const opens: string[] = [];
    const text = body.replace(MARKER, (_m, id: string) => { opens.push(id); return ""; });
    return { text, opens };
  }
  /** The turn is over: whatever was held was not a marker. */
  end(): string {
    const t = this.held;
    this.held = "";
    return t;
  }
}
