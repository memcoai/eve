import {
  type CompactionContext,
  type CompactionStrategy,
  type CompactionSummaryOptions,
  turns,
} from "eve/compaction";
import type { HistoryMessage } from "eve/context";

import { clamp, isCheckpointHead, isPersonMessage } from "./shared.js";

export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
export const PRUNE_MARKER = "[Old tool result content cleared]";
export const PRUNE_SKIP_TURNS = 2;
// opencode V1 prompt.ts:1161-1167: compact when usage >= limit.input - min(COMPACTION_BUFFER, maxOutput).
export const COMPACTION_BUFFER = 20_000;
const TAIL_SHARE = 0.25;
const TAIL_MIN = 2_000;
const TAIL_MAX = 15_000;

const TEMPLATE = `Use this structure:

## Objective
## Requirements
## Decisions
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files
(at most 15)
## Important Context

Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given, such as AGENTS.md: the next agent receives current versions of all of these separately.
Do not mention the summary process or that context was compacted.`;

export const FIRST_PROMPT = `You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.

${TEMPLATE}`;

export const UPDATE_PROMPT = `Update the existing checkpoint in the conversation above into one consolidated summary. Newer history always takes precedence over the existing checkpoint.

${TEMPLATE}`;

export interface OpencodeCompactionOptions {
  /** Tokens of recent whole turns kept beside the summary. Defaults to clamp(25% of the limit, 2k, 15k). */
  readonly keepTokens?: number;
  readonly reserveTokens?: number;
  /** Tool output tokens kept whole, newest first. Defaults to PRUNE_PROTECT. */
  readonly pruneProtect?: number;
  /** The fewest tokens a prune must free to apply. Defaults to PRUNE_MINIMUM. */
  readonly pruneMinimum?: number;
  readonly model?: CompactionSummaryOptions["model"];
}

export function opencodeCompaction(options: OpencodeCompactionOptions = {}): CompactionStrategy {
  const reserve = options.reserveTokens ?? COMPACTION_BUFFER;
  return {
    when: {
      phases: ["step"],
      due: (measure) => measure.inputTokens >= measure.contextWindowTokens - reserve,
    },
    async compact(history, ctx) {
      let base = history;
      if (ctx.reason !== "manual") {
        base = prune(history, ctx, options);
        if (ctx.tokens.estimate(base) <= ctx.tokens.limit) return base;
      }
      const keep = options.keepTokens ?? clamp(ctx.tokens.limit * TAIL_SHARE, TAIL_MIN, TAIL_MAX);
      const { head, tail } = split(base, keep, ctx);
      const summary = await ctx.summarize(head, {
        prompt: isCheckpointHead(head) ? UPDATE_PROMPT : FIRST_PROMPT,
        reusePrefix: true,
        model: options.model,
      });
      return [...ctx.checkpoint(summary), ...tail];
    },
  };
}

/** Clears old tool outputs past the newest PRUNE_PROTECT tokens and the last turns, if that frees PRUNE_MINIMUM. */
export function prune(
  history: readonly HistoryMessage[],
  ctx: Pick<CompactionContext, "tokens">,
  limits: { readonly pruneProtect?: number; readonly pruneMinimum?: number } = {},
): readonly HistoryMessage[] {
  const protect = limits.pruneProtect ?? PRUNE_PROTECT;
  const minimum = limits.pruneMinimum ?? PRUNE_MINIMUM;
  const candidates = new Set<number>();
  let turns = 0;
  let protectedTokens = 0;
  let freed = 0;
  scan: for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (isPersonMessage(message)) turns++;
    if (turns < PRUNE_SKIP_TURNS || message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (part.output.type === "text" && part.output.value === PRUNE_MARKER) break scan;
      const size = ctx.tokens.estimate([message]);
      if (protectedTokens <= protect) {
        protectedTokens += size;
        continue;
      }
      candidates.add(index);
      freed += size;
    }
  }
  if (freed < minimum) return history;
  return history.map((message, index) => {
    if (!candidates.has(index) || message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result"
          ? { ...part, output: { type: "text" as const, value: PRUNE_MARKER } }
          : part,
      ),
    };
  });
}

/** The newest whole turns within `keep` tokens as the tail; the latest turn always, and only it if all fit. */
function split(
  history: readonly HistoryMessage[],
  keep: number,
  ctx: Pick<CompactionContext, "tokens">,
): { head: HistoryMessage[]; tail: HistoryMessage[] } {
  const all = turns(history);
  let cut = all.length - 1;
  let used = ctx.tokens.estimate(all[cut] ?? []);
  while (cut > 1) {
    const next = ctx.tokens.estimate(all[cut - 1]!);
    if (used + next > keep) break;
    used += next;
    cut--;
  }
  return { head: all.slice(0, cut).flat(), tail: all.slice(cut).flat() };
}
