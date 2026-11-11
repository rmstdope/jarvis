# jv-ve6

## What happened
Green on macOS locally, red on `test (windows-latest)`: new tests used `path.join` (backslashes) against expected POSIX strings, and a test regex read README.md with CRLF line endings.

## Why
Not established beyond the above; nothing in the plan or `CLAUDE.md` says the suite also runs on Windows.

## Cost
One red CI attempt and one extra push.

## Prevent by
A line in `CLAUDE.md` Testing: "Tests run on Windows too: compare paths with `path.posix` or normalise, and normalise `\r\n` when reading text files."

## Seen before
Nothing like it yet (see jv-cn0 for Windows suite work).
