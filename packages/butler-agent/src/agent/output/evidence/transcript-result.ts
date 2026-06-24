import {
  completionObligationEvidenceReceiptsFromResult,
  readCompletionObligationEvidence,
} from "../completion/obligation-evidence.ts";
import {
  buildEvidenceCapabilityLedger,
} from "./ledger-state.ts";
import type {
  EvidenceCapabilityReceipt,
  EvidenceCapabilityReference,
  RejectedEvidenceCapabilityReceipt,
} from "./types.ts";
import {
  evidenceReceiptsFromResult,
} from "./receipts.ts";
import {
  safeIdentifier,
  safeOptionalPublicText,
  safePublicText,
  safePublicTextArray,
  safeRelativePath,
  safeToolArgumentKeys,
  safeToolArgumentRecord,
  safeUrl,
} from "./transcript-sanitizers.ts";
import type {
  EvidenceArtifactRef,
  EvidenceReceipt,
  EvidenceReference,
} from "../../turn/native/output/tool-types.ts";

export const TOOL_RESULT_EVIDENCE_TRANSCRIPT_SCHEMA =
  "butler.tool-result-evidence-transcript.v1" as const;
const TOOL_CALL_ARGUMENTS_TRANSCRIPT_SCHEMA = "butler.tool-call-arguments-transcript.v1" as const;

export interface EvidenceTranscriptToolResult {
  schema_version: typeof TOOL_RESULT_EVIDENCE_TRANSCRIPT_SCHEMA;
  evidence_capability_receipts: EvidenceCapabilityReceipt[];
  evidence_receipts: EvidenceReceipt[];
  evidence_limitations: string[];
  completion_obligation_evidence: {
    outcome: ReturnType<typeof readCompletionObligationEvidence>["outcome"];
    satisfied: ReturnType<typeof readCompletionObligationEvidence>["satisfied"];
    missing_critical: ReturnType<typeof readCompletionObligationEvidence>["missingCritical"];
    missing_non_critical: ReturnType<typeof readCompletionObligationEvidence>["missingNonCritical"];
    limitations: string[];
  };
  rejected_evidence_capability_receipts?: RejectedEvidenceCapabilityReceipt[];
}

export interface EvidenceTranscriptToolCallArguments {
  schema_version: typeof TOOL_CALL_ARGUMENTS_TRANSCRIPT_SCHEMA;
  argument_keys: string[];
  safe_arguments: Record<string, unknown>;
}

export function evidenceTranscriptToolResultProjection(result: unknown): EvidenceTranscriptToolResult {
  const capabilityInputs = completionObligationEvidenceReceiptsFromResult(result);
  const legacyReceipts = evidenceReceiptsFromResult(result).map(safeLegacyEvidenceReceipt);
  const ledger = buildEvidenceCapabilityLedger({
    receipts: [...capabilityInputs, ...legacyReceipts],
  });
  const evidenceRead = readCompletionObligationEvidence({
    receipts: [...capabilityInputs, ...legacyReceipts],
  });
  const limitations = safePublicTextArray(evidenceRead.limitations);
  return {
    schema_version: TOOL_RESULT_EVIDENCE_TRANSCRIPT_SCHEMA,
    evidence_capability_receipts: ledger.receipts.map(safeCapabilityReceipt),
    evidence_receipts: legacyReceipts,
    evidence_limitations: limitations,
    completion_obligation_evidence: {
      outcome: evidenceRead.outcome,
      satisfied: evidenceRead.satisfied,
      missing_critical: evidenceRead.missingCritical,
      missing_non_critical: evidenceRead.missingNonCritical,
      limitations,
    },
    ...(ledger.rejectedReceipts.length > 0
      ? { rejected_evidence_capability_receipts: ledger.rejectedReceipts.map(safeRejectedReceipt) }
      : {}),
  };
}

export function evidenceTranscriptToolCallArgumentsProjection(args: Record<string, unknown>): EvidenceTranscriptToolCallArguments {
  return {
    schema_version: TOOL_CALL_ARGUMENTS_TRANSCRIPT_SCHEMA,
    argument_keys: safeToolArgumentKeys(args),
    safe_arguments: safeToolArgumentRecord(args),
  };
}

export function evidenceTranscriptErrorMessage(value: unknown): string {
  return safePublicText(value, "Tool execution failed.");
}

function safeCapabilityReceipt(receipt: EvidenceCapabilityReceipt): EvidenceCapabilityReceipt {
  return {
    receipt_id: safeIdentifier(receipt.receipt_id, "redacted-receipt"),
    schema_version: receipt.schema_version,
    producer: {
      kind: receipt.producer.kind,
      name: safeIdentifier(receipt.producer.name, "tool"),
      ...(receipt.producer.call_id ? { call_id: safeIdentifier(receipt.producer.call_id, "redacted-call") } : {}),
    },
    capability: receipt.capability,
    evidence_kind: receipt.evidence_kind,
    maturity: receipt.maturity,
    confidence: receipt.confidence,
    verified: receipt.verified,
    summary: safePublicText(receipt.summary, "Evidence capability was produced."),
    references: receipt.references.map(safeCapabilityReference).filter(isPresent),
    ...(receipt.satisfies && receipt.satisfies.length > 0 ? { satisfies: receipt.satisfies } : {}),
    limitations: safePublicTextArray(receipt.limitations),
    created_at: receipt.created_at,
  };
}

function safeCapabilityReference(reference: EvidenceCapabilityReference): EvidenceCapabilityReference | null {
  const safe: EvidenceCapabilityReference = {};
  const label = safeOptionalPublicText(reference.label);
  const url = safeUrl(reference.url);
  const path = safeRelativePath(reference.path);
  const artifactId = safeOptionalPublicText(reference.artifact_id);
  const toolCallId = safeOptionalPublicText(reference.tool_call_id);
  const taskId = safeOptionalPublicText(reference.task_id);
  if (label) {
    safe.label = label;
  }
  if (url) {
    safe.url = url;
  }
  if (path) {
    safe.path = path;
  }
  if (artifactId) {
    safe.artifact_id = artifactId;
  }
  if (toolCallId) {
    safe.tool_call_id = toolCallId;
  }
  if (taskId) {
    safe.task_id = taskId;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function safeLegacyEvidenceReceipt(receipt: EvidenceReceipt): EvidenceReceipt {
  const references = receipt.references.map(safeLegacyReference).filter(isPresent);
  const artifacts = (receipt.artifacts ?? []).map(safeLegacyArtifact).filter(isPresent);
  return {
    schema: receipt.schema,
    id: safeIdentifier(receipt.id, "redacted-receipt"),
    producer: {
      kind: receipt.producer.kind,
      name: safeIdentifier(receipt.producer.name, "tool"),
    },
    receiptType: receipt.receiptType,
    verified: receipt.verified,
    covers: safePublicTextArray(receipt.covers),
    summary: safePublicText(receipt.summary, "Evidence was produced."),
    references,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(receipt.satisfies && receipt.satisfies.length > 0 ? { satisfies: receipt.satisfies } : {}),
    ...(receipt.metrics ? { metrics: receipt.metrics } : {}),
  };
}

function safeLegacyReference(reference: EvidenceReference): EvidenceReference | null {
  const kind = reference.kind;
  const ref = kind === "url" ? safeUrl(reference.ref) : safeOptionalPublicText(reference.ref);
  const label = safeOptionalPublicText(reference.label);
  if (!ref) {
    return null;
  }
  return {
    kind,
    ref,
    ...(label ? { label } : {}),
  };
}

function safeLegacyArtifact(artifact: EvidenceArtifactRef): EvidenceArtifactRef | null {
  const id = safeOptionalPublicText(artifact.id);
  const label = safeOptionalPublicText(artifact.label);
  const path = safeRelativePath(artifact.path);
  const mediaType = safeOptionalPublicText(artifact.mediaType);
  const role = safeOptionalPublicText(artifact.role);
  const safe: EvidenceArtifactRef = {
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(path ? { path } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(role ? { role } : {}),
  };
  return Object.keys(safe).length > 0 ? safe : null;
}

function safeRejectedReceipt(receipt: RejectedEvidenceCapabilityReceipt): RejectedEvidenceCapabilityReceipt {
  return {
    ...(receipt.receipt_id ? { receipt_id: safeIdentifier(receipt.receipt_id, "redacted-receipt") } : {}),
    ...(receipt.schema_version ? { schema_version: safeIdentifier(receipt.schema_version, "unknown") } : {}),
    issues: receipt.issues.map((issue) => ({
      field: safeIdentifier(issue.field, "field"),
      code: safeIdentifier(issue.code, "issue"),
      message: safePublicText(issue.message, "Receipt was rejected."),
    })),
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
