# J.A.R.V.I.S. — architecture

This document describes what J.A.R.V.I.S. is, how it is put together, and which technologies it is
built on. It reflects the code in this repository as of the M10 milestone (see
`IMPLEMENTATION-PLAN.md` for the milestone history and the decisions taken along the way).

## 1. High-level overview

J.A.R.V.I.S. is a **team-collaborative knowledge base**: a durable, searchable, shared memory for
the things that otherwise stay scattered across meetings, browser tabs, videos, PDFs and notes.
Several people, each on their own machine, build one shared knowledge base, and a coding agent (or a human at
the CLI) captures, searches, links and shares on their behalf.

The system rests on four design bets:

1. **Shared truth is plain files in a git repository.** Every captured item, every enrichment result,
   every judged link, every briefing is a file in a *content repo* hosted on the team's GitHub. There
   is no server and no central database; git is the only rendezvous point.
2. **Each machine keeps a disposable SQLite index.** Full-text search and vector search live in a
   local `.index/jarvis.db` that is derived from the files and never committed. A corrupt index is an
   inconvenience, never data loss: `jarvis reindex --full` rebuilds it.
3. **Local models first.** Embeddings always run locally. Chat and enrichment models run locally
   where the hardware allows and fall back, through a provider facade and a task-based router, to the
   GitHub Copilot CLI or any OpenAI-compatible API. Every model step is optional: "no model" means
   *skip*, never *fail*.
4. **Agent-driven use.** The normal way to use J.A.R.V.I.S. is through a coding agent that drives the
   CLI and the local HTTP service. `docs/AGENT-INSTRUCTIONS.md` (printed by `jarvis skill`) tells the agent how.

The knowledge loop is **Capture → Understand → Use**:

- **Capture**: notes, pasted text, web pages (browser extension), YouTube transcripts, PDFs, meeting
  recordings (Whisper) and Teams transcripts, all through one `ingest()` function.
- **Understand**: enrich with summaries, tags and entity mentions; clean garbled transcripts against a
  shared glossary; build a knowledge graph of links (heuristic, vector-based, LLM-judged and manual).
- **Use**: keyword, semantic and hybrid search; grounded question answering with citations; a chat
  panel; tasks linked into the graph; and *briefings*, component-rendered documents (diagrams,
  timelines, comparisons) that can be published to Confluence.

The invariant that shapes everything is **authored is shared, derived is local**. Anything a human or
a model authored (docs, enrichment output, judged edges and rejections, entities, briefings,
comments, decks, tasks) lives in git. Anything recomputable (chunks, vectors, the full-text index,
heuristic edges, pipeline markers) lives in the gitignored `.index/` directory and is never committed.

### 1.1 The shape of the system

```
                ┌──────────── entrypoints (thin) ─────────────┐
   CLI  ────────┤  src/cli.ts                                  │
   HTTP service ┤  src/server.ts + src/http.ts + src/chat/*    │      files: the content repo (git)
   web UI ──────┤  web/  (browser, same origin)                ├──►   +
   extension ───┤  extension/  (MV3, talks HTTP)               │      local index: .index/jarvis.db
   macOS app ───┤  jarvis-app/  (WKWebView over the UI)  │
                └───────────────┬──────────────────────────────┘
                                │
                ┌───────────────▼──────────────────────────────┐
                │ core library  src/core, src/providers,       │
                │               src/briefings, src/producers   │
                └──────────────────────────────────────────────┘
```

The core library owns all logic. The CLI commands and the HTTP routes are thin adapters over it: the
rule is *no logic in a CLI command or a route that is not in the core*. The HTTP service on
`127.0.0.1:7281` is the architectural seam that every other client (web UI, extension, macOS app,
agents) talks to.

Two repositories are always involved: the **code repo** (this one, the tool) and one **content repo**
per team (the knowledge). The content repo is the collaboration and access boundary.

### 1.2 Capability tiers

A machine does as much as its hardware and configuration allow:

| Tier | Requires | Adds |
|---|---|---|
| Local builder (default) | an embedding server | capture, chunk, embed, semantic + keyword search, heuristic edges |
| Tier 1 | a chat model via the router (local, Copilot, gateway) | summaries, tags, entity mentions, LLM-judged edges, transcript cleanup, synthesis, meeting summaries, chat |
| Consumer (published mode, partial) | a published snapshot | capture and keyword search only; never runs models |

## 2. Tech stack walkthrough

### 2.1 Runtime and language

| Choice | Version | Why |
|---|---|---|
| **Bun** | 1.4.2 (pinned in CI) | One runtime for the CLI, the HTTP server (`Bun.serve`), SQLite (`bun:sqlite`), TOML (`Bun.TOML`), subprocesses (`Bun.spawn`), tests (`bun test`) and bundling (`Bun.build`). No Node, no Vite, one lockfile. |
| **TypeScript** | 5.9, strict, ESM | Three typechecked trees: core (`tsconfig.json`), web (`web/tsconfig.json`, DOM lib) and extension (`extension/tsconfig.json`, Chrome types). `bun run typecheck` runs all three. |

Bun executes TypeScript directly, so there is no build step for the CLI or the server. Only the
browser-side code (web UI, extension) is bundled, and that is done by `Bun.build` from
`scripts/build-web.ts` and `scripts/build-extension.ts`.

### 2.2 Storage

| Choice | Version | Role |
|---|---|---|
| **git** | system | The only "server". `src/core/git.ts` runs it as a subprocess with `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=true` so it never prompts. Sync always pulls with `--no-rebase` (merge), and `.gitattributes` declares `edges/*.jsonl merge=union` so concurrent appends to a sidecar merge mechanically. |
| **SQLite** via `bun:sqlite` | Homebrew SQLite on macOS | The local projection at `<content-repo>/.index/jarvis.db`, opened in WAL mode. Bun's bundled SQLite refuses extension loading, so `src/core/db.ts` points Bun at the Homebrew dylib with `Database.setCustomSQLite()` before the first connection. |
| **sqlite-vec** | 0.1.9 | Vector search. A `vec0` virtual table `chunks_vec(chunk_id, embedding float[512])` answers kNN queries (`embedding MATCH ? AND k = ?`). |
| **FTS5** | built into SQLite | Keyword search. `documents_fts` is an external-content table over `documents(title, body, summary, tags)` kept in sync by insert/update/delete triggers; BM25 `rank` orders hits and `snippet()` produces highlighted excerpts. |
| **ulid** | 3.0.2 | Every item id is a ULID, so ids sort by capture time and file names never change on title edits. Chunk ids are SHA-256 content hashes instead, so unchanged text keeps its embedding across reindexes. |
| **yaml** | 2.9.1 | Doc frontmatter (`docs/<ulid>.md`), presentation frontmatter and briefing frontmatter all use the real YAML parser. Config files use `Bun.TOML`. No hand-rolled YAML or TOML subsets. |

The content repo layout that these pieces read and write:

```
<content-repo>/
  docs/<ulid>.md                 one captured doc per file: YAML frontmatter + verbatim body
  edges/<doc-ulid>.jsonl         authored edges + rejections, one sidecar per source doc, append-only
  entities/<ulid>.json           entity registry, one file per entity
  briefings/<id>.brief.mdx       briefings, lessons, meeting summaries (+ <id>.comments.json)
  presentations/<slug>/index.mdx MDX deck bundles with colocated assets
  config/glossary.toml           shared transcription terms and their ASR variants
  config/team.toml               projection policy
  config/confluence.json         non-secret Confluence target
  filters.json                   shared capture blocklist
  .index/                        gitignored local projection
```

### 2.3 Models and inference

| Choice | Role |
|---|---|
| **Ollama** (`http://localhost:11434`, overridable) | Embeddings with `qwen3-embedding:0.6b` via `POST /api/embed`, and local chat models via `POST /api/chat` with `think:false` (thinking under constrained JSON burns the budget). |
| **oMLX** (`http://127.0.0.1:8000/v1`) | Alternative embedding and chat server on Apple Silicon, OpenAI-style API. |
| **GitHub Copilot CLI** | Headless `copilot -p … --output-format json` for document-level enrichment, and `copilot --acp` (Agent Client Protocol over NDJSON stdio) for the Discuss chat. Rides the team entitlement, no key. |
| **OpenAI-compatible API** (OpenAI itself, or any compatible server such as vLLM or LM Studio) | `POST /chat/completions` with a bearer token read from the environment variable *named* in `models.toml`; `OPENAI_API_KEY` is detected automatically. |

The **embedding contract** is pinned in `src/core/constants.ts`: model Qwen3-Embedding-0.6B, native
1024 dimensions truncated to the first **512** and L2-normalized. Every chunk and every query vector
goes through the same `normalizeVector()` so distances are comparable. Changing the model requires a
full reindex.

The **provider facade** (`src/providers/types.ts`) is the only interface pipeline code sees:

```ts
type TaskKind = 'tag'|'summary'|'entities'|'edge-judge'|'cleanup'|'synthesis';
interface ResolvedModel { id: string; complete(prompt, {json?, maxTokens?, reasoningEffort?}): Promise<string> }
router.resolve({ kind: 'summary', minQuality: 'standard' })  // → ResolvedModel | null (= skip)
```

The **router** (`src/providers/router.ts`) reads `~/.jarvis/models.toml` (or synthesizes a
config from live detection), probes every entry's availability once in parallel at creation, and then
resolves synchronously: quality floor → `bestFor` affinity → provider preference → cheapest sufficient
quality. `TruncationError` (the output cap was hit) is a deterministic signal, never retried; ENRICH
falls back once to a summary-only prompt instead. Six shipped presets under `docs/examples/models/`
cover common hardware, and `jarvis doctor` reports which task kinds resolve to nothing.

### 2.4 The pipeline

Every phase is batch-oriented, idempotent and resumable; "pending" is derived from state, never from a
queue.

```
CAPTURE ─► INDEX ─► CHUNK ─► EMBED ─► embedding candidates ─► EDGE-REFINE ─► sidecar (shared)
CAPTURE ─► ENRICH ─┬─► auto edges     (need tags)              [derived, every machine]
                   └─► entity edges   (need resolved mentions) [derived, every machine]
CAPTURE ──────────► backlink edges    (need only other docs' titles)
SHARE = git commit + pull (merge) + push
```

| Phase | Module | Pending when |
|---|---|---|
| CAPTURE | `src/core/ingest.ts` | a producer hands over `{source, title, body, …}` |
| INDEX | `src/core/reindex.ts` | file new, or its hash differs from `documents.file_hash`; deleted files are reaped |
| CHUNK | `src/core/chunk.ts` | doc has no chunk rows (paragraph packing, 400-token budget, 50-token overlap) |
| EMBED | `src/core/embed.ts` | `chunks.embedded = 0` (batches of 8) |
| ENRICH | `src/core/enrich.ts`, `entities.ts` | no `summary` or `proc_version < 1`; writes summary, tags, resolved mentions, `proc_version` last |
| CLEANUP | `src/core/cleanup.ts`, `glossary.ts` | `source: meeting` with `metadata.cleanup_version < 1`; deterministic glossary fixes plus an optional guarded LLM layer |
| EDGES | `src/core/edges.ts` | `edged_at IS NULL` or older than `indexed_at`; backlink → auto → entity → embedding producers under one shared write rule |
| EDGE-REFINE | `src/core/refine.ts`, `sidecar.ts` | an embedding candidate not yet present in any sidecar as an edge or rejection |
| SHARE | `src/core/sync.ts` | `jarvis sync`: commit captures → pull → process → commit enrichment → push |

`processContent()` in `src/core/sync.ts` is the local pipeline (`jarvis process`). Later modules plug
their passes in through `registerProcessPass()`, and projections (briefings, presentations) plug into
reindex through `registerProjectionHook()`, so `sync` and `reindex` stay the single entry points.

Pulling *before* enriching is deliberate: a teammate's already-enriched files arrive first, so the
pending scan skips them and no two machines race nondeterministic model output into git.

### 2.5 Search

`src/core/search.ts` offers three modes. **keyword** runs an FTS5 MATCH (each term quoted, implicit
AND). **semantic** embeds the query and runs kNN over `chunks_vec` with `k = limit × 10`, keeping the
best chunk per document. **hybrid** fuses both with Reciprocal Rank Fusion (`Σ 1/(60 + rank)`), then
expands through graph neighbours weighted by edge weight and fuses again. Explicit semantic search
throws when the embedding server is down; hybrid degrades to keyword only.

### 2.6 Briefings and rendering

`src/briefings/` is a **DOM-free** library shared by the server, the CLI and the browser bundle:

- `parser.ts`: a hand-rolled recursive-descent parser for Markdown interleaved with PascalCase
  component tags (`<Section title="…">`, `<StepFlow steps={[…]} />`). Attribute values are quoted
  strings or lenient JSON (unquoted keys, trailing commas, single quotes), never JS expressions.
  Errors carry line and column. Mermaid is deliberately unsupported; `SvgDiagram` is the escape hatch.
- `markdown.ts`: a small block-level Markdown parser (nested lists, fences, tables, quotes) with an
  inline pass and a URL allowlist.
- `components.ts` + `diagrams.ts`: a registry of 19 components (metadata eagerly, renderer as a
  thunk) whose diagram builders emit fully inline-styled SVG with `var(--x, fallback)` pairs, so the
  same markup works in the browser and inside a CSS-isolated Confluence HTML macro.
- `store.ts`: briefings are parsed on demand (no derived files), with a comments sidecar and its
  status transitions. `index.ts` projects briefings into the index as `source: briefing` rows with
  `part_of` and `references` edges.
- `confluence.ts`: a storage-format XHTML renderer with native macros and a REST v1 publisher keyed
  by page title, so any teammate can republish.

### 2.7 Interfaces

| Interface | Stack | Notes |
|---|---|---|
| **CLI** `src/cli.ts` | Bun, `src/core/args.ts` | A command registry; each command is a few lines over the core. The entrypoint must stay the last statement because top-level `await` stops later registrations. |
| **HTTP service** `src/server.ts`, `src/http.ts` | `Bun.serve` on `127.0.0.1:7281`, no auth | `src/http.ts` holds the route registry so feature modules (`src/chat/routes.ts`) never import `server.ts` back. Non-API paths serve `web/dist` with an SPA fallback. |
| **Web UI** `web/` | vanilla TypeScript, hash routing, imperative DOM, bundled by `Bun.build` | Imports only `src/briefings/*` (never core). Views: browse/search with facets, capture, briefings with TOC and comments rail, presentations, item detail, Sync button, resizable Discuss panel. |
| **Chat** `src/chat/` | Agent Client Protocol (JSON-RPC 2.0 over NDJSON stdio) | A dependency-free ACP client spawns one shared `copilot --acp` process, advertises no filesystem or terminal capabilities and answers every permission request "cancelled", so chat is strictly read-only. One ACP session per chat session, 60-minute idle expiry, NDJSON streaming to the browser. |
| **Browser extension** `extension/` | Chrome/Edge Manifest V3, TypeScript, bundled `@mozilla/readability` 0.6 | Opt-in auto-capture after a dwell timer, a single blocklist module (globs, allow overrides block), server-synced filters, and a popup for capture, context, tags, search, tasks and links. |
| **macOS app** `jarvis-app/` | Swift, Cocoa + WebKit, built by `swiftc` from `bundle.sh` | A WKWebView over the web UI. Reuses a running service or starts a managed backend (`bun install`, `web:build`, `jarvis serve`) with logs under Application Support. |

### 2.8 Capture producers

All producers end in the same `ingest()` contract (`src/producers/`):

| Producer | External tool | Mechanics |
|---|---|---|
| note / paste / file | none | `jarvis note`, `jarvis ingest --file`, web Capture view |
| PDF | `@opendocsg/pdf2md` 0.3.2 | text extracted to Markdown before capture; the binary never enters git; image-only and encrypted PDFs fail explicitly |
| YouTube | `yt-dlp` | metadata print plus `json3`/`vtt` auto-subtitles |
| Meeting: Teams `.vtt` | none | `<v Speaker>` cues coalesced into `Speaker: text` paragraphs |
| Meeting: pasted `.md/.txt` | none | speaker and timestamp heuristics |
| Meeting: audio/video | `mlx_whisper` → `faster-whisper` → `whisper-cli` | glossary-derived initial prompt, sibling VTT appended as raw context |
| Inbox scan | the above | a gitignored drop zone with per-folder locks, atomic state and staged resume |
| Browser extension | Readability | page-shaped payload mapped by the server |

### 2.9 Optional deck viewer

Presentations are plain MDX bundles (`presentations/<slug>/index.mdx`, body containing a
`<Presentation` component) and are indexed and searchable on their own. Presenting them is delegated
to whatever local viewer app the team uses: set `JARVIS_DECK_VIEWER_URL` to its base URL. The
viewer must answer `GET /api/health` with JSON whose `app` field equals `JARVIS_DECK_VIEWER_APP`
(default `deck-viewer`) and `GET /api/contents` with `{sources:[{id, path}]}` listing its mounted
directories; when the content repo is among them the UI shows a "Present in deck viewer" link. Nothing
is hardcoded to a particular product or port.

### 2.10 Model ids are configuration

No model id is pinned in code for a third-party service. Live detection uses `gpt-4.1` for the Copilot
CLI and OpenAI unless `JARVIS_COPILOT_MODEL` / `JARVIS_OPENAI_MODEL` say otherwise, the
Discuss chat model comes from `chatModel` in `config.toml` or `JARVIS_CHAT_MODEL`, and the shipped
presets carry a comment reminding you to use an id your entitlement offers.

### 2.11 Configuration, diagnostics and quality

- Per-machine config lives in `~/.jarvis/` (`config.toml`, `models.toml`); shared policy in the
  content repo under `config/`. Secrets are never stored; `models.toml` holds only the *names* of
  environment variables.
- `jarvis init` is a six-step wizard whose every default is answerable with `--yes`. `jarvis doctor`
  runs every environment check with an exact fix text and exits 1 on required failures; the convention
  is "never write 'check your environment' prose, add a doctor check".
- Tests: `bun test` (124 tests, about 92 % line coverage) covers every pipeline pass, the parsers, the
  HTTP routes, sync across two real git clones including a non-fast-forward push retry, the model
  router and every provider over mocked HTTP, the embedders, the inbox pipeline, the ACP client against
  a fake agent process, the web helpers under happy-dom, and the CLI end to end as a subprocess with
  a registry guard that every command and route group is registered. External services are behind seams (injectable embedder, fake router, mocked fetch,
  scripted subprocess runners) so the suite is hermetic.
- CI (`.github/workflows/ci.yml`) is change-aware. A `plan` job diffs the push or pull request and
  runs `scripts/ci-plan.ts`, which walks each test file's transitive import graph (plus the sources of
  any bundle it builds and the data files it reads) and selects only the tests that can be affected.
  Documentation-only changes run nothing; changes to global files (lockfile, tsconfig, the workflow,
  test helpers) run everything on Linux, macOS and Windows; a weekly scheduled run and a manual
  dispatch always run everything. The single required status check is `ci-status`, which always runs
  and passes only when every planned job succeeded or was legitimately skipped, so the branch rule on
  `main` never blocks on a skipped job.
- `scripts/eval-model.ts` runs the production ENRICH, CLEANUP, EDGE-REFINE and synthesis passes
  against a chosen model with weighted objective checks (summary present, tags in range, expected
  mention, glossary term fixed, negation preserved, complete batch judged, citation present).

## 3. Repository layout

```
src/cli.ts              command registry (thin)
src/server.ts           Bun.serve routes for capture/search/browse/items/briefings/presentations/tasks/links/sync
src/http.ts             route registry + JSON helpers (no import cycles)
src/core/               all pipeline logic, config, git, search, tasks, links, doctor, init, inbox
src/providers/          provider facade, models.toml, router, process-wide getRouter()
src/briefings/          parser, frontmatter, toc, markdown, diagrams, components, render, store, confluence
src/chat/               ACP client, chat sessions, streaming routes
src/producers/          pdf, youtube, transcript, whisper, meeting
web/                    web UI sources → web/dist via scripts/build-web.ts
extension/              MV3 extension sources + static → extension/dist via scripts/build-extension.ts
jarvis-app/       Swift launcher + bundle.sh
docs/examples/models/   shipped model presets
docs/AGENT-INSTRUCTIONS.md   how agents should operate J.A.R.V.I.S. (`jarvis skill`)
scripts/                build-web, build-extension, eval-model
tests/                  bun test suites and fixtures (fake ACP agent, PDF, VTT)
```

## 4. Known limits

- Published-projection mode (a designated publisher uploading a verified SQLite snapshot for
  consumers) has roles and consumer-aware sync only; export, transport and install are not built.
- Vision capture is not implemented and `/api/capture-visuals` does not exist, by policy.
- Windows and Linux sqlite-vec loading is exercised in CI but has not been validated on real machines.
- The HTTP service has no authentication and binds to localhost only; the content repo is the trust
  boundary.
