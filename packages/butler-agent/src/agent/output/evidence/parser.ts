import { randomUUID } from "node:crypto";
import { sanitizePublicText } from "../../events/turn-events.ts";
import type { PublicWorkObligationKind } from "../../tools/tool-support.ts";
import { safeEvidenceReference, unsupportedSatisfiesIssues } from "./policy.ts";
import {
  EVIDENCE_CAPABILITY_EVIDENCE_KINDS,
  EVIDENCE_CAPABILITY_KINDS,
  EVIDENCE_CAPABILITY_MATURITIES,
  EVIDENCE_CAPABILITY_PRODUCER_KINDS,
  EVIDENCE_CAPABILITY_SCHEMA_VERSION,
  type EvidenceCapabilityEvidenceKind,
  type EvidenceCapabilityKind,
  type EvidenceCapabilityMaturity,
  type EvidenceCapabilityParseResult,
  type EvidenceCapabilityProducerKind,
  type EvidenceCapabilityReceipt,
  type EvidenceCapabilityReceiptInput,
  type EvidenceCapabilityReceiptIssue,
  type EvidenceCapabilityReference,
} from "./types.ts";

export {
  EVIDENCE_CAPABILITY_EVIDENCE_KINDS,
  EVIDENCE_CAPABILITY_KINDS,
  EVIDENCE_CAPABILITY_MATURITIES,
  EVIDENCE_CAPABILITY_PRODUCER_KINDS,
  EVIDENCE_CAPABILITY_SCHEMA_VERSION,
  EVIDENCE_CAPABILITY_TAXONOMY,
  type EvidenceCapabilityEvidenceKind,
  type EvidenceCapabilityKind,
  type EvidenceCapabilityMaturity,
  type EvidenceCapabilityParseResult,
  type EvidenceCapabilityProducerKind,
  type EvidenceCapabilityReceipt,
  type EvidenceCapabilityReceiptInput,
  type EvidenceCapabilityReceiptIssue,
  type EvidenceCapabilityReference,
} from "./types.ts";

const KNOWN_CAPABILITIES = new Set<string>(EVIDENCE_CAPABILITY_KINDS);
const KNOWN_EVIDENCE_KINDS = new Set<string>(EVIDENCE_CAPABILITY_EVIDENCE_KINDS);
const KNOWN_MATURITIES = new Set<string>(EVIDENCE_CAPABILITY_MATURITIES);
const KNOWN_PRODUCER_KINDS = new Set<string>(EVIDENCE_CAPABILITY_PRODUCER_KINDS);
const PUBLIC_WORK_OBLIGATIONS = new Set<string>([
  "source_verified",
  "command_executed",
  "durable_artifact",
  "data_table_created",
  "chart_rendered",
]);
const RECEIPT_ID_RANDOM_SUFFIX_LENGTH = 12;
const EVIDENCE_SUMMARY_MAX_CHARS = 320;
const MAX_EVIDENCE_REFERENCES = 12;
const MAX_EVIDENCE_LIMITATIONS = 8;
const VERIFIED_CONFIDENCE = 1;
const CANDIDATE_CONFIDENCE = 0.5;

export function createEvidenceCapabilityReceipt(
  input: EvidenceCapabilityReceiptInput,
): EvidenceCapabilityReceipt {
  const maturity = input.maturity ?? (input.verified === false ? "candidate" : "verified");
  const confidence = input.confidence ?? (maturity === "verified" ? VERIFIED_CONFIDENCE : CANDIDATE_CONFIDENCE);
  const receipt: EvidenceCapabilityReceipt = {
    receipt_id: `ecr-${randomUUID().slice(0, RECEIPT_ID_RANDOM_SUFFIX_LENGTH)}`,
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: input.producer,
    capability: input.capability,
    evidence_kind: input.evidence_kind,
    maturity,
    confidence,
    verified: input.verified ?? maturity === "verified",
    summary: sanitizePublicText(input.summary, "Evidence capability was produced.").slice(0, EVIDENCE_SUMMARY_MAX_CHARS),
    ...(recordValue(input.scope) ? { scope: recordValue(input.scope)! } : {}),
    references: input.references ?? [],
    ...(input.satisfies && input.satisfies.length > 0 ? { satisfies: [...new Set(input.satisfies)] } : {}),
    limitations: safeLimitations(input.limitations),
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const parsed = parseEvidenceCapabilityReceipt(receipt);
  if (!parsed.ok) {
    throw new Error(`Invalid evidence capability receipt: ${parsed.issues.map((issue) => issue.code).join(", ")}`);
  }
  return parsed.receipt;
}

export function parseEvidenceCapabilityReceipt(value: unknown): EvidenceCapabilityParseResult {
  const issues: EvidenceCapabilityReceiptIssue[] = [];
  const record = recordValue(value);
  if (!record) {
    return invalid("receipt", "invalid_receipt", "Receipt must be an object.");
  }
  const schemaVersion = stringValue(record.schema_version);
  if (schemaVersion !== EVIDENCE_CAPABILITY_SCHEMA_VERSION) {
    issues.push(issue("schema_version", "invalid_schema_version", "Receipt schema version is not supported."));
  }
  const receiptId = stringValue(record.receipt_id);
  if (!receiptId) {
    issues.push(issue("receipt_id", "missing_receipt_id", "Receipt id is required."));
  }

  const producer = parseProducer(record.producer, issues);
  const capability = parseKnownString(record.capability, KNOWN_CAPABILITIES, "capability", "unknown_capability", issues);
  const evidenceKind = parseKnownString(
    record.evidence_kind,
    KNOWN_EVIDENCE_KINDS,
    "evidence_kind",
    "unknown_evidence_kind",
    issues,
  );
  const maturity = parseKnownString(record.maturity, KNOWN_MATURITIES, "maturity", "unknown_maturity", issues);
  const verified = typeof record.verified === "boolean" ? record.verified : null;
  if (verified === null) {
    issues.push(issue("verified", "missing_verified", "Verified flag is required."));
  }
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? record.confidence
    : null;
  if (confidence === null || confidence < 0 || confidence > 1) {
    issues.push(issue("confidence", "invalid_confidence", "Confidence must be a number between 0 and 1."));
  }
  const summary = stringValue(record.summary);
  if (!summary) {
    issues.push(issue("summary", "missing_summary", "Safe redacted summary is required."));
  }
  const scope = recordValue(record.scope);
  const references = parseReferences(record.references, issues);
  const satisfies = parseObligations(record.satisfies, issues);
  const limitations = safeLimitations(record.limitations);
  const createdAt = stringValue(record.created_at);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    issues.push(issue("created_at", "invalid_created_at", "Created timestamp must be an ISO-compatible date."));
  }
  if (verified === true && maturity !== "verified") {
    issues.push(issue("verified", "verified_requires_maturity", "Verified receipts must use verified maturity."));
  }
  if (satisfies.length > 0 && (verified !== true || maturity !== "verified")) {
    issues.push(issue("satisfies", "satisfies_requires_verified", "Only verified receipts can satisfy obligations."));
  }
  issues.push(...unsupportedSatisfiesIssues({
    capability: capability as EvidenceCapabilityKind | null,
    evidenceKind: evidenceKind as EvidenceCapabilityEvidenceKind | null,
    references,
    satisfies,
  }));
  if (issues.length > 0) {
    return { ok: false, receipt: null, issues };
  }
  return {
    ok: true,
    receipt: {
      receipt_id: receiptId!,
      schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
      producer: producer!,
      capability: capability as EvidenceCapabilityKind,
      evidence_kind: evidenceKind as EvidenceCapabilityEvidenceKind,
      maturity: maturity as EvidenceCapabilityMaturity,
      confidence: confidence!,
      verified: verified!,
      summary: sanitizePublicText(summary!, "Evidence capability was produced.").slice(0, EVIDENCE_SUMMARY_MAX_CHARS),
      ...(scope ? { scope } : {}),
      references,
      ...(satisfies.length > 0 ? { satisfies } : {}),
      limitations,
      created_at: new Date(createdAt!).toISOString(),
    },
    issues: [],
  };
}

function parseProducer(value: unknown, issues: EvidenceCapabilityReceiptIssue[]): EvidenceCapabilityReceipt["producer"] | null {
  const record = recordValue(value);
  if (!record) {
    issues.push(issue("producer", "missing_producer", "Producer is required."));
    return null;
  }
  const kind = parseKnownString(record.kind, KNOWN_PRODUCER_KINDS, "producer.kind", "unknown_producer_kind", issues);
  const name = stringValue(record.name);
  if (!name) {
    issues.push(issue("producer.name", "missing_producer_name", "Producer name is required."));
  }
  const callId = stringValue(record.call_id);
  if (!kind || !name) {
    return null;
  }
  return {
    kind: kind as EvidenceCapabilityProducerKind,
    name,
    ...(callId ? { call_id: callId } : {}),
  };
}

function parseReferences(value: unknown, issues: EvidenceCapabilityReceiptIssue[]): EvidenceCapabilityReference[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(issue("references", "invalid_references", "References must be an array."));
    return [];
  }
  const references: EvidenceCapabilityReference[] = [];
  for (const [index, item] of value.entries()) {
    const record = recordValue(item);
    if (!record) {
      issues.push(issue(`references.${index}`, "invalid_reference", "Reference must be an object."));
      continue;
    }
    const safe = safeEvidenceReference({ index, record });
    issues.push(...safe.issues);
    if (safe.reference) {
      references.push(safe.reference);
    }
  }
  return references.slice(0, MAX_EVIDENCE_REFERENCES);
}

function parseObligations(value: unknown, issues: EvidenceCapabilityReceiptIssue[]): PublicWorkObligationKind[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(issue("satisfies", "invalid_satisfies", "Satisfies must be an array."));
    return [];
  }
  const obligations: PublicWorkObligationKind[] = [];
  for (const item of value) {
    const text = stringValue(item);
    if (!text || !PUBLIC_WORK_OBLIGATIONS.has(text)) {
      issues.push(issue("satisfies", "unknown_obligation", "Unknown completion obligation."));
      continue;
    }
    obligations.push(text as PublicWorkObligationKind);
  }
  return [...new Set(obligations)];
}

function parseKnownString(
  value: unknown,
  known: Set<string>,
  field: string,
  errorCode: string,
  issues: EvidenceCapabilityReceiptIssue[],
): string | null {
  const text = stringValue(value);
  if (!text || !known.has(text)) {
    issues.push(issue(field, errorCode, `${field} is not a known evidence capability value.`));
    return null;
  }
  return text;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function safeLimitations(value: unknown): string[] {
  return [...new Set(stringArray(value)
    .map((item) => sanitizePublicText(item, "Evidence limitation was recorded.").trim())
    .filter(Boolean))]
    .slice(0, MAX_EVIDENCE_LIMITATIONS);
}

function issue(field: string, code: string, message: string): EvidenceCapabilityReceiptIssue {
  return { field, code, message };
}

function invalid(field: string, code: string, message: string): EvidenceCapabilityParseResult {
  return { ok: false, receipt: null, issues: [issue(field, code, message)] };
}
