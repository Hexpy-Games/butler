import type { GuidedEffectError } from "../effects/index.ts";

export type AuthorityCategory = "command";
export type AuthorityDecision = "pending" | "allowed" | "denied" | "modified";
export type AuthorityOutcome = "pending" | "applied" | "failed" | "uncertain";
export type AuthorityDecisionAction = "allow" | "deny" | "modify";

/** Fixed safe projection for a terminal self-session Deny decision. */
export const AUTHORITY_DENIAL_TEXT =
  "Reviewed command denied. No command was run." as const;

export type AuthorityCommandInput = {
  command: string;
  cwd: string;
  state_effect: "mutation" | "remote_observation";
  timeout_ms?: number;
  max_output_tokens?: number;
  output_paths?: string[];
  output_mode?: "auto" | "silent_on_success" | "full";
};

export type AuthorityAdmissionInput = {
  ownerSessionId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceWorkId: string;
  workspacePath: string;
  planRevisionId: string;
  actionKey: string;
  authorityGeneration: number;
  capability: string;
  target: string;
  normalizedInput: AuthorityCommandInput;
  modelRef: string;
  reasoningEffort: string;
};

export type AuthorityRequestProjection = {
  request_ref: string;
  category: AuthorityCategory;
  reason: string;
  executable: string;
  command_count?: number;
};

export type AuthorityAdmissionResult =
  | {
      status: "pending";
      requestRef: string;
      projection: AuthorityRequestProjection;
    }
  | {
      status: "allowed";
      requestRef: string;
      sourceWorkId: string;
      normalizedTarget: string;
      normalizedInput: AuthorityCommandInput;
    }
  | {
      status: "denied";
      requestRef: string;
      denialText: typeof AUTHORITY_DENIAL_TEXT;
    }
  | {
      status: "modified";
      requestRef: string;
      replacementPending: true;
    };

export type AuthorityDecisionResult = {
  requestRef: string;
  sourceSessionId: string;
  sourceWorkId: string;
  scheduleClientMessageId: string;
  scheduleInputText: string;
  modelRef: string;
  reasoningEffort: string;
  decision: Exclude<AuthorityDecision, "pending">;
};

/**
 * Bounded, opaque receipt for a terminal authority outcome.
 * Carries only reconciliation pointers; never command, input, output, or path data.
 */
export type AuthorityOutcomeReceipt =
  | {
      schema: "butler.authority-outcome-receipt.v1";
      outcome: "applied";
      evidenceRef: string;
      journalEffectId: string;
      dispatchAttempt: number;
    }
  | {
      schema: "butler.authority-outcome-receipt.v1";
      outcome: "uncertain";
      evidenceRef: string;
      journalEffectId: string;
      dispatchAttempt: number;
      errorCode: GuidedEffectError["code"];
    };

export type AuthorityStoredExecution = {
  requestRef: string;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceWorkId: string;
  workspacePath: string;
  planRevisionId: string;
  actionKey: string;
  authorityGeneration: number;
  capability: string;
  normalizedTarget: string;
  normalizedInput: AuthorityCommandInput;
  decision: "allowed" | "denied" | "modified";
  alternativeInput?: string;
  outcome: AuthorityOutcome;
  outcomeReceipt?: AuthorityOutcomeReceipt;
};

export type AuthorityOutcomeInput =
  | {
      requestRef: string;
      ownerSessionId: string;
      sourceWorkId: string;
      status: "applied";
      receipt: Extract<AuthorityOutcomeReceipt, { outcome: "applied" }>;
    }
  | {
      requestRef: string;
      ownerSessionId: string;
      sourceWorkId: string;
      status: "uncertain";
      receipt: Extract<AuthorityOutcomeReceipt, { outcome: "uncertain" }>;
    }
  | {
      requestRef: string;
      ownerSessionId: string;
      sourceWorkId: string;
      status: "failed";
      receipt?: never;
    };

export interface PrincipalAuthorityRepository {
  findByIdentity(identitySha256: string): AuthorityRecord | null;
  findBySlot(input: {
    sourceWorkId: string;
    planRevisionId: string;
    actionKey: string;
    capability: string;
    authorityGeneration: number;
  }): AuthorityRecord | null;
  insert(record: AuthorityRecord): void;
  findByPublicRef(requestRef: string): AuthorityRecord | null;
  listPending(ownerSessionId: string): AuthorityRecord[];
  listDecided(): AuthorityRecord[];
  isSourceWorkEligible(input: {
    sourceSessionId: string;
    sourceWorkId: string;
  }): boolean;
  decide(input: {
    requestRef: string;
    ownerSessionId: string;
    sourceSessionId: string;
    action: AuthorityDecisionAction;
    alternativeInput?: string;
    now: string;
  }): AuthorityRecord | null;
  recordOutcome(input: {
    requestRef: string;
    sourceWorkId: string;
    status: "applied" | "failed" | "uncertain";
    receiptJson?: string;
    now: string;
  }): AuthorityRecord | null;
}

export type AuthorityRecord = {
  requestId: string;
  requestRef: string;
  identitySha256: string;
  ownerSessionId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceWorkId: string;
  workspacePath: string;
  planRevisionId: string;
  actionKey: string;
  authorityGeneration: number;
  capability: string;
  normalizedTarget: string;
  normalizedInputJson: string;
  modelRef: string;
  reasoningEffort: string;
  category: AuthorityCategory;
  reason: string;
  executable: string;
  commandCount: number;
  decision: AuthorityDecision;
  scheduleClientMessageId: string;
  scheduleInputText: string;
  privateAlternativeInput: string | null;
  outcome: AuthorityOutcome;
  outcomeReceiptJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface PrincipalAuthority {
  admit(input: AuthorityAdmissionInput): AuthorityAdmissionResult;
  list(input: { ownerSessionId: string }): AuthorityRequestProjection[];
  decide(input: {
    ownerSessionId: string;
    requestRef: string;
    sourceSessionId: string;
    action: AuthorityDecisionAction;
    alternativeInput?: string;
  }): AuthorityDecisionResult;
  listDecided(): AuthorityDecisionResult[];
  execution(input: {
    ownerSessionId: string;
    requestRef: string;
    /** Optional only for legacy projection readers; execution fails closed when absent. */
    sourceSessionId?: string;
    /** Optional only for legacy projection readers; execution fails closed when absent. */
    clientMessageId?: string;
    turnId: string;
  }): AuthorityStoredExecution;
  recordOutcome(input: AuthorityOutcomeInput): void;
}
