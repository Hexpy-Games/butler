import type { EffectAdapter, EffectDispatchOutcome } from "../effects/index.ts";
import { executeTopicConversation } from "../../tools/conversation/executor.ts";

/** The App reservation is idempotent: reconciliation resumes the same seed/target,
 * never creates a second conversation after a lost HTTP response. */
export function prepareGuidedConversationBranchEffect(input: {
  args: Record<string, unknown>; butlerData: string; appSessionId?: string;
}) {
  const target = "conversation-branch";
  const execute = async (effect: { normalizedInput: Record<string, unknown>; idempotencyKey: string; signal: AbortSignal }): Promise<EffectDispatchOutcome<unknown>> => {
    try {
      const result = await executeTopicConversation({ ...input, args: effect.normalizedInput,
        requestId: effect.idempotencyKey, signal: effect.signal });
      return { status: "applied", result };
    } catch (error) {
      return { status: "uncertain", error: { code: "session_branch_response_unconfirmed",
        message: error instanceof Error ? error.message : "The conversation creation response was not confirmed." } };
    }
  };
  const adapter: EffectAdapter<Record<string, unknown>, unknown> = {
    capability: "start_topic_conversation", reviewedPlanBinding: "accepted_plan",
    normalizeTarget(value) { if (value !== target) throw new Error("session_branch_target_changed"); return value; },
    sanitizeTarget: () => "새 대화",
    normalizeInput(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_branch_input_invalid");
      return value as Record<string, unknown>;
    },
    dispatch: effect => effect.signal.aborted
      ? Promise.resolve({ status: "not_applied", error: { code: "session_branch_cancelled", message: "Conversation creation was cancelled before dispatch." } })
      : execute(effect),
    reconcile: effect => effect.dispatchAttempts === 0 ? Promise.resolve({ status: "not_applied" }) : execute(effect),
  };
  return { target, input: input.args, adapter };
}
