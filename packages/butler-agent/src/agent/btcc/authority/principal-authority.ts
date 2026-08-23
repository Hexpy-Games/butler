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
import {
  admissionResult,
  authorityProjection,
} from "./admission-projection.ts";
import { parseAuthorityOutcomeReceipt } from "./outcome-receipt.ts";
import {
  canonicalJson,
  deterministicClientMessageId,
  digest,
} from "./request-identity.ts";

const ALLOW_SCHEDULE_INPUT_TEXT = "Continue the approved operation exactly once.";
const MAX_ALTERNATIVE_INPUT_BYTES = 16 * 1024;

export function createPrincipalAuthority(
  repository: PrincipalAuthorityRepository,
): PrincipalAuthority {
  return {
    admit(input) {
      const identitySha256 = digest(canonicalJson({
        version: 1,
        ownerSessionId: input.ownerSessionId, sourceSessionId: input.sourceSessionId,
        sourceTurnId: input.sourceTurnId, sourceWorkId: input.sourceWorkId,
        workspacePath: input.workspacePath, planRevisionId: input.planRevisionId,
        actionKey: input.actionKey, authorityGeneration: input.authorityGeneration,
        capability: input.capability, target: input.target,
        normalizedInput: input.normalizedInput,
      }));
      const existing = repository.findByIdentity(identitySha256);
      if (existing) {
        assertNotOperationallyClosed(existing);
        return admissionResult(existing);
      }
      const slot = repository.findBySlot({
        sourceWorkId: input.sourceWorkId, planRevisionId: input.planRevisionId,
        actionKey: input.actionKey, capability: input.capability,
        authorityGeneration: input.authorityGeneration,
      });
      if (slot) {
        throw new AuthorityRequestError("authority_slot_identity_mismatch");
      }
      const now = new Date().toISOString();
      const requestId = `authority-${crypto.randomUUID()}`;
      const requestRef = `authority-ref-${digest(`${requestId}\0${identitySha256}`).slice(0, 32)}`;
      const record: AuthorityRecord = {
        requestId,
        requestRef,
        identitySha256,
        ownerSessionId: required(input.ownerSessionId, "owner session"),
        sourceSessionId: required(input.sourceSessionId, "source session"),
        sourceTurnId: required(input.sourceTurnId, "source Turn"),
        sourceWorkId: required(input.sourceWorkId, "source Work"),
        workspacePath: required(input.workspacePath, "workspace"),
        planRevisionId: required(input.planRevisionId, "Plan revision"),
        actionKey: required(input.actionKey, "action"),
        authorityGeneration: input.authorityGeneration,
        capability: required(input.capability, "capability"),
        normalizedTarget: required(input.target, "target"),
        normalizedInputJson: canonicalJson(input.normalizedInput),
        modelRef: required(input.modelRef, "model"),
        reasoningEffort: required(input.reasoningEffort, "reasoning effort"),
        category: "command",
        reason: "Run one reviewed command",
        executable: firstExecutable(input.normalizedInput.command),
        commandCount: 1,
        decision: "pending",
        scheduleClientMessageId: deterministicClientMessageId(requestId),
        scheduleInputText: ALLOW_SCHEDULE_INPUT_TEXT,
        privateAlternativeInput: null,
        outcome: "pending",
        outcomeReceiptJson: null,
        closeReason: null,
        closeScope: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      repository.insert(record);
      const stored = repository.findByIdentity(identitySha256);
      if (!stored || stored.identitySha256 !== identitySha256) {
        throw new AuthorityRequestError("authority_request_insert_conflict");
      }
      assertNotOperationallyClosed(stored);
      return admissionResult(stored);
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
          current.sourceSessionId !== input.sourceSessionId ||
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
        sourceSessionId: input.sourceSessionId,
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

export class AuthorityRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuthorityRequestError";
  }
}

function assertNotOperationallyClosed(record: AuthorityRecord): void {
  if (record.decision === "pending" && record.closeReason !== null) {
    throw new AuthorityRequestError("authority_request_operationally_closed");
  }
}

function firstExecutable(command: string): string {
  const tokens = shellWords(command);
  if (!tokens) return "command";
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) index += 1;
  const token = tokens[index];
  if (!token || !/^[A-Za-z0-9_./-]+$/u.test(token) || token.startsWith("$") || token.startsWith("-")) return "command";
  const executable = token.split(/[\\/]/u).at(-1)?.trim() ?? "";
  return executable.slice(0, 96) || "command";
}

function shellWords(input: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of input.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped || quote) return null;
  if (started) words.push(word);
  return words;
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
