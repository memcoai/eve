import type { HistoryMessage } from "eve/context";
import { describe, expect, it } from "vitest";

import { SUMMARIZATION_PROMPT, SUMMARY_PREFIX, codexCompaction } from "./codex.js";
import { compactOf, dueOf, fakeContext, pairsIntact, toolTurn, user } from "./fake.js";

const history: HistoryMessage[] = [
  user("first ask"),
  ...toolTurn("call-1", "output one"),
  { role: "assistant", content: "done one" },
  { role: "user", kind: "execution.continuation", content: "continue" } as HistoryMessage,
  user("second ask " + "y".repeat(400)),
  ...toolTurn("call-2", "output two"),
  { role: "assistant", content: "done two" },
  user("third ask"),
];

describe("codexCompaction", () => {
  it("summarizes the whole history with Codex's prompt and keeps only person messages", async () => {
    const { ctx, calls } = fakeContext({ limit: 100_000 });
    const result = await compactOf(codexCompaction())(history, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toBe(history);
    expect(calls[0]!.options).toEqual({ prompt: SUMMARIZATION_PROMPT, model: undefined });
    expect(result![0]).toMatchObject({ kind: "context.compaction" });
    expect(result![1]).toEqual({ role: "assistant", content: `${SUMMARY_PREFIX}\nSUMMARY` });
    expect(result!.slice(2)).toEqual([user("first ask"), history[5], user("third ask")]);
    expect(pairsIntact(result!)).toBe(true);
  });

  it("keeps the newest person messages within the budget, truncating the one that overflows", async () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    const result = await compactOf(codexCompaction({ userMessageBudget: 60 }))(history, ctx);
    const kept = result!.slice(2);
    expect(kept.at(-1)).toEqual(user("third ask"));
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ kind: "user" });
    expect((kept[0]!.content as string).startsWith("second ask")).toBe(true);
    expect((kept[0]!.content as string).length).toBeLessThan(
      (history[5]!.content as string).length,
    );
  });

  it("is due at a step past 90% of the window or the threshold, whichever is lower", () => {
    const due = dueOf(codexCompaction());
    const base = { phase: "step" as const, threshold: 150_000, contextWindowTokens: 200_000 };
    expect(due({ ...base, inputTokens: 149_999 })).toBe(false);
    expect(due({ ...base, inputTokens: 150_000 })).toBe(true);
    expect(due({ ...base, threshold: 190_000, inputTokens: 179_999 })).toBe(false);
    expect(due({ ...base, threshold: 190_000, inputTokens: 180_000 })).toBe(true);
  });

  it("is due at turn end past the post-turn share, and never when that share is 0", () => {
    const base = { phase: "turn-end" as const, threshold: 190_000, contextWindowTokens: 200_000 };
    const due = dueOf(codexCompaction());
    expect(due({ ...base, inputTokens: 139_999 })).toBe(false);
    expect(due({ ...base, inputTokens: 140_000 })).toBe(true);
    expect(dueOf(codexCompaction({ postTurnPercent: 0 }))({ ...base, inputTokens: 199_000 })).toBe(
      false,
    );
    expect(
      dueOf(codexCompaction({ postTurnPercent: 0.5 }))({ ...base, inputTokens: 100_000 }),
    ).toBe(true);
  });
});
