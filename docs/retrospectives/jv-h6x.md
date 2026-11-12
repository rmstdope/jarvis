# jv-h6x — retrospective

- **Implementer:** Bishop
- **Date:** 2026-11-12
- **PR:** #89

## The local fast gate was red on tests the change does not touch, and green in CI

**What happened.** Unrelated tests failed locally at the 5000ms bun default while CI was green on the same head. `bun test tests/cli-e2e.test.ts` failed "note → search → reindex → task → link → tasks" and "initiatives: add, …" with the change applied, and with it stashed away (plain main). The full `bun test` then failed "sync across two clones" (two tests, 7–8s). `uptime` showed load averages 23.8 / 14.6 / 11.6 on 18 cores, with other fleet sessions running gates at the same time. Running a cli-e2e test alone with `-t` is not a valid check either: the initiatives test depends on notes created by earlier tests in the file.
**Why.** Not established beyond the load: the subprocess-spawning suites exceed bun's per-test timeout when the machine is saturated.
**Cost.** About ten minutes and three extra local suite runs to show the failures were present on main.
**Prevent by.** `produce-bead` *Building*: before trusting a red fast gate, record `uptime`. When the load is above the core count and the failing tests are untouched subprocess suites, rerun only those files once against `origin/main` and say so in the PR body. Alternatively, give the subprocess suites in `tests/cli-e2e.test.ts` and the sync tests an explicit per-test timeout.
**Seen before.** none found
