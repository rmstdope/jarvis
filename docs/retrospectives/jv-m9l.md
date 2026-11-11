# jv-m9l — green locally, red in CI: a web test leaked its fake fetch into a later file

## What happened
The new reproduction test for jv-m9l starts the real service and POSTs `/api/sync` with the global `fetch`. It
passed locally on its own, with the full suite, and with CI's exact file selection in one process. On CI's
ubuntu run it got `404 {"error":"not found"}` after 100 ms: not the service, but `tests/webEnv.ts`'s fake fetch.
Three tests in `tests/webinitiative.test.ts` call `boot()` twice. The second `installWebEnv` saved the first
env's fake `fetch` as the "real" one, and `afterEach` restored only that one, so every later file in the process
ran on the fake. Whether it shows depends on the order Bun runs the files in, which differed between the local
and CI Bun builds. The first CI run said only `Received: undefined`, so it took a second run, after the assertion
was changed to include the status and body, to see it.

## Why
`installWebEnv` assumed one install per test and never guarded against nesting. No test after the web tests used
the real `fetch` until this one.

## Cost
Two of the three red-CI fix attempts, and about forty minutes.

## Prevent by
`tests/webEnv.ts`: `installWebEnv` now restores any env still installed, and `restore()` is idempotent;
`tests/webenv.test.ts` pins it. An HTTP assertion in a test should include the status and the body
(`expect({ status, body }).toMatchObject(…)`), so a red CI log names the answer and not just `undefined`.

## Seen before
`jv-oya.3` is another `tests/webEnv.ts` difference, from happy-dom rather than from isolation. No leak like this one.
