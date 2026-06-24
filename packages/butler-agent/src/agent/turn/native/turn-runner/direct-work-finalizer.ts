import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  activeDirectWorkProgressSnapshot,
  directWorkSemanticProgressAdvanced,
  finalDeliveryBlockerForOpenDirectWork,
  type OpenDirectWorkBlocker,
  openDirectWorkContinuationPrompt,
} from "../../direct-work-continuation.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import { promptContextSection } from "../context/turn-prompt.ts";
import { directWorkContinuationAttempts } from "../policy/turn-errors.ts";
import type { NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import { WorkStreamStore, workStreamTerminal } from "../../../work/work-stream.ts";

export async function closeDirectWork(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  userText: string;
  finalText: string;
  audit: ToolAuditEntry[];
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  if (!input.useTools) return input.finalText;
  let finalText = input.finalText;
  const maxDirectWorkContinuations = directWorkContinuationAttempts();
  for (let repairAttempt = 0; repairAttempt < maxDirectWorkContinuations; repairAttempt += 1) {
    const blocker = finalDeliveryBlockerForOpenDirectWork({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
    });
    if (!blocker) break;
    const workBeforeContinuation = activeDirectWorkProgressSnapshot({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
    });
    finalText = await input.runToolPrompt(openDirectWorkContinuationPrompt({
      objective: input.userText,
      personaContext: promptContextSection(
        typeof input.turnInput.metadata?.promptContext === "string" ? input.turnInput.metadata.promptContext : "",
        "Active Persona Reminder",
      ),
      audit: input.audit,
      blocker,
    }), 8, "direct_work_continuation");
    const workAfterContinuation = activeDirectWorkProgressSnapshot({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
    });
    if (!directWorkSemanticProgressAdvanced(workBeforeContinuation, workAfterContinuation)) break;
  }
  const remainingBlocker = finalDeliveryBlockerForOpenDirectWork({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
  });
  if (remainingBlocker) {
    markRemainingDirectWorkRecoverable({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      blocker: remainingBlocker,
    });
    return recoverableDirectWorkDeliveryText({
      blocker: remainingBlocker,
      finalText,
      language: input.deps.messageLanguage,
    });
  }
  return finalText;
}

function markRemainingDirectWorkRecoverable(input: {
  butlerData: string;
  sessionId: string;
  blocker: OpenDirectWorkBlocker;
}): void {
  try {
    const store = new WorkStreamStore(input.butlerData);
    const active = store.activeForSession(input.sessionId);
    if (!active || workStreamTerminal(active.state) || active.state === "recoverable") return;
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
      "아직 완료라고 보고할 수 있는 상태까지는 도달하지 못했습니다.",
      "",
      `현재 작업은 \`${input.blocker.title}\`이고, ${input.blocker.phase ?? "현재"} 단계에서 다시 이어갈 수 있게 복구 상태로 남겨뒀습니다.`,
      active ? `남은 항목: ${active.label}` : "남은 항목: active WorkStream이 아직 보고 가능한 상태가 아닙니다.",
      "",
      compactPriorText(input.finalText),
    ].filter(Boolean).join("\n");
  }
  return [
    "I cannot honestly report this as complete yet.",
    "",
    `The current work is \`${input.blocker.title}\`, and I left it recoverable from the ${input.blocker.phase ?? "current"} phase.`,
    active ? `Remaining item: ${active.label}` : "Remaining item: the active WorkStream is not reportable yet.",
    "",
    compactPriorText(input.finalText),
  ].filter(Boolean).join("\n");
}

function compactPriorText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= 500) return normalized;
  return `${normalized.slice(0, 497).trimEnd()}...`;
}
