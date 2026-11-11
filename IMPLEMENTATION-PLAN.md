# J.A.R.V.I.S. — implementation plan

Rebuild of the system specified in `../TEAM-BRAIN-SYSTEM-DESCRIPTION.md`, renamed
**jarvis** everywhere (package name, `~/.jarvis`, `JARVIS_*` env vars).
One milestone per loop iteration; each milestone ends with `bun test` green and a commit.

## Status

| Milestone | Scope | Status |
|---|---|---|
| M1 | Scaffold, constants, SQLite + sqlite-vec schema, frontmatter, chunker, embedder (Ollama/oMLX), `ingest`, `reindex`, hybrid/keyword/semantic `search`, CLI (`note`, `ingest`, `reindex`, `search`) | ✅ done |
| M2 | HTTP service (`serve`, capture/health/search/browse/recent/item/tags/context/filters/sync routes), git `sync` (commit → pull merge → process → commit → push), `process`, `dedup` | ✅ done |
| M2.5 | Capture producers: PDF (`ingest --file x.pdf`), YouTube (`youtube`), meeting (`meeting`: Teams `.vtt`, pasted `.md/.txt`, audio via mlx_whisper/faster-whisper/whisper-cli with glossary initial prompt + sibling VTT), glossary parser | ✅ done |
| M3 | Provider facade (local/Ollama, openai-compat, copilot) + router + `models.toml` parse/detect/write, ENRICH (map-reduce, truncation fallback, entity resolution + stubs), EDGES (backlink/auto/entity/embedding), EDGE-REFINE (sidecar edges + rejections), `entities dedup`, CLEANUP (deterministic + LLM), `ask` + `POST /api/ask`, `models`, `config` | ✅ done |
| M4 | Briefings: recursive-descent MDX-lite parser with lenient JSON props, YAML frontmatter, TOC, comments sidecar with status transitions, store (create/approve/list), 19-component registry with inline-styled SVG diagram builders, block Markdown parser, index projection (`source: briefing` rows + `part_of`/`references` edges), `/api/briefings` + comments routes, `briefing` CLI, Confluence storage-format renderer + REST publisher keyed by title | ✅ done |
| M5 | Web UI: vanilla TypeScript bundled by `Bun.build` into `web/dist` (no Vite), hash routes browse/search (facets, two paginated lists), capture, briefings list + detail (shared component renderer, TOC, comments rail), presentations list/detail (service side lands in M8), item detail with edges, back/forward, Sync button with confirm modal + toast, resizable Discuss panel over the NDJSON chat API (service side lands in M9) | ✅ done |
| M6 | Onboarding: six-step `init` wizard (all defaults answerable with `--yes`; clone/select/create repo, author, embeddings with hardware detection and optional `ollama pull`, preset recommendation with overwrite confirmation, first reindex + smoke search, doctor), `doctor` with exact fix texts and `--json/--core-only/--port` (exit 1 on required failures), six shipped presets under `docs/examples/models/` parsed by a test, `config preset [name --show]`, `config set-inbox` | ✅ done |
| M7 | Tasks (`task add/list/show/done/reopen/suggest`, `tasks`; files authoritative for status; `⚠ no links` flag), manual links (`link`, append-only sidecar, derived edges replaced), `note/ingest --task`, ingest honours the task block on update, HTTP `GET /api/tasks`, `POST /api/task`, `GET /api/task/:id`, `/done`, `/reopen`, `/suggest`, `POST /api/link` | ✅ done |
| M8 | Presentations (`presentation share` with staging + atomic rename, asset-escape/symlink guards, id/slug uniqueness; `presentation promote` keeping the ULID with provenance; index projection with reaping; deck-viewer discovery via `/api/health` + `/api/contents`; `/api/presentations`, `/api/presentation/:slugOrId`), meeting summaries (`summarize`, `draftMeetingSummary` → `kind: meeting-summary` briefing with the three mandatory sections), inbox scan (`scan-inbox`: classification, 60 s settle, mkdir lock reclaimed only for dead pids on the same host, atomic `.state.json`, staged resume, per-folder isolation, archive with collision suffix) | ✅ done |
| M9 | Chat ("Discuss"): dependency-free ACP JSON-RPC client over NDJSON stdio to `copilot --acp` (no fs/terminal capabilities, every permission request answered cancelled), one shared process, one ACP session per chat session with ULID ids, 60-min idle expiry, one in-flight prompt per session, item/briefing scopes grounded on the first turn (≤ 60 000 chars), jarvis scope with per-turn stop-word keyword retrieval (≤ 8 terms, 6 results, ≤ 8 000 chars), `POST /api/chat/sessions`, NDJSON `…/messages`, `…/cancel`, `DELETE`; chat model id from config (`chatModel`, `JARVIS_CHAT_MODEL`); tested against a fake ACP agent process | ✅ done |
| M10 | Browser extension rewritten as a typed thin client (MV3, single blocklist module, bundled Readability, opt-in auto-capture, popup with tasks/link/new-task against the now-existing routes, no dormant image code), macOS launcher (`jarvis-app/main.swift` + `bundle.sh`, compiles with swiftc), CI on Linux/macOS/Windows with the sqlite-vec doctor check, `scripts/eval-model.ts` with weighted objective checks, agent instructions (`docs/AGENT-INSTRUCTIONS.md`, `jarvis skill`) | ✅ done |

## Status summary

All ten milestones are implemented and committed (124 tests, about 92 % line coverage, three typechecked trees). Deliberately
**not** built, per the spec's own scoping: published-projection snapshot export/transport (§3.4 still
prints a note in `sync`), vision capture (`/api/capture-visuals`, not permitted), and the future
enhancements in §25. Cross-platform sqlite-vec loading is exercised in CI but has not been validated
on real Windows/Linux machines.

## Decisions taken during the rewrite (per spec §24)

- Reindex reaps deleted docs incrementally and `--full` resets edges/entities too (§24.2.3).
- Ollama URL is configurable (`JARVIS_OLLAMA_URL`), not hardcoded (§24.2.10).
- `--limit` and other integer flags are validated in the arg parser (§23).
- `processContent` has a pass registry (`registerProcessPass`) so M3 plugs enrich/edges/refine in without touching sync; the server has a route registry for the same reason.
- Glossary uses the real TOML parser plus a line scan for the `# Misheard as:` comment convention (§24.2.1).
- The CLI entrypoint must stay the last statement in `src/cli.ts` (top-level await stops later `register()` calls).
- Sidecar lines record the judging `model` id and are signed with the resolved capture identity, never `$USER` (§24.2.5/6). Stubs carry the doc author.
- Edge producers run in priority order across all pending docs (backlink → auto → entity → embedding) so a stronger derived edge is never pre-empted by a weaker one written for an earlier doc.
- The router is created once per process (`getRouter`) and tests pin it to a null router for hermeticity.
- `src/briefings/` is DOM-free and imported by both the server (Confluence) and, in M5, the browser bundle, so core never imports the web tree (§24.2.8). SvgDiagram/raw HTML is sanitized with a small allowlist (§24.2.11).
- The web UI imports only `src/briefings/*` (DOM-free) and never core; it is bundled by Bun end to end (`bun run web:build`), so there is one toolchain and one lockfile (§24.2.9).
- `doctor` takes injectable `which`/embed probes so every check path is unit-tested; the convention is "never write 'check your environment' prose, add a doctor check".
- Doc frontmatter serialization preserves extra keys after the fixed order (presentations carry `provenance`).
- The route registry lives in `src/http.ts` so feature route modules (chat, …) never import `server.ts` back (import cycles silently drop registrations).
- The chat model id is configuration, not code (§24.2.10).
- The extension shares nothing with the server at build time but its `api.ts` mirrors the route contract; the popup's search/tasks/link features now target implemented routes (§24.2.2).
- Embedder is injectable (`setEmbedderForTests`) so the pipeline is tested without a server.

## Layout

```
src/cli.ts            thin command registry
src/core/*.ts         all logic (constants, db, frontmatter, chunk, embed, docs, ingest, reindex, search, config, args, git, sync, browse, filters)
src/server.ts         Bun.serve route registry + static web/dist
src/producers/        capture producers (pdf, youtube, transcript, whisper, meeting)
src/briefings/        parser, frontmatter, toc, markdown, diagrams, components, render, store, confluence, index projection
web/                  index.html, src/{main,api,ui,discuss}.ts, styles.css → dist/ via scripts/build-web.ts
src/chat/             ACP client, chat session service, streaming routes
src/http.ts           route registry + JSON helpers
extension/            MV3 extension sources + static assets → dist/ via scripts/build-extension.ts
jarvis-app/     Swift launcher + bundle.sh
scripts/              build-web, build-extension, eval-model
src/providers/        LLM providers (local, openaiCompat, copilot), models.toml, router, process-wide getRouter()
tests/                bun test
```
