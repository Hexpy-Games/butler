import type { ConversationMessage, MessageFileRef, SessionArtifactSummary } from "../../../butler-protocol/src/index.ts";
export type ViewMode = "image" | "markdown" | "text" | "pdf" | "html" | "unsupported";
export type ResultTarget =
  | { kind: "image"; path: string; title: string }
  | { kind: "file"; id: string; name: string; title: string; type?: string }
  | { kind: "output"; id: string; title: string }
  | { kind: "doc"; id: string; title: string }
  | { kind: "url"; url: string; title: string };
export type ViewerParams = { kind: "file" | "output" | "doc" | "url"; id: string; title: string; name?: string; type?: string };

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const TEXT_EXTENSIONS = [".csv", ".json", ".log", ".md", ".txt", ".tsv", ".xml", ".yaml", ".yml"];
const CODE_EXTENSIONS = [".css", ".go", ".java", ".js", ".jsx", ".kt", ".py", ".rs", ".ts", ".tsx"];

export function extension(value?: string): string {
  const name = value?.trim().toLocaleLowerCase("en-US").split(/[/\\]/u).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

export function fileViewMode(name: string, kind?: string): ViewMode {
  const ext = extension(name);
  if (kind === "image" || IMAGE_EXTENSIONS.includes(ext)) return "image";
  if ([".html", ".htm"].includes(ext)) return "html";
  if (ext === ".pdf" || kind === "report") return "pdf";
  if (ext === ".md") return "markdown";
  if (kind === "code" || kind === "csv_file" || kind === "table_file" || kind === "document"
    || TEXT_EXTENSIONS.includes(ext) || CODE_EXTENSIONS.includes(ext)) return "text";
  return "unsupported";
}

export function artifactName(a: SessionArtifactSummary): string {
  return [a.source_label, a.safe_path_label, a.title].find(name => extension(name ?? undefined)) ?? a.title;
}

export function artifactTarget(a: SessionArtifactSummary): ResultTarget | null {
  if (a.kind === "web") return { kind: "output", id: a.id, title: a.title };
  if (a.kind === "doc") return { kind: "doc", id: a.id, title: a.title };
  if (!a.file_id) return null;
  if (fileViewMode(artifactName(a), a.kind) === "image") {
    return { kind: "image", path: `/message-files/${encodeURIComponent(a.file_id)}`, title: a.title };
  }
  return { kind: "file", id: a.file_id, name: artifactName(a), title: a.title, type: a.kind };
}

export function fileArtifact(file: MessageFileRef): SessionArtifactSummary {
  return {
    id: `artifact-${file.file_id}`, file_id: file.file_id, title: file.safe_name,
    kind: file.kind === "image" ? "image" : "file", safe_path_label: file.safe_name,
    source_label: file.source_label, deliverable: file.deliverable, url: file.url,
    signed_url: file.signed_url, size_bytes: file.size_bytes, created_at: file.created_at, open_action: "route",
  };
}

export function messageResults(message: Pick<ConversationMessage, "artifacts" | "attachments">): SessionArtifactSummary[] {
  const attachments = message.attachments ?? [];
  const legacy = attachments.every(x => x.source_label == null);
  return (message.artifacts?.length ? message.artifacts : attachments.map(fileArtifact)).filter(a => legacy || a.deliverable);
}

export function sessionResults(summary: SessionArtifactSummary[], messages: ConversationMessage[]): SessionArtifactSummary[] {
  const latest = new Map<string, SessionArtifactSummary>();
  for (const artifact of [...summary, ...messages.flatMap(message => message.artifacts ?? [])]) {
    if (artifact.deliverable !== true) continue;
    const key = artifact.source_label && artifact.sha256
      ? JSON.stringify([artifact.source_label, artifact.sha256])
      : artifact.id;
    const previous = latest.get(key);
    if (!previous || artifact.created_at >= previous.created_at) latest.set(key, artifact);
  }
  return [...latest.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function resultDescription(name: string, size?: number): string {
  return [extension(name).slice(1).toUpperCase(), size === undefined ? "" : formatSize(size)].filter(Boolean).join(" · ");
}

export function viewerParams(t: Exclude<ResultTarget, { kind: "image" }>): ViewerParams {
  if (t.kind === "url") return { kind: t.kind, id: t.url, title: t.title };
  return { ...t };
}

export function paramsTarget(p: ViewerParams): Exclude<ResultTarget, { kind: "image" }> {
  if (p.kind === "url") return { kind: "url", url: p.id, title: p.title };
  if (p.kind === "file") return { kind: "file", id: p.id, title: p.title, name: p.name!, type: p.type };
  return { kind: p.kind, id: p.id, title: p.title };
}

export function markdownFileName(title: string): string {
  const base = title.trim().replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/gu, " ").slice(0, 80).trim() || "project-document";
  return base.toLocaleLowerCase("en-US").endsWith(".md") ? base : `${base}.md`;
}
