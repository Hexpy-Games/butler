import type { DurableWorkView } from "../durable-work/index.ts";

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
      status: "rejected" | "failed" | "uncertain";
      error: GuidedEffectError;
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

export type EffectAdapter<TNormalizedInput = unknown, TResult = unknown> = {
  readonly capability: string;
  normalizeTarget(target: string): string;
  sanitizeTarget(normalizedTarget: string): string;
  normalizeInput(input: unknown): TNormalizedInput;
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
  }): Promise<EffectReconciliation<TResult>>;
};

export type ExecuteGuidedEffectInput<
  TNormalizedInput = unknown,
  TResult = unknown,
> = {
  work: DurableWorkView;
  accessMode: GuidedEffectAccessMode;
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
  error?: GuidedEffectError;
  createdAt: string;
  updatedAt: string;
};

export type PrepareGuidedEffectResult =
  | { ok: true; created: boolean; record: GuidedEffectJournalRecord }
  | { ok: false; message: string };

export type MaybePromise<T> = T | Promise<T>;

export interface GuidedEffectJournal {
  prepare(identity: GuidedEffectIdentity): MaybePromise<PrepareGuidedEffectResult>;
  find(effectId: string): MaybePromise<GuidedEffectJournalRecord | null>;
  listForWork(
    workId: string,
    limit?: number,
  ): MaybePromise<GuidedEffectJournalRecord[]>;
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
