import type { PublicWorkObligationKind } from "../turn/native-tool-types.ts";
import {
  createEvidenceCapabilityReceipt,
  parseEvidenceCapabilityReceipt,
} from "./evidence-capability-parser.ts";
import {
  EVIDENCE_CAPABILITY_SCHEMA_VERSION,
  type EvidenceCapabilityLedger,
  type EvidenceCapabilityReceipt,
  type EvidenceCapabilityReceiptIssue,
  type RejectedEvidenceCapabilityReceipt,
} from "./evidence-capability-types.ts";

const LEGACY_RECEIPT_SCHEMA = "butler.evidence-receipt.v1";
const PUBLIC_WORK_OBLIGATIONS = new Set<PublicWorkObligationKind>([
  "source_verified",
  "command_executed",
  "durable_artifact",
  "data_table_created",
  "chart_rendered",
]);

export function buildEvidenceCapabilityLedger(input: {
  receipts?: unknown[];
  required?: PublicWorkObligationKind[];
} = {}): EvidenceCapabilityLedger {
  const receipts: EvidenceCapabilityReceipt[] = [];
  const rejectedReceipts: RejectedEvidenceCapabilityReceipt[] = [];
  for (const value of input.receipts ?? []) {
    const normalized = normalizeEvidenceCapabilityReceipts(value);
    receipts.push(...normalized.receipts);
    rejectedReceipts.push(...normalized.rejectedReceipts);
  }
  const required = uniqueObligations(input.required ?? []);
  const satisfied = uniqueObligations(receipts.flatMap((receipt) => {
    if (!receipt.verified || receipt.maturity !== "verified") return [];
    return receipt.satisfies ?? [];
  }));
  return {
    required,
    satisfied,
    missing: required.filter((obligation) => !satisfied.includes(obligation)),
    receipts,
    rejectedReceipts,
  };
}

export function normalizeEvidenceCapabilityReceipts(value: unknown): {
  receipts: EvidenceCapabilityReceipt[];
  rejectedReceipts: RejectedEvidenceCapabilityReceipt[];
} {
  const record = recordValue(value);
  if (record?.schema_version === EVIDENCE_CAPABILITY_SCHEMA_VERSION) {
    const parsed = parseEvidenceCapabilityReceipt(value);
    return parsed.ok
      ? { receipts: [parsed.receipt], rejectedReceipts: [] }
      : { receipts: [], rejectedReceipts: [rejectedReceipt(value, parsed.issues)] };
  }
  if (record?.schema === LEGACY_RECEIPT_SCHEMA) return normalizeLegacyReceipt(record);
  return {
    receipts: [],
    rejectedReceipts: [rejectedReceipt(value, [{
      field: "schema",
      code: "unsupported_receipt_schema",
      message: "Receipt schema is not supported by the evidence capability ledger.",
    }])],
  };
}

export function missingCompletionObligationsFromLedger(
  ledger: EvidenceCapabilityLedger,
): PublicWorkObligationKind[] {
  return ledger.missing;
}

function normalizeLegacyReceipt(record: Record<string, unknown>): {
  receipts: EvidenceCapabilityReceipt[];
  rejectedReceipts: RejectedEvidenceCapabilityReceipt[];
} {
  const receipts: EvidenceCapabilityReceipt[] = [];
  const rejectedReceipts: RejectedEvidenceCapabilityReceipt[] = [];
  const producer = legacyProducer(record);
  const summary = stringValue(record.summary) ?? "Legacy evidence receipt was normalized.";
  const references = legacyReferences(record);
  const covers = stringArray(record.covers);
  const candidateOnly = covers.includes("source_candidates") ||
    covers.includes("source_candidate") ||
    stringValue(record.receiptType) === "coverage" ||
    producer.name === "web_search";
  if (candidateOnly) {
    receipts.push(createEvidenceCapabilityReceipt({
      producer,
      capability: "source_candidate",
      evidence_kind: "source_candidate",
      maturity: "candidate",
      verified: false,
      confidence: 0.4,
      summary,
      references,
      limitations: ["Search candidate discovery is not source verification."],
      created_at: new Date().toISOString(),
    }));
  }
  for (const obligation of stringArray(record.satisfies)) {
    if (candidateOnly) {
      rejectedReceipts.push(rejectedReceipt(record, [{
        field: "satisfies",
        code: "candidate_cannot_satisfy_obligation",
        message: "Legacy search candidate receipts cannot satisfy completion obligations.",
      }]));
      continue;
    }
    if (!PUBLIC_WORK_OBLIGATIONS.has(obligation as PublicWorkObligationKind)) {
      rejectedReceipts.push(rejectedReceipt(record, [{
        field: "satisfies",
        code: "unknown_obligation",
        message: "Unknown legacy completion obligation.",
      }]));
      continue;
    }
    const mapped = legacyObligationMapping(obligation as PublicWorkObligationKind, record, covers);
    if (
      (obligation === "durable_artifact" ||
        obligation === "data_table_created" ||
        obligation === "chart_rendered") &&
      !hasArtifactReference(references)
    ) {
      rejectedReceipts.push(rejectedReceipt(record, [{
        field: "references",
        code: "missing_artifact_reference",
        message: "Legacy artifact obligations require structured artifact evidence.",
      }]));
      continue;
    }
    try {
      receipts.push(createEvidenceCapabilityReceipt({
        producer,
        capability: mapped.capability,
        evidence_kind: mapped.evidence_kind,
        verified: record.verified === true,
        confidence: record.verified === true ? 0.75 : 0.2,
        summary,
        references,
        satisfies: [obligation as PublicWorkObligationKind],
        limitations: stringArray(record.limitations),
        created_at: new Date().toISOString(),
      }));
    } catch (error) {
      rejectedReceipts.push(rejectedReceipt(record, [{
        field: "legacy",
        code: "legacy_normalization_failed",
        message: error instanceof Error ? error.message : "Legacy receipt could not be normalized.",
      }]));
    }
  }
  if (receipts.length === 0 && rejectedReceipts.length === 0) {
    rejectedReceipts.push(rejectedReceipt(record, [{
      field: "legacy",
      code: "no_mappable_capability",
      message: "Legacy receipt does not declare a mappable evidence capability.",
    }]));
  }
  return { receipts, rejectedReceipts };
}

function legacyObligationMapping(
  obligation: PublicWorkObligationKind,
  record: Record<string, unknown>,
  covers: string[],
): Pick<EvidenceCapabilityReceipt, "capability" | "evidence_kind"> {
  if (obligation === "source_verified") {
    return {
      capability: "source_verified",
      evidence_kind: covers.includes("workspace_file_read") || stringValue(record.receiptType) === "state"
        ? "workspace_inspection"
        : "source_page",
    };
  }
  if (obligation === "command_executed") return { capability: "command_executed", evidence_kind: "execution_result" };
  if (obligation === "data_table_created") return { capability: "data_table_created", evidence_kind: "data_table" };
  if (obligation === "chart_rendered") return { capability: "chart_rendered", evidence_kind: "chart" };
  return { capability: "durable_artifact", evidence_kind: "artifact" };
}

function legacyProducer(record: Record<string, unknown>): EvidenceCapabilityReceipt["producer"] {
  const producer = recordValue(record.producer);
  return {
    kind: "tool",
    name: stringValue(producer?.name) ?? stringValue(record.producerName) ?? "legacy_tool",
  };
}

function legacyReferences(record: Record<string, unknown>): EvidenceCapabilityReceipt["references"] {
  const references = Array.isArray(record.references) ? record.references : [];
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  return [...references, ...artifacts].map((item) => {
    const entry = recordValue(item) ?? {};
    return {
      ...(stringValue(entry.label) ? { label: stringValue(entry.label)! } : {}),
      ...(stringValue(entry.ref) && /^https?:\/\//u.test(stringValue(entry.ref)!) ? { url: stringValue(entry.ref)! } : {}),
      ...(stringValue(entry.url) ? { url: stringValue(entry.url)! } : {}),
      ...(stringValue(entry.path) ? { path: stringValue(entry.path)! } : {}),
      ...(stringValue(entry.id) ? { artifact_id: stringValue(entry.id)! } : {}),
    };
  });
}

function hasArtifactReference(references: EvidenceCapabilityReceipt["references"]): boolean {
  return references.some((reference) => Boolean(reference.artifact_id || reference.path || reference.label));
}

function uniqueObligations(values: PublicWorkObligationKind[]): PublicWorkObligationKind[] {
  return [...new Set(values.filter((value) => PUBLIC_WORK_OBLIGATIONS.has(value)))];
}

function rejectedReceipt(value: unknown, issues: EvidenceCapabilityReceiptIssue[]): RejectedEvidenceCapabilityReceipt {
  const record = recordValue(value);
  return {
    ...(stringValue(record?.receipt_id ?? record?.id) ? { receipt_id: stringValue(record?.receipt_id ?? record?.id)! } : {}),
    ...(stringValue(record?.schema_version ?? record?.schema) ? { schema_version: stringValue(record?.schema_version ?? record?.schema)! } : {}),
    issues,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}
