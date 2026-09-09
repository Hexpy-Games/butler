import type {
  GuidedEffectError,
  GuidedEffectOutcome,
  GuidedEffectReceipt,
} from "../effects/index.ts";
import type { AuthorityOutcomeReceipt } from "./contracts.ts";

export type AppliedAuthorityOutcomeReceipt = Extract<
  AuthorityOutcomeReceipt,
  { outcome: "applied" }
>;

export type UncertainAuthorityOutcomeReceipt = Extract<
  AuthorityOutcomeReceipt,
  { outcome: "uncertain" }
>;

/** Evidence input derived from the public generic effect outcome union only. */
export type GuidedEffectUncertainEvidenceInput = NonNullable<
  Extract<GuidedEffectOutcome, { status: "uncertain" }>["evidence"]
>;

const GUIDED_EFFECT_ID_PATTERN = /^guided-effect-[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_SCHEMA = "butler.authority-outcome-receipt.v1" as const;
const EVIDENCE_REF_PREFIX = "authority-evidence-";
const APPLIED_RECEIPT_KEYS = "dispatchAttempt,evidenceRef,journalEffectId,outcome,schema";
const UNCERTAIN_RECEIPT_KEYS =
  "dispatchAttempt,errorCode,evidenceRef,journalEffectId,outcome,schema";

const GUIDED_EFFECT_ERROR_CODES: readonly GuidedEffectError["code"][] = [
  "effect_work_plan_missing",
  "effect_plan_review_required",
  "effect_action_not_found",
  "effect_action_ambiguous",
  "effect_request_invalid",
  "effect_identity_conflict",
  "effect_access_denied",
  "effect_cancelled",
  "effect_dispatch_failed",
  "effect_reconciliation_required",
  "effect_journal_conflict",
];

function isGuidedEffectErrorCode(value: unknown): value is GuidedEffectError["code"] {
  return typeof value === "string" &&
    (GUIDED_EFFECT_ERROR_CODES as readonly string[]).includes(value);
}

export function deriveAppliedAuthorityOutcomeReceipt(
  receipt: GuidedEffectReceipt,
): AppliedAuthorityOutcomeReceipt | null {
  const { effectId, identitySha256, receiptId, dispatchAttempt } = receipt;
  if (typeof effectId !== "string" || !GUIDED_EFFECT_ID_PATTERN.test(effectId)) {
    return null;
  }
  if (
    typeof identitySha256 !== "string" ||
    !SHA256_PATTERN.test(identitySha256)
  ) {
    return null;
  }
  if (receiptId !== `guided-effect-receipt-${identitySha256}`) {
    return null;
  }
  if (typeof dispatchAttempt !== "number") {
    return null;
  }
  if (!Number.isInteger(dispatchAttempt) || dispatchAttempt <= 0) {
    return null;
  }
  return {
    schema: RECEIPT_SCHEMA,
    outcome: "applied",
    evidenceRef: `${EVIDENCE_REF_PREFIX}${identitySha256}`,
    journalEffectId: effectId,
    dispatchAttempt,
  };
}

/**
 * Bounded terminal receipt for an already-durable generic effect uncertainty.
 * Accepts only validated reconciliation pointers; never target/input/result/
 * path data or raw diagnostic text.
 */
export function deriveUncertainAuthorityOutcomeReceipt(
  evidence: GuidedEffectUncertainEvidenceInput,
): UncertainAuthorityOutcomeReceipt | null {
  const { effectId, identitySha256, dispatchAttempt, errorCode } = evidence;
  if (typeof effectId !== "string" || !GUIDED_EFFECT_ID_PATTERN.test(effectId)) {
    return null;
  }
  if (
    typeof identitySha256 !== "string" ||
    !SHA256_PATTERN.test(identitySha256)
  ) {
    return null;
  }
  if (
    typeof dispatchAttempt !== "number" ||
    !Number.isInteger(dispatchAttempt) ||
    dispatchAttempt <= 0
  ) {
    return null;
  }
  if (!isGuidedEffectErrorCode(errorCode)) {
    return null;
  }
  return {
    schema: RECEIPT_SCHEMA,
    outcome: "uncertain",
    evidenceRef: `${EVIDENCE_REF_PREFIX}${identitySha256}`,
    journalEffectId: effectId,
    dispatchAttempt,
    errorCode,
  };
}

/**
 * Strict stored-receipt reader for execution projections. Returns null for
 * malformed or cross-discriminant receipts so callers can fail closed.
 */
export function parseAuthorityOutcomeReceipt(
  value: string | null | undefined,
): AuthorityOutcomeReceipt | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== RECEIPT_SCHEMA) return null;
  const keys = Object.keys(record).sort().join(",");
  if (record.outcome === "applied") {
    if (keys !== APPLIED_RECEIPT_KEYS || "errorCode" in record) return null;
    const fields = safeReceiptFields(record);
    return fields
      ? {
          schema: RECEIPT_SCHEMA,
          outcome: "applied",
          evidenceRef: fields.evidenceRef,
          journalEffectId: fields.journalEffectId,
          dispatchAttempt: fields.dispatchAttempt,
        }
      : null;
  }
  if (record.outcome === "uncertain") {
    if (keys !== UNCERTAIN_RECEIPT_KEYS) return null;
    if (!isGuidedEffectErrorCode(record.errorCode)) return null;
    const fields = safeReceiptFields(record);
    return fields
      ? {
          schema: RECEIPT_SCHEMA,
          outcome: "uncertain",
          evidenceRef: fields.evidenceRef,
          journalEffectId: fields.journalEffectId,
          dispatchAttempt: fields.dispatchAttempt,
          errorCode: record.errorCode,
        }
      : null;
  }
  return null;
}

function safeReceiptFields(
  record: Record<string, unknown>,
): {
  evidenceRef: string;
  journalEffectId: string;
  dispatchAttempt: number;
} | null {
  const evidenceRef = record.evidenceRef;
  if (
    typeof evidenceRef !== "string" ||
    !evidenceRef.startsWith(EVIDENCE_REF_PREFIX) ||
    !SHA256_PATTERN.test(evidenceRef.slice(EVIDENCE_REF_PREFIX.length))
  ) {
    return null;
  }
  const journalEffectId = record.journalEffectId;
  if (
    typeof journalEffectId !== "string" ||
    !GUIDED_EFFECT_ID_PATTERN.test(journalEffectId)
  ) {
    return null;
  }
  const dispatchAttempt = record.dispatchAttempt;
  if (
    typeof dispatchAttempt !== "number" ||
    !Number.isInteger(dispatchAttempt) ||
    dispatchAttempt <= 0
  ) {
    return null;
  }
  return { evidenceRef, journalEffectId, dispatchAttempt };
}
