# jv-m5e — retrospective

- **Implementer:** Bishop
- **Date:** 2026-11-12
- **PR:** #66

## The bug report's steps did not reproduce the bug

**What happened.** The bead said: click New chat, click the chat box, type; the page switches to
#/chat mid-typing and the first words are lost. Three runs of those steps in Chrome lost nothing:
from an empty chat, after confirming the "Start a new chat?" dialog, and with a document tab open.
The bug only appeared when the dialog was left open and the click on the chat box landed on its
backdrop. That cancelled the dialog, focus went back to the New chat button, and typed spaces
pressed it twice: once to reopen the dialog, once to confirm it.

**Why.** The verifier's report named the clicks but not the dialog that opened between them. It
also gave the route change, which is a symptom, as the cause. A step that opens a dialog was
invisible in the bug's own description.

**Cost.** About three failed reproduction rounds in the browser, plus reading the routing and
render code for a cause that was not there, before the dialog was suspected.

**Prevent by.** `.claude/skills/verify-jarvis/SKILL.md`, where a proposed follow-up bug is
written: list every step as performed, including each dialog that opened and what was clicked on
it (or that it was not answered), and keep what was seen apart from what is believed to cause it.

**Seen before.** none found
