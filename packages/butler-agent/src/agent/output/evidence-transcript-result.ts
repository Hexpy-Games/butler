import { sanitizePublicText } from "../events/turn-events.ts";
import {
  completionObligationEvidenceReceiptsFromResult,
  readCompletionObligationEvidence,
} from "./completion-obligation-evidence.ts";
import {
  buildEvidenceCapabilityLedger,
} from "./evidence-capability-ledger-state.ts";
import type {
  EvidenceCapabilityReceipt,
  EvidenceCapabilityReference,
  RejectedEvidenceCapabilityReceipt,
} from "./evidence-capability-types.ts";
import {
  evidenceReceiptsFromResult,
} from "./evidence-receipts.ts";
import type {
  EvidenceArtifactRef,
  EvidenceReceipt,
  EvidenceReference,
} from "../turn/native/output/tool-types.ts";

export const TOOL_RESULT_EVIDENCE_TRANSCRIPT_SCHEMA =
  "butler.tool-result-evidence-transcript.v1" as const;

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
  schema_version: "butler.tool-call-arguments-transcript.v1";
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
    schema_version: "butler.tool-call-arguments-transcript.v1",
    argument_keys: Object.keys(args).map((key) => safeIdentifier(key, "argument")).slice(0, 24),
    safe_arguments: safeToolArgumentRecord(args),
  };
}

function safeToolArgumentRecord(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 24)) {
    safe[safeIdentifier(key, "argument")] = safeToolArgumentValue(key, value, 0);
  }
  return safe;
}

function safeToolArgumentValue(key: string, value: unknown, depth: number): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (depth > 2) return "[redacted]";
  if (typeof value === "string") return safePublicText(value, "[redacted]");
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeToolArgumentValue(key, item, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(record).slice(0, 16)) {
      safe[safeIdentifier(key, "field")] = safeToolArgumentValue(key, childValue, depth + 1);
    }
    return safe;
  }
  return null;
}

export function evidenceTranscriptErrorMessage(value: unknown): string {
  return safePublicText(value, "Tool execution failed.");
}

function isSensitiveKey(key: string): boolean {
  return /\b(?:api[_-]?key|token|secret|password|passphrase|authorization|auth|credential|credentials|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?key|cookie|set-cookie)\b/iu
    .test(key);
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
  if (label) safe.label = label;
  if (url) safe.url = url;
  if (path) safe.path = path;
  if (artifactId) safe.artifact_id = artifactId;
  if (toolCallId) safe.tool_call_id = toolCallId;
  if (taskId) safe.task_id = taskId;
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
  if (!ref) return null;
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

function safePublicTextArray(values: string[]): string[] {
  return values
    .map((value) => safeOptionalPublicText(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
}

function safePublicText(value: unknown, fallback: string): string {
  const stripped = stripHiddenReasoning(typeof value === "string" ? value : "");
  const sanitized = sanitizePublicText(stripped, fallback).trim();
  if (!sanitized || hasPrivateOrSecretSentinel(sanitized)) return fallback;
  return sanitized.slice(0, 320);
}

function safeOptionalPublicText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const safe = safePublicText(value, "");
  return safe ? safe.slice(0, 240) : null;
}

function safeIdentifier(value: unknown, fallback: string): string {
  const safe = safeOptionalPublicText(value);
  return safe?.replace(/\s+/gu, "-").slice(0, 120) || fallback;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function safeRelativePath(value: unknown): string | null {
  const text = safeOptionalPublicText(value);
  if (!text) return null;
  if (
    text.startsWith("/") ||
    text.startsWith("~") ||
    /^[A-Za-z]:[\\/]/u.test(text) ||
    text.split(/[\\/]+/u).includes("..")
  ) {
    return null;
  }
  return text;
}

function stripHiddenReasoning(value: string): string {
  return value.replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
    .replace(/<\/?think\b[^>]*>/giu, "");
}

function hasPrivateOrSecretSentinel(value: string): boolean {
  return (
    /SECRET[_-]?TOKEN/iu.test(value) ||
    /raw prompt text/iu.test(value) ||
    /<think\b|<\/think>/iu.test(value) ||
    /\/Users\/private\b/u.test(value) ||
    /(?:api[_-]?key|secret|token|authorization|bearer)\s*[:=]/iu.test(value)
  );
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
