import type { BtccTurnProgressObserver } from "../contracts.ts";

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
