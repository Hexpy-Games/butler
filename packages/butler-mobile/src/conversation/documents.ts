import type { MessageContent, ProjectDashboardDocument, ProjectDashboardDocumentType, ProjectSourceContentPart, SessionBranchRequest } from "../../../butler-protocol/src/index.ts";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import type { getAppCopy } from "../../../butler-i18n/src/index.ts";

// Matches packages/butler-app/client/ui/src/components/conversation/conversationUtils.tsx.
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export function documentContent(text: string, references: ProjectSourceContentPart[]): MessageContent {
  return { version: 1, parts: [{ type: "text", text }, ...references] };
}

export function branchDestination(project: boolean, title: string, projectId?: string): SessionBranchRequest["destination"] {
  return project ? { kind: "new_project", name: title }
    : projectId ? { kind: "project", projectId } : { kind: "chat" };
}

export function documentKindLabel(type: ProjectDashboardDocumentType, copy: ReturnType<typeof getAppCopy>): string {
  if (type === "artifact") return copy.projectSignpost.results;
  if (type === "task") return copy.interfaceStatus.task;
  if (type === "plan") return copy.composer.plan;
  if (type === "roadmap") return copy.projectDocumentMetadata.roadmap;
  if (type === "spec") return copy.interfaceStatus.spec;
  if (type === "report" || type === "message") return copy.interfaceStatus.report;
  if (type === "reference") return copy.projectSignpost.history;
  return copy.projectDocumentMetadata.document;
}

export function projectDocumentFileName(document: ProjectDashboardDocument): string {
  const base = document.title.trim().replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/gu, " ").slice(0, 80).trim() || "project-document";
  return base.toLocaleLowerCase("en-US").endsWith(".md") ? base : `${base}.md`;
}

export async function readProjectDocumentPage(client: GatewayClient, document: ProjectDashboardDocument, cursor?: string): Promise<ProjectDashboardDocument> {
  if (!document.project_id || !document.revision) {
    if (document.markdown) return document;
    throw new Error("Project source reference is missing.");
  }
  const query = new URLSearchParams({ kind: document.document_type ?? document.kind,
    id: document.id, revision: document.revision, ...(cursor ? { cursor } : {}) });
  return client.request(`/projects/${encodeURIComponent(document.project_id)}/dashboard/source?${query}`);
}

export async function completeProjectDocument(client: GatewayClient, document: ProjectDashboardDocument): Promise<ProjectDashboardDocument> {
  let page = await readProjectDocumentPage(client, document);
  let markdown = page.markdown;
  const cursors = new Set<string>();
  while (page.nextCursor) {
    if (cursors.has(page.nextCursor)) throw new Error("Project source cursor repeated.");
    cursors.add(page.nextCursor);
    page = await readProjectDocumentPage(client, page, page.nextCursor);
    markdown += page.markdown;
  }
  return { ...page, markdown, truncated: false, nextCursor: null };
}
