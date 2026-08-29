import { subsessionResultId } from "./identities.ts";
import {
  defaultCode,
  safeTerminalSummary,
} from "./terminal-results.ts";
import type {
  CompleteStewardResultOutcome,
  ParentInputSink,
  StewardResultCode,
  StewardResultStatus,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";

/** Commits one typed child outcome and reuses the existing parent App ingress. */
export async function completeStewardResultForDependencies(
  input: SubsessionDelegationDependencies,
  parentInputSink: ParentInputSink,
  resultInput: Parameters<SubsessionDelegationService["completeStewardResult"]>[0],
): Promise<CompleteStewardResultOutcome> {
  const relation = input.store.relationByChildSessionId(resultInput.childSessionId);
  if (!relation) throw new Error("subsession_relation_missing");
  const childTurn = await input.parentTurns.findTurn(resultInput.childTurnId);
  if (resultInput.status !== "cancelled" &&
      (!childTurn || childTurn.sessionId !== relation.child_session_id ||
       childTurn.semanticState !== "delivered")) {
    throw new Error("subsession_child_turn_missing");
  }
  const expectedResultId = subsessionResultId(
    relation.child_session_id,
    resultInput.childTurnId,
  );
  if (resultInput.resultId !== expectedResultId) throw new Error("subsession_result_identity_mismatch");
  if (resultInput.status === "cancelled") {
    await input.durableWork.abandonBoundWorkForTurn(resultInput.childTurnId);
  }

  const existing = input.store.resultByRelationId(relation.relation_id);
  if (existing) {
    const pending = input.store.pendingParentInputForResult(existing.result_id);
    if (pending) {
      await parentInputSink(pending);
      input.store.markParentInputDelivered(existing.result_id);
    }
    return { status: "duplicate", result: existing } satisfies CompleteStewardResultOutcome;
  }

  const packet = input.store.packetByRelationId(relation.relation_id);
  const parent = input.sessionBindings.getBySessionId(relation.parent_session_id);
  const parentChatId = parent?.transportBindings.find((binding) =>
    binding.transport === "app" && binding.peerId.trim(),
  )?.peerId;
  if (!parentChatId) throw new Error("parent_app_binding_required");
  const taskId = input.store.taskIdByRelationId(relation.relation_id);
  if (!taskId?.trim()) throw new Error("subsession_task_context_missing");

  const status = resultInput.status ?? "success";
  const terminalStatus: StewardResultStatus = status;
  const terminalCode: StewardResultCode | null = resultInput.code ?? defaultCode(status);
  let evidence: {
    summary: string;
    acceptanceEvidence: string[];
    changedArtifacts: string[];
    commits: string[];
    tests: string[];
    remainingRisks: string[];
    followUpRecommendations: string[];
    detailRefs: string[];
  };
  if (resultInput.summary?.trim()) {
    evidence = {
      summary: safeSummary(resultInput.summary),
      acceptanceEvidence: [],
      changedArtifacts: resultInput.changedArtifacts ?? [],
      ...emptyReportDetails(),
    };
  } else {
    if (terminalStatus === "success") {
      throw new Error("subsession_success_result_content_required");
    }
    if (terminalStatus === "failed") {
      throw new Error("subsession_failed_result_summary_required");
    }
    evidence = {
      summary: safeTerminalSummary(terminalStatus, terminalCode),
      acceptanceEvidence: [],
      changedArtifacts: [],
      ...emptyReportDetails(),
    };
  }

  const modelRef = nonEmpty(packet?.model_ref) ?? nonEmpty(parent?.modelRef);
  const parentReasoning = parent?.metadata?.reasoning_effort;
  const reasoningEffort = nonEmpty(packet?.reasoning_effort) ??
    (typeof parentReasoning === "string" ? nonEmpty(parentReasoning) : null);
  if (!modelRef || !reasoningEffort) throw new Error("subsession_parent_model_context_missing");

  const result = input.store.commitResult({
    relation,
    childTurnId: resultInput.childTurnId,
    resultId: resultInput.resultId,
    taskId,
    modelRef,
    reasoningEffort,
    status: terminalStatus,
    code: terminalCode,
    summary: evidence.summary,
    acceptanceEvidence: evidence.acceptanceEvidence,
    changedArtifacts: evidence.changedArtifacts,
    commits: evidence.commits,
    tests: evidence.tests,
    remainingRisks: evidence.remainingRisks,
    followUpRecommendations: evidence.followUpRecommendations,
    detailRefs: evidence.detailRefs,
    parentChatId,
  });
  if (terminalStatus === "success") {
    const childWork = await input.durableWork.boundWorkForTurn(
      resultInput.childTurnId,
    );
    if (childWork && childWork.status !== "completed") {
      await completeWork(input, {
        turnId: resultInput.childTurnId,
        sessionId: relation.child_session_id,
        work: childWork,
        mutationCallId: `steward-work:${resultInput.resultId}`,
        summary: evidence.summary,
      });
    }
  }
  const pending = input.store.pendingParentInputForResult(result.result.result_id);
  if (pending) {
    await parentInputSink(pending);
    input.store.markParentInputDelivered(result.result.result_id);
  }
  return {
    status: result.inserted ? "committed" : "duplicate",
    result: result.result,
  } satisfies CompleteStewardResultOutcome;
}

async function completeWork(
  input: SubsessionDelegationDependencies,
  command: {
    turnId: string;
    sessionId: string;
    work: NonNullable<Awaited<ReturnType<
      SubsessionDelegationDependencies["durableWork"]["boundWorkForTurn"]
    >>>;
    mutationCallId: string;
    summary: string;
  },
): Promise<void> {
  await input.durableWork.recordDisposition({
    turnId: command.turnId,
    sessionId: command.sessionId,
    ...(command.work.scope.kind === "project"
      ? { projectRef: command.work.scope.projectRef }
      : {}),
    mutationCallId: command.mutationCallId,
    workId: command.work.workId,
    disposition: "completed",
    summary: command.summary,
    actionUpdates: (command.work.currentPlan?.actions ?? []).map((action) => ({
      actionKey: action.actionKey,
      status: "done" as const,
    })),
    remainingActions: [],
    evidenceRefs: [],
    followups: [],
  });
}

function safeSummary(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptyReportDetails() {
  return {
    commits: [] as string[],
    tests: [] as string[],
    remainingRisks: [] as string[],
    followUpRecommendations: [] as string[],
    detailRefs: [] as string[],
  };
}
