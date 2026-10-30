import type { HistoryMessage } from "eve/context";
import { describe, expect, it } from "vitest";

import {
  compactOf,
  dueOf,
  estimate,
  fakeContext,
  ids,
  pairsIntact,
  toolTurn,
  user,
} from "./fake.js";
import { FIRST_PROMPT, PRUNE_MARKER, UPDATE_PROMPT, opencodeCompaction } from "./opencode.js";

const BIG = "x".repeat(60_000);

function conversation(turnCount: number): HistoryMessage[] {
  return Array.from({ length: turnCount }, (_, index) => [
    user(`question ${index + 1}`),
    ...toolTurn(`call-${index + 1}`, BIG),
    { role: "assistant" as const, content: `answer ${index + 1}` },
  ]).flat();
}

function marked(history: readonly HistoryMessage[]): string[] {
  return history.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" &&
          part.output.type === "text" &&
          part.output.value === PRUNE_MARKER
            ? [part.toolCallId]
            : [],
        )
      : [],
  );
}

describe("opencodeCompaction", () => {
  it("prunes old tool outputs without a model call when that fits", async () => {
    const history = conversation(8);
    const { ctx, calls } = fakeContext({ limit: 90_000 });
    const result = await compactOf(opencodeCompaction())(history, ctx);
    expect(calls).toHaveLength(0);
    expect(result).toBeDefined();
    expect(marked(result!)).toEqual(["call-1", "call-2", "call-3"]);
    expect(ids(result!)).toEqual(ids(history));
    expect(pairsIntact(result!)).toBe(true);
    expect(estimate(result!)).toBeLessThanOrEqual(90_000);
    expect(result).toContainEqual(user("question 8"));
  });

  it("summarizes the head with its prompt and prefix reuse, keeping a tail of whole turns", async () => {
    const history = conversation(8);
    const { ctx, calls } = fakeContext({ limit: 40_000 });
    const result = await compactOf(opencodeCompaction({ keepTokens: 35_000 }))(history, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ prompt: FIRST_PROMPT, reusePrefix: true });
    expect(result![0]).toMatchObject({ kind: "context.compaction" });
    expect(result![1]).toEqual({ role: "assistant", content: "SUMMARY" });
    const tail = result!.slice(2);
    expect(ids(tail)).toEqual(["call-7", "call-8"]);
    expect(tail[0]).toEqual(user("question 7"));
    expect(pairsIntact(tail)).toBe(true);
    expect(ids(calls[0]!.messages)).toEqual([
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
      "call-6",
    ]);
  });

  it("asks for an update when the history already starts with a checkpoint", async () => {
    const history: HistoryMessage[] = [
      { role: "user", kind: "context.compaction", content: "<marker>" } as HistoryMessage,
      { role: "assistant", content: "old summary" },
      ...conversation(3),
    ];
    const { ctx, calls } = fakeContext({ limit: 10_000, reason: "manual", phase: "manual" });
    await compactOf(opencodeCompaction({ keepTokens: 1 }))(history, ctx);
    expect(calls[0]!.options?.prompt).toBe(UPDATE_PROMPT);
    expect(calls[0]!.messages[0]).toMatchObject({ kind: "context.compaction" });
  });

  it("always summarizes a manual compaction", async () => {
    const { ctx, calls } = fakeContext({ limit: 1_000_000, reason: "manual", phase: "manual" });
    const result = await compactOf(opencodeCompaction())(conversation(3), ctx);
    expect(calls).toHaveLength(1);
    expect(result!.slice(2)).toContainEqual(user("question 3"));
  });

  it("is due before a step once input reaches the window minus the reserve", () => {
    const due = dueOf(opencodeCompaction());
    const base = { phase: "step" as const, threshold: 150_000, contextWindowTokens: 200_000 };
    expect(due({ ...base, inputTokens: 179_999 })).toBe(false);
    expect(due({ ...base, inputTokens: 180_000 })).toBe(true);
  });
});
