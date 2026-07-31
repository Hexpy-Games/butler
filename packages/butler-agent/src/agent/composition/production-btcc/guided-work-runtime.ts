import type { BtccTurnProgressObserver } from "../../btcc/index.ts";
import { digest } from "../../btcc/core/index.ts";
import type {
  DurableWorkContext,
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../../btcc/durable-work/index.ts";
import type { TurnRecord } from "../../btcc/turn/index.ts";
import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import { isDurableWorkTool } from "./durable-work-tools.ts";

type GuidedWorkRuntimeInput = {
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
};

export function workScopeForTurn(
  turn: TurnRecord,
  trackingMode: "ledger" | "local" | "none",
): WorkTurnScope {
  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    ...(trackingMode === "ledger" && turn.context.projectRef
      ? { projectRef: turn.context.projectRef }
      : {}),
  };
}

export async function safeLoadWorkContext(
  service: DurableWorkService,
  scope: WorkTurnScope,
): Promise<DurableWorkContext | null> {
  try {
    return await service.loadContext(scope);
  } catch {
    return null;
  }
}

export async function safeImportOpenLegacyWork(
  service: DurableWorkService,
  scope: WorkTurnScope,
): Promise<void> {
  try {
    await service.importOpenLegacyWork(scope);
  } catch {
    // Legacy continuity is best effort and cannot veto the current Turn.
  }
}

export async function safeBoundWork(
  service: DurableWorkService,
  turnId: string,
): Promise<DurableWorkView | null> {
  try {
    return await service.boundWorkForTurn(turnId);
  } catch {
    return null;
  }
}

export async function safeBindOpenWork(
  service: DurableWorkService,
  scope: WorkTurnScope,
  expectedWorkId?: string,
): Promise<DurableWorkView | null> {
  try {
    return await service.bindOpenWork(scope, expectedWorkId);
  } catch {
    return null;
  }
}

export async function bindPresentedWorkForToolDispatch(
  input: GuidedWorkRuntimeInput,
  scope: WorkTurnScope,
  presentedWorkId: string,
): Promise<void> {
  const current = await safeBoundWork(input.durableWork, scope.turnId);
  if (current && current.workId !== presentedWorkId) return;
  const bound = current ??
    await safeBindOpenWork(input.durableWork, scope, presentedWorkId);
  if (bound?.workId !== presentedWorkId) return;
  await backfillTurnToolResults(input, scope);
}

export async function safeAttachToolResult(
  input: GuidedWorkRuntimeInput,
  scope: WorkTurnScope,
  toolCallId: string,
): Promise<void> {
  if (!await safeBoundWork(input.durableWork, scope.turnId)) return;
  try {
    await input.durableWork.attachToolResult({
      ...scope,
      mutationCallId: digest(`btcc-guided-work-result-attach.v1\0${toolCallId}`),
      toolCallId,
    });
  } catch {
    // Work bookkeeping cannot veto an otherwise valid tool result.
  }
}

export async function backfillTurnToolResults(
  input: GuidedWorkRuntimeInput,
  scope: WorkTurnScope,
): Promise<void> {
  for (const record of input.toolJournal.list(scope.turnId)) {
    if (record.status !== "completed" || isDurableWorkTool(record.toolName)) continue;
    await safeAttachToolResult(input, scope, record.callId);
  }
}

export async function publishWorkCheckpoint(
  progress: BtccTurnProgressObserver | undefined,
  turnId: string,
  service: DurableWorkService,
): Promise<void> {
  const work = await safeBoundWork(service, turnId);
  const checkpoint = work?.latestCheckpoint;
  if (!checkpoint || !progress?.phaseActivityChanged) return;
  try {
    await progress.phaseActivityChanged({
      turnId,
      semanticState: "admitted",
      activityId: `durable-work:${work.workId}`,
      title: checkpoint.publicSummary,
      summary: checkpoint.publicSummary,
      rationale: "",
      nextStep: checkpoint.nextStep,
    });
  } catch {
    // Public progress cannot veto Work or delivery.
  }
}
