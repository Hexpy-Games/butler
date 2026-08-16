import { basename, extname, isAbsolute } from "node:path";
import type { BtccFinalArtifact } from "../contracts.ts";
import { digest } from "../identity/index.ts";
import type { GuidedToolJournalRecord } from
  "../ports/index.ts";

const MAX_FINAL_ARTIFACTS = 12;
const MAX_FINAL_ARTIFACT_BYTES = 10 * 1024 * 1024;

export function collectGuidedFinalArtifacts(
  records: readonly GuidedToolJournalRecord[],
): BtccFinalArtifact[] {
  const artifacts: BtccFinalArtifact[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.status !== "completed") continue;
    const result = object(record.result);
    if (!result || result.ok === false) continue;
    for (const candidate of artifactCandidates(result)) {
      const artifact = finalArtifact(candidate);
      if (!artifact || seen.has(artifact.safePathLabel)) continue;
      seen.add(artifact.safePathLabel);
      artifacts.push(artifact);
      if (artifacts.length >= MAX_FINAL_ARTIFACTS) return artifacts;
    }
  }
  return artifacts;
}

function artifactCandidates(result: Record<string, unknown>): unknown[] {
  return [
    ...(Array.isArray(result.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result.verified_output_files)
      ? result.verified_output_files : []),
  ];
}

function finalArtifact(value: unknown): BtccFinalArtifact | null {
  const candidate = object(value);
  if (!candidate) return null;
  const safePathLabel = safeArtifactPath(candidate.path);
  if (!safePathLabel) return null;
  const sizeBytes = finitePositiveNumber(
    candidate.size_bytes ?? candidate.sizeBytes,
  );
  if (sizeBytes !== undefined && sizeBytes > MAX_FINAL_ARTIFACT_BYTES) return null;
  const kind = artifactKind(candidate.artifact_kind ?? candidate.kind);
  const mimeType = safeText(candidate.mediaType ?? candidate.mime_type) ??
    mimeTypeForPath(safePathLabel);
  const createdAt = safeText(candidate.modified_at ?? candidate.createdAt);
  const identity = {
    safePathLabel,
    kind,
    mimeType,
    sizeBytes,
    createdAt,
  };
  return {
    id: `artifact-${digest(JSON.stringify(identity))}`,
    kind,
    title: basename(safePathLabel),
    safePathLabel,
    mimeType,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function safeArtifactPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    return null;
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts[0] !== "artifacts") return null;
  return parts.join("/");
}

function artifactKind(value: unknown): BtccFinalArtifact["kind"] {
  if (
    value === "csv_file" || value === "table_file" ||
    value === "chart_file" || value === "image" ||
    value === "document" || value === "code" || value === "report" ||
    value === "file"
  ) {
    return value;
  }
  return "unknown";
}

function mimeTypeForPath(path: string): string {
  const extension = extname(path).toLocaleLowerCase("en-US");
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".csv") return "text/csv";
  if (extension === ".json") return "application/json";
  if ([".txt", ".md", ".ts", ".tsx", ".js", ".jsx"].includes(extension)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : undefined;
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}
