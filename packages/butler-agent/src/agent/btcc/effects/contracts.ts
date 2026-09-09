import type { DurableWorkView } from "../work/index.ts";
import type { GuidedEffectRecoveryEntry } from "./guided-effect-recovery.ts";

export type GuidedEffectAccessMode =
  | "full_access"
  | "ask_first"
  | "read_only";

export type GuidedEffectError = {
  code:
    | "effect_work_plan_missing"
    | "effect_plan_review_required"
    | "effect_action_not_found"
    | "effect_action_ambiguous"
    | "effect_request_invalid"
    | "effect_identity_conflict"
    | "effect_access_denied"
    | "effect_cancelled"
    | "effect_dispatch_failed"
    | "effect_reconciliation_required"
    | "effect_journal_conflict";
  message: string;
  recoverable: boolean;
  /** Adapter-specific durable diagnostic used to preserve terminal uncertainty. */
  sourceCode?: string;
};

export type GuidedEffectReceipt<TResult = unknown> = {
  effectId: string;
  receiptId: string;
  idempotencyKey: string;
  identitySha256: string;
  requestSha256: string;
  inputSha256: string;
  targetSha256: string;
  workId: string;
  planRevisionId: string;
  actionKey: string;
  capability: string;
  sanitizedTarget: string;
  result: TResult;
  appliedAt: string;
  dispatchAttempt?: number;
};

export type GuidedEffectUncertainEvidence = {
  effectId: string;
  identitySha256: string;
  dispatchAttempt: number;
  errorCode: GuidedEffectError["code"];
};

export type GuidedEffectOutcome<TResult = unknown> =
  | {
      ok: true;
      status: "applied";
      replayed: boolean;
      result: TResult;
      receipt: GuidedEffectReceipt<TResult>;
    }
  | {
      ok: false;
      status: "rejected";
      error: GuidedEffectError;
    }
  | {
      ok: false;
      status: "failed";
      error: GuidedEffectError;
    }
  | {
      ok: false;
      status: "uncertain";
      error: GuidedEffectError;
      evidence?: GuidedEffectUncertainEvidence;
    };

export type EffectAdapterError = {
  code: string;
  message: string;
  recoverable?: boolean;
};

export type EffectDispatchOutcome<TResult> =
  | { status: "applied"; result: TResult }
  | { status: "not_applied"; error: EffectAdapterError }
  | { status: "uncertain"; error: EffectAdapterError };

export type EffectReconciliation<TResult> =
  | { status: "applied"; result: TResult }
  | { status: "not_applied" }
  | { status: "uncertain"; error?: EffectAdapterError };

export type EffectBlockerRelation =
  | "unrelated"
  | "overlapping"
  | "equivalent"
  | "ambiguous";

export type MaybePromise<T> = T | Promise<T>;

export type EffectAdapter<TNormalizedInput = unknown, TResult = unknown> = {
  readonly capability: string;
  /** Defaults to exact_action; accepted_plan still requires an accepted Plan. */
  readonly reviewedPlanBinding?: "exact_action" | "accepted_plan";
  normalizeTarget(target: string): string;
  sanitizeTarget(normalizedTarget: string): string;
  normalizeInput(input: unknown): TNormalizedInput;
  recoveryHint?(input: TNormalizedInput): GuidedEffectRecoveryHint | undefined;
  classifyEffectBlocker?(input: {
    blockerCapability: string;
    blockerTarget: string;
    blockerInput: Record<string, unknown>;
    normalizedTarget: string;
    normalizedInput: TNormalizedInput;
  }): MaybePromise<EffectBlockerRelation>;
  dispatch(input: {
    normalizedTarget: string;
    normalizedInput: TNormalizedInput;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<EffectDispatchOutcome<TResult>>;
  reconcile(input: {
    normalizedTarget: string;
    normalizedInput: TNormalizedInput;
    idempotencyKey: string;
    signal: AbortSignal;
    dispatchAttempts: number;
    priorError?: GuidedEffectError;
  }): Promise<EffectReconciliation<TResult>>;
};

export type ExecuteGuidedEffectInput<
  TNormalizedInput = unknown,
  TResult = unknown,
> = {
  work: DurableWorkView;
  accessMode: GuidedEffectAccessMode;
  /** Runtime-owned tool occurrence; required by accepted_plan adapters. */
  occurrenceId?: string;
  signal: AbortSignal;
  target: string;
  input: unknown;
  adapter: EffectAdapter<TNormalizedInput, TResult>;
};

export type GuidedEffectIdentity = {
  effectId: string;
  receiptId: string;
  idempotencyKey: string;
  identitySha256: string;
  requestSha256: string;
  inputSha256: string;
  targetSha256: string;
  workId: string;
  planRevisionId: string;
  actionKey: string;
  capability: string;
  sanitizedTarget: string;
};

export type GuidedEffectRecoveryHint =
  | {
      capability: "edit_file";
      startLine: number;
      beforeSha256: string;
      afterSha256: string;
    }
  | {
      capability: "edit_file";
      entries: readonly GuidedEffectRecoveryEntry[];
    };

export type GuidedEffectJournalStatus =
  | "prepared"
  | "dispatching"
  | "applied"
  | "uncertain"
  | "failed";

export type GuidedEffectJournalRecord = GuidedEffectIdentity & {
  status: GuidedEffectJournalStatus;
  journalRevision: number;
  dispatchAttempts: number;
  result?: unknown;
  receipt?: GuidedEffectReceipt;
  recoveryHint?: GuidedEffectRecoveryHint;
  error?: GuidedEffectError;
  createdAt: string;
  updatedAt: string;
};

export type GuidedWorkEffectBlockerRecord = {
  blockerId: string;
  sourceTurnId: string;
  sourceOccurrenceId: string;
  workId: string;
  capability: string;
  target: string;
  input: Record<string, unknown>;
  inputSha256: string;
  idempotencyKey: string;
  detail: string;
  status: "unresolved" | "applied";
  resolution?: { status: "applied" | "not_applied" };
  createdAt: string;
};

export type PrepareGuidedEffectResult =
  | { ok: true; created: boolean; record: GuidedEffectJournalRecord }
  | { ok: false; message: string };

export interface GuidedEffectJournal {
  prepare(
    identity: GuidedEffectIdentity,
    recoveryHint?: GuidedEffectRecoveryHint,
  ): MaybePromise<PrepareGuidedEffectResult>;
  find(effectId: string): MaybePromise<GuidedEffectJournalRecord | null>;
  listForWork(
    workId: string,
    limit?: number,
  ): MaybePromise<GuidedEffectJournalRecord[]>;
  listEffectBlockersForReconciliation(
    workId: string,
  ): MaybePromise<GuidedWorkEffectBlockerRecord[]>;
  resolveBlockerOccurrence(
    workId: string,
    sourceOccurrenceId: string,
    resolution: "applied" | "not_applied",
  ): MaybePromise<boolean>;
  claimDispatch(
    effectId: string,
    expectedJournalRevision: number,
  ): MaybePromise<GuidedEffectJournalRecord | null>;
  returnToPrepared(
    effectId: string,
    expectedJournalRevision: number,
  ): MaybePromise<GuidedEffectJournalRecord | null>;
  recordApplied<TResult>(
    effectId: string,
    expectedJournalRevision: number,
    result: TResult,
    receipt: GuidedEffectReceipt<TResult>,
  ): MaybePromise<GuidedEffectJournalRecord | null>;
  recordUncertain(
    effectId: string,
    expectedJournalRevision: number,
    error: GuidedEffectError,
  ): MaybePromise<GuidedEffectJournalRecord | null>;
  recordFailed(
    effectId: string,
    expectedJournalRevision: number,
    error: GuidedEffectError,
  ): MaybePromise<GuidedEffectJournalRecord | null>;
}

export type GuidedEffectFaultPoint =
  | "before_intent"
  | "after_intent"
  | "after_blocker_resolution"
  | "after_dispatch_marker"
  | "after_dispatch"
  | "after_receipt";

export type GuidedEffectFaultHook = (
  point: GuidedEffectFaultPoint,
  identity: Readonly<GuidedEffectIdentity>,
) => MaybePromise<void>;

export interface GuidedEffectService {
  execute<TNormalizedInput, TResult>(
    input: ExecuteGuidedEffectInput<TNormalizedInput, TResult>,
  ): Promise<GuidedEffectOutcome<TResult>>;
}
