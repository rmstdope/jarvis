# Second Brain — instructions for coding agents

You are operating a team knowledge base ("Second Brain") on behalf of a human. Everything below is
driven through the `brain` CLI (`bun run brain …` in the code repo) and the local HTTP service on
`http://127.0.0.1:7281`. Shared truth is files in the **content repo** (git); the SQLite index is
local and disposable.

## Orientation (start of every session)

1. `brain doctor --core-only` — fix any failure it prints before doing anything else.
2. `brain tasks` — the user's open tasks. Use these instead of a session to-do list.
3. `brain sync --no-push` when the user wants fresh teammate knowledge (pulls, indexes, enriches).

## Capture → Understand → Use

- **Capture**: `brain note "…" [--task <id>]`, `brain ingest --file <path|-|x.pdf> [--url … --task <id>]`,
  `brain youtube <url>`, `brain meeting <file.vtt|.md|.mp3>`, `brain scan-inbox`. Capture verbatim; never
  paraphrase into the body.
- **Understand**: `brain process` runs reindex → enrich → edges → refine → dedup locally. Model steps are
  skipped, never failed, when no model is available (`brain models`).
- **Use**: `brain search "<q>" [--mode hybrid|semantic|keyword]`, `brain ask "<question>"` (cites ids in
  brackets), `brain task suggest <id>`, `brain link <src> <dst[,dst]> --relation …`.

## Tasks and links (do this proactively)

- When the user commits to work, `brain task add "<title>" [--due YYYY-MM-DD --link <ids>]`.
- While a task is in play, link what you capture or find: `brain link <task> <doc>`.
- When work visibly lands, `brain task done <id>`.
- Report every task and link you create **by id and title**.

## Briefings

- Before authoring, run `brain briefing components [--search <topic>] --verbose` and pick components
  deliberately: `BlockDiagram` for topologies, `SequenceDiagram` for ordered interactions, `StepFlow`
  for linear processes, `Timeline` for roadmaps, `ComparisonTable`/`ProConList` for decisions.
- Create with `brain briefing create --title "…"`, then edit `briefings/<id>.brief.mdx` in the content repo.
  Mermaid is not supported; use `SvgDiagram` as the escape hatch.
- Handle `open` comments (`brain briefing show <id>`), then mark them handled in the comments sidecar.
- Publish only approved briefings: `brain briefing approve <id>` → `brain briefing publish <id>`.

## Sharing

`brain sync` commits authored files, pulls with merge (never rebase), processes, commits enrichment,
pushes. If it reports merge conflicts, stop and show the files to the user; never resolve `docs/*.md`
conflicts silently. Never commit `.index/`.

## Rules

- Never write a "check your environment" instruction; run `brain doctor` and quote its fix line.
- Never send meeting transcripts to a cloud provider unless the team's `config/team.toml` allows it.
- Model ids live in `~/.second-brain/models.toml`, never in code you write.
