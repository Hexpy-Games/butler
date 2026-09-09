import type {
  AuthorityAdmissionInput,
  AuthorityAdmissionResult,
  AuthorityRecord,
  PrincipalAuthorityRepository,
} from "./contracts.ts";
import { admissionResult } from "./admission-projection.ts";
import { AuthorityRequestError } from "./authority-request-error.ts";
import { permissionForAdmission } from "./conversation-permission.ts";
import {
  canonicalJson,
  deterministicClientMessageId,
  digest,
} from "./request-identity.ts";

const ALLOW_SCHEDULE_INPUT_TEXT = "Continue the approved operation exactly once.";

export function admitAuthorityRequest(
  repository: PrincipalAuthorityRepository,
  input: AuthorityAdmissionInput,
): AuthorityAdmissionResult {
  let authorityGeneration = input.authorityGeneration;
  let identitySha256: string;
  while (true) {
    identitySha256 = authorityIdentity(input, authorityGeneration);
    const existing = repository.findByIdentity(identitySha256);
    if (existing) {
      assertNotOperationallyClosed(existing);
      return admissionResult(existing);
    }
    if (repository.hasConversationPermission(permissionForAdmission(input).grantRef)) return { status: "granted" };
    const slot = repository.findBySlot({
      sourceWorkId: input.sourceWorkId,
      planRevisionId: input.planRevisionId,
      actionKey: input.actionKey,
      capability: input.capability,
      authorityGeneration,
    });
    if (!slot) break;
    if (!authoritySlotIsTerminal(slot)) {
      throw new AuthorityRequestError("authority_slot_identity_mismatch");
    }
    authorityGeneration += 1;
  }
  const now = new Date().toISOString();
  const requestId = `authority-${crypto.randomUUID()}`;
  const requestRef = `authority-ref-${
    digest(`${requestId}\0${identitySha256}`).slice(0, 32)
  }`;
  const reviewedEffect = input.category === "reviewed_effect";
  const category = reviewedEffect ? "reviewed_effect" : "command";
  const record: AuthorityRecord = {
    requestId,
    requestRef,
    identitySha256,
    ownerSessionId: required(input.ownerSessionId, "owner session"),
    sourceSessionId: required(input.sourceSessionId, "source session"),
    sourceTurnId: required(input.sourceTurnId, "source Turn"),
    ...(input.operationOccurrenceId ? { sourceCallId: input.operationOccurrenceId } : {}),
    sourceWorkId: required(input.sourceWorkId, "source Work"),
    workspacePath: required(input.workspacePath, "workspace"),
    planRevisionId: required(input.planRevisionId, "Plan revision"),
    actionKey: required(input.actionKey, "action"),
    authorityGeneration,
    capability: required(input.capability, "capability"),
    normalizedTarget: required(input.target, "target"),
    normalizedInputJson: canonicalJson(input.normalizedInput),
    modelRef: required(input.modelRef, "model"),
    reasoningEffort: required(input.reasoningEffort, "reasoning effort"),
    category,
    reason: input.publicActionTitle || (reviewedEffect ? "Apply one reviewed effect" : "Run one reviewed command"),
    executable: reviewedEffect
      ? required(input.capability, "capability").slice(0, 96)
      : firstExecutable(input.normalizedInput.command),
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
}

function authorityIdentity(
  input: AuthorityAdmissionInput,
  authorityGeneration: number,
): string {
  const commonIdentity = {
    version: 1,
    ownerSessionId: input.ownerSessionId,
    sourceSessionId: input.sourceSessionId,
    sourceTurnId: input.sourceTurnId,
    sourceWorkId: input.sourceWorkId,
    workspacePath: input.workspacePath,
    planRevisionId: input.planRevisionId,
    actionKey: input.actionKey,
    authorityGeneration,
    capability: input.capability,
    target: input.target,
    normalizedInput: input.normalizedInput,
    ...(input.operationOccurrenceId ? { operationOccurrenceId: input.operationOccurrenceId } : {}),
  };
  return digest(canonicalJson(reviewedEffectIdentity(input, commonIdentity)));
}

function reviewedEffectIdentity(
  input: AuthorityAdmissionInput,
  commonIdentity: Record<string, unknown>,
): Record<string, unknown> {
  if (input.category !== "reviewed_effect") return commonIdentity;
  return {
    ...commonIdentity,
    version: 2,
    category: input.category,
    operationOccurrenceId: required(
      input.operationOccurrenceId,
      "operation occurrence",
    ),
  };
}

function authoritySlotIsTerminal(record: AuthorityRecord): boolean {
  return record.closeReason !== null || record.decision === "denied" || record.decision === "modified" ||
    record.outcome !== "pending";
}

function assertNotOperationallyClosed(record: AuthorityRecord): void {
  if (record.decision === "pending" && record.closeReason !== null) {
    throw new AuthorityRequestError("authority_request_operationally_closed");
  }
}

function required(value: string, label: string): string {
  if (!value.trim()) {
    throw new AuthorityRequestError(
      `authority_${label.replace(/\s+/gu, "_")}_missing`,
    );
  }
  return value;
}

function firstExecutable(command: string): string {
  const tokens = shellWords(command);
  if (!tokens) return "command";
  let index = 0;
  while (index < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) index += 1;
  const token = tokens[index];
  if (!token || !/^[A-Za-z0-9_./-]+$/u.test(token) || token.startsWith("$") ||
      token.startsWith("-")) return "command";
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
