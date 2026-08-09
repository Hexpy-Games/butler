import { createHash, randomUUID } from "node:crypto";
import { createEvidenceCapabilityReceipt } from "../../../output/evidence/ledger.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function operationCover(toolName: string): string {
  if (toolName === "read_file") return "workspace_file_read";
  if (toolName === "write_file" || toolName === "edit_file") {
    return "workspace_file_written";
  }
  if (toolName === "grep_files") return "workspace_search_result";
  if (toolName === "list_files") return "workspace_file_list";
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

export function safeWorkspacePath(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const trimmed = path.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.startsWith("~")) return null;
  if (/^[A-Za-z]:/u.test(trimmed)) return null;
  if (trimmed.split(/[\\/]+/u).includes("..")) return null;
  return trimmed;
}

export function fileToolCapabilityReceipt(input: {
  toolName: "read_file" | "write_file" | "edit_file" | "grep_files" | "list_files";
  ok: boolean;
  path?: unknown;
  paths?: unknown;
  error?: unknown;
  truncated?: unknown;
  created?: unknown;
  overwritten?: unknown;
  edited?: unknown;
  bytes?: unknown;
  filesSearched?: unknown;
  filesSkipped?: unknown;
  matches?: unknown;
  files?: unknown;
  dirsVisited?: unknown;
  filesConsidered?: unknown;
  sha256?: unknown;
  applied?: unknown;
  conflicting?: unknown;
  not_attempted?: unknown;
}) {
  if (
    (input.toolName === "write_file" || input.toolName === "edit_file") &&
    input.ok
  ) {
    const path = safeWorkspacePath(input.path);
    const paths = safeWorkspacePaths(input.paths);
    const applied = safeMutationRecordPaths(input.applied);
    const mutationReferences = paths.length > 0
      ? paths.map((value) => ({ path: value }))
      : path ? [{ path }] : [];
    const receipts = [createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: input.toolName },
      capability: "workspace_mutated",
      evidence_kind: "mutation_result",
      maturity: "verified",
      verified: true,
      confidence: 1,
      summary: "File mutation completed with redacted path metadata.",
      scope: {
        operation: input.created
          ? "created"
          : input.edited ? "edited" : input.overwritten ? "overwritten" : "written",
        created: Boolean(input.created),
        overwritten: Boolean(input.overwritten),
        paths,
        applied,
        files_written: paths.length > 0 ? paths.length : undefined,
        bytes: typeof input.bytes === "number" ? input.bytes : undefined,
      },
      references: mutationReferences,
    })];
    if (path || paths.length > 0) {
      receipts.push(createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: input.toolName },
        capability: "durable_artifact",
        evidence_kind: "artifact",
        maturity: "verified",
        verified: true,
        confidence: 0.95,
        summary: "File mutation produced durable workspace file evidence.",
        scope: {
          operation: input.created
            ? "created"
            : input.edited ? "edited" : input.overwritten ? "overwritten" : "written",
          paths,
          applied,
          bytes: typeof input.bytes === "number" ? input.bytes : undefined,
        },
        references: mutationReferences,
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

  if (input.toolName === "list_files" && input.ok) {
    const files = Array.isArray(input.files) ? input.files : [];
    return [createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: input.toolName },
      capability: "source_candidate",
      evidence_kind: "workspace_inspection",
      maturity: "candidate",
      verified: false,
      confidence: input.truncated ? 0.75 : 0.95,
      summary: "Workspace file discovery completed with bounded path metadata.",
      scope: {
        tool: input.toolName,
        truncated: Boolean(input.truncated),
        files_considered: typeof input.filesConsidered === "number" ? input.filesConsidered : undefined,
        dirs_visited: typeof input.dirsVisited === "number" ? input.dirsVisited : undefined,
        file_count: files.length,
      },
      references: sourceCandidateReferences(files),
      limitations: input.truncated ? ["Discovery was bounded and may be partial."] : [],
    })];
  }

  if (input.toolName === "read_file" && input.ok) {
    const truncated = Boolean(input.truncated);
    const files = Array.isArray(input.files) ? input.files : null;
    const references = files
      ? readFileReferences(files)
      : (() => {
        const path = safeWorkspacePath(input.path);
        if (!path) return [];
        return [{
          path,
          ...(typeof input.sha256 === "string" && /^[a-f0-9]{64}$/u.test(input.sha256) ? { sha256: input.sha256 } : {}),
          ...(typeof input.bytes === "number" && Number.isFinite(input.bytes) && input.bytes >= 0 ? { bytes: Math.floor(input.bytes) } : {}),
        }];
      })();
    // A batch is source-verifying only when it can name at least one admitted
    // workspace-relative success. Failed-only or unreferenceable batches must
    // remain limitation evidence rather than claiming verification.
    if (references.length === 0) {
      return [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: input.toolName },
        capability: "limitation_recorded",
        evidence_kind: "limitation",
        maturity: "rejected",
        verified: false,
        confidence: 0.7,
        summary: "File inspection produced no safe admitted file reference for verification.",
        scope: {
          tool: input.toolName,
          batch: Boolean(files),
          truncated,
        },
        limitations: ["No file content or private path was exposed in the receipt."],
      })];
    }
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
        batch: Boolean(files),
        files_requested: files ? files.length : undefined,
        files_verified: references.length,
        truncated,
        bytes: typeof input.bytes === "number" ? input.bytes : undefined,
        files_searched: typeof input.filesSearched === "number" ? input.filesSearched : undefined,
        files_skipped: typeof input.filesSkipped === "number" ? input.filesSkipped : undefined,
        match_count: Array.isArray(input.matches) ? input.matches.length : undefined,
      },
      references,
      satisfies: ["source_verified"],
      limitations: truncated ? ["Result was bounded and may be partial."] : [],
    })];
  }

  if (
    (input.toolName === "write_file" || input.toolName === "edit_file") &&
    !input.ok
  ) {
    const paths = safeWorkspacePaths(input.paths);
    const applied = safeMutationRecordPaths(input.applied);
    const conflicting = safeMutationRecordPaths(input.conflicting);
    const notAttempted = safeMutationRecordPaths(input.not_attempted);
    return [createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: input.toolName },
      capability: "limitation_recorded",
      evidence_kind: "mutation_result",
      maturity: "rejected",
      verified: false,
      confidence: 0.9,
      summary: "File mutation was rejected or stopped with bounded conflict state.",
      scope: {
        tool: input.toolName,
        error: typeof input.error === "string" ? input.error : "unknown_error",
        paths,
        applied,
        conflicting,
        not_attempted: notAttempted,
      },
      references: [...new Set([...applied, ...conflicting, ...notAttempted, ...paths])].map((path) => ({ path })),
      limitations: ["No file content or private absolute path was exposed in the receipt."],
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

function safeWorkspacePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const path = safeWorkspacePath(item);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= 20) break;
  }
  return paths;
}

function safeMutationRecordPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return safeWorkspacePaths(value.map((item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).path
      : undefined
  )));
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

function readFileReferences(files: unknown): Array<{ path: string; bytes?: number; sha256?: string }> {
  if (!Array.isArray(files)) return [];
  const references: Array<{ path: string; bytes?: number; sha256?: string }> = [];
  const seen = new Set<string>();
  for (const value of files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.ok !== true || record.skipped === true) continue;
    const path = safeWorkspacePath(record.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    references.push({
      path,
      ...(typeof record.bytes === "number" && Number.isFinite(record.bytes) && record.bytes >= 0 ? { bytes: Math.floor(record.bytes) } : {}),
      ...(typeof record.sha256 === "string" && /^[a-f0-9]{64}$/u.test(record.sha256) ? { sha256: record.sha256 } : {}),
    });
    if (references.length >= 12) break;
  }
  return references;
}
