# jv-4mc — retrospective

- **Implementer:** Bishop
- **Date:** 2026-11-11
- **PR:** #59

## Chrome's resize_window reported success but the viewport stayed at 606 px

**What happened.** To check the fix at 900 and 1512 px, `mcp__claude-in-chrome__resize_window`
(1512×900) was called twice and returned "Successfully resized" both times. The page still reported
`innerWidth` 606 (`screen.availWidth` 1512, dpr 2), so the web UI stayed in its phone layout and the
tab strip was hidden. I worked around it by appending a same-origin `<iframe>` of the app at exactly
900 and 1512 px, driving its `location.hash`, and measuring `.jv-tabstrip` inside it. The iframe
laid out exactly like a viewport of that width.
**Why.** Not established. It may be the Chrome window's tiling or placement on the navigator's
display.
**Cost.** About five minutes and two wasted browser round trips.
**Prevent by.** In `.claude/skills/verify-jarvis/SKILL.md`, under the web UI checks: read
`innerWidth` after any `resize_window`. If it does not match, measure at the width you need inside
a same-origin iframe of that width.
**Seen before.** none found
