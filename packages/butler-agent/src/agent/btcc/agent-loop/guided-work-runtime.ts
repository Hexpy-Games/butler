import type {
  BtccTurnProgressObserver,
  WorkProgressTask,
} from "../contracts.ts";
import type {
  DurableWorkContext,
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import type { TurnRecord } from "../turn/index.ts";
import type {
  PrincipalAuthority,
} from "../authority/index.ts";
import { sanitizePublicText } from "../../events/turn-events.ts";
import { publicWorkActionDisplay } from "../projection/index.ts";

type GuidedWorkRuntimeInput = {
  durableWork: DurableWorkService;
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
  return await service.loadContext(scope);
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
  return await service.boundWorkForTurn(turnId);
}

export async function safeBindOpenWork(
  service: DurableWorkService,
  scope: WorkTurnScope,
  expectedWorkId?: string,
): Promise<DurableWorkView | null> {
  return await service.bindOpenWork(scope, expectedWorkId);
}

export async function loadInitialGuidedWork(
  input: GuidedWorkRuntimeInput,
  scope: WorkTurnScope,
): Promise<{ context: DurableWorkContext | null; bound: boolean }> {
  let context = await safeLoadWorkContext(input.durableWork, scope);
  if (!context) {
    await safeImportOpenLegacyWork(input.durableWork, scope);
    context = await safeLoadWorkContext(input.durableWork, scope);
  }
  if (!context) return { context: null, bound: false };
  const bound = await safeBoundWork(input.durableWork, scope.turnId);
  if (bound?.workId !== context.work.workId) {
    return { context, bound: false };
  }
  return {
    context: await safeLoadWorkContext(input.durableWork, scope),
    bound: true,
  };
}

export async function loadGuidedTurnWork(input: {
  durableWork: DurableWorkService;
  scope: WorkTurnScope;
  trackingMode: "ledger" | "local" | "none";
  authority?: PrincipalAuthority;
  authorityRequestRef?: string;
  authorityClientMessageId?: string;
  workspacePath: string;
}): Promise<{
  context: DurableWorkContext | null;
  bound: boolean;
}> {
  const storedAuthority = input.authorityRequestRef && input.authority &&
    input.authorityClientMessageId
    ? input.authority.execution({
        ownerSessionId: input.scope.sessionId,
        requestRef: input.authorityRequestRef,
        sourceSessionId: input.scope.sessionId,
        clientMessageId: input.authorityClientMessageId,
        turnId: input.scope.turnId,
      })
    : undefined;
  if (input.authorityRequestRef && !storedAuthority) {
    throw new Error("authority_context_missing");
  }
  if (storedAuthority) {
    if (storedAuthority.sourceSessionId !== input.scope.sessionId ||
        storedAuthority.sourceTurnId === input.scope.turnId ||
        storedAuthority.workspacePath !== input.workspacePath) {
      throw new Error("authority_request_identity_mismatch");
    }
    const bound = await safeBindOpenWork(
      input.durableWork,
      input.scope,
      storedAuthority.sourceWorkId,
    );
    if (!bound || bound.workId !== storedAuthority.sourceWorkId) {
      throw new Error("authority_source_work_unavailable");
    }
  }
  const initial = input.trackingMode === "none"
    ? { context: null, bound: false }
    : await loadInitialGuidedWork({
        durableWork: input.durableWork,
      }, input.scope);
  if (storedAuthority && (!initial.bound ||
      initial.context?.work.workId !== storedAuthority.sourceWorkId)) {
    throw new Error("authority_source_work_unavailable");
  }
  return initial;
}

export async function publishWorkProgress(
  progress: BtccTurnProgressObserver | undefined,
  turnId: string,
  turnRevision: number,
  service: DurableWorkService,
  modelRef?: string,
): Promise<void> {
  if (!progress?.workProgressChanged) return;
  const work = await safeBoundWork(service, turnId);
  const plan = work?.currentPlan;
  if (!work || !plan) return;
  const currentMaterial = [
    work.latestDisposition,
    work.latestCompletionValidation,
    work.latestResultReview,
    work.latestPlanReview,
    work.latestCheckpoint,
    work.currentPlan,
  ].find((entry) => entry?.originTurnId === turnId);
  const progressByKey = new Map(
    work.actionProgress.map((action) => [action.actionKey, action]),
  );
  const tasks: WorkProgressTask[] = plan.actions.map((action, index) => {
    const actionProgress = progressByKey.get(action.actionKey);
    return {
      taskId: `${work.workId}:${action.actionKey}`,
      taskTitle: publicWorkActionDisplay(
        action,
        compactPublicText(action.actionKey, `작업 ${index + 1}`),
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
      ...(currentMaterial?.originTurnId
        ? { originTurnId: currentMaterial.originTurnId }
        : {}),
      ...(currentMaterial?.revision !== undefined
        ? { sourceRevision: currentMaterial.revision }
        : {}),
      programId: work.workId,
      ...(modelRef ? { modelRef } : {}),
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
  const characters = [...text];
  if (characters.length <= 32) return text;
  const prefix = characters.slice(0, 31).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  const bounded = lastSpace >= 16 ? prefix.slice(0, lastSpace) : prefix;
  return `${bounded.trimEnd()}…`;
}
