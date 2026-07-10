import { createHash, randomUUID } from "node:crypto";
import { createEvidenceCapabilityReceipt } from "../../../output/evidence/ledger.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function operationCover(toolName: string): string {
  if (toolName === "read_file") return "workspace_file_read";
  if (toolName === "write_file") return "workspace_file_written";
  if (toolName === "grep_files") return "workspace_search_result";
  return "workspace_file_operation";
}

export function fileToolEvidenceReceipt(input: {
  toolName: string;
  summary: string;
  references?: Record<string, unknown>;
  satisfies?: string[];
}) {
  return [{
    schema: "butler.evidence-receipt.v1",
    id: `receipt-${input.toolName}-${randomUUID()}`,
    producer: { kind: "tool", name: input.toolName },
    receiptType: "execution",
    verified: true,
    covers: ["execution_result", operationCover(input.toolName)],
    summary: input.summary,
    references: input.references ? [input.references] : [],
    satisfies: input.satisfies ?? ["source_verified"],
  }];
}

function safeWorkspacePath(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const trimmed = path.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return null;
  if (trimmed.split(/[\\/]+/u).includes("..")) return null;
  return trimmed;
}

export function fileToolCapabilityReceipt(input: {
  toolName: "read_file" | "write_file" | "grep_files";
  ok: boolean;
  path?: unknown;
  error?: unknown;
  truncated?: unknown;
  created?: unknown;
  overwritten?: unknown;
  bytes?: unknown;
  filesSearched?: unknown;
  filesSkipped?: unknown;
  matches?: unknown;
}) {
  if (input.toolName === "write_file" && input.ok) {
    const path = safeWorkspacePath(input.path);
    const receipts = [createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: input.toolName },
      capability: "workspace_mutated",
      evidence_kind: "mutation_result",
      maturity: "verified",
      verified: true,
      confidence: 1,
      summary: "File mutation completed with redacted path metadata.",
      scope: {
        operation: input.created ? "created" : input.overwritten ? "overwritten" : "written",
        created: Boolean(input.created),
        overwritten: Boolean(input.overwritten),
        bytes: typeof input.bytes === "number" ? input.bytes : undefined,
      },
      references: path ? [{ path }] : [],
    })];
    if (path) {
      receipts.push(createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: input.toolName },
        capability: "durable_artifact",
        evidence_kind: "artifact",
        maturity: "verified",
        verified: true,
        confidence: 0.95,
        summary: "File mutation produced durable workspace file evidence.",
        scope: {
          operation: input.created ? "created" : input.overwritten ? "overwritten" : "written",
          bytes: typeof input.bytes === "number" ? input.bytes : undefined,
        },
        references: [{ path }],
        satisfies: ["durable_artifact"],
      }));
    }
    return receipts;
  }

  if (input.toolName === "grep_files" && input.ok) {
    const truncated = Boolean(input.truncated);
    const references = sourceCandidateReferences(input.matches);
    return [createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: input.toolName },
      capability: "source_candidate",
      evidence_kind: "source_candidate",
      maturity: "candidate",
      verified: false,
      confidence: truncated ? 0.35 : 0.5,
      summary: "Workspace search returned candidate file matches for later verification.",
      scope: {
        tool: input.toolName,
        truncated,
        files_searched: typeof input.filesSearched === "number" ? input.filesSearched : undefined,
        files_skipped: typeof input.filesSkipped === "number" ? input.filesSkipped : undefined,
        match_count: Array.isArray(input.matches) ? input.matches.length : undefined,
        candidate_count: references.length,
      },
      references,
      limitations: ["Search candidate discovery is not source verification."],
    })];
  }

  if (input.toolName === "read_file" && input.ok) {
    const path = safeWorkspacePath(input.path);
    const truncated = Boolean(input.truncated);
    return [createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: input.toolName },
      capability: "source_verified",
      evidence_kind: "workspace_inspection",
      maturity: "verified",
      verified: true,
      confidence: truncated ? 0.75 : 0.95,
      summary: truncated
        ? "File inspection completed with bounded partial results."
        : "File inspection completed with redacted metadata.",
      scope: {
        tool: input.toolName,
        truncated,
        bytes: typeof input.bytes === "number" ? input.bytes : undefined,
        files_searched: typeof input.filesSearched === "number" ? input.filesSearched : undefined,
        files_skipped: typeof input.filesSkipped === "number" ? input.filesSkipped : undefined,
        match_count: Array.isArray(input.matches) ? input.matches.length : undefined,
      },
      references: path ? [{ path }] : [],
      satisfies: ["source_verified"],
      limitations: truncated ? ["Result was bounded and may be partial."] : [],
    })];
  }

  return [createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: input.toolName },
    capability: "limitation_recorded",
    evidence_kind: "limitation",
    maturity: "rejected",
    verified: false,
    confidence: 0.7,
    summary: "File tool execution was skipped or failed before producing verified evidence.",
    scope: {
      tool: input.toolName,
      error: typeof input.error === "string" ? input.error : "unknown_error",
    },
    limitations: ["No file content or private path was exposed in the receipt."],
  })];
}

function sourceCandidateReferences(matches: unknown): Array<{ path: string; label?: string }> {
  if (!Array.isArray(matches)) return [];
  const references = new Map<string, { path: string; label?: string }>();
  for (const value of matches) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const match = value as Record<string, unknown>;
    const path = safeWorkspacePath(match.path);
    if (!path || references.has(path)) continue;
    const line = typeof match.line === "number" && Number.isFinite(match.line) && match.line > 0
      ? Math.floor(match.line)
      : null;
    references.set(path, {
      path,
      ...(line ? { label: `line ${line}` } : {}),
    });
    if (references.size >= 12) break;
  }
  return [...references.values()];
}
