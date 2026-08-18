import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { GuidedEffectAccessMode } from "../effects/index.ts";
import type { PrincipalAuthority } from "../authority/index.ts";
import type {
  GuidedActivityBinding,
  GuidedActivityProjection,
} from "../projection/index.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";

/**
 * Captures only user-facing progress text for operational fallback.  The
 * wrapped observer remains downstream-only; its facts never enter Work or
 * effect authorization.
 */
export function createGuidedOperationalProgressCapture(
  progress: BtccTurnProgressObserver | undefined,
): {
  observer: BtccTurnProgressObserver | undefined;
  facts(): string[];
} {
  if (!progress) return { observer: undefined, facts: () => [] };
  const values: string[] = [];
  const remember = (value: string | undefined): void => {
    const text = value?.trim();
    if (text && !values.includes(text)) values.push(text);
  };
  return {
    observer: {
      stateChanged: (update) => progress.stateChanged(update),
      workProgressChanged: (update) => {
        if (isCurrentMaterialUpdate(update)) {
          for (const task of update.tasks) remember(task.taskOutcome || task.taskTitle);
        }
        return progress.workProgressChanged?.(update);
      },
      phaseActivityChanged: (update) => {
        if (isCurrentMaterialUpdate(update)) {
          remember(update.summary);
          remember(update.nextStep);
        }
        return progress.phaseActivityChanged?.(update);
      },
      operationChanged: (update) => progress.operationChanged?.(update),
      modelRoundWaitingChanged: (update) => progress.modelRoundWaitingChanged?.(update),
      operationalNoticeChanged: (update) => progress.operationalNoticeChanged?.(update),
      runtimeFaulted: (update) => progress.runtimeFaulted?.(update),
    },
    facts: () => values.slice(),
  };
}

function isCurrentMaterialUpdate(update: {
  turnId: string;
  originTurnId?: string;
  sourceRevision?: number;
}): boolean {
  return update.originTurnId === update.turnId &&
    typeof update.sourceRevision === "number" &&
    Number.isInteger(update.sourceRevision) && update.sourceRevision > 0;
}

export function createGuidedAskFirstProgress(
  progress: BtccTurnProgressObserver | undefined,
): BtccTurnProgressObserver | undefined {
  if (!progress) return undefined;
  return { stateChanged: (update) => progress.stateChanged(update) };
}

export function createGuidedPublicActivity(input: {
  accessMode: GuidedEffectAccessMode;
  activity: GuidedActivityProjection;
}): GuidedActivityProjection {
  if (input.accessMode !== "ask_first") return input.activity;
  return {
    observeToolBatch: (batch) => input.activity.observeToolBatch({
      text: "Reviewed command pending Allow.",
      toolCalls: batch.toolCalls.map((call) => ({ name: call.name, args: {} })),
    }),
    observeTool: (call) => input.activity.observeTool({ ...call, args: {} }),
    markManaged: (binding?: GuidedActivityBinding) => input.activity.markManaged(binding),
    publishAccepted: (binding: GuidedActivityBinding) => input.activity.publishAccepted(binding),
  };
}

export function createGuidedPublicLoopCallbacks(input: {
  accessMode: GuidedEffectAccessMode;
  activity: GuidedActivityProjection;
}): Pick<BtccAgentLoopInput, "onAssistantTextBeforeTools" | "finalTextFromToolResult"> {
  return {
    onAssistantTextBeforeTools: ({ text, toolCalls }) => input.activity.observeToolBatch({
      text: input.accessMode === "ask_first" ? "Reviewed command pending Allow." : text,
      toolCalls: toolCalls.map((call) => ({
        name: call.name,
        args: input.accessMode === "ask_first" ? {} : call.arguments,
      })),
    }),
    finalTextFromToolResult: ({ toolResult }) => authorityPending(toolResult.output)
      ? "This reviewed command is waiting for Allow."
      : null,
  };
}

export function projectGuidedAuthorityOutcome(input: {
  authority?: PrincipalAuthority;
  ownerSessionId: string;
  requestRef: string;
}): string {
  if (!input.authority) return "Approved command outcome could not be verified.";
  try {
    const execution = input.authority.execution({
      ownerSessionId: input.ownerSessionId,
      requestRef: input.requestRef,
    });
    if (execution.outcome === "applied") return "Approved command completed once.";
    if (execution.outcome === "failed") return "Approved command failed to complete.";
    return "Approved command outcome is pending.";
  } catch {
    return "Approved command outcome could not be verified.";
  }
}

function authorityPending(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).authority_pending === true;
}
