# jv-xsn — retrospective

## The gate's workload classifier refuses on this project

**What happened:** `produce-bead` *Building* says to classify the diff with
`git diff --name-only -z … | xargs -0 .cerebro/cerebro/scripts/build-workload --classify` before the
gate. Here it exits 1 with `build-workload: no rust_paths in .cerebro/project.conf - cannot classify
safely.` Also, `project-conf navigator_gates` prints an error ("unset, and no default") rather than
an empty answer, though the skill says empty means none.

**Why:** `rust_paths` is commented out in `.cerebro/project.conf` (J.A.R.V.I.S. has no Rust), and the
classifier treats an absent declaration as a refusal rather than "non-rust".

**Cost:** a few minutes deciding whether a refused classification blocks the gate; it was read as
non-rust and the gate ran.

**Prevent by:** either declare `rust_paths` with a never-matching value in `.cerebro/project.conf`,
or have `scripts/build-workload --classify` answer `non-rust` when no `rust_paths` is declared; and
have `project-conf` print nothing for an unset `navigator_gates`.

**Seen before:** nothing like it yet.
