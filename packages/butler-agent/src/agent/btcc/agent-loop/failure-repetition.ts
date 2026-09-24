import { digest, stableJson } from "../identity/index.ts";
import type {
  BtccAgentLoopToolCall,
  BtccAgentLoopToolResult,
} from "./contracts.ts";

/** Serializable counts; restored with the loop so compaction never resets them. */
export type FailureRepetitionState = Record<string, number>;

export interface FailureRepetitionTracker {
  /** Returns the model-facing copy of a result, stating an identical repeat as a fact. */
  annotate(call: BtccAgentLoopToolCall, result: BtccAgentLoopToolResult): BtccAgentLoopToolResult;
  /** Returns the runtime observation, stating how often this kind was already given. */
  nudge(kind: string, observation: string): string;
  snapshot(): FailureRepetitionState;
}

/**
 * Repetition is feedback, never termination: counts are per Turn and only
 * inform the model that the same attempt produced the same failure before.
 */
export function createFailureRepetitionTracker(
  restored?: FailureRepetitionState,
): FailureRepetitionTracker {
  const counts = new Map<string, number>(Object.entries(restored ?? {}));
  const increment = (key: string) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  };
  return {
    annotate(call, result) {
      if (result.ok) return result;
      const count = increment(`tool:${failureKey(call, result.error)}`);
      if (count < 2) return result;
      return {
        ...result,
        error: {
          ...result.error,
          repeat_count: count,
          repetition: `Fact: this identical failure (same tool, arguments, and error) has occurred ${count} times in this turn. Repeating the same call returns the same result; change the arguments, use another tool, or take another approach.`,
        },
      };
    },
    nudge(kind, observation) {
      const count = increment(`nudge:${kind}`);
      return count < 2
        ? observation
        : `${observation}\n\nFact: this same runtime notice has been given ${count} times in this turn.`;
    },
    snapshot: () => Object.fromEntries(counts),
  };
}

function failureKey(
  call: BtccAgentLoopToolCall,
  error: { code: string; message: string },
): string {
  return digest(stableJson({
    tool: call.name,
    arguments: canonicalArguments(call.arguments),
    code: error.code,
    message: error.message,
  }));
}

function canonicalArguments(value: unknown): unknown {
  try {
    return JSON.parse(stableJson(value ?? null));
  } catch {
    return String(value);
  }
}
