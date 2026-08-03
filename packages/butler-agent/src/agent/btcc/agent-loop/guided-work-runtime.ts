import type {
  BtccTurnProgressObserver,
  WorkProgressTask,
} from "../contracts.ts";
import { digest } from "../identity/index.ts";
import type {
  DurableWorkContext,
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import { sanitizePublicText } from "../../events/turn-events.ts";
import { isDurableWorkTool } from "../work/index.ts";

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
): Promise<boolean> {
  const current = await safeBoundWork(input.durableWork, scope.turnId);
  if (current && current.workId !== presentedWorkId) return false;
  const bound = current ??
    await safeBindOpenWork(input.durableWork, scope, presentedWorkId);
  if (bound?.workId !== presentedWorkId) return false;
  await backfillTurnToolResults(input, scope);
  return true;
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

export async function publishWorkProgress(
  progress: BtccTurnProgressObserver | undefined,
  turnId: string,
  turnRevision: number,
  service: DurableWorkService,
): Promise<void> {
  if (!progress?.workProgressChanged) return;
  const work = await safeBoundWork(service, turnId);
  const plan = work?.currentPlan;
  if (!work || !plan) return;
  const progressByKey = new Map(
    work.actionProgress.map((action) => [action.actionKey, action]),
  );
  const tasks: WorkProgressTask[] = plan.actions.map((action, index) => {
    const actionProgress = progressByKey.get(action.actionKey);
    return {
      taskId: `${work.workId}:${action.actionKey}`,
      taskTitle: compactPublicText(
        action.actionKey,
        `작업 ${index + 1}`,
      ),
      taskDescription: publicText(action.description, action.actionKey),
      taskOutcome: publicText(actionProgress?.note, action.description),
      taskOrder: index,
      taskState: projectActionState(actionProgress?.status ?? "pending"),
      workId: work.workId,
      workTitle: publicText(work.objective, "Managed Work"),
      workState: work.status === "completed"
        ? "completed"
        : work.status === "abandoned"
          ? "cancelled"
          : "active",
    };
  });
  try {
    await progress.workProgressChanged({
      turnId,
      turnRevision,
      programId: work.workId,
      tasks,
    });
  } catch {
    // Checklist projection cannot veto Work or delivery.
  }
}

function projectActionState(
  status: "pending" | "active" | "done" | "blocked" | "skipped",
): WorkProgressTask["taskState"] {
  if (status === "done") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "skipped";
  return status === "active" ? "active" : "planned";
}

function publicText(value: string | undefined, fallback: string): string {
  return sanitizePublicText(value, fallback).trim() || fallback;
}

function compactPublicText(value: string | undefined, fallback: string): string {
  const text = publicText(value, fallback).replace(/\s+/gu, " ");
  return [...text].slice(0, 32).join("");
}
