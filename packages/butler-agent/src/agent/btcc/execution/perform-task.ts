import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  ResultCandidateProduct,
  TargetStateRevision,
  WorkspaceRevision,
} from "./contracts.ts";
import type { OperationResultProjection } from "../operation-result/index.ts";
import { isResultReadRequest } from "../operation-result/index.ts";
import { withTaskExecutionDeferral } from "../deferral/index.ts";
import { taskExecutionSubmissionSchema } from "./submission-schema.ts";

const CONTRACT: PhaseContract = {
  phase: "task_execution",
  objective: "execute_the_exact_accepted_task_and_record_its_concrete_result",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "execute_accepted_task", "record_concrete_result", "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_self_review",
  ],
};

const codec = withTaskExecutionDeferral<ResultCandidateProduct>({
  submissionSchema: taskExecutionSubmissionSchema,
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Task Execution state");
    const value = requireRecord(submission, "Task Execution submission");
    requireLiteral(value.kind, "result_candidate", "Task Execution kind");
    const executionTarget = requireRecord(state.executionTarget, "executionTarget");
    const target = requireRecord(executionTarget.target, "executionTarget.target");
    const resultSummary = requireString(value.resultSummary, "resultSummary");
    const summary = {
      ref: contentRef("result-summary", { content: resultSummary }),
      content: resultSummary,
    };
    const common = {
      turnId: envelope.binding.turnId,
      goalContractRef: requireContentRef(state.goalContractRef, "goalContractRef"),
      authorityRef: requireContentRef(state.authorityRef, "authorityRef"),
      workRef: requireContentRef(state.workRef, "workRef"),
      taskRef: requireContentRef(state.taskRef, "taskRef"),
      taskRevisionSha256: requireString(state.taskRevisionSha256, "taskRevisionSha256"),
      attemptRef: requireContentRef(state.attemptRef, "attemptRef"),
      executionTargetRef: requireContentRef(state.executionTargetRef, "executionTargetRef"),
      executionCheckpointRef: envelope.binding.checkpointId,
      resultSummary: summary,
      operationResultRefs: envelope.operationResults.map((result) => result.resultRef),
      operationResults: envelope.operationResults,
      unresolvedConditionRefs: [] as [],
      targetStateRevisions: targetStateRevisions(envelope.operationResults),
      effectReceiptRefs: [] as [],
    };
    const resultBody = target.kind === "provisioned_workspace"
      ? workspaceResult(common, target, envelope)
      : target.kind === "repository_promotion"
        ? promotionResult(common, target, envelope)
        : { ...common, kind: "non_artifact" as const, artifactRevisionRefs: [] as [] };
    return {
      kind: "result_candidate",
      result: { ref: contentRef("result-candidate", resultBody), ...resultBody },
    };
  },
});

export function performTask(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function promotionResult(
  common: Omit<ResultCandidateProduct["result"], "ref" | "kind" | "artifactRevisionRefs">,
  target: Record<string, unknown>,
  envelope: Parameters<PhaseCodec<unknown>["decode"]>[1],
) {
  const promoted = envelope.operationResults.filter((result) => result.outcome === "promoted");
  if (promoted.length !== 1) {
    throw new Error("Promotion Execution requires one exact promotion receipt");
  }
  const result = promoted[0]!;
  if (!result.promotionRecords) {
    throw new Error("Promotion Execution requires its durable transaction journal records");
  }
  assertSameRef(result.promotionRecords.transaction.ref, result.transactionRef, "transaction");
  assertSameRef(
    result.promotionRecords.commitReceipt.ref,
    result.promotionReceiptRef,
    "promotion receipt",
  );
  assertSameRef(
    result.promotionRecords.promotedSnapshot.ref,
    result.promotedSnapshotRef,
    "promoted snapshot",
  );
  const closedJournal = result.promotionRecords.journals.at(-1);
  if (!closedJournal || closedJournal.state !== "closed") {
    throw new Error("Promotion Execution requires a closed forward journal");
  }
  return {
    ...common,
    kind: "repository_promotion" as const,
    authorizationRef: requireContentRef(target.authorizationRef, "authorizationRef"),
    transactionRef: requireContentRef(result.transactionRef, "transactionRef"),
    commitJournalRef: requireContentRef(result.commitJournalRef, "commitJournalRef"),
    promotionReceiptRef: requireContentRef(result.promotionReceiptRef, "promotionReceiptRef"),
    promotedSnapshotRef: requireContentRef(result.promotedSnapshotRef, "promotedSnapshotRef"),
    promotionRecords: result.promotionRecords,
    artifactRevisionRefs: [] as ContentRef[],
  };
}

function assertSameRef(
  actual: { id: string; sha256: string },
  expected: unknown,
  label: string,
): void {
  const ref = requireContentRef(expected, label);
  if (actual.id !== ref.id || actual.sha256 !== ref.sha256) {
    throw new Error(`Promotion ${label} record does not match its operation receipt`);
  }
}

function workspaceResult(
  common: Omit<ResultCandidateProduct["result"], "ref" | "kind" | "artifactRevisionRefs">,
  target: Record<string, unknown>,
  envelope: Parameters<PhaseCodec<unknown>["decode"]>[1],
) {
  const workspaceRef = requireContentRef(target.workspaceRef, "workspaceRef");
  const workspaceActions = envelope.operationResults.filter(
    (result) =>
      (result.outcome === "observed" || result.outcome === "workspace_artifact_applied") &&
      result.request.kind === "workspace_artifact_action" &&
      sameContentRef(result.request.workspaceRef, workspaceRef) &&
      result.targetSnapshotRef,
  );
  if (workspaceActions.length === 0) {
    throw new Error(
      "Workspace artifact Execution requires a successful snapshot-bearing workspace action",
    );
  }
  const applied = workspaceActions.filter(
    (result) => result.outcome === "workspace_artifact_applied",
  );
  const artifactRevisionRefs = applied.map((result, index) =>
    requireContentRef(result.artifactRevisionRef, `artifactRevisionRef[${index}]`));
  const targetSnapshotRef = requireContentRef(
    workspaceActions.at(-1)!.targetSnapshotRef,
    "targetSnapshotRef",
  );
  const body = {
    workspaceRef,
    producingWorkRef: common.workRef,
    producingTaskRef: common.taskRef,
    producingAttemptRef: common.attemptRef,
    baseAcceptedRevisionRefs: requireContentRefs(
      target.acceptedBaseRevisionRefs,
      "acceptedBaseRevisionRefs",
    ),
    artifactRevisionRefs,
    targetSnapshotRef,
    producedByOperationRefs: workspaceActions.map((result) => result.observationRef),
  };
  const revision: WorkspaceRevision = {
    ref: contentRef("workspace-revision", body), ...body,
  };
  return {
    ...common,
    kind: "workspace_artifact" as const,
    workspaceRef,
    workspaceRevisionRef: revision.ref,
    workspaceRevision: revision,
    artifactRevisionRefs,
  };
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function targetStateRevisions(
  results: OperationResultProjection[],
): TargetStateRevision[] {
  return results.flatMap((result) => {
    if (result.outcome === "operation_rejected" || isResultReadRequest(result.request)) return [];
    const target = targetOf(result);
    if (!target) return [];
    const body = {
      target,
      operationResultRef: result.resultRef,
      observationRef: result.observationRef,
      outcome: result.outcome,
      ...(result.targetSnapshotRef ? { targetSnapshotRef: result.targetSnapshotRef } : {}),
    };
    return [{ ref: contentRef("target-state-revision", body), ...body }];
  });
}

function targetOf(result: OperationResultProjection): TargetStateRevision["target"] | null {
  const request = result.request;
  if (request.kind === "observe") {
    return { kind: "scope", scopeRef: request.scopeRef };
  }
  if (
    request.kind === "workspace_artifact_action" ||
    request.kind === "workspace_artifact_observation"
  ) {
    return { kind: "workspace", workspaceRef: request.workspaceRef };
  }
  if (request.kind === "repository_promotion") {
    return { kind: "repository", finalSnapshotRef: request.finalSnapshotRef };
  }
  return null;
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    sha256: requireString(record.sha256, `${label}.sha256`),
  };
}

function requireContentRefs(value: unknown, label: string): ContentRef[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requireContentRef(item, `${label}[${index}]`));
}
