# jv-e1c — retrospective

## A follow-up bead I filed was claimed by another builder before I could rank it

**What happened:** The review of PR #25 surfaced the same defect in the Copilot model steps, so I
filed it with `bd create --type bug --labels bugfix …` (jv-zdv). I then ran `bd update --priority 4`
to make it unranked, and `bd update --status open` after seeing it `in_progress`. By then the fleet
had already assigned it to Nightcrawler at the default priority. My edits re-prioritised a bead
another builder held and briefly reset its status. I restored `in_progress` and left a note.

**Why:** `bd create` without `--priority` files at the default priority, which the builder queues
(`scripts/bugfix-candidates`) accept. A `bugfix`-labelled bead is in a queue the moment it exists,
so "created unranked, ranked later" (CLAUDE.md, *Work tracking*) only holds if the bead is unranked
*at creation*.

**Cost:** One bead with its priority changed under a live claim, a reset status that had to be
restored, and a note to the navigator.

**Prevent by:** In `skills/beads-workflow` (and `fix-bug`/`produce-bead` wherever they file a
follow-up), pass `--priority 4` on `bd create` itself. A builder never edits status or priority on
a bead it did not just create without first reading `assignee`.

**Seen before:** No.
