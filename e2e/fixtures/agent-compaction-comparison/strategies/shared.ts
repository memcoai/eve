import type { HistoryMessage } from "eve/context";

export type UserHistoryMessage = Extract<HistoryMessage, { role: "user" }> & {
  readonly kind?: string;
};

export function kindOf(message: HistoryMessage): string | undefined {
  return message.role === "user" ? (message as UserHistoryMessage).kind : undefined;
}

export function isPersonMessage(message: HistoryMessage): message is UserHistoryMessage {
  return kindOf(message) === "user";
}

export function isCheckpointHead(history: readonly HistoryMessage[]): boolean {
  const first = history[0];
  return first !== undefined && kindOf(first) === "context.compaction";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
