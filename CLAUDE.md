# Instructions

These are the instructions for the agents that **develop** Second Brain. They are not the
instructions for an agent that **uses** a brain: those live in `docs/AGENT-INSTRUCTIONS.md`, are
printed by `brain skill`, and are product content to be edited like any other shipped file.

## The project

Second Brain is a team knowledge base whose shared truth is plain files in a git content repo,
indexed on every machine into a disposable SQLite database (FTS5 + sqlite-vec). It is a Bun +
TypeScript CLI (`src/cli.ts`, run as `bun run brain …`), a local HTTP service on
`http://127.0.0.1:7281` (`src/server.ts`), a vanilla TypeScript web UI (`web/`), an MV3 browser
extension (`extension/`) and a small Swift launcher for macOS (`second-brain-app/`). Its users are
the members of a team, who mostly drive it through a coding agent. "Working" means a user can
capture, search, ask, link, task and sync against a content repo with no model available, that the
model steps (enrich, edges, refine, ask, chat) improve that when one is, and that nothing a user
wrote is ever lost: the index can always be rebuilt from the files.

`docs/ARCHITECTURE.md` is the design; the *Decisions* in `IMPLEMENTATION-PLAN.md` are binding
unless a bead changes them on purpose.

## Producer review

Nothing merges red. Before delivery, a producer obtains and addresses one independent, full review
of the complete diff and bead. If its changes are substantial enough to make another review useful,
the producer chooses the right follow-up scope and obtains it; minor, self-contained answers need
not create a review loop. Unresolved findings, a red or missing check, or a reviewer that cannot
produce a usable result go to a person. Whether the navigator also takes part in the plan, the
review or the merge is `navigator_gates` in `.cerebro/project.conf`; absent means none. This review
satisfies the Four eye Principle below.

## Work tracking

Planned work is tracked in beads (`bd`), prefix `sb`; `skills/beads-workflow` carries the commands.
GitHub issues are the inbox for outside requests and bug reports only. Every bead is created
unranked and ranked later with the navigator; a bead is planned in one session and implemented in
another.

The board syncs through the Dolt remote on `origin`, not through git. A fresh clone runs
`bd bootstrap` once (it refuses if a database already exists, so do not run `bd list` first); after
that it is `bd dolt pull` and `bd dolt push`.

## Skills Usage

Always select the appropriate skill for a specific task. Always write explicitly in the chat which
skills are currently being used, and follow the instructions in the skills to the letter.

## Development practices

### Small Increments

Develop in very small increments that can each be delivered on their own. The code base keeps a
strong safety net of tests so a change never silently breaks existing behaviour.

### Test-driven Development (TDD)

Write the test before the code, for features and for bugs alike: first a test that reproduces the
bug, then the fix, then the whole suite green. While pinpointing a bug you may add traces and try
fixes freely; once it is pinpointed, add or update the test that triggers it before applying the fix.

### Collaboration

Seek clarification from the navigator when requirements are ambiguous. Use the question tool with
predefined answers when possible, and a free-text option when necessary.

### Design

Prefer the simple design and say so when you decline a more general one. The design should be easy
to change.

### Four eye Principle

All code changes are reviewed by another instance before they merge. Nothing merges automatically
without review, and nothing merges unless every pre-merge check passes.

## Pre-merge Checklist (Must Pass Before Creating a PR)

These mirror `gate_full` in `.cerebro/project.conf` and the jobs in `.github/workflows/ci.yml`:

```sh
bun install --frozen-lockfile
bun run typecheck          # core, web and extension trees
bun test
bun run web:build
bun run extension:build
```

Run each check as its own command and read its exit status; never chain them with `;` or pipe their
output through `grep`, since that hides failures. A change to `second-brain-app/` must also pass
`swiftc -typecheck second-brain-app/main.swift` on macOS.

CI is change-aware (`scripts/ci-plan.ts`): it runs only the tests whose import graph reaches a
changed file. When you add a test that reads a non-TypeScript file, or a new global input, teach the
planner about it and cover that in `tests/ci-plan.test.ts`.

## Implementation Design Rules

### Architecture

- Files are the truth; the SQLite index under `.index/` is derived and never committed. Anything a
  user wrote must be recoverable with `brain reindex --full`.
- `src/cli.ts` is a thin command registry; logic lives in `src/core/`, `src/producers/`,
  `src/providers/`, `src/briefings/` and `src/chat/`. The CLI entrypoint stays the last statement in
  `src/cli.ts` (top-level await stops later `register()` calls).
- HTTP routes register through `src/http.ts`; feature route modules never import `src/server.ts`.
- `src/briefings/` is DOM-free. The web UI imports only `src/briefings/*`, never core; the extension
  shares nothing with the server at build time and mirrors the route contract in its `api.ts`.
- One toolchain and one lockfile: Bun builds, bundles and tests everything (no Vite, no npm).

### Models and providers

- Every model step is optional: no model means *skip*, never *fail*.
- Model ids are configuration (`~/.second-brain/models.toml`, `chatModel`), never literals in code.
- Providers are local first, then the GitHub Copilot CLI or a generic OpenAI-compatible API
  (`OPENAI_API_KEY`). Do not add references to proprietary gateways.
- Never send meeting transcripts to a cloud provider unless the team's `config/team.toml` allows it.

### Naming

The product is **second-brain** everywhere: `~/.second-brain`, `SECOND_BRAIN_*` environment
variables, `second-brain` in prose. Never reintroduce the old "team-brain" names.

### User-facing errors

Never write "check your environment" prose. When something can be missing, add a `brain doctor`
check with an exact fix line, and inject its probes so the check is unit-tested.

### Code

- TypeScript strict mode; type every exported function signature explicitly. Import local modules
  with their `.ts` extension and use `import type` for type-only imports (`verbatimModuleSyntax`).
- Doc-comment exported functions, classes and types with `/** … */`, and keep comments current.
- Prefer injectable seams (`setEmbedderForTests`, `setRouterForTests`, injectable `which` probes)
  over mocking modules.

### Testing

- Tests use `bun test` and live in `tests/`. They are hermetic: `tests/helpers.ts` pins the router to
  null, temporary data directories come from `tmpDataDir()`, and semantic tests use the fake
  embedder. No test needs a network, a model server or the user's `~/.second-brain`.
- End-to-end CLI behaviour is covered in `tests/cli-e2e.test.ts`; the web UI in `tests/web.test.ts`
  and `tests/webdom.test.ts` (happy-dom); the extension in `tests/extension.test.ts`.

## Chat

Be concise about what you are about to do, are doing and have done. Focus on the key changes.

## Communication with user

When asking the user a question, use the question tool with predefined answers, plus a free-text
option when the answer cannot be predefined.
