import { existsSync, statSync } from "fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import type { ArtifactRef } from "../../../../test-support/harness/contracts.ts";
import type { ToolAuditEntry } from "./tool-types.ts";

const MAX_RUNTIME_ARTIFACT_REFS = 12;

export function runtimeArtifactsFromAudit(input: {
  audit: ToolAuditEntry[];
  butlerData: string;
  workspacePath: string;
}): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const entry of input.audit) {
    if (!entry.ok || !isRecord(entry.result)) continue;
    collectVerifiedOutputArtifacts({
      artifacts,
      seen,
      result: entry.result,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
    });
    collectPublicDataArtifacts({
      artifacts,
      seen,
      result: entry.result,
      butlerData: input.butlerData,
    });
    if (artifacts.length >= MAX_RUNTIME_ARTIFACT_REFS) break;
  }
  return artifacts.slice(0, MAX_RUNTIME_ARTIFACT_REFS);
}

function collectVerifiedOutputArtifacts(input: {
  artifacts: ArtifactRef[];
  seen: Set<string>;
  result: Record<string, unknown>;
  butlerData: string;
  workspacePath: string;
}): void {
  const verified = Array.isArray(input.result.verified_output_files)
    ? input.result.verified_output_files
    : [];
  const cwd = typeof input.result.cwd === "string" && input.result.cwd.trim()
    ? input.result.cwd.trim()
    : input.workspacePath;
  for (const [index, item] of verified.entries()) {
    if (input.artifacts.length >= MAX_RUNTIME_ARTIFACT_REFS) return;
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) continue;
    const safePathLabel = item.path.trim();
    const localPath = resolveVerifiedArtifactPath({
      cwd,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      safePathLabel,
    });
    if (!localPath) continue;
    appendRuntimeArtifact(input.artifacts, input.seen, {
      id: `artifact-${safeIdentifier(safePathLabel)}-${index + 1}`,
      kind: artifactKindFromValue(item.artifact_kind, localPath),
      title: basename(safePathLabel) || "Artifact",
      safePathLabel,
      localPath,
      mimeType: mimeTypeForPath(localPath),
      sizeBytes: numberValue(item.size_bytes) ?? fileSize(localPath),
      createdAt: typeof item.modified_at === "string" ? item.modified_at : undefined,
    });
  }
}

function collectPublicDataArtifacts(input: {
  artifacts: ArtifactRef[];
  seen: Set<string>;
  result: Record<string, unknown>;
  butlerData: string;
}): void {
  const labels = stringList(input.result.artifact_labels ?? input.result.artifact_label);
  if (labels.length === 0) return;
  const kinds = stringList(input.result.artifact_kinds ?? input.result.artifact_kind);
  const artifactId = typeof input.result.artifact_id === "string" && input.result.artifact_id.trim()
    ? input.result.artifact_id.trim()
    : null;
  const publicDataRoot = join(input.butlerData, "artifacts", "public-data");
  for (const [index, label] of labels.entries()) {
    if (input.artifacts.length >= MAX_RUNTIME_ARTIFACT_REFS) return;
    const localPath = resolveUnderRoot(publicDataRoot, label);
    if (!localPath || !existsSync(localPath)) continue;
    const title = typeof input.result.title === "string" && input.result.title.trim()
      ? input.result.title.trim()
      : basename(label);
    appendRuntimeArtifact(input.artifacts, input.seen, {
      id: labels.length === 1 && artifactId
        ? artifactId
        : `artifact-${artifactId ?? safeIdentifier(label)}-${index + 1}`,
      kind: artifactKindFromValue(kinds[index] ?? kinds[0], localPath),
      title,
      safePathLabel: label,
      localPath,
      mimeType: mimeTypeForPath(localPath),
      sizeBytes: fileSize(localPath),
    });
  }
}

function appendRuntimeArtifact(
  artifacts: ArtifactRef[],
  seen: Set<string>,
  artifact: ArtifactRef,
): void {
  const key = artifact.localPath
    ? `path:${resolve(artifact.localPath)}`
    : `id:${artifact.id}:${artifact.safePathLabel ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  artifacts.push(artifact);
}

function resolveVerifiedArtifactPath(input: {
  cwd: string;
  butlerData: string;
  workspacePath: string;
  safePathLabel: string;
}): string | null {
  const cwd = resolve(input.cwd);
  const workspace = resolve(input.workspacePath);
  const candidate = resolve(cwd, input.safePathLabel);
  if (isPathInsideRoot(candidate, workspace) && existsSync(candidate)) {
    return candidate;
  }
  if (!input.safePathLabel.startsWith("artifacts/")) return null;
  const dataCandidate = resolveUnderRoot(input.butlerData, input.safePathLabel);
  return dataCandidate && existsSync(dataCandidate) ? dataCandidate : null;
}

function resolveUnderRoot(root: string, child: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, child);
  return isPathInsideRoot(candidate, resolvedRoot) ? candidate : null;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function artifactKindFromValue(value: unknown, localPath?: string): ArtifactRef["kind"] {
  if (
    value === "csv_file" ||
    value === "table_file" ||
    value === "chart_file" ||
    value === "image" ||
    value === "document" ||
    value === "code" ||
    value === "report" ||
    value === "file"
  ) {
    return value;
  }
  const ext = localPath ? extname(localPath).toLocaleLowerCase("en-US") : "";
  if (ext === ".csv") return "csv_file";
  if (ext === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "report";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"].includes(ext)) return "code";
  if ([".md", ".txt", ".json", ".html"].includes(ext)) return "document";
  return "file";
}

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLocaleLowerCase("en-US");
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json";
  if (ext === ".html") return "text/html";
  if (ext === ".md" || ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

function fileSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-").slice(0, 48) || "artifact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
