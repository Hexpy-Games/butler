import type {
  PublicWorkObligationKind,
  ToolAuditEntry,
} from "../../turn/native/output/tool-types.ts";
import {
  buildEvidenceCapabilityLedger,
  missingCompletionObligationsFromLedger,
} from "../evidence/ledger-state.ts";
import {
  evidenceReceiptsFromResult,
} from "../evidence/receipts.ts";
import {
  reconstructDurableOutcomeReceiptsFromAuditEntry,
} from "./outcome-reconstruction.ts";
import type {
  EvidenceCapabilityLedger,
  EvidenceCapabilityReceipt,
} from "../evidence/types.ts";

export type CompletionObligationEvidenceOutcome =
  | "satisfied"
  | "repair_request"
  | "limitation"
  | "explicit_blocker";

export interface CompletionObligationEvidenceRead {
  authoritative: boolean;
  ledger: EvidenceCapabilityLedger;
  outcome: CompletionObligationEvidenceOutcome;
  satisfied: PublicWorkObligationKind[];
  missingCritical: PublicWorkObligationKind[];
  missingNonCritical: PublicWorkObligationKind[];
  limitations: string[];
}

export function completionObligationEvidenceReceiptsFromResult(result: unknown): unknown[] {
  const record = recordValue(result);
  return Array.isArray(record?.evidence_capability_receipts)
    ? record.evidence_capability_receipts
    : [];
}

export function hasEvidenceCapabilityReceiptField(result: unknown): boolean {
  const record = recordValue(result);
  return Boolean(record && Object.hasOwn(record, "evidence_capability_receipts"));
}

export function readCompletionObligationEvidence(input: {
  required?: PublicWorkObligationKind[];
  critical?: PublicWorkObligationKind[];
  receipts?: unknown[];
}): CompletionObligationEvidenceRead {
  const receipts = input.receipts ?? [];
  const ledger = buildEvidenceCapabilityLedger({
    required: input.required ?? [],
    receipts,
  });
  const critical = new Set(input.critical ?? input.required ?? []);
  const missingCritical = missingCompletionObligationsFromLedger(ledger)
    .filter((obligation) => critical.has(obligation));
  const missingNonCritical = missingCompletionObligationsFromLedger(ledger)
    .filter((obligation) => !critical.has(obligation));
  return {
    authoritative: input.receipts !== undefined,
    ledger,
    outcome: completionObligationEvidenceOutcome({
      ledger,
      missingCritical,
      missingNonCritical,
    }),
    satisfied: ledger.satisfied,
    missingCritical,
    missingNonCritical,
    limitations: limitationMetadata(ledger.receipts, missingNonCritical),
  };
}

export function readCompletionObligationEvidenceFromAudit(input: {
  audit: ToolAuditEntry[];
  required?: PublicWorkObligationKind[];
  critical?: PublicWorkObligationKind[];
}): CompletionObligationEvidenceRead {
  return readCompletionObligationEvidence({
    required: input.required,
    critical: input.critical,
    receipts: input.audit
      .filter((entry) => entry.ok)
      .flatMap(completionObligationEvidenceReceiptsFromAuditEntry),
  });
}

function completionObligationEvidenceReceiptsFromAuditEntry(entry: ToolAuditEntry): unknown[] {
  const reconstructed = reconstructDurableOutcomeReceiptsFromAuditEntry(entry);
  if (hasEvidenceCapabilityReceiptField(entry.result)) {
    return [
      ...completionObligationEvidenceReceiptsFromResult(entry.result),
      ...reconstructed,
    ];
  }
  return [
    ...(entry.evidenceReceipts ?? []),
    ...evidenceReceiptsFromResult(entry.result),
    ...reconstructed,
  ];
}

function completionObligationEvidenceOutcome(input: {
  ledger: EvidenceCapabilityLedger;
  missingCritical: PublicWorkObligationKind[];
  missingNonCritical: PublicWorkObligationKind[];
}): CompletionObligationEvidenceOutcome {
  if (input.missingCritical.length > 0) {
    return hasExplicitBlocker(input.ledger.receipts) ? "explicit_blocker" : "repair_request";
  }
  if (input.missingNonCritical.length > 0) return "limitation";
  return "satisfied";
}

function hasExplicitBlocker(receipts: EvidenceCapabilityReceipt[]): boolean {
  return receipts.some((receipt) =>
    receipt.capability === "explicit_blocker" &&
    receipt.evidence_kind === "blocker" &&
    receipt.verified &&
    receipt.maturity === "verified",
  );
}

function limitationMetadata(
  receipts: EvidenceCapabilityReceipt[],
  missingNonCritical: PublicWorkObligationKind[],
): string[] {
  const limitations = new Set(receipts.flatMap((receipt) => receipt.limitations));
  for (const obligation of missingNonCritical) {
    limitations.add(`Non-critical evidence is missing: ${obligation}.`);
  }
  return [...limitations].slice(0, 8);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
