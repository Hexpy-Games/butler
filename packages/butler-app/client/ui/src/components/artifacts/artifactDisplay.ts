import { appCopy } from "@/app/copy";
import { relativeAge } from "@/app/utils.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import { absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls.ts";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const TEXT_EXTENSIONS = [
  ".csv",
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
  | "web"
  | "html"
  | "image"
  | "markdown"
  | "pdf"
  | "text"
  | "unsupported";

/** Absolute URL for the artifact's file (signed when known), if it has one. */
export function artifactUrl(
  artifact: SessionArtifactSummary,
): string | undefined {
  const source = messageFileSource(artifact);
  return source ? absoluteGatewayUrl(source) : undefined;
}

/**
 * The artifact's size, as attachment tiles show it. Its type comes from the file name; the stored kind is an
 * internal, untranslated value (document, code, report, …), so it is never shown.
 */
export function artifactDescription(artifact: SessionArtifactSummary): string {
  return typeof artifact.size_bytes === "number" ? formatArtifactSize(artifact.size_bytes) : "";
}

export function artifactMeta(artifact: SessionArtifactSummary): string {
  return relativeAge(artifact.created_at);
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The artifact kind of a stored file, from the kind the agent decided by its content: text previews as text,
 * a picture as a picture, and any other file (an Office document, an archive) by its type or not at all.
 */
export function storedFileArtifactKind(file: { kind: string }): "image" | "document" | "file" {
  return file.kind === "image" ? "image" : file.kind === "text" ? "document" : "file";
}

export function artifactPreviewMode(
  artifact: SessionArtifactSummary,
): ArtifactPreviewMode {
  if (artifact.kind === "web") return "web";
  // The file's own path decides the renderer: a deliverable's title (and stored name) may carry no extension.
  const extension =
    artifactExtension(artifact.source_label ?? undefined) ||
    artifactExtension(artifact.safe_path_label) ||
    artifactExtension(artifact.title);
  if (artifact.kind === "image" || IMAGE_EXTENSIONS.includes(extension)) {
    return "image";
  }
  // A page Butler made runs on the content host; the user's own uploaded page is untrusted and shows as source.
  if ([".html", ".htm"].includes(extension)) return artifact.kind === "attachment" ? "text" : "html";
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
  const name = value?.trim().toLocaleLowerCase("en-US").split(/[/\\]/u).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}
