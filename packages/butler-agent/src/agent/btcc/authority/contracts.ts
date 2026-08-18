export type AuthorityCategory = "command";
export type AuthorityDecision = "pending" | "allowed" | "denied";
export type AuthorityScheduleState = "pending" | "scheduled";
export type AuthorityOutcome = "pending" | "applied" | "failed";

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
    };

export type AuthorityAllowResult = {
  requestRef: string;
  sourceSessionId: string;
  sourceWorkId: string;
  scheduleClientMessageId: string;
  scheduleInputText: string;
  modelRef: string;
  reasoningEffort: string;
  scheduleState: AuthorityScheduleState;
  decision: "allowed";
};

export type AuthorityDenyResult = {
  requestRef: string;
  sourceSessionId: string;
  sourceWorkId: string;
  scheduleClientMessageId: string;
  scheduleInputText: string;
  modelRef: string;
  reasoningEffort: string;
  scheduleState: AuthorityScheduleState;
  decision: "denied";
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
  decision: "allowed" | "denied";
  outcome: AuthorityOutcome;
};

export type AuthorityOutcomeInput = {
  requestRef: string;
  ownerSessionId: string;
  sourceWorkId: string;
  status: "applied" | "failed";
  receipt?: unknown;
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
  allow(requestRef: string, ownerSessionId: string, now: string): AuthorityRecord | null;
  deny(requestRef: string, ownerSessionId: string, now: string): AuthorityRecord | null;
  markScheduled(
    requestRef: string,
    ownerSessionId: string,
    clientMessageId: string,
    now: string,
  ): AuthorityRecord | null;
  recordOutcome(input: {
    requestRef: string;
    sourceWorkId: string;
    status: "applied" | "failed";
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
  scheduleState: AuthorityScheduleState;
  scheduleClientMessageId: string;
  scheduleInputText: string;
  outcome: AuthorityOutcome;
  outcomeReceiptJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface PrincipalAuthority {
  admit(input: AuthorityAdmissionInput): AuthorityAdmissionResult;
  list(input: { ownerSessionId: string }): AuthorityRequestProjection[];
  allow(input: {
    ownerSessionId: string;
    requestRef: string;
  }): AuthorityAllowResult;
  deny(input: {
    ownerSessionId: string;
    requestRef: string;
  }): AuthorityDenyResult;
  markScheduled(input: {
    ownerSessionId: string;
    requestRef: string;
    clientMessageId: string;
  }): void;
  execution(input: {
    ownerSessionId: string;
    requestRef: string;
  }): AuthorityStoredExecution;
  recordOutcome(input: AuthorityOutcomeInput): void;
}
