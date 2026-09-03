import { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import { digest } from "../identity/index.ts";
import { subsessionResultId } from "./identities.ts";
import { normalizeTerminalReportContent } from "./terminal-results.ts";
import { parentSubsessionIsTerminal } from "./outbox-recovery.ts";
import type {
  CompleteStewardResultOutcome,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";

export function hasQueuedWorkerResult(
  store: SubsessionDelegationDependencies["store"],
  queue: NativeInboundQueue,
  input: { parentSessionId: string; parentTurnId: string },
): boolean {
  return store.relationsByParentSessionId(input.parentSessionId).some((relation) => {
    const result = store.resultByRelationId(relation.relation_id);
    return Boolean(result && workerResultTurnId(result.result_id) !== input.parentTurnId &&
      queue.hasPendingOrProcessingEvent(`worker-result:${result.result_id}`));
  });
}

function workerResultTurnId(resultId: string): string {
  return `steward-worker-result-${digest(resultId).slice(0, 32)}`;
}

export async function completeWorkerResultForDependencies(
  input: SubsessionDelegationDependencies,
  queue: NativeInboundQueue,
  resultInput: Parameters<SubsessionDelegationService["completeWorkerResult"]>[0],
): Promise<CompleteStewardResultOutcome> {
  const relation = input.store.relationByChildSessionId(resultInput.childSessionId);
  if (!relation) throw new Error("worker_relation_missing");
  const childTurnId = input.store.childTurnIdByRelationId(relation.relation_id);
  if (!childTurnId || childTurnId !== resultInput.childTurnId) {
    throw new Error("worker_turn_identity_mismatch");
  }
  const expectedResultId = subsessionResultId(relation.child_session_id, childTurnId);
  if (resultInput.resultId !== expectedResultId) throw new Error("worker_result_identity_mismatch");
  const packet = input.store.packetByRelationId(relation.relation_id);
  const parent = input.sessionBindings.getBySessionId(relation.parent_session_id);
  if (!packet || !parent || parent.role !== "steward") {
    throw new Error("worker_parent_steward_missing");
  }
  const existing = input.store.resultByRelationId(relation.relation_id);
  if (resultInput.status === "cancelled") {
    await input.durableWork.abandonBoundWorkForTurn(childTurnId);
  }
  if (existing) {
    const pending = input.store.pendingParentInputForResult(existing.result_id);
    if (pending && !parentSubsessionIsTerminal(input.store, relation.parent_session_id)) {
      await enqueueWorkerReport(input, queue, relation.parent_session_id, parent.workspacePath,
        parent.projectId, parent.modelRef, parent.metadata?.reasoning_effort,
        existing, pending.text);
      input.store.markParentInputDelivered(existing.result_id);
    }
    return { status: "duplicate", result: existing };
  }
  const status = resultInput.status ?? "success";
  const summary = safeWorkerSummary(resultInput.summary, status);
  const committed = input.store.commitResult({
    relation,
    childTurnId,
    resultId: expectedResultId,
    taskId: packet.task_id,
    modelRef: packet.model_ref,
    reasoningEffort: packet.reasoning_effort,
    status,
    code: resultInput.code ?? (status === "success" ? null : "steward_execution_failed"),
    summary,
    acceptanceEvidence: [],
    changedArtifacts: resultInput.changedArtifacts ?? [],
    changedFiles: resultInput.changedFiles ?? [],
    commits: [],
    tests: [],
    remainingRisks: [],
    followUpRecommendations: [],
    detailRefs: [],
    parentChatId: relation.parent_session_id,
  });
  if (!parentSubsessionIsTerminal(input.store, relation.parent_session_id)) {
    await enqueueWorkerReport(input, queue, relation.parent_session_id, parent.workspacePath,
      parent.projectId, parent.modelRef, parent.metadata?.reasoning_effort,
      committed.result, committed.parentInput.text);
  }
  input.store.markParentInputDelivered(committed.result.result_id);
  return {
    status: committed.inserted ? "committed" : "duplicate",
    result: committed.result,
  };
}

async function enqueueWorkerReport(
  input: SubsessionDelegationDependencies,
  queue: NativeInboundQueue,
  stewardSessionId: string,
  workspacePath: string,
  projectId: string | undefined,
  modelRef: string,
  reasoningEffort: unknown,
  result: CompleteStewardResultOutcome["result"],
  parentInputText: string,
): Promise<void> {
  const turnId = workerResultTurnId(result.result_id);
  queue.enqueueIdempotent({
    eventId: `worker-result:${result.result_id}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: stewardSessionId },
    sender: { id: "butler-worker-result", displayName: "Worker" },
    message: {
      id: `worker-result-message:${result.result_id}`,
      text: parentInputText,
      timestamp: result.created_at,
    },
    routingHints: { sessionId: stewardSessionId, turnId },
    nativeStewardContext: {
      version: 1,
      role: "steward",
      projectName: projectId ?? "",
      workspacePath,
      modelRef: modelRef as `${string}/${string}`,
      ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
    },
    raw: { source: "btcc-worker-result" },
  });
}

function safeWorkerSummary(
  value: string | undefined,
  status: string,
): string {
  const safe = value ? normalizeTerminalReportContent(value) : "";
  if (safe) return safe;
  return status === "success"
    ? "Worker completed the bounded Task."
    : "Worker could not complete the bounded Task.";
}
