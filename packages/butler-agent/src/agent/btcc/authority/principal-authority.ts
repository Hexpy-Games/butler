import { createHash } from "node:crypto";
import type {
  AuthorityDecisionAction,
  AuthorityDecisionResult,
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

const ALLOW_SCHEDULE_INPUT_TEXT = "Continue the approved operation exactly once.";
const MAX_ALTERNATIVE_INPUT_BYTES = 16 * 1024;

export function createPrincipalAuthority(
  repository: PrincipalAuthorityRepository,
): PrincipalAuthority {
  return {
    admit(input) {
      const identitySha256 = digest(canonicalJson({
        version: 1,
        ownerSessionId: input.ownerSessionId,
        sourceSessionId: input.sourceSessionId,
        sourceTurnId: input.sourceTurnId,
        sourceWorkId: input.sourceWorkId,
        workspacePath: input.workspacePath,
        planRevisionId: input.planRevisionId,
        actionKey: input.actionKey,
        authorityGeneration: input.authorityGeneration,
        capability: input.capability,
        target: input.target,
        normalizedInput: input.normalizedInput,
      }));
      const existing = repository.findByIdentity(identitySha256);
      if (existing) return admissionResult(existing);
      const slot = repository.findBySlot({
        sourceWorkId: input.sourceWorkId,
        planRevisionId: input.planRevisionId,
        actionKey: input.actionKey,
        capability: input.capability,
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
        createdAt: now,
        updatedAt: now,
      };
      repository.insert(record);
      const stored = repository.findByIdentity(identitySha256);
      if (!stored || stored.identitySha256 !== identitySha256) {
        throw new AuthorityRequestError("authority_request_insert_conflict");
      }
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
  };
}

export class AuthorityRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuthorityRequestError";
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

function deterministicClientMessageId(requestId: string): string {
  const value = digest(`authority-queue\0${requestId}`).slice(0, 32);
  return `client-${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
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
  const expected = action === "allow"
    ? "allowed"
    : action === "deny"
      ? "denied"
      : "modified";
  return record.decision === expected &&
    (action !== "modify" || record.privateAlternativeInput === alternativeInput);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
