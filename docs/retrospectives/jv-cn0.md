# jv-cn0 — retrospective

- **Implementer:** Bishop
- **Date:** 2026-11-11
- **PR:** #5

## `db.close()` left the index database open

**What happened.** On Windows, about 40 tests failed in cleanup with `EBUSY ... rm <tmp dir>`. On
macOS, `lsof -p <pid>` still showed `.index/jarvis.db` open after `withDb`, `reindex` or `ingest`
had returned and called `db.close()`.
**Why.** In Bun 1.4.2, `bun:sqlite`'s `close()` uses `sqlite3_close_v2`. Any statement made with
`db.prepare()` and never `finalize()`d keeps the connection, and its file handle, alive until
garbage collection. Statements from `db.query()` are cached and finalized by `close()`.
**Cost.** About an hour reading Windows CI logs before the leak was pinned locally with `lsof`.
**Prevent by.** Following the rule in the `openDb` doc comment in `src/core/db.ts`: use
`db.query()`, never `db.prepare()`. The `tmpDataDir().cleanup()` check in `tests/helpers.ts` fails
any test that leaves a database held. A trap entry in `.cerebro/traps.md` would put this in front of
planners.
**Seen before.** none found

## A test helper's `new Database()` broke `openDb()` for later test files on macOS

**What happened.** The first version of the cleanup check opened the database with a plain
`new Database(f)`. The full suite passed, but `bun test ./tests/cli-e2e.test.ts
./tests/pipeline.test.ts` failed 8 tests with `does not support dynamic extension loading`. The
review found it, not the gate.
**Why.** On macOS, the first in-process `Database` decides which SQLite library Bun loads. If that
first database is opened before `ensureCustomSqlite()` has run, Bun loads its bundled SQLite. Every
later `Database.setCustomSQLite` call then fails, and `src/core/db.ts` swallows the error.
**Cost.** One review round and one extra CI run.
**Prevent by.** Calling `ensureCustomSqlite()` before any `new Database` outside `openDb`, in tests
too. The gate could also run each test file on its own, not only the whole suite in alphabetical
order.
**Seen before.** none found
