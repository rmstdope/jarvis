# jv-oya.3 — happy-dom fires hashchange on history.replaceState

## What happened
The first tab routing passed every test, but the cold review showed it would break in Chrome, Safari and the Mac app: those browsers fire no `hashchange` for `history.replaceState`, happy-dom does. I had added an echo guard to match happy-dom, and in a real browser it stayed set and swallowed the next real navigation.

## Why
`tests/webEnv.ts` models a browser, and nothing said where happy-dom differs from one. I wrote the code to fit the test environment.

## Cost
One blocking review finding and a rewrite of the guard and `webEnv.ts`.

## Prevent by
`tests/webEnv.ts` now swallows that event like a browser, with a comment naming the difference; add further happy-dom differences to that file as they are found.

## Seen before
Nothing like it yet.
