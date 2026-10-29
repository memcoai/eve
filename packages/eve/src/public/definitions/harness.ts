import type { Memo, SessionFrame } from "#dynamic/definition.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";
import type { HistoryMessage } from "#shared/history-message.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolDefinition } from "#tools/definition.js";

/** A value, or a function eve calls only where it needs the value. */
export type Lazy<T> = T | (() => T | Promise<T>);

/** The model step that just ended. */
export interface HarnessModelStep {
  /** The prose the step wrote. */
  readonly text: string | null;
  /** The structured value the step delivered for the turn's output schema. */
  readonly output?: JsonValue;
  /** Every call the step made targeted a tool that ends the turn, and each did. */
  readonly endsTurn: boolean;
}

/** How big the next model call is, as eve estimates it before sending it. */
export interface HarnessSize {
  /** The call's estimated input tokens: instructions, tools, and the history. */
  readonly tokens: number;
  /**
   * The model's context window, when eve knows it. After the provider rejected a prompt for its
   * size, at most what that prompt held.
   */
  readonly window?: number;
}

/** A call the running turn made, as the session's view has it. */
export interface HarnessCall {
  readonly callId: string;
  readonly tool: string;
  readonly status: "requested" | "running" | "settled";
  readonly input?: JsonValue;
  /** How it settled: `completed`, `failed`, `rejected`, …. */
  readonly outcome?: string;
  /** Absent for output too large for the view. */
  readonly output?: JsonValue;
  readonly error?: { readonly message: string };
}

/** What a harness reads: the session as of its latest commit, and where eve is deciding. */
export interface HarnessContext extends SessionFrame {
  /**
   * Keeps what the harness learns from outside, as a dynamic value's `ctx.memo` does. A cache,
   * not a record of effects: a deployment change or a crash can run it again.
   */
  readonly memo: Memo;
  /** The history eve is deciding about. */
  readonly history: readonly HistoryMessage[];
  /** Notes this harness added to the running turn that are still in its history. */
  readonly continuations: number;
  /** Model calls the running turn has made. */
  readonly steps: number;
  /** Calls the running turn made, oldest first. */
  readonly calls: readonly HarnessCall[];
  /** The model step that just ended, where eve decides after one. Absent at the turn's start. */
  readonly lastStep?: HarnessModelStep;
  /** The next model call's size, where eve asks for the history. */
  readonly size?: HarnessSize;
  /** `session.compact()` asked for a compaction, where eve asks for the history. */
  readonly compact?: true;
  /**
   * eve's summary of older turns: a checkpoint, then the recent turns whole. `tokens` is the
   * call's size to aim under; eve's own threshold when absent. Only in `history`; elsewhere it
   * throws.
   */
  summarize(
    history: readonly HistoryMessage[],
    options?: { readonly tokens?: number },
  ): Promise<HistoryMessage[]>;
}

/** What the turn does next. */
export type HarnessNext =
  /** Call the model, after showing it `note` when there is one. */
  | { readonly model: { readonly note?: string } }
  /**
   * End the turn with `output`. While the turn's tasks work it can't end: eve waits for them and
   * calls the model with their results. Under an output schema the turn ends with the value the
   * model delivered.
   */
  | { readonly settle: { readonly output: JsonValue | null } }
  /**
   * Call tools: each through the gate a model's call goes through (approval, sign-in, the
   * runtime's own tools), recorded in history as a call the agent made. eve decides again once
   * they've settled.
   */
  | { readonly calls: readonly { readonly tool: string; readonly input?: JsonValue }[] }
  /** End the turn as failed, with `message` for the person. */
  | { readonly fail: { readonly message: string } };

/** What the agent is for its next model call. A field it leaves out is what its files declare. */
export interface HarnessAgent {
  /** The model, in place of the agent's. */
  readonly model?: Lazy<PublicAgentDynamicModelResult | null | undefined>;
  /**
   * The system instructions the model reads: in place of the agent's, which `declared` holds.
   * Without it, the agent's. `(declared) => [...Object.values(declared), "…"]` adds to them;
   * `declared.agent` is the agent's own (with its list of skills), and each file in
   * `agent/instructions/` is there by its slug. Declared instructions keep eve's order, and come
   * before the harness's own.
   */
  readonly instructions?:
    | HarnessInstructions
    | ((
        declared: HarnessDeclaredInstructions,
      ) => HarnessInstructions | undefined | Promise<HarnessInstructions | undefined>);
  /**
   * The tools the model is offered, besides eve's own `eve__` tools: in place of the agent's,
   * which `declared` holds. Without it, the agent's. `(declared) => ({ ...declared, mine })` adds a
   * tool; leaving a declared one out removes it, including eve's `bash` and `read_file`.
   */
  readonly tools?:
    | HarnessTools
    | ((
        declared: HarnessDeclaredTools,
      ) => HarnessTools | undefined | Promise<HarnessTools | undefined>);
}

type HarnessInstructions = string | readonly (string | HarnessDeclared)[];

// oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
type HarnessTools = Readonly<Record<string, ToolDefinition<any, any> | HarnessDeclared>>;

/** Something the agent's files declare, which a harness keeps by returning it. */
export interface HarnessDeclared {
  readonly [DECLARED]: string;
}

/** The tools the agent's files declare, by name. */
export type HarnessDeclaredTools = Readonly<Record<string, HarnessDeclared>>;

/** The instructions the agent declares: `agent`, and each `agent/instructions/` file's, by slug. */
export type HarnessDeclaredInstructions = Readonly<Record<string, HarnessDeclared>> & {
  readonly agent: HarnessDeclared;
};

const DECLARED: unique symbol = Symbol.for("eve.harness.declared") as never;

/** The declared tool or instructions named `name`, for a harness to keep. */
export function declaredTool(name: string): HarnessDeclared {
  return { [DECLARED]: name };
}

/** The name of the declared tool `value` keeps, if it is one. */
export function declaredToolName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !(DECLARED in value)) return undefined;
  const name = (value as HarnessDeclared)[DECLARED];
  return typeof name === "string" ? name : undefined;
}

/** What a harness says should be true. A field it leaves out, or returns `undefined` for, is eve's. */
export interface HarnessPlan {
  readonly agent?: HarnessAgent;
  /**
   * What the model reads about the past, which becomes the session's history. eve asks before
   * each model call and for `session.compact()`. A change to messages the model hasn't read yet
   * joins the history; a change to ones it has read is a rewrite, which eve checks. Asked again
   * about what it returned, it must return the same. `undefined` is eve's own: summarize past the
   * threshold, or the history as it is.
   */
  readonly history?: Lazy<readonly HistoryMessage[] | undefined>;
  /**
   * What the turn does: at its start, before the model has run, and after each model step. At
   * the start, `{ settle }` ends the turn without calling the model, and its output is the reply.
   */
  readonly next?: Lazy<HarnessNext | undefined>;
}

/** Cheap and synchronous: it says what each field is. Work belongs in the lazy fields. */
export type Harness = (ctx: HarnessContext) => HarnessPlan;

const HARNESS: unique symbol = Symbol.for("eve.harness");

/** An opaque `defineHarness()` value. */
export interface HarnessDefinition {
  readonly [HARNESS]: Harness;
}

/**
 * Experimental. Defines how the agent's turns run, in `agent/harness.ts`. eve calls the function
 * wherever it decides, and applies what it returns through the checks no harness can change:
 * approvals, budgets, the turn's tasks, and a bounded number of notes per turn.
 *
 * ```ts
 * import { defineHarness } from "eve";
 *
 * export default defineHarness((ctx) => ({
 *   next: () =>
 *     ctx.lastStep?.text?.includes("[source]") === false && ctx.continuations === 0
 *       ? { model: { note: "Cite a source for each claim." } }
 *       : undefined,
 * }));
 * ```
 */
export function defineHarness(harness: Harness): HarnessDefinition {
  if (typeof harness !== "function") {
    throw new Error(
      "defineHarness() takes a function: defineHarness((ctx) => ({ next, history }))",
    );
  }
  const definition = { [HARNESS]: harness };
  stampDefinitionKey(definition, "harness");
  return definition;
}

/** The function a `defineHarness()` value holds, or `undefined` for anything else. */
export function harnessOf(value: unknown): Harness | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const harness = (value as Partial<HarnessDefinition>)[HARNESS];
  return typeof harness === "function" ? harness : undefined;
}
