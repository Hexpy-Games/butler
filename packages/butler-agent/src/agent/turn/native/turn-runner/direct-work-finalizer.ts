import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  activeDirectWorkProgressSnapshot,
  directWorkSemanticProgressAdvanced,
  finalDeliveryBlockerForOpenDirectWork,
  type OpenDirectWorkBlocker,
  openDirectWorkContinuationPrompt,
} from "../../direct-work-continuation.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import {
  deliveredWithContinuationState,
  type RuntimeDeliveryClassification,
} from "../../runtime-delivery-state.ts";
import { promptContextSection } from "../context/turn-prompt.ts";
import { directWorkContinuationAttempts } from "../policy/turn-errors.ts";
import type { NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import { WorkStreamStore, workStreamTerminal } from "../../../work/work-stream.ts";
import {
  directTurnModelRequestsRemaining,
  hasDirectTurnModelRequestReserve,
  type createDirectTurnBudget,
} from "../../direct-turn-budget.ts";

const DIRECT_WORK_FINALIZATION_MODEL_REQUEST_RESERVE = 2;
const DIRECT_WORK_FINALIZATION_SYNTHESIS_REQUEST_ALLOWANCE = 1;
const DIRECT_WORK_CONTINUATION_MAX_TOOL_ROUNDS = 8;
const DIRECT_WORK_CONTINUATION_LIMITATION_CODE = "direct_work_continuation";

export interface DirectWorkFinalizationResult {
  text: string;
  delivery?: RuntimeDeliveryClassification;
}

export async function closeDirectWork(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId?: string | null;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  userText: string;
  finalText: string;
  audit: ToolAuditEntry[];
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
  guardFinalText(finalText: string): Promise<string> | string;
}): Promise<DirectWorkFinalizationResult> {
  if (!input.useTools) return { text: input.finalText };
  const deliverableTextBeforeContinuation = await input.guardFinalText(input.finalText);
  let finalText = deliverableTextBeforeContinuation;
  const maxDirectWorkContinuations = directWorkContinuationAttempts();
  for (let repairAttempt = 0; repairAttempt < maxDirectWorkContinuations; repairAttempt += 1) {
    const blocker = finalDeliveryBlockerForOpenDirectWork({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      turnId: input.turnId,
    });
    if (!blocker) break;
    if (!hasDirectTurnModelRequestReserve(
      input.turnBudget,
      DIRECT_WORK_FINALIZATION_MODEL_REQUEST_RESERVE,
    )) {
      break;
    }
    const repairModelRounds = directWorkFinalizationRepairRounds(input.turnBudget);
    if (repairModelRounds <= 0) break;
    const workBeforeContinuation = activeDirectWorkProgressSnapshot({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      turnId: input.turnId,
    });
    finalText = await input.guardFinalText(await input.runToolPrompt(openDirectWorkContinuationPrompt({
      objective: input.userText,
      personaContext: promptContextSection(
        typeof input.turnInput.metadata?.promptContext === "string" ? input.turnInput.metadata.promptContext : "",
        "Active Persona Reminder",
      ),
      audit: input.audit,
      blocker,
    }), repairModelRounds, "direct_work_continuation"));
    const workAfterContinuation = activeDirectWorkProgressSnapshot({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      turnId: input.turnId,
    });
    if (!directWorkSemanticProgressAdvanced(workBeforeContinuation, workAfterContinuation)) break;
  }
  const remainingBlocker = finalDeliveryBlockerForOpenDirectWork({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
    turnId: input.turnId,
  });
  if (remainingBlocker) {
    markRemainingDirectWorkRecoverable({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      blocker: remainingBlocker,
    });
    return {
      text: await recoverableDirectWorkDeliveryText({
        finalText: deliverableTextBeforeContinuation,
        language: input.deps.messageLanguage,
      }, input.guardFinalText),
      delivery: deliveredWithContinuationState({
        limitationCodes: [DIRECT_WORK_CONTINUATION_LIMITATION_CODE],
        limitations: [],
      }),
    };
  }
  return { text: finalText };
}

function directWorkFinalizationRepairRounds(
  turnBudget: ReturnType<typeof createDirectTurnBudget>,
): number {
  const spendable = directTurnModelRequestsRemaining(turnBudget) -
    DIRECT_WORK_FINALIZATION_MODEL_REQUEST_RESERVE -
    DIRECT_WORK_FINALIZATION_SYNTHESIS_REQUEST_ALLOWANCE;
  return Math.max(0, Math.min(DIRECT_WORK_CONTINUATION_MAX_TOOL_ROUNDS, spendable));
}

function markRemainingDirectWorkRecoverable(input: {
  butlerData: string;
  sessionId: string;
  blocker: OpenDirectWorkBlocker;
}): void {
  try {
    const store = new WorkStreamStore(input.butlerData);
    const active = store.read(input.blocker.id);
    if (!active || workStreamTerminal(active.state) || active.state === "recoverable") return;
    if (active.owner_session_id !== input.sessionId) return;
    store.transition({
      id: active.id,
      state: "recoverable",
      statusNote: `Turn delivered before direct work was complete; resume from ${input.blocker.phase ?? "current phase"}.`,
    });
  } catch {
    // WorkStream recovery bookkeeping must not block user-visible delivery.
  }
}

async function recoverableDirectWorkDeliveryText(input: {
  finalText: string;
  language: RuntimeMessageLanguage;
}, guardFinalText: (finalText: string) => Promise<string> | string): Promise<string> {
  const publicText = input.finalText.trim();
  if (publicText) return publicText;
  if (input.language === "ko") {
    return await guardFinalText("아직 최종 답변을 만들지 못했습니다. 이어서 처리하겠습니다.");
  }
  return await guardFinalText("I could not produce the final answer yet. I will continue from the saved work state.");
}
