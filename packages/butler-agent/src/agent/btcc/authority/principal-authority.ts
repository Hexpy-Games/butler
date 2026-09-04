import type {
  AuthorityAbandonedWorkCloseInput,
  AuthorityDecisionAction,
  AuthorityDecisionResult,
  AuthorityOperationalCloseInput,
  AuthorityOperationalCloseResult,
  AuthorityOutcomeInput,
  AuthorityRecord,
  AuthorityRequestProjection,
  AuthorityStoredExecution,
  PrincipalAuthority,
  PrincipalAuthorityRepository,
} from "./contracts.ts";
import { authorityProjection } from "./admission-projection.ts";
import { admitAuthorityRequest } from "./authority-request-admission.ts";
import { AuthorityRequestError } from "./authority-request-error.ts";
import { parseAuthorityOutcomeReceipt } from "./outcome-receipt.ts";
import {
  canonicalJson,
} from "./request-identity.ts";

const MAX_ALTERNATIVE_INPUT_BYTES = 16 * 1024;

export function createPrincipalAuthority(
  repository: PrincipalAuthorityRepository,
): PrincipalAuthority {
  return {
    admit(input) {
      return admitAuthorityRequest(repository, input);
    },

    list(input): AuthorityRequestProjection[] {
      return repository.listPending(input.ownerSessionId).map(authorityProjection);
    },

    decide(input): AuthorityDecisionResult {
      const alternativeInput = input.action === "modify"
        ? requiredAlternative(input.alternativeInput ?? "")
        : undefined;
      const current = repository.findByPublicRef(input.requestRef);
      if (!current || current.ownerSessionId !== input.ownerSessionId ||
          (input.sourceSessionId !== undefined &&
            current.sourceSessionId !== input.sourceSessionId) ||
          !repository.isSourceWorkEligible({
            sourceSessionId: current.sourceSessionId,
            sourceWorkId: current.sourceWorkId,
          })) {
        throw new AuthorityRequestError("authority_request_not_found");
      }
      if (current.decision !== "pending") {
        if (sameDecision(current, input.action, alternativeInput)) {
          return decisionResult(current);
        }
        throw new AuthorityRequestError(
          input.action === "modify" && current.decision === "modified"
            ? "authority_modify_identity_mismatch"
            : "authority_decision_conflict",
        );
      }
      const decided = repository.decide({
        requestRef: input.requestRef,
        ownerSessionId: input.ownerSessionId,
        sourceSessionId: current.sourceSessionId,
        action: input.action,
        ...(alternativeInput ? { alternativeInput } : {}),
        now: new Date().toISOString(),
      });
      if (!decided) {
        const raced = repository.findByPublicRef(input.requestRef);
        if (raced && sameDecision(raced, input.action, alternativeInput)) {
          return decisionResult(raced);
        }
        throw new AuthorityRequestError("authority_decision_conflict");
      }
      return decisionResult(decided);
    },

    listDecided(): AuthorityDecisionResult[] {
      return repository.listDecided().map(decisionResult);
    },

    execution(input): AuthorityStoredExecution {
      const record = repository.findByPublicRef(input.requestRef);
      if (!record || record.ownerSessionId !== input.ownerSessionId ||
          !input.sourceSessionId || !input.clientMessageId ||
          record.sourceSessionId !== input.sourceSessionId ||
          record.scheduleClientMessageId !== input.clientMessageId) {
        throw new AuthorityRequestError("authority_request_not_found");
      }
      if (record.decision !== "allowed" && record.decision !== "denied" &&
          record.decision !== "modified") {
        throw new AuthorityRequestError("authority_request_not_allowed");
      }
      if (record.sourceTurnId === input.turnId) {
        throw new AuthorityRequestError("authority_schedule_turn_mismatch");
      }
      if (record.decision === "modified" &&
          !record.privateAlternativeInput?.trim()) {
        throw new AuthorityRequestError("authority_request_corrupt");
      }
      let normalizedInput: AuthorityStoredExecution["normalizedInput"];
      try {
        normalizedInput = JSON.parse(record.normalizedInputJson) as AuthorityStoredExecution["normalizedInput"];
      } catch {
        throw new AuthorityRequestError("authority_request_corrupt");
      }
      const outcomeReceipt = record.outcomeReceiptJson === null
        ? undefined : parseAuthorityOutcomeReceipt(record.outcomeReceiptJson);
      if (record.outcomeReceiptJson !== null && !outcomeReceipt) {
        throw new AuthorityRequestError("authority_request_corrupt");
      }
      return {
        requestRef: record.requestRef,
        sourceSessionId: record.sourceSessionId,
        sourceTurnId: record.sourceTurnId,
        sourceWorkId: record.sourceWorkId,
        workspacePath: record.workspacePath,
        planRevisionId: record.planRevisionId,
        actionKey: record.actionKey,
        authorityGeneration: record.authorityGeneration,
        capability: record.capability,
        normalizedTarget: record.normalizedTarget,
        category: record.category,
        normalizedInput,
        decision: record.decision,
        ...(record.privateAlternativeInput
          ? { alternativeInput: record.privateAlternativeInput }
          : {}),
        outcome: record.outcome,
        ...(outcomeReceipt ? { outcomeReceipt } : {}),
      };
    },

    recordOutcome(input: AuthorityOutcomeInput): void {
      const record = repository.findByPublicRef(input.requestRef);
      if (!record || record.ownerSessionId !== input.ownerSessionId ||
          record.sourceWorkId !== input.sourceWorkId) {
        throw new AuthorityRequestError("authority_outcome_identity_mismatch");
      }
      repository.recordOutcome({
        requestRef: input.requestRef,
        sourceWorkId: input.sourceWorkId,
        status: input.status,
        ...(input.receipt === undefined ? {} : { receiptJson: canonicalJson(input.receipt) }),
        now: new Date().toISOString(),
      });
    },

    closeSelfSession(
      input: AuthorityOperationalCloseInput,
    ): AuthorityOperationalCloseResult {
      const selfSessionId = required(input.selfSessionId, "self session");
      const closedCount = repository.closePendingSelfSessionRequests({
        selfSessionId,
        reason: input.reason,
        scope: "self_session",
        now: new Date().toISOString(),
      });
      return { scope: "self_session", reason: input.reason, closedCount };
    },

    closeAbandonedWork(
      input: AuthorityAbandonedWorkCloseInput,
    ): AuthorityOperationalCloseResult {
      const sourceWorkId = required(input.sourceWorkId, "source Work");
      const closedCount = repository.closePendingSourceWorkRequests({
        sourceWorkId,
        reason: input.reason,
        scope: "work",
        now: new Date().toISOString(),
      });
      return { scope: "work", reason: input.reason, closedCount };
    },
  };
}

function decisionResult(record: AuthorityRecord): AuthorityDecisionResult {
  if (record.decision === "pending") {
    throw new AuthorityRequestError("authority_request_not_decided");
  }
  return {
    requestRef: record.requestRef,
    sourceSessionId: record.sourceSessionId,
    sourceWorkId: record.sourceWorkId,
    scheduleClientMessageId: record.scheduleClientMessageId,
    scheduleInputText: record.scheduleInputText,
    modelRef: record.modelRef,
    reasoningEffort: record.reasoningEffort,
    decision: record.decision,
  };
}

function sameDecision(
  record: AuthorityRecord,
  action: AuthorityDecisionAction,
  alternativeInput: string | undefined,
): boolean {
  const expected = action === "allow" ? "allowed" : action === "deny" ? "denied" : "modified";
  return record.decision === expected &&
    (action !== "modify" || record.privateAlternativeInput === alternativeInput);
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new AuthorityRequestError(`authority_${label.replace(/\s+/gu, "_")}_missing`);
  return value;
}

function requiredAlternative(value: string): string {
  if (!value.trim()) throw new AuthorityRequestError("authority_modify_input_missing");
  if (Buffer.byteLength(value, "utf8") > MAX_ALTERNATIVE_INPUT_BYTES) {
    throw new AuthorityRequestError("authority_modify_input_too_large");
  }
  return value;
}
