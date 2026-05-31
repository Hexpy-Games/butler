import { relativeAge } from "@/app/utils.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";

const MESSAGE_FILE_URL_PATTERN = /^\/message-files\/file-[0-9a-f-]{36}$/iu;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const TEXT_EXTENSIONS = [
  ".csv",
  ".html",
  ".json",
  ".log",
  ".md",
  ".txt",
  ".tsv",
  ".xml",
  ".yaml",
  ".yml",
];
const CODE_EXTENSIONS = [
  ".css",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
];

export type ArtifactPreviewMode =
  | "image"
  | "markdown"
  | "pdf"
  | "text"
  | "unsupported";

export function artifactUrl(
  artifact: SessionArtifactSummary,
): string | undefined {
  if (!artifact.url || !MESSAGE_FILE_URL_PATTERN.test(artifact.url))
    return undefined;
  const serverUrl =
    typeof window !== "undefined" ? window.butlerApp?.serverUrl : undefined;
  return serverUrl ? new URL(artifact.url, serverUrl).toString() : artifact.url;
}

export function artifactDescription(artifact: SessionArtifactSummary): string {
  const size =
    typeof artifact.size_bytes === "number"
      ? formatArtifactSize(artifact.size_bytes)
      : "";
  return [artifact.kind, size].filter(Boolean).join(" / ");
}

export function artifactMeta(artifact: SessionArtifactSummary): string {
  return relativeAge(artifact.created_at);
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function artifactPreviewMode(
  artifact: SessionArtifactSummary,
): ArtifactPreviewMode {
  const extension = artifactExtension(
    artifact.title || artifact.safe_path_label,
  );
  if (artifact.kind === "image" || IMAGE_EXTENSIONS.includes(extension)) {
    return "image";
  }
  if (extension === ".pdf" || artifact.kind === "report") return "pdf";
  if (extension === ".md") return "markdown";
  if (
    artifact.kind === "code" ||
    artifact.kind === "csv_file" ||
    artifact.kind === "table_file" ||
    artifact.kind === "document" ||
    TEXT_EXTENSIONS.includes(extension) ||
    CODE_EXTENSIONS.includes(extension)
  ) {
    return "text";
  }
  return "unsupported";
}

function artifactExtension(value: string | undefined): string {
  const name = value?.trim().toLocaleLowerCase("en-US") ?? "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}
