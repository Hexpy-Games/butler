import { api } from "./api.ts";
import type { ProjectDashboardDocument } from "./types.ts";

export async function readProjectDocumentPage(document: ProjectDashboardDocument, cursor?: string): Promise<ProjectDashboardDocument> {
  if (!document.project_id || !document.revision) {
    if (document.markdown) return document;
    throw new Error("Project source reference is missing.");
  }
  const query = new URLSearchParams({ kind: document.document_type ?? document.kind,
    id: document.id, revision: document.revision, ...(cursor ? { cursor } : {}) });
  return api<ProjectDashboardDocument>(`/projects/${encodeURIComponent(document.project_id)}/dashboard/source?${query}`);
}

/** Attachment compatibility until typed refs replace this path: never attach a partial report. */
export async function completeProjectDocument(document: ProjectDashboardDocument): Promise<ProjectDashboardDocument> {
  let page = await readProjectDocumentPage(document);
  let markdown = page.markdown;
  const cursors = new Set<string>();
  while (page.nextCursor) {
    if (cursors.has(page.nextCursor)) throw new Error("Project source cursor repeated.");
    cursors.add(page.nextCursor);
    page = await readProjectDocumentPage(page, page.nextCursor);
    markdown += page.markdown;
  }
  return { ...page, markdown, truncated: false, nextCursor: null };
}
