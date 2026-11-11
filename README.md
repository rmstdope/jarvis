# J.A.R.V.I.S.

J.A.R.V.I.S. is a team-collaborative knowledge base. Shared truth is plain files in a git **content repo**; every
machine keeps a disposable SQLite index (FTS5 + sqlite-vec); models run locally first, with the
GitHub Copilot CLI or any OpenAI-compatible API as fallbacks; a coding agent drives it all
through the CLI and the local HTTP service.

## Quick start

J.A.R.V.I.S. is meant to be used **through a coding agent** (GitHub Copilot in VS Code or the Copilot
CLI, Claude Code, or any equivalent). You describe what you want; the agent captures, searches, links
and syncs by running the `jarvis` commands for you. The only commands a human normally runs are the
one-time setup below.

### 1. Install and set up (once per machine)

```
git clone <this repo> jarvis && cd jarvis
bun install
bun run jarvis init            # six-step wizard: content repo, author, embeddings, model preset, first index, doctor
bun run jarvis doctor          # anything that fails prints an exact fix
```

`init` clones or creates the team's **content repo**, which is where the knowledge lives; you choose
its path in the wizard (the default is `~/jarvis-content/<repo-name>`). Keep it separate from
this code repo. Below, `<content-repo>` stands for whatever path you chose.

### 2. Point your agent at J.A.R.V.I.S.

Give the agent the operating instructions and access to both repositories:

```
bun run jarvis skill > <content-repo>/AGENTS.md   # or CLAUDE.md, or .github/copilot-instructions.md
```

Then open a session **in the content repo** (a VS Code multi-root workspace with this code repo and
the content repo works well, so the agent's file tools can see both):

```
cd <content-repo>
copilot            # or: claude, or your agent of choice
```

To present decks, run [Slidecraft](https://github.com/rmstdope/slidecraft) and add the content repo
as one of its vaults (`bun run jarvis doctor` says whether that is done, and how).

Optionally start the local service so the web UI and the browser extension work too:

```
bun run jarvis serve           # http://127.0.0.1:7281 (run `bun run web:build` once first)
```

### 3. Talk to J.A.R.V.I.S.

Typical requests, and what the agent does underneath:

| You say | The agent runs |
|---|---|
| "Save this article: https://…" / "Note that we decided X" | `jarvis ingest --url …`, `jarvis note "…"` |
| "Pull in the transcript from today's meeting" | `jarvis meeting <file>` or `jarvis scan-inbox` |
| "What do we know about zoom drift?" | `jarvis search "…"`, `jarvis ask "…"` (answers cite item ids) |
| "I'll take the firmware follow-up" | `jarvis task add "…" --link <ids>` |
| "Write a briefing on the Acorn roadmap" | `jarvis briefing components`, `jarvis briefing create`, edits the `.brief.mdx` |
| "Share with the team" / "Get the latest" | `jarvis sync` (commit → pull → enrich → push) |

Summaries, tags, entity links and judged relations are added automatically during `sync` when a chat
model is available (`jarvis models` shows what resolves); without one J.A.R.V.I.S. still captures,
indexes and searches.

## Commands (what the agent runs)

`bun run jarvis help` lists everything. Humans rarely need these directly, but this is what the agent
is working with:

| Command | What it does |
|---|---|
| `note`, `ingest --file`, `youtube`, `meeting`, `scan-inbox` | capture into the content repo |
| `search "<q>" [--mode hybrid\|semantic\|keyword]`, `ask "<q>"` | find things, or get a cited answer |
| `enrich [--limit --dry-run]` | ask a model for a summary, 3–8 tags and entity mentions per unenriched doc, resolve mentions against the entity registry (creating stubs), write them to the doc's frontmatter; skipped when no model is available |
| `edges`, `refine`, `cleanup`, `entities dedup` | the other individual passes: derived links, LLM-judged links, glossary transcript cleanup, entity merging |
| `process` | reindex → enrich → edges → refine → dedup scan, without git |
| `sync [--no-push]` | commit → pull (merge) → process → commit enrichment → push |
| `task add\|list\|show\|done\|suggest`, `tasks`, `link` | tasks and manual links |
| `briefing create\|components\|list\|show\|comment\|approve\|publish` | briefings and Confluence |
| `presentation share\|promote`, `summarize` | decks and meeting summaries |
| `init`, `doctor`, `config`, `models` | onboarding and diagnostics |

## Parts

| Part | Where | Build / run |
|---|---|---|
| Core library + CLI | `src/core`, `src/cli.ts` | `bun run jarvis <command>` |
| LLM providers + router | `src/providers` | `~/.jarvis/models.toml`, `jarvis config preset` |
| Briefings + Confluence | `src/briefings` | `jarvis briefing …` |
| HTTP service | `src/server.ts`, `src/http.ts`, `src/chat` | `jarvis serve` |
| Web UI | `web/` | `bun run web:build` |
| Browser extension (MV3) | `extension/` | `bun run extension:build`, load `extension/dist` unpacked |
| macOS app | `jarvis-app/` | `./jarvis-app/bundle.sh` → `~/Applications/J.A.R.V.I.S.app` |
| Model presets | `docs/examples/models/` | `jarvis config preset <name>` |
| Eval | `scripts/eval-model.ts` | `bun run scripts/eval-model.ts --model copilot:gpt-4.1` |

`bun test` runs 124 tests (two-clone git sync, every pipeline pass, parsers, routes, the LLM providers and
embedders over mocked HTTP, the CLI as a real subprocess, a fake ACP agent); `bun run test:coverage` reports
line coverage (about 92 %). CI is change-aware: `bun run ci:plan` prints what a set of changed files would
run (docs-only changes run nothing); `main` requires the `ci-status` check to pass before anything merges.
`bun run typecheck` covers the core, web and extension trees. CI runs on Linux, macOS and Windows.
