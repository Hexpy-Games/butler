import {
  isFactualCompletionFailure,
  validateStewardCompletion,
} from "./completion-evidence.ts";
import { resolveAcceptedStewardReport } from "./accepted-terminal-report.ts";
import { validateBlockedMutationEvidence } from "./mutation-completion-evidence.ts";
import { subsessionChildTurnId, subsessionResultId } from "./identities.ts";
import {
  completePacketContext,
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
  const expectedChildTurnId = subsessionChildTurnId(relation.relation_id);
  if (resultInput.childTurnId !== expectedChildTurnId) {
    throw new Error("subsession_child_turn_identity_mismatch");
  }
  const expectedResultId = subsessionResultId(relation.child_session_id, expectedChildTurnId);
  if (resultInput.resultId !== expectedResultId) throw new Error("subsession_result_identity_mismatch");

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
  const contextReady = packet !== null && completePacketContext(packet);
  let terminalStatus: StewardResultStatus = contextReady ? status : "blocked";
  let terminalCode: StewardResultCode | null = contextReady
    ? resultInput.code ?? defaultCode(status)
    : "delegation_context_incomplete";
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
  if (terminalStatus === "success") {
    const work = await input.durableWork.boundWorkForTurn(resultInput.childTurnId);
    if (work?.status === "blocked" || work?.latestDisposition?.disposition === "blocked") {
      // A Steward's durable Work disposition is the production authority for
      // a blocked outcome.  Do not leak its provider-authored explanation or
      // import the Worker-only task_needs_split code into this vertical.
      terminalStatus = "blocked";
      terminalCode = null;
      const partial = packet?.execution_mode === "mutation"
        ? await validateBlockedMutationEvidence({
            relation,
            packet,
            childTurnId: resultInput.childTurnId,
            sessionBindings: input.sessionBindings,
            durableWork: input.durableWork,
            rootWorkId: input.store.rootWorkIdByRelationId(relation.relation_id),
            toolJournal: input.toolJournal,
            effectJournal: input.effectJournal,
          }, work)
        : { acceptanceEvidence: [], changedArtifacts: [] };
      evidence = {
        summary: safeTerminalSummary("blocked", null),
        acceptanceEvidence: partial.acceptanceEvidence,
        changedArtifacts: partial.changedArtifacts,
        ...emptyReportDetails(partial.changedArtifacts.length > 0),
      };
    } else {
      try {
        const completion = await validateStewardCompletion({
          relation,
          packet: packet!,
          childTurnId: resultInput.childTurnId,
          sessionBindings: input.sessionBindings,
          durableWork: input.durableWork,
          rootWorkId: input.store.rootWorkIdByRelationId(relation.relation_id),
          toolJournal: input.toolJournal,
          effectJournal: input.effectJournal,
        });
        const report = await resolveAcceptedStewardReport({
          binding: {
            relationId: relation.relation_id,
            resultId: resultInput.resultId,
            childSessionId: relation.child_session_id,
            childTurnId: resultInput.childTurnId,
          },
          reportEvidenceAnchors: completion.reportEvidenceAnchors,
          ...(resultInput.summary !== undefined ? { reportedContent: resultInput.summary } : {}),
          turns: input.parentTurns,
        });
        evidence = {
          summary: report.summary,
          acceptanceEvidence: completion.acceptanceEvidence,
          changedArtifacts: completion.changedArtifacts,
          commits: report.commits,
          tests: report.tests,
          remainingRisks: report.remainingRisks,
          followUpRecommendations: report.followUpRecommendations,
          detailRefs: report.detailRefs,
        };
      } catch (error) {
        if (!isFactualCompletionFailure(error)) throw error;
        terminalStatus = "failed";
        terminalCode = "steward_execution_failed";
        evidence = {
          summary: safeTerminalSummary("failed", terminalCode),
          acceptanceEvidence: [],
          changedArtifacts: [],
          ...emptyReportDetails(),
        };
      }
    }
  } else {
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
  if (packet && contextReady && packet.task_id !== taskId) {
    throw new Error("subsession_task_identity_mismatch");
  }

  const result = input.store.commitResult({
    relation,
    packet,
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

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptyReportDetails(preservedPartialMutation = false) {
  return {
    commits: [] as string[],
    tests: [] as string[],
    remainingRisks: preservedPartialMutation
      ? ["The delegated Work stopped before completion; review the preserved partial changes before applying them."]
      : [] as string[],
    followUpRecommendations: [] as string[],
    detailRefs: [] as string[],
  };
}
