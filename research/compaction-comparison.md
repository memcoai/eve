---
issue: "TBD (follows vercel/ai#24087 and the compaction strategy discussion)"
status: draft
last_updated: "2026-10-30"
---

# Compaction strategies compared: eve, opencode, Codex

eve's compaction API (`compaction.compact`, with `{ compact, when }` triggers) should be able to
express the compaction of other agents, not only eve's own. This note ports opencode's and
openai/codex's compaction to eve strategies and runs all three on one replay.

## The strategies

|                | eve default                             | opencode                                                                                  | Codex                                                                                          |
| -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| When           | before a model call, over the threshold | before a model call, within a reserve of the window                                       | before a model call over `min(threshold, 90% window)`, and after a turn over a post-turn share |
| First move     | summarize the head, keep a fixed tail   | clear old tool output (keep the newest 40k tokens of it), stop if that frees 20k and fits | summarize everything                                                                           |
| Kept           | fixed tail of messages                  | tail of whole turns within 25% of the window (2k to 15k)                                  | newest user messages within 20k tokens                                                         |
| Summary prompt | eve's transcript prompt                 | opencode's first/update prompts, with the turn's prefix reused                            | Codex's checkpoint prompt, prefixed as a handoff                                               |

Sources: [`fixture strategies`](../e2e/fixtures/agent-compaction-comparison/strategies/),
ported from opencode `packages/opencode/src/session/compaction.ts` (810c0eba) and
openai/codex `codex-rs/core/src/compact.rs` and `session/turn.rs` (184c9c55).

## Method

The [`agent-compaction-comparison`](../e2e/fixtures/agent-compaction-comparison/) fixture declares
a 16k-token window and a 0.6 threshold. Its replay is seven turns: six turns each read one ~3.4k
token file with `read-file`, then the last asks for an access code that only the first file holds.
Each strategy runs as its own agent (`EVE_COMPACTION_STRATEGY`) on the same replay:

```sh
cd e2e/fixtures/agent-compaction-comparison
EVE_E2E_MODEL=mock node replay.mjs     # deterministic
node replay.mjs                         # the default e2e model
```

opencode's and Codex's absolute token constants are sized for ~200k windows, so the fixture scales
them by 16k/200k. Codex's post-turn share is set to 0.35 so the replay reaches it.

A run passes when it compacts at least once, every compaction completes (the rewritten history
passed `checkHistory`), and the last reply holds the code. `reads` counts `read-file` calls: more
than six means the agent lost the code and read the file again.

## Results (mock model)

|                   | default | opencode | Codex       |
| ----------------- | ------- | -------- | ----------- |
| Task finished     | yes     | yes      | yes         |
| Compactions       | 2, step | 1, step  | 3, turn-end |
| Model calls       | 13      | 15       | 16          |
| `read-file` calls | 6       | 7        | 6           |
| Input tokens      | 75,523  | 106,550  | 65,565      |
| Output tokens     | 41      | 55       | 101         |

The mock model reports no cache reads; real-model results, with cached input, are pending.

- **opencode** compacts latest (near the window) and its prune-first move clears the old tool output
  that held the code, with no summary of it. The agent has to read the file again, which is the
  most input of the three.
- **Codex** compacts between turns, so no turn carries a mid-turn summary call and the next request
  starts small: the least input, at the cost of the most output (three summaries).
- **eve's default** sits between them.

## What the API could not express

- **Summary placement.** Codex puts the summary after the retained user messages; eve's
  `checkpoint()` must open the history, so the port puts it first.
- **Message kinds.** `HistoryMessage` has no typed kind, so telling a person's message from a
  framework-injected one is done by content shape.
- **Output reserve.** The trigger's measure has no reserved output tokens, so opencode's reserve is
  an option of the strategy, not read from the model.
- **Overflow retry.** Codex retries a summary request that overflows by dropping the oldest items;
  `summarize()` has no such loop, and the reserved `"overflow"` reason is unused.

Out of scope here: provider-native compaction items (Codex's encrypted `Compaction` item), background
precompute, and cache-TTL timers.
