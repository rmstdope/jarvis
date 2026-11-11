---
name: verify-jarvis
description: J.A.R.V.I.S.'s verification skill, named by `verification_skill` in .cerebro/project.conf. Psylocke verifies merged beads that change what a user sees by using the merged build against a scratch home and a scratch content repo, never the navigator's own. She batches related beads into one look, seeds the state each needs, checks the web UI in Chrome and the CLI in a terminal, hands the navigator what only a person can judge (answer quality, the extension, the macOS app), explores near the change, then presents the evidence, a recommended pass or fail per bead, and proposed follow-up beads.
---

# Verifying J.A.R.V.I.S. beads

This skill **extends `verify-bead`; it does not replace it.** Load `verify-bead` first and follow it,
together with `agents/verifier.md`. That covers the candidates, the fresh `origin/main` worktree, the
commit check, `verification=pending`, the sha in every verdict, the report written onto the bead
before asking, the recipes in *Taking the verdict*, and the end of a pass. Where this file is more
specific, this file wins. It adds seven things: batching, an isolated home and content repo, seeding
state, a launch recipe that replaces the declared command and the port refusal, the surfaces beyond a
browser tab, human checks, and exploratory testing.

Every question below is the verifier's three-action sandwich: `asking --bead <id> --phase verify`,
the question, then `working --bead <id> --phase verify` before anything else. In a batch, `--bead`
is the first bead of the batch.

## Which beads are looked at

The verifier's classification decides: `app-paths --classify` says `application` for anything under
`src/`, `web/`, `extension/` or `jarvis-app/`, and for `docs/AGENT-INSTRUCTIONS.md` and
`docs/examples/`. Everything it calls `invisible` is marked `not-needed` silently, as the verifier
says. Never widen or narrow that by judgement. If you think a classified bead changes nothing a user
can notice (an internal refactor under `src/core/`, say), still look briefly, and say in the report
that the look found nothing visible to check.

A user meets J.A.R.V.I.S. in five places, and a bead's look covers each one its diff reaches:

| Surface | Reached through | Looked at by |
|---|---|---|
| The CLI (`bun run jarvis …`) | `src/cli.ts`, `src/core/`, `src/producers/`, `src/providers/`, `src/briefings/` | you, in a terminal |
| The web UI | `web/`, `src/server.ts`, `src/http.ts`, `src/chat/`, `src/briefings/` | you, in Chrome |
| The agent instructions | `docs/AGENT-INSTRUCTIONS.md` (`jarvis skill`) | you, by following them |
| The browser extension | `extension/` | the navigator, with your preparation |
| The macOS app | `jarvis-app/` | the navigator, with your preparation |

Most users drive J.A.R.V.I.S. through a coding agent that runs the CLI, so a CLI change is a user-facing
change even when no screen changes.

## Batch beads into one look

Seeding a content repo and starting the service is the expensive part, so share it. After the
candidate lists are built, and after the epic sweeps (which batch themselves through
`verifier-epic-candidates`), group the ordinary candidates:

- **Batch together** beads that are all in the verification tree at the same `origin/main` sha and
  share a journey: the same command family (capture, search and ask, tasks and links, briefings,
  sync), the same web view (browse, search, capture, briefings, presentations, item detail, Discuss),
  or the same seeded state.
- **Keep apart** a bead that needs a different seed (an empty repo, a teammate's conflicting edit,
  real models where the others need none), and a reopened `verification:failed` bead: its rebuild
  deserves its own clean look.
- **At most four beads per batch.** The question tool takes four questions per call, and the verdict
  call asks one per bead.

Say each batch and its reason in one line before launching, for example "batch A: jv-a1b, jv-a1c,
both the briefing comments rail, one run at `<short sha>`". Then, per batch:

1. Prepare every bead (verify-bead's *Prepare*): one checklist per bead, criterion by criterion.
2. Make the scratch state and seed it (below).
3. Launch once (*Launching the service*, below).
4. Walk the beads in the order that reaches their states most cheaply, keeping a separate evidence
   log per bead. A screenshot or transcript can serve two beads, but name it in both logs.
5. Collect every human check in the batch into **one** hand-off (below).
6. Explore once for the whole batch (below).
7. Write **one report per bead** onto that bead (`Verification report at <full sha>`, as
   verify-bead says), then ask for the batch's verdicts in **one** call of the question tool, one
   question per bead.

A batch never merges verdicts: each bead passes or fails on its own evidence. If the navigator's
answers split a batch, record each bead by its own recipe.

## Never touch the navigator's knowledge

The navigator's `~/.jarvis` (their config, models and keys) and their content repo (the team's shared
knowledge, pushed to a team remote) are theirs. A capture you make there lands in the team's
knowledge base; a `sync` from there pushes it to every teammate. So every command of a look, the
CLI and the service alike, runs against a scratch home and a scratch content repo with a scratch
remote, in your scratchpad, and **never without these variables set**:

```bash
V=<your scratchpad>/verify-<batch>          # one per batch; never inside the worktree
export JARVIS_HOME="$V/home"                # config, models.toml: never ~/.jarvis
export JARVIS_DATA="$V/content"             # the content repo: never theirs
export JARVIS_AUTHOR=psylocke               # captures are signed as the verifier
export JARVIS_EMBED_FAKE=1                  # deterministic embeddings, no embedding server
export JARVIS_MODELS="$V/no-models.toml"    # no chat model: see "Models" below
```

Run `bun run jarvis config show` once after exporting and confirm that every path it prints is under
`$V`. If any is not, stop: that is a blocker to report, not something to work round.

Never run `jarvis init`, `sync`, `config set-*` or `presentation share` without those variables, and
never pass `--repo` or `--data` pointing outside `$V`. Never read, copy or print the navigator's
`~/.jarvis/config.toml`: it holds their keys.

### Models

The default look has **no chat model** (an empty `$V/no-models.toml`), which is also how J.A.R.V.I.S.
must work for a user without one: every model step is skipped, never failed. A skip that reads as an
error, or a command that fails without a model, is a finding.

When a bead changes what a model step produces (enrich, edges, refine, cleanup, `ask`, summaries,
the Discuss chat), the look needs a real model, and that changes what leaves the machine. Ask the
navigator first, in the batch's first question, which model to use: their own (`JARVIS_MODELS` set
to their `~/.jarvis/models.toml`, read where it is, never copied or edited), or none (the model
criteria become human checks for them). Embeddings stay fake unless the bead is about embeddings or
semantic search quality, which is a human check. The seeded content is the repository's own fixtures,
never anything of the navigator's. Never add a `config/team.toml` to the scratch repo that allows
transcripts to reach a cloud provider.

## Seed the state

Seed from the merged worktree, with the variables above exported, using the user's own commands so
the seed is itself a journey:

```bash
mkdir -p "$V" && : > "$V/no-models.toml"
git init -q --bare "$V/team.git"                                  # the scratch "team" remote
bun run jarvis init --yes --data "$JARVIS_DATA" --data-root "$V"   # writes only under $V
git -C "$JARVIS_DATA" remote add origin "$V/team.git"
bun run jarvis note "Zoom drift is fixed by firmware X1656" --title "Zoom drift"
bun run jarvis ingest --file tests/fixtures/hello.pdf
bun run jarvis meeting tests/fixtures/teams.vtt --title "Weekly sync"
bun run jarvis ingest --file tests/fixtures/pasted.txt --source paste
bun run jarvis task add "Ship the firmware" --due 2026-12-01
bun run jarvis briefing create --title "Acorn roadmap"
bun run jarvis sync                                               # commits; "no upstream … local-only" is expected
git -C "$JARVIS_DATA" push -q -u origin main                      # sets the upstream; later syncs push
```

The scratch remote starts empty, so the first `sync` commits the captures and continues local-only;
the push after it sets the upstream, and every later `sync` pulls and pushes as a user's does. Seed only what the batch needs, and add what a bead's journey needs on top: more notes
for paging, a briefing with comments, a task with links, a presentation shared from a scratch folder
under `$V`.

**A teammate**, for sync and conflict beads: clone the scratch remote into `$V/teammate`, run the
teammate's commands there with `JARVIS_DATA="$V/teammate"` and a second `JARVIS_HOME`
(`"$V/home-teammate"`, seeded with its own `init --yes`), push, then `sync` from the first repo.

A bead whose seed fails at the merged sha has found a regression in a command that worked before:
that is itself a finding, logged with the command and its output.

## Launching the service

This replaces the declared `launch_web` (`bun run web`), which serves against the default home and
content repo, and verify-bead's occupied-port refusal. Do not ask about the port. From the merged
worktree, with the variables exported:

```bash
bun run web:build
bun run jarvis serve --port <port>       # on the first free port from 7282 to 7299
```

- **Never use 7281 for a web UI look.** 7281 belongs to the navigator's own service or macOS app
  (against their real content repo), and their browser extension sends captures to whatever holds
  it. Check each candidate port with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and take the first free
  one. Never stop, signal or reuse a server you did not start. If none of 7282–7299 is free, that is
  a blocker to report.
- The service prints `jarvis service on http://127.0.0.1:<port>  (content repo: …)`. Confirm the
  content repo it names is under `$V` before opening a tab; then `GET /api/health` answers
  `{"ok":true,"docs":<n>}` with the seeded count.
- Name the port in the report, as "verified on http://127.0.0.1:<port>".
- **Clear the web UI's saved state before every look.** Every look serves on the first free port
  from 7282, so earlier looks share one origin and its `localStorage`, including the chat's saved
  conversation and attachment (`jv.chat`), which survives a reload by design. Open a tab on
  `http://127.0.0.1:<port>/`, run `localStorage.clear(); sessionStorage.clear();
  [localStorage.length, sessionStorage.length]` in the page (javascript_tool) and confirm `[0, 0]`,
  then reload. The page writes its own empty tab-strip key on load, so after the reload check
  `localStorage.getItem("jv.chat") === null` and that the chat shows the unscoped first screen with
  no scope chip, not a length of 0. Do this once per batch, again before a bead kept apart in its
  own look, and again before a bead whose criteria open on the chat first screen or depend on chat
  or tab state. State left by an earlier step of the same look is not a finding; state present
  right after a clear is (jv-y3d was a false failure of exactly this kind). The navigator's own
  `http://127.0.0.1:7281` origin is never cleared.
- **A local file Chrome cannot open as `file://`** (a mockup, review page, evidence): serve its
  directory with `python3 -m http.server <free port from 7282–7299> --bind 127.0.0.1 --directory <dir>`
  and open that URL. Stop only the servers you started.

The extension and the macOS app talk to port 7281 only (*The extension and the app*, below).

## The look, for J.A.R.V.I.S.

On top of verify-bead's *Look*, check what the acceptance touches:

- **The CLI.** Run each command a criterion names exactly as a user (or their agent) would type it,
  with `bun run jarvis …`, and keep the full transcript, command and output, in the evidence log; a
  transcript is the CLI's screenshot. Check the exit status as well as the words: a failure must
  exit non-zero, and success zero. `--json` output, where the command offers it, must parse.
- **The words a user reads.** Usage lines, `doctor` checks and their `fix:` lines, warnings, and
  errors. Every fix line names an exact command or setting; "check your environment" prose is a
  finding. A failure from missing configuration must be a `doctor` check, not a stack trace. Quote
  the line in the log.
- **The files.** Files are the truth, so a capture, task, link, briefing or comment the bead changes
  must land as the file the bead describes in `$JARVIS_DATA`: open it and quote the frontmatter.
  Then `bun run jarvis reindex --full` and repeat the read path (search, browse, `task show`): what
  the bead stored must come back from the files alone.
- **Sync.** A bead that touches what is committed or shared gets a `sync` to the scratch remote and,
  where the acceptance mentions teammates, the teammate round trip from *Seed the state*. Read
  `git -C "$V/team.git" log` to show what was shared.
- **The web UI.** Open `http://127.0.0.1:<port>/` (after clearing its saved state, see
  *Launching the service*) and walk the views the bead touched. Use the back
  and forward buttons across the hash routes, and reload on a deep link. A bead agreed with a
  mockup names it in its acceptance: open it in a second tab and compare side by side, screenshotting
  both.
- **Desktop and narrow.** Look at desktop width, and where the bead changes layout, the Discuss
  panel, lists or long titles, again at about 390 px wide. **Never resize the navigator's Chrome
  window, and never open a verification tab in it while sizes are checked**: they are using it.
  Do every sized look in a Chrome window of your own (a new window, not a new tab), and set the size
  there with the developer tools' device mode, or by resizing your own window. If no window of your
  own can be opened, or one of the navigator's tabs landed in it, that is a blocker to report. A
  look that needs no particular size may use a tab in the navigator's window.
- **Light and dark.** Where the bead changes colour or contrast, say which theme you saw. If only
  one is reachable, the other is a human check.
- **The agent instructions.** When `docs/AGENT-INSTRUCTIONS.md` changes, read `bun run jarvis skill`
  and run each command it newly names or changes, against the scratch state: every one must exist
  and do what the text says. An instruction that names a missing command or flag is a finding.
- **The console and the service log.** Read the browser console after the journey, filtered by a
  pattern, not dumped whole, and the `serve` output. A new error or warning during the journey is a
  finding.

## The extension and the app

Both reach the service on port 7281 only (the extension's host permission and the app's `PORT`), so
both looks are the navigator's to make, with everything prepared.

1. **Ask before taking 7281.** If something listens there it is the navigator's: ask them, in the
   hand-off, to stop it for the look ("your service on 7281 (pid …) runs against your content repo;
   stop it for a few minutes and say when"), and wait. Say that while the scratch service holds
   7281, their own installed extension sends anything it auto-captures into the scratch repo, so
   auto-capture should be off for the look. Never stop it yourself.
2. **Serve the scratch state on 7281** with the variables exported, exactly as above but
   `--port 7281`, and confirm the content repo it names is under `$V`.
3. **The extension**: build it in the merged worktree (`bun run extension:build`) and hand the
   navigator the path to `<worktree>/extension/dist`, to load as an unpacked extension in a Chrome
   profile they choose (`chrome://extensions`, Developer mode, *Load unpacked*). If they already
   have J.A.R.V.I.S. capture installed, say that the unpacked copy is a second, separate extension
   and theirs should be switched off during the look. Afterwards ask them to remove the unpacked
   copy and switch theirs back on.
4. **The macOS app**: build it into your scratchpad, never `~/Applications`:
   `jarvis-app/bundle.sh "$V/J.A.R.V.I.S.app"`. The app reuses a service already on 7281, so with
   the scratch service there it shows the scratch state. Start it from your shell with the variables
   exported (`"$V/J.A.R.V.I.S.app/Contents/MacOS/Jarvis" &`) so a managed backend, if it starts one,
   inherits them. Then hand the navigator the window. A bead about the app's own backend start
   (no service running) is a human check in which you say plainly that the app will start a backend
   in the merged worktree.
5. **Give 7281 back**: stop the scratch service and the app you started, and tell the navigator they
   can start theirs again.

## Human checks: hand the navigator the running build

Some criteria have no transcript or screenshot that settles them. They go to the navigator, and you
prepare everything first so their part takes a minute:

- **Answer quality**: whether an `ask` answer, a Discuss reply, an enrichment summary, its tags, or a
  refined link is *good*. You can show that it happened, cites ids in brackets and is grounded in the
  seeded items. Whether it is good is theirs to judge.
- **"Good enough"**: whether a briefing renders well, a layout or the Discuss panel feels right, or
  a message reads clearly to a teammate who is not a developer.
- **The extension and the macOS app** (above), and the Confluence publish, which needs their
  credentials: prepare it with `briefing publish <id> --dry-run` and show them the output.
- **Anything you could not reach**: a theme your browser will not show, real embeddings, another
  platform.

The hand-off, once per batch, after your own checks and before the verdict:

1. Leave the service running and the state **exactly** as it is to judge: the tab named, the
   terminal command ready to paste (with the variables in front of it, so their shell cannot reach
   their own repo by accident), the unpacked extension's path, the app window.
2. Write `asking`, then ask in **one** call of the question tool, one question per human check
   (at most four, so split a long list into more calls). Each question says:
   - the URL, tab, window or command, and what is on screen right now;
   - what to judge, in user terms, and what good looks like, quoting the acceptance or `## Outcome`;
   - optionally, a few numbered steps to try.

   Options: **Good**, **Concern** (works, but worth a follow-up), **Fail** (does not meet what was
   agreed), each with room for a note.
3. Write `working` the instant they answer. Copy each answer and note into the bead's log verbatim,
   attributed to the navigator. A human check left unanswered is a gap, not a pass.

If they are away, the beads stay pending with the report attached, as verify-bead says. The next
pass re-asks from the report without looking again.

## Explore near the change

After the agreed criteria and before the report, spend **about 10–15 minutes per batch** using
J.A.R.V.I.S. near what changed, as a curious user, or a user's agent, would. No script; aim at the
change's edges:

- the neighbouring commands and flags, a missing or extra argument, a bad value (`--due soon`,
  `--limit 0`, an unknown id), `help`, and the command run twice;
- no model, no embedding server, an empty content repo, and a repo with an item that has no body;
- the same item through the other surfaces: captured in the CLI, read in the web UI, and the reverse;
- `reindex --full` after the change, and `sync` with nothing to share;
- in the web UI: back and forward, reload mid-action, a very long title or query, keyboard only, and
  the narrow width next to the change;
- unusual text: non-ASCII, Swedish characters, Markdown, and very long lines.

Log each finding with steps, what appeared and a screenshot or transcript. Then sort it:

- **A regression this batch caused** (it worked before this bead's commit, and the bead's diff
  explains the break) counts against that bead's verdict. Say which criterion or outcome it breaks.
- **Everything else** (an older defect, a rough edge, an idea) is a proposed follow-up and never
  fails the bead.

When unsure which it is, say so in the report and recommend the follow-up.

## Present the results

The report on each bead follows verify-bead's *Recommend*, with these sections:

- `Verification report at <full sha>`, then the bead's title and its batch;
- the scratch state: what was seeded, the port, and whether a real model was used (and which);
- the evidence log, one entry per criterion, with the human checks marked as the navigator's
  answers;
- **Exploration**: what you tried, and each finding with its sorting;
- the **gaps**: what nobody could reach;
- the **recommendation**: Passed, Passed with a follow-up, or Failed (build or plan), with the one
  or two facts it turns on;
- the **proposed follow-ups**: for each, a title in *Writing a good bead* form, the outcome for the
  user (or the developer), one acceptance line, and why it is not a defect in this bead. A defect in
  shipped behaviour is proposed as a bug (`--type bug --labels bugfix`), anything else as a task.
  Both are filed at P4, unranked, and only when the navigator approves them.

Then in chat, before the verdict question, give the navigator a short summary per batch: one line per
bead with the recommendation, then the follow-ups. The full evidence is on the beads. Ask for the
verdicts and the follow-ups in one call where they fit in four questions, and in consecutive calls
where they do not. Record only what they answered, by the recipes in `agents/verifier.md`.

## When the look is over

Stop every server and app you started (the scratch service, any `http.server`, the scratch app), and
only those; give 7281 back if you took it, and confirm the navigator removed the unpacked extension.
Close the tabs and any window you opened, and switch off device emulation. Delete `$V`: it holds
nothing of the navigator's, and the report on the bead is the record.
