import type { GuidedEffectError } from "../effects/index.ts";

export type AuthorityCategory = "command";
export type AuthorityDecision = "pending" | "allowed" | "denied" | "modified";
export type AuthorityOutcome = "pending" | "applied" | "failed" | "uncertain";
export type AuthorityDecisionAction = "allow" | "deny" | "modify";

/**
 * Bounded typed reason for an operational (non-card) close of still-open
 * authority requests. Never a decision value and never a card Cancel.
 */
export type AuthorityOperationalCloseReason =
  | "session_archived"
  | "session_permanently_deleted"
  | "session_cancelled"
  | "work_abandoned";

/** Bounded scope of the operational close. */
export type AuthorityOperationalCloseScope = "self_session" | "work";

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

export type AuthorityOperationalCloseInput = {
  selfSessionId: string;
  reason: AuthorityOperationalCloseReason;
};

/** Typed input for the factual Work abandonment/supersession close. */
export type AuthorityAbandonedWorkCloseInput = {
  sourceWorkId: string;
  reason: Extract<AuthorityOperationalCloseReason, "work_abandoned">;
};

export type AuthorityOperationalCloseResult = {
  scope: AuthorityOperationalCloseScope;
  reason: AuthorityOperationalCloseReason;
  closedCount: number;
};

/**
 * Narrow durable capability for closing a factual Butler self-session's
 * still-open requests. Required by guided Turn-stop persistence so the close
 * runs inside the same SQLite transaction that cancels the Turn; the
 * production composition supplies its one PrincipalAuthority instance here.
 */
export type AuthoritySelfSessionCloseCapability = {
  closeSelfSession(
    input: AuthorityOperationalCloseInput,
  ): AuthorityOperationalCloseResult;
};

/**
 * Narrow durable capability for closing the still-open requests of exactly one
 * factually abandoned/superseded Work. Required by Guided Work abandonment so
 * the close runs inside the same SQLite transaction as the Work status
 * transition; the production composition supplies its one PrincipalAuthority
 * instance here. Guided Work never sees authority SQL through this port.
 */
export type AuthorityAbandonedWorkCloseCapability = {
  closeAbandonedWork(
    input: AuthorityAbandonedWorkCloseInput,
  ): AuthorityOperationalCloseResult;
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
  /**
   * Operational (non-decision) close of still-open requests whose factual
   * owning AND source session both equal the given Butler self-session.
   * This is not a descendant or subtree close: a row with a child source
   * session under this owner never matches. Mutually exclusive CAS with
   * `decide`: only decision-pending rows without an existing close audit win.
   */
  closePendingSelfSessionRequests(input: {
    selfSessionId: string;
    reason: AuthorityOperationalCloseReason;
    scope: AuthorityOperationalCloseScope;
    now: string;
  }): number;
  /**
   * Operational (non-decision) close of still-open requests whose exact
   * source_work_id equals the factually abandoned Work. This is never a
   * descendant, ancestor, sibling-subtree, or session-wide close: a request on
   * any other Work in the same owner session never matches. Mutually exclusive
   * CAS with `decide`: only decision-pending rows without an existing close
   * audit win; outcome stays 'pending' by the schema invariant.
   */
  closePendingSourceWorkRequests(input: {
    sourceWorkId: string;
    reason: AuthorityOperationalCloseReason;
    scope: AuthorityOperationalCloseScope;
    now: string;
  }): number;
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
  closeReason: AuthorityOperationalCloseReason | null;
  closeScope: AuthorityOperationalCloseScope | null;
  closedAt: string | null;
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
  /**
   * Operational stop for a factual Butler self-session: atomically closes only
   * still-open requests whose owning AND source session both equal that
   * session, with bounded typed audit fields and no synthetic card decision.
   */
  closeSelfSession(
    input: AuthorityOperationalCloseInput,
  ): AuthorityOperationalCloseResult;
  /**
   * Operational stop for one factually abandoned/superseded Work: atomically
   * closes only still-open requests whose exact source_work_id is that Work,
   * with bounded typed audit fields and no synthetic card decision.
   */
  closeAbandonedWork(
    input: AuthorityAbandonedWorkCloseInput,
  ): AuthorityOperationalCloseResult;
}
