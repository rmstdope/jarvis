# J.A.R.V.I.S. — instructions for coding agents

You are operating a team knowledge base ("J.A.R.V.I.S.") on behalf of a human. Everything below is
driven through the `jarvis` CLI and the local HTTP service on `http://127.0.0.1:7281`. If `jarvis` is
not found, run `bun --cwd=<code repo> run jarvis …` instead, and tell the user to run `bun link` in that
folder so the plain command works. Shared truth is files in the **content repo** (git); the SQLite index is
local and disposable.

## Orientation (start of every session)

1. `jarvis doctor --core-only` — fix any failure it prints before doing anything else.
2. `jarvis tasks` — the user's open tasks. Use these instead of a session to-do list.
3. `jarvis sync --no-push` when the user wants fresh teammate knowledge (pulls, indexes, enriches).

## Capture → Understand → Use

- **Capture**: `jarvis note "…" [--task <id>]`, `jarvis ingest --file <path|-|x.pdf> [--url … --task <id>]`,
  `jarvis youtube <url>`, `jarvis meeting <file.vtt|.md|.mp3>`, `jarvis scan-inbox`. Capture verbatim; never
  paraphrase into the body.
- **Understand**: `jarvis process` runs reindex → enrich → edges → refine → dedup locally. Model steps are
  skipped, never failed, when no model is available (`jarvis models`).
- **Use**: `jarvis search "<q>" [--mode hybrid|semantic|keyword]`, `jarvis ask "<question>"` (cites ids in
  brackets), `jarvis task suggest <id>`, `jarvis link <src> <dst[,dst]> --relation …`.

## Tasks and links (do this proactively)

- When the user commits to work, `jarvis task add "<title>" [--due YYYY-MM-DD --link <ids>]`.
- While a task is in play, link what you capture or find: `jarvis link <task> <doc>`.
- When work visibly lands, `jarvis task done <id>`.
- Report every task and link you create **by id and title**.

## Briefings

- Before authoring, run `jarvis briefing components [--search <topic>] --verbose` and pick components
  deliberately: `BlockDiagram` for topologies, `SequenceDiagram` for ordered interactions, `StepFlow`
  for linear processes, `Timeline` for roadmaps, `ComparisonTable`/`ProConList` for decisions.
- Create with `jarvis briefing create --title "…"`, then edit `briefings/<id>.brief.mdx` in the content repo.
  Mermaid is not supported; use `SvgDiagram` as the escape hatch.
- Handle `open` comments (`jarvis briefing show <id>`), then mark them handled in the comments sidecar.
- Publish only approved briefings: `jarvis briefing approve <id>` → `jarvis briefing publish <id>`.

## Sharing

`jarvis sync` commits authored files, pulls with merge (never rebase), processes, commits enrichment,
pushes. If it reports merge conflicts, stop and show the files to the user; never resolve `docs/*.md`
conflicts silently. Never commit `.index/`.

## Rules

- Never write a "check your environment" instruction; run `jarvis doctor` and quote its fix line.
- Never send meeting transcripts to a cloud provider unless the team's `config/team.toml` allows it.
- Model ids live in `~/.jarvis/models.toml`, never in code you write.
