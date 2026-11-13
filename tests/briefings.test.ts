import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBriefingBody, parseLenientJson, BriefingParseError } from "../src/briefings/parser.ts";
import { splitBriefing, serializeBriefing } from "../src/briefings/frontmatter.ts";
import { buildToc, collectHeadings } from "../src/briefings/toc.ts";
import { renderMarkdown, renderInline } from "../src/briefings/markdown.ts";
import { componentNames, listComponents, COMPONENT_COUNT, sanitizeSvg } from "../src/briefings/components.ts";
import { renderBriefingHtml, flattenText } from "../src/briefings/render.ts";
import { routeBlockEdge, resetMarkerCounter, wrapText } from "../src/briefings/diagrams.ts";
import { createBriefing, readBriefing, listBriefings, approveBriefing, addComment, readComments, transitionComment } from "../src/briefings/store.ts";
import { briefingToStorage, markdownToStorage, publishBriefing, confluenceAuthHeader } from "../src/briefings/confluence.ts";
import "../src/briefings/index.ts";
import { reindex } from "../src/core/reindex.ts";
import { ingest } from "../src/core/ingest.ts";
import { search } from "../src/core/search.ts";
import { withDb } from "../src/core/db.ts";
import { handle } from "../src/server.ts";
import { clearEmbedder, tmpDataDir, useFakeEmbedder } from "./helpers.ts";

let t: ReturnType<typeof tmpDataDir>;
beforeEach(() => {
  t = tmpDataDir();
  useFakeEmbedder();
});
afterEach(() => {
  t.cleanup();
  clearEmbedder();
});

describe("parser", () => {
  test("markdown, components, nested, self-closing, raw children, attributes", () => {
    const src = `# Intro\n\n<Section title="One" id='s1'>\n\nText with <b>lowercase html</b> and a stray </Nope> closer.\n\n<Callout variant="warn" collapsible>\n\nInner\n\n</Callout>\n\n<StepFlow steps={[{title:'A', accent:"teal"},{title:"B",},]} />\n\n</Section>\n\n<SvgDiagram caption="c"><svg><Foo/></svg></SvgDiagram>\n\n\`\`\`mermaid\n<NotATag>\n\`\`\`\n`;
    const tree = parseBriefingBody(src);
    expect(tree.map((n) => n.type)).toEqual(["markdown", "component", "component", "markdown"]);
    const sec = tree[1] as Extract<typeof tree[number], { type: "component" }>;
    expect(sec.name).toBe("Section");
    expect(sec.props).toEqual({ title: "One", id: "s1" });
    expect(sec.line).toBe(3);
    expect(sec.children[0]).toMatchObject({ type: "markdown" });
    expect((sec.children[0] as { content: string }).content).toContain("<b>lowercase html</b>");
    expect((sec.children[0] as { content: string }).content).toContain("</Nope>");
    const callout = sec.children[1] as typeof sec;
    expect(callout.props).toEqual({ variant: "warn", collapsible: true });
    const flow = sec.children[2] as typeof sec;
    expect(flow.selfClosing).toBe(true);
    expect(flow.props.steps).toEqual([{ title: "A", accent: "teal" }, { title: "B" }]);
    const svg = tree[2] as typeof sec;
    expect(svg.children).toEqual([{ type: "raw", content: "<svg><Foo/></svg>" }]);
    expect((tree[3] as { content: string }).content).toContain("<NotATag>");
  });
  test("errors carry line and column", () => {
    expect(() => parseBriefingBody("ok\n\n<Callout>\nno close")).toThrow(BriefingParseError);
    try {
      parseBriefingBody("a\n<Section title=\"x\">\n<Callout>\n</Section>");
    } catch (e) {
      expect((e as BriefingParseError).line).toBe(3);
      expect((e as BriefingParseError).message).toMatch(/unclosed <Callout>/);
    }
    expect(() => parseBriefingBody("<Callout x={[1,}>")).toThrow(/invalid JSON/);
  });
  test("lenient json", () => {
    expect(parseLenientJson("{a:1, 'b':'x', \"c\":[true,null,],}")).toEqual({ a: 1, b: "x", c: [true, null] });
    expect(() => parseLenientJson("{a: 1+1}")).toThrow();
  });
});

describe("frontmatter + toc", () => {
  test("split, serialize, arrays and toc gate", () => {
    const { frontmatter, body } = splitBriefing(`---\ntitle: "Hello: there"\ntags: [a, b]\ntoc: true\nkind: lesson\ntrail: 01T\nextra: keep\n---\n\n## A\n\n## B\n`);
    expect(frontmatter).toMatchObject({ title: "Hello: there", tags: ["a", "b"], toc: true, kind: "lesson", trail: "01T", extra: "keep" });
    const text = serializeBriefing(frontmatter, body);
    expect(text.startsWith("---\ntitle: 'Hello: there'\n") || text.startsWith("---\ntitle: \"Hello: there\"\n")).toBe(true);
    expect(splitBriefing(text).frontmatter.extra).toBe("keep");
    const tree = parseBriefingBody(`<Section title="S">\n\n### Sub\n\n</Section>\n\n# Top\n\n#### too deep\n\n\`\`\`\n# not a heading\n\`\`\`\n\n## Sub 2\n\n## Sub 2\n`);
    expect(collectHeadings(tree).map((h) => `${h.level}:${h.text}`)).toEqual(["2:S", "3:Sub", "1:Top", "2:Sub 2", "2:Sub 2"]);
    const toc = buildToc(tree)!;
    expect(toc.map((e) => e.slug)).toEqual(["s", "sub", "top", "sub-2", "sub-2-2"]);
    expect(buildToc(tree, false)).toBeNull();
    expect(buildToc(parseBriefingBody("## a\n\n## b"), undefined)).toBeNull();
    expect(buildToc(parseBriefingBody("## a\n\n## b"), true)!.length).toBe(2);
  });
});

describe("markdown", () => {
  test("blocks and inline", () => {
    const html = renderMarkdown("# H1\n\nPara *em* **strong** `code` [l](https://x.test) [[01ARZ3NDEKTSV4RRFFQ69G5FAV]] a * b\n\n- one\n  - nested\n- two\n\n1. first\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n```mermaid\ngraph TD\n```\n");
    expect(html).toContain("<h1>H1</h1>");
    expect(html).toContain("<em>em</em> <strong>strong</strong> <code>code</code>");
    expect(html).toContain('href="https://x.test" target="_blank" rel="noopener"');
    expect(html).toContain('href="#/item/01ARZ3NDEKTSV4RRFFQ69G5FAV"');
    expect(html).toContain("a * b");
    expect(html).toContain("<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li></ol>");
    expect(html).toContain("<blockquote><p>quote</p></blockquote>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<hr>");
    expect(html).toContain('<pre><code class="language-mermaid">graph TD</code></pre>');
    expect(renderInline("[x](javascript:alert(1))")).toContain('href="#"');
    expect(renderInline("<script>")).toBe("&lt;script&gt;");
  });

  test("an initiative mention links to its tab in the same browser tab (jv-77m)", () => {
    expect(renderInline("see [Software Principles](jarvis://initiative/01ABC_d-9)")).toBe('see <a href="#/initiative/01ABC_d-9">Software Principles</a>');
    expect(renderMarkdown("Pick [**It**](jarvis://initiative/I1).")).toContain('<a href="#/initiative/I1"><strong>It</strong></a>');
    expect(renderInline("[x](jarvis://initiative/a%22b)")).not.toContain("#/initiative/");
    expect(renderInline("[x](https://x.test)")).toContain('target="_blank"');
  });

  test("a jarvis:// link that is not an initiative reads as its plain words, never a dead link (jv-ba9)", () => {
    expect(renderInline("as [Principles and the train](jarvis://note/01N9.)")).toBe("as Principles and the train");
    expect(renderInline("[x](jarvis://task/T1)")).toBe("x");
    expect(renderInline("[x](JARVIS://note/N1)")).toBe("x");
    expect(renderInline("[x](jarvis://initiative/a%22b)")).toBe("x");
    expect(renderMarkdown("See [**It**](jarvis://note/N1).")).toContain("See <strong>It</strong>.");
  });
});

describe("components", () => {
  test("all 19 register and render without throwing", () => {
    expect(componentNames().length).toBe(COMPONENT_COUNT);
    expect(listComponents("topology").map((c) => c.id)).toEqual(["BlockDiagram"]);
    resetMarkerCounter();
    const src = `<Section title="S"><Callout variant="good" title="T">x</Callout><Grid2><Callout>a</Callout><Callout variant="bad">b</Callout></Grid2><FlowDiagram caption="f">A -> B</FlowDiagram><TagPill variant="warn">Soon</TagPill><ProConList items={[{kind:'pro',text:'p'},{kind:'con',text:'c'}]} /><ComparisonTable headers={['a','b']} rows={[['1','2'],{cells:['3','4'],highlight:true}]} caption="cmp" /><ItemCard itemId="01X" label="Src" /><SvgDiagram><svg viewBox="0 0 1 1"><script>x</script><rect onclick="y"/></svg></SvgDiagram><Legend items={[{color:'teal',label:'now'}]} /><StepFlow steps={[{title:'A',eyebrow:'1',status:'done'},{title:'B',meta:'m'},{title:'C'},{title:'D'},{title:'E'}]} arrows="dashed" /><CycleDiagram steps={[{title:'Plan'},{title:'Do'},{title:'Check'},{title:'Act'}]} centerTitle="PDCA" /><CycleDiagram mode="hub" steps={[{title:'a'},{title:'b',satellite:true}]} centerTitle="Hub" /><PyramidDiagram layers={[{title:'top',sub:'s',meta:'m'},{title:'mid'},{title:'base'}]} /><StackDiagram layers={[{title:'UI',items:['web']},{title:'Core'}]} arrows /><Timeline events={[{date:'2026-10',title:'Kick'},{date:'2026-12',title:'GA',deadline:true,description:'ship'}]} /><SequenceDiagram actors={[{id:'a',label:'App'},{id:'b',label:'API'}]} messages={[{from:'a',to:'b',label:'GET'},{from:'b',to:'a',label:'200',dashed:true},{from:'b',to:'b',label:'self'}]} /><Quadrants xAxis={{label:'Effort',low:'lo',high:'hi'}} yAxis={{label:'Value'}} items={[{label:'A',x:0.2,y:0.8}]} quadrants={['q1','q2','q3','q4']} /><ActivityDiagram nodes={[{id:'s',type:'start'},{id:'a',type:'action',label:'Do it'},{id:'d',type:'decision',label:'ok?'},{id:'f',type:'fork'},{id:'e',type:'end'}]} edges={[{from:'s',to:'a'},{from:'a',to:'d',label:'go'},{from:'d',to:'e'}]} /><BlockDiagram nodes={[{id:'cli',row:0,column:0,title:'CLI',kicker:'entry'},{id:'core',row:0,column:1,title:'Core library',sub:'logic',items:['ingest','search'],emphasis:true},{id:'db',row:1,column:1,title:'SQLite',dashed:true}]} edges={[{from:'cli',to:'core',label:'calls'},{from:'core',to:'cli',label:'returns'},{from:'core',to:'db',curve:true,dashed:true}]} /><Unknown foo="1" /></Section>`;
    const html = renderBriefingHtml(parseBriefingBody(src));
    expect(html).toContain('<section class="jv-section" id="s"');
    expect(html).toContain("jv-callout-good");
    expect(html).toContain("jv-grid2");
    expect(html).toContain("A -&gt; B");
    expect(html).toContain("Soon");
    expect(html).toContain("background:var(--jv-row-hl, #e3fcef)");
    expect(html).toContain('href="#/item/01X"');
    expect(html).toContain("not loaded");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
    expect(html).toContain("PDCA");
    expect(html).toContain("<figcaption");
    expect(html).toContain("Unknown component &lt;Unknown&gt;");
    const markers = html.match(/id="jv-arrow-\d+"/g)!;
    expect(new Set(markers).size).toBe(markers.length);
    // 5 steps → vertical
    expect(html).toContain('viewBox="0 0 220');
  });
  test("block edge routing offsets opposite pairs and wraps text", () => {
    const a = { id: "a", row: 0, column: 0, title: "A" }, b = { id: "b", row: 0, column: 1, title: "B" };
    const r1 = routeBlockEdge(a, b, { from: "a", to: "b" }, false);
    const r2 = routeBlockEdge(b, a, { from: "b", to: "a" }, true);
    expect(r1.path.startsWith("M220,64")).toBe(true);
    expect(r2.path.startsWith("M280,94")).toBe(true);
    const v = routeBlockEdge(a, { id: "c", row: 1, column: 0, title: "C" }, { from: "a", to: "c" }, false);
    expect(v.path).toBe("M120,108 L120,158");
    expect(wrapText("one two three four five", 60, 14)).toEqual(["one two", "three", "four", "five"]);
    expect(sanitizeSvg('<svg><a xlink:href="javascript:x">t</a><foreignObject>z</foreignObject></svg>')).toBe("<svg><a>t</a></svg>");
  });
});

describe("store, comments, index, routes", () => {
  test("create → list → approve → comments with transitions", async () => {
    const b = createBriefing(t.dir, { title: "My brief", author: "me", status: "draft", tags: ["x"] });
    expect(existsSync(join(t.dir, "briefings", `${b.id}.brief.mdx`))).toBe(true);
    expect(b.body).toContain('<Callout title="Summary">');
    expect(listBriefings(t.dir)[0]).toMatchObject({ id: b.id, title: "My brief", kind: "briefing", status: "draft", tags: ["x"] });
    expect(() => createBriefing(t.dir, { title: "L", kind: "lesson" })).toThrow(/trail/);
    approveBriefing(t.dir, b.id);
    expect(readBriefing(t.dir, b.id)!.status).toBe("approved");
    expect(readFileSync(join(t.dir, "briefings", `${b.id}.brief.mdx`), "utf8")).toContain("status: approved");
    const c = addComment(t.dir, b.id, { comment: "fix this", author: "kim" });
    expect(readComments(t.dir, b.id)[0]).toMatchObject({ id: c.id, status: "open", author: "kim", anchor: { treeHash: "", nodePath: [] } });
    expect(() => transitionComment(t.dir, b.id, c.id, "done")).toThrow(/cannot move/);
    transitionComment(t.dir, b.id, c.id, "handled", { agentNote: "did it" });
    expect(readComments(t.dir, b.id)[0]).toMatchObject({ status: "handled", handledBy: "agent", agentNote: "did it" });
    transitionComment(t.dir, b.id, c.id, "done");
    expect(readComments(t.dir, b.id)[0].doneAt).toBeDefined();
  });
  test("briefings are projected into the index with edges and are searchable", async () => {
    const doc = await ingest(t.dir, { source: "meeting", title: "Transcript", body: "we discussed streamlite", author: "me" });
    const trail = createBriefing(t.dir, { title: "Trail", author: "me" });
    const lesson = createBriefing(t.dir, { title: "Lesson one", kind: "lesson", trail: trail.id, author: "me", body: "<Section title=\"Streamlite basics\">\n\nStreamlite reduces bandwidth.\n\n<StepFlow steps={[{title:'Analyse frames'}]} />\n\n</Section>\n" });
    const summary = createBriefing(t.dir, { title: "Meeting summary: Transcript", kind: "meeting-summary", source_doc: doc.id, author: "me", subtitle: "Decisions taken", body: "## Decisions\n\nUse streamlite.\n" });
    const r = await reindex(t.dir);
    expect(r.briefingsIndexed).toBe(3);
    const rows = withDb(t.dir, (db) => ({
      docs: db.query("SELECT id, source, summary, metadata, file_path FROM documents WHERE source='briefing' ORDER BY id").all() as any[],
      edges: db.query("SELECT src, dst, relation FROM edges WHERE created_by='briefing' ORDER BY relation").all() as any[],
      body: (db.query("SELECT body FROM documents WHERE id = ?").get(lesson.id) as any).body,
    }));
    expect(rows.docs.length).toBe(3);
    expect(rows.docs.find((d) => d.id === summary.id)).toMatchObject({ summary: "Decisions taken", file_path: `briefings/${summary.id}.brief.mdx` });
    expect(JSON.parse(rows.docs.find((d) => d.id === lesson.id).metadata)).toEqual({ kind: "lesson", source_path: `briefings/${lesson.id}.brief.mdx`, trail: trail.id });
    expect(rows.edges).toEqual([{ src: lesson.id, dst: trail.id, relation: "part_of" }, { src: summary.id, dst: doc.id, relation: "references" }]);
    expect(rows.body).toContain("Streamlite basics");
    expect(rows.body).toContain("Analyse frames");
    const hits = await search(t.dir, "streamlite bandwidth", { mode: "keyword" });
    expect(hits[0].docId).toBe(lesson.id);
    expect(hits[0].source).toBe("briefing");
    // removing the file reaps the row; rerun clears briefing edges and recreates
    const { rmSync } = await import("node:fs");
    rmSync(join(t.dir, "briefings", `${summary.id}.brief.mdx`));
    const r2 = await reindex(t.dir);
    expect(r2.reaped).toBe(1);
    expect(withDb(t.dir, (db) => (db.query("SELECT count(*) c FROM edges WHERE created_by='briefing'").get() as any).c)).toBe(1);
  });
  test("HTTP routes", async () => {
    const call = (method: string, path: string, body?: unknown) => handle(new Request(`http://127.0.0.1:7281${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), { dataDir: t.dir });
    const b = createBriefing(t.dir, { title: "R", author: "me", body: "<Callout>hi</Callout>\n" });
    expect((await (await call("GET", "/api/briefings")).json())[0].id).toBe(b.id);
    const d = await (await call("GET", `/api/briefing/${b.id}?html=1`)).json();
    expect(d.tree[0].name).toBe("Callout");
    expect(d.html).toContain("jv-callout");
    expect((await call("GET", "/api/briefing/nope")).status).toBe(404);
    expect((await call("POST", `/api/briefing/${b.id}/comments`, { text: "hello" })).status).toBe(200);
    expect((await call("POST", `/api/briefing/${b.id}/comments`, {})).status).toBe(400);
    expect((await (await call("GET", `/api/briefing/${b.id}/comments`)).json()).length).toBe(1);
  });
  test("a comment posted as the web client posts it carries the service's author, as the CLI would record (jv-ii7)", async () => {
    const saved = process.env.JARVIS_AUTHOR;
    process.env.JARVIS_AUTHOR = "psylocke";
    try {
      const b = createBriefing(t.dir, { title: "R", author: "me", body: "hi\n" });
      const req = new Request(`http://127.0.0.1:7281/api/briefing/${b.id}/comments`, { method: "POST", body: JSON.stringify({ comment: "from the web" }), headers: { "content-type": "application/json" } });
      expect((await (await handle(req, { dataDir: t.dir })).json()).author).toBe("psylocke");
      expect(readComments(t.dir, b.id)[0].author).toBe("psylocke");
      const explicit = new Request(`http://127.0.0.1:7281/api/briefing/${b.id}/comments`, { method: "POST", body: JSON.stringify({ comment: "x", author: "kim" }), headers: { "content-type": "application/json" } });
      expect((await (await handle(explicit, { dataDir: t.dir })).json()).author).toBe("kim");
    } finally {
      if (saved === undefined) delete process.env.JARVIS_AUTHOR;
      else process.env.JARVIS_AUTHOR = saved;
    }
  });
});

describe("confluence", () => {
  test("storage format rendering", () => {
    expect(markdownToStorage("# T\n\ntext `c` ![a](https://i/x.png) [l](https://x)\n\n```ts\nlet x\n```\n\n---\n")).toBe('<h1>T</h1><p>text <code>c</code> <ac:image ac:alt="a"><ri:url ri:value="https://i/x.png"/></ac:image> <a href="https://x">l</a></p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[let x]]></ac:plain-text-body></ac:structured-macro><hr/>');
    const b = createBriefing(t.dir, { title: "P", subtitle: "sub", body: `<Section title="A">\n\n<Callout variant="warn" title="W">x</Callout>\n\n<Grid2><Callout variant="good">g</Callout><Callout>n</Callout></Grid2>\n\n<ComparisonTable headers={['h']} rows={[{cells:['v'],highlight:true}]} />\n\n<TagPill variant="good">ok</TagPill>\n\n<BlockDiagram nodes={[{id:'a',row:0,column:0,title:'A'}]} />\n\n</Section>\n\n<Section title="B">\n\n## C\n\n## D\n\n</Section>\n` });
    const s = briefingToStorage(readBriefing(t.dir, b.id)!);
    expect(s.startsWith('<ac:structured-macro ac:name="toc">')).toBe(true);
    expect(s).toContain("<p><em>sub</em></p><h2>A</h2>");
    expect(s).toContain('ac:name="warning"><ac:parameter ac:name="title">W</ac:parameter>');
    expect(s).toContain('ac:name="panel"><ac:parameter ac:name="bgColor">#e8f8ef</ac:parameter>');
    expect(s).toContain('<td data-highlight-colour="#e3fcef">v</td>');
    expect(s).toContain('ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">ok</ac:parameter>');
    expect(s).toContain('ac:name="html"><ac:plain-text-body><![CDATA[<figure');
  });
  test("publish: draft refused, create then update by title, auth headers", async () => {
    const b = createBriefing(t.dir, { title: "Pub", status: "draft", body: "hi\n" });
    await expect(publishBriefing(t.dir, b, {})).rejects.toThrow(/draft/);
    expect((await publishBriefing(t.dir, b, { dryRun: true, allowDraft: true })).storage).toContain("<p>hi</p>");
    await expect(publishBriefing(t.dir, b, { allowDraft: true, env: {} })).rejects.toThrow(/confluence\.json/);
    mkdirSync(join(t.dir, "config"), { recursive: true });
    writeFileSync(join(t.dir, "config", "confluence.json"), JSON.stringify({ baseUrl: "https://wiki.test/", spaceKey: "ARB", parentPageId: "99" }));
    await expect(publishBriefing(t.dir, b, { allowDraft: true, env: {} })).rejects.toThrow(/CONFLUENCE_PAT/);
    const calls: { url: string; init: RequestInit }[] = [];
    let exists = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === undefined) return new Response(JSON.stringify({ results: exists ? [{ id: "123", version: { number: 4 } }] : [] }));
      return new Response(JSON.stringify({ id: "123", _links: { base: "https://wiki.test", webui: "/x" } }));
    }) as unknown as typeof fetch;
    const r1 = await publishBriefing(t.dir, b, { allowDraft: true, fetchImpl, env: { CONFLUENCE_PAT: "tok" } });
    expect(r1).toEqual({ action: "created", pageId: "123", title: "Pub", url: "https://wiki.test/x" });
    expect(calls[0].url).toBe("https://wiki.test/rest/api/content?spaceKey=ARB&title=Pub&type=page&expand=version&limit=1");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(calls[1].init.method).toBe("POST");
    expect(JSON.parse(calls[1].init.body as string).ancestors).toEqual([{ id: "99" }]);
    exists = true;
    const r2 = await publishBriefing(t.dir, b, { allowDraft: true, fetchImpl, env: { CONFLUENCE_EMAIL: "a@b", CONFLUENCE_API_TOKEN: "t" } });
    expect(r2.action).toBe("updated");
    expect(calls[3].init.method).toBe("PUT");
    expect(calls[3].url).toBe("https://wiki.test/rest/api/content/123");
    expect(JSON.parse(calls[3].init.body as string).version).toEqual({ number: 5 });
    expect(confluenceAuthHeader({ CONFLUENCE_EMAIL: "a@b", CONFLUENCE_API_TOKEN: "t" })).toBe(`Basic ${Buffer.from("a@b:t").toString("base64")}`);
  });

  test("tinted panels take their background from tokens, so dark looks stay readable", () => {
    const variants = ["accent", "warn", "good", "bad", "neutral", "investigate"];
    const src = variants.map((v) => `<Callout variant="${v}" title="T">\n\nx\n\n</Callout>`).join("\n\n")
      + `\n\n<FlowDiagram>\nA --> B\n</FlowDiagram>\n\n<ComparisonTable headers={["h"]} rows={[{cells:["a"],highlight:true}]} />`;
    const html = renderBriefingHtml(parseBriefingBody(src));
    const light: Record<string, string> = { accent: "#eef4ff", warn: "#fff7e6", good: "#e8f8ef", bad: "#fdecec", neutral: "#f3f4f6", investigate: "#f3eefe" };
    for (const v of variants) expect(html).toContain(`jv-callout-${v}" style="margin:16px 0;padding:12px 16px;border-left:4px solid`), expect(html).toContain(`background:var(--jv-tint-${v}, ${light[v]})`);
    expect(html).toContain("background:var(--jv-code-bg, #f8fafc)");
    expect(html).toContain("background:var(--jv-head-bg, #f3f4f6)");
    expect(html).toContain('style="background:var(--jv-row-hl, #e3fcef)"');
  });
});
