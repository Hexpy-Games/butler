export interface ProjectSourceReference {
  kind: "work" | "task" | "plan" | "spec" | "report" | "message" | "reference";
  id: string;
  revision: string;
}
export interface ProjectSourceContentPart {
  type: "project_source_ref";
  projectId: string;
  source: ProjectSourceReference;
  titleSnapshot: string;
  /** Quoted subject selected by the user; never a status mutation or instruction. */
  topic?: string;
}
/** Server-resolved, persisted alongside the accepted queue input. Never accepted from a request body. */
export interface ResolvedProjectSource {
  projectId: string;
  source: ProjectSourceReference;
  title: string;
  topic?: string;
  safeExcerpt: string;
  excerptTruncated: boolean;
  originalRef: { fileId: string; sha256: string; sizeBytes: number };
}
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "session_ref"; sessionId: string; titleSnapshot: string }
  | ProjectSourceContentPart;
export interface MessageContent { version: 1; parts: MessageContentPart[] }
export interface ResolvedSessionReference {
  sessionId: string; title: string; canonicalSessionId: string | null;
  status: "available" | "empty" | "unavailable"; preview: string;
}

export function isMessageContent(value: unknown): value is MessageContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Partial<MessageContent>;
  return doc.version === 1 && Array.isArray(doc.parts) && doc.parts.length <= 1000 && doc.parts.every(part =>
    part && typeof part === "object" && (part.type === "text"
      ? typeof part.text === "string"
      : part.type === "session_ref" ? typeof part.sessionId === "string" && part.sessionId.trim().length > 0 &&
        typeof part.titleSnapshot === "string" : isProjectSourceContentPart(part)));
}

export function isProjectSourceContentPart(value: unknown): value is ProjectSourceContentPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Partial<ProjectSourceContentPart>;
  return part.type === "project_source_ref" && typeof part.projectId === "string" && part.projectId.length > 0 && part.projectId.length <= 256 &&
    typeof part.titleSnapshot === "string" && part.titleSnapshot.length <= 500 &&
    (part.topic === undefined || typeof part.topic === "string" && part.topic.trim().length > 0 && part.topic.length <= 80) && !!part.source &&
    ["work", "task", "plan", "spec", "report", "message", "reference"].includes(part.source.kind) &&
    typeof part.source.id === "string" && part.source.id.length > 0 && part.source.id.length <= 256 &&
    typeof part.source.revision === "string" && /^[a-f0-9]{64}$/u.test(part.source.revision);
}

export function messageContentText(content: MessageContent): string {
  return content.parts.map(part => part.type === "text" ? part.text : `@${part.titleSnapshot}`).join("");
}

export function readMessageContent(json: string | null | undefined): MessageContent | undefined {
  if (!json) return undefined;
  const parsed: unknown = JSON.parse(json);
  if (!isMessageContent(parsed)) throw new Error("invalid_message_content");
  return parsed;
}
