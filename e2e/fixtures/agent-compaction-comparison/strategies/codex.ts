import type {
  CompactionContext,
  CompactionStrategy,
  CompactionSummaryOptions,
} from "eve/compaction";
import type { HistoryMessage } from "eve/context";

import { isPersonMessage, type UserHistoryMessage } from "./shared.js";

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const AUTO_COMPACT_SHARE = 9 / 10;

export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include: Current progress and key decisions made; Important context, constraints, or user preferences; What remains to be done (clear next steps); Any critical data, examples, or references needed to continue.
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export interface CodexCompactionOptions {
  /** Share of the context window that makes a finished turn compact. 0 disables post-turn compaction. */
  readonly postTurnPercent?: number;
  readonly userMessageBudget?: number;
  readonly model?: CompactionSummaryOptions["model"];
}

export function codexCompaction(options: CodexCompactionOptions = {}): CompactionStrategy {
  const postTurnPercent = options.postTurnPercent ?? 0.7;
  const budget = options.userMessageBudget ?? COMPACT_USER_MESSAGE_MAX_TOKENS;
  return {
    when: {
      phases: ["step", "turn-end"],
      due(measure) {
        const limit = Math.min(measure.threshold, measure.contextWindowTokens * AUTO_COMPACT_SHARE);
        const limitReached = measure.inputTokens >= limit;
        if (measure.phase === "step") return limitReached;
        return (
          postTurnPercent > 0 &&
          (limitReached || measure.inputTokens >= measure.contextWindowTokens * postTurnPercent)
        );
      },
    },
    async compact(history, ctx) {
      const summary = await ctx.summarize(history, {
        prompt: SUMMARIZATION_PROMPT,
        model: options.model,
      });
      // Codex puts the summary after the retained user messages; eve requires the checkpoint first.
      return [
        ...ctx.checkpoint(`${SUMMARY_PREFIX}\n${summary}`),
        ...retainedUserMessages(history, budget, ctx),
      ];
    },
  };
}

/** The newest person messages within `budget`, latest always whole, in original order. */
export function retainedUserMessages(
  history: readonly HistoryMessage[],
  budget: number,
  ctx: Pick<CompactionContext, "tokens">,
): HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let remaining = budget;
  for (const message of history.filter(isPersonMessage).reverse()) {
    const size = ctx.tokens.estimate([message]);
    if (size <= remaining || kept.length === 0) {
      kept.unshift(message);
      remaining -= size;
      continue;
    }
    const truncated = truncate(message, remaining);
    if (truncated !== undefined) kept.unshift(truncated);
    break;
  }
  return kept;
}

function truncate(message: UserHistoryMessage, tokens: number): HistoryMessage | undefined {
  if (typeof message.content !== "string" || tokens <= 0) return undefined;
  return { ...message, content: message.content.slice(0, tokens * 4) };
}
