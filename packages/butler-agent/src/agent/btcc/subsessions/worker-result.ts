import { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import { digest } from "../identity/index.ts";
import { subsessionResultId } from "./identities.ts";
import { boundedTerminalReportContent } from "./terminal-results.ts";
import { parentSubsessionIsTerminal } from "./outbox-recovery.ts";
import type {
  CompleteStewardResultOutcome,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";

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
  if (existing) {
    if (!parentSubsessionIsTerminal(input.store, relation.parent_session_id)) {
      await enqueueWorkerReport(input, queue, relation.parent_session_id, parent.workspacePath,
        parent.projectId, parent.modelRef, parent.metadata?.reasoning_effort,
        packet.parent_work_ref.work_id, existing);
    }
    input.store.markParentInputDelivered(existing.result_id);
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
      packet.parent_work_ref.work_id, committed.result);
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
  workId: string,
  result: CompleteStewardResultOutcome["result"],
): Promise<void> {
  const turnId = `steward-worker-result-${digest(result.result_id).slice(0, 32)}`;
  const work = await input.durableWork.bindOpenWork({
    turnId,
    sessionId: stewardSessionId,
    ...(projectId ? { projectRef: projectId } : {}),
  }, workId);
  if (!work || work.workId !== workId) throw new Error("worker_parent_work_missing");
  queue.enqueueIdempotent({
    eventId: `worker-result:${result.result_id}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: stewardSessionId },
    sender: { id: "butler-worker-result", displayName: "Worker" },
    message: {
      id: `worker-result-message:${result.result_id}`,
      text: [
        "Worker report for the current Steward Plan action.",
        `Status: ${result.status}`,
        `Summary: ${result.summary}`,
        `Changed artifacts: ${result.changed_artifacts.join("; ") || "none"}`,
        "Integrate this result, review and validate the whole delegated Work, correct it if needed, then report once to Butler.",
      ].join("\n"),
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
  const safe = value ? boundedTerminalReportContent(value) : "";
  if (safe) return safe;
  return status === "success"
    ? "Worker completed the bounded Task."
    : "Worker could not complete the bounded Task.";
}
