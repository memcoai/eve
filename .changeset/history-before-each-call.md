---
"eve": patch
---

When a provider rejects a prompt as too long for the model's window, eve now compacts the history and retries the call once, and fails the turn if the history doesn't shrink.

An experimental `agent/harness.ts`'s `history` now runs before every model call and for `session.compact()`, and what it returns becomes the session's history. `ctx.size` gives the call's estimated tokens and the model's window, `ctx.compact` marks a `session.compact()`, and `ctx.summarize(history)` is eve's summarizer; `ctx.compaction` is gone. A change to messages the model hasn't read yet joins the history without a compaction; a change to ones it has read is checked and recorded as one.
