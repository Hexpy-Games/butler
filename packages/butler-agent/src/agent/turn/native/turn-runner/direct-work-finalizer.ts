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
}): Promise<DirectWorkFinalizationResult> {
  if (!input.useTools) return { text: input.finalText };
  let finalText = input.finalText;
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
    finalText = await input.runToolPrompt(openDirectWorkContinuationPrompt({
      objective: input.userText,
      personaContext: promptContextSection(
        typeof input.turnInput.metadata?.promptContext === "string" ? input.turnInput.metadata.promptContext : "",
        "Active Persona Reminder",
      ),
      audit: input.audit,
      blocker,
    }), repairModelRounds, "direct_work_continuation");
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
      text: recoverableDirectWorkDeliveryText({
        blocker: remainingBlocker,
        finalText,
        language: input.deps.messageLanguage,
      }),
      delivery: deliveredWithContinuationState({
        limitationCodes: [DIRECT_WORK_CONTINUATION_LIMITATION_CODE],
        limitations: [directWorkContinuationLimitationText({
          blocker: remainingBlocker,
          language: input.deps.messageLanguage,
        })],
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

function recoverableDirectWorkDeliveryText(input: {
  blocker: OpenDirectWorkBlocker;
  finalText: string;
  language: RuntimeMessageLanguage;
}): string {
  const active = input.blocker.activeItems.at(0);
  if (input.language === "ko") {
    return [
      `\`${input.blocker.title}\` 작업이 ${input.blocker.phase ?? "현재"} 단계에서 아직 완료 조건을 만족하지 못했습니다.`,
      active ? `다음에 이어갈 항목: ${active.label}` : "다음에 이어갈 항목: 보고 가능한 상태까지 WorkStream 정리가 더 필요합니다.",
      "상태: recoverable로 저장했습니다.",
      "",
      compactPriorText(input.finalText),
    ].filter(Boolean).join("\n");
  }
  return [
    `\`${input.blocker.title}\` has not met the completion condition in the ${input.blocker.phase ?? "current"} phase.`,
    active ? `Next item to resume: ${active.label}` : "Next item to resume: the WorkStream still needs reportable closure.",
    "State: saved as recoverable.",
    "",
    compactPriorText(input.finalText),
  ].filter(Boolean).join("\n");
}

function directWorkContinuationLimitationText(input: {
  blocker: OpenDirectWorkBlocker;
  language: RuntimeMessageLanguage;
}): string {
  const active = input.blocker.activeItems.at(0);
  if (input.language === "ko") {
    return active
      ? `남은 직접 작업은 recoverable continuation으로 보존되었습니다: ${active.label}`
      : "남은 직접 작업은 recoverable continuation으로 보존되었습니다.";
  }
  return active
    ? `Remaining direct work was preserved as a recoverable continuation: ${active.label}`
    : "Remaining direct work was preserved as a recoverable continuation.";
}

function compactPriorText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= 500) return normalized;
  return `${normalized.slice(0, 497).trimEnd()}...`;
}
