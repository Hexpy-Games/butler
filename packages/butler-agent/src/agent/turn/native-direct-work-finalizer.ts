import type { RuntimeTurnInput } from "../../test-support/harness/contracts.ts";
import {
  activeDirectWorkProgressSnapshot,
  directWorkSemanticProgressAdvanced,
  finalDeliveryBlockerForOpenDirectWork,
  openDirectWorkContinuationPrompt,
} from "./direct-work-continuation.ts";
import { promptContextSection } from "./native-turn-prompt.ts";
import {
  directWorkContinuationAttempts,
  goalCompletionIncompleteError,
} from "./native-turn-errors.ts";
import type { NativeTurnRunnerDeps } from "./native-turn-runner-types.ts";
import type { ToolAuditEntry } from "./native-tool-types.ts";

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
    throw goalCompletionIncompleteError(
      `active direct work stream is not deliverable: ${remainingBlocker.title}`,
    );
  }
  return finalText;
}
