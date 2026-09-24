export const AGENT_LOOP_NO_PROGRESS_CODE = "agent_loop_no_progress" as const;
export const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 10;
const MAX_NO_PROGRESS_ROUNDS_CEILING = 200;
const ENV_KEY = "BUTLER_AGENT_LOOP_MAX_NO_PROGRESS_ROUNDS";

/**
 * Useful rounds are unbounded. A round is "no progress" only by structure: the
 * runtime re-asked after a tool-free reply, or every tool call in the batch
 * failed. Consecutive no-progress rounds stop the loop instead of spending
 * model tokens forever; a successful tool result or fresh user direction resets.
 */
export class AgentLoopNoProgressError extends Error {
  readonly code = AGENT_LOOP_NO_PROGRESS_CODE;
  constructor(readonly rounds: number, readonly reason: NoProgressReason) {
    super(`BTCC agent loop stopped after ${rounds} consecutive rounds without progress (${reason})`);
    this.name = "AgentLoopNoProgressError";
  }
}

export type NoProgressReason =
  | "final_candidate_reprompt"
  | "text_tool_call_reprompt"
  | "empty_response_reprompt"
  | "failed_tool_batch";

export function selectMaxNoProgressRounds(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = env[ENV_KEY]?.trim();
  if (!configured) return DEFAULT_MAX_NO_PROGRESS_ROUNDS;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_NO_PROGRESS_ROUNDS_CEILING) {
    throw new Error(`invalid_agent_loop_limit:${ENV_KEY}`);
  }
  return parsed;
}

export function createNoProgressGuard(limit = selectMaxNoProgressRounds()): {
  stalled(reason: NoProgressReason): void;
  toolBatch(results: readonly { ok: boolean }[]): void;
  progressed(): void;
} {
  const max = Math.max(1, Math.trunc(limit));
  let consecutive = 0;
  const stalled = (reason: NoProgressReason) => {
    consecutive += 1;
    if (consecutive >= max) throw new AgentLoopNoProgressError(consecutive, reason);
  };
  return {
    stalled,
    toolBatch(results) {
      if (results.some((result) => result.ok)) consecutive = 0;
      else stalled("failed_tool_batch");
    },
    progressed() {
      consecutive = 0;
    },
  };
}
