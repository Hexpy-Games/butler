import type { MessageContent, ResolvedProjectSource } from "../../../../foundation/message-content.ts";
import type { ChatRow } from "../../infrastructure/core/records.ts";
import type { ProjectDashboardDocument } from "../../interface/protocol/session-dashboard-contract.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const TOTAL_EXCERPT_CHARACTERS = 4_000;

export async function resolveProjectSourceReferences(input: {
  chat: ChatRow | null; content?: MessageContent;
  readSource(projectId: string, query: { kind: string; id: string; revision: string; cursor?: string }): Promise<ProjectDashboardDocument>;
  messageFiles: AppMessageFileStore;
}): Promise<ResolvedProjectSource[]> {
  const parts = input.content?.parts.filter((part) => part.type === "project_source_ref") ?? [];
  if (!parts.length) return [];
  const chat = input.chat;
  if (!chat || chat.archived || !chat.project_id || parts.some((part) => part.projectId !== chat.project_id)) {
    throw new AppStoreOperationError(409, "project_source_scope_changed", "Project source scope changed.");
  }
  const refs = [...new Map(parts.map((part) => [`${part.source.kind}:${part.source.id}`, part])).values()];
  if (refs.length > 8 || parts.some((part) => refs.some((ref) => ref.source.kind === part.source.kind && ref.source.id === part.source.id && ref.source.revision !== part.source.revision))) {
    throw new AppStoreOperationError(400, "invalid_project_sources", "At most eight consistent project sources are allowed.");
  }
  let remaining = TOTAL_EXCERPT_CHARACTERS;
  const result: ResolvedProjectSource[] = [];
  for (const part of refs) {
    let page = await input.readSource(chat.project_id, part.source);
    const revision = page.revision!;
    const chunks = [page.markdown];
    let bytes = Buffer.byteLength(page.markdown);
    const seen = new Set<string>();
    while (page.nextCursor) {
      if (bytes > MAX_SOURCE_BYTES || seen.has(page.nextCursor)) throw new AppStoreOperationError(413, "project_source_too_large", "Project source exceeds the snapshot limit.");
      seen.add(page.nextCursor);
      page = await input.readSource(chat.project_id, { ...part.source, revision, cursor: page.nextCursor });
      if (page.revision !== revision) throw new AppStoreOperationError(409, "source_changed", "Project source changed.");
      bytes += Buffer.byteLength(page.markdown); chunks.push(page.markdown);
    }
    if (bytes > MAX_SOURCE_BYTES) throw new AppStoreOperationError(413, "project_source_too_large", "Project source exceeds the snapshot limit.");
    const original = chunks.join("");
    const file = input.messageFiles.create({ ownerSessionId: chat.id, name: `${page.title || "project-source"}.md`,
      mimeType: "text/markdown", bytes: original }).file;
    const excerpt = original.slice(0, Math.min(remaining, 1000));
    remaining -= excerpt.length;
    result.push({ projectId: chat.project_id, source: { ...part.source, revision }, title: page.title,
      safeExcerpt: excerpt, excerptTruncated: excerpt.length < original.length,
      originalRef: { fileId: file.file_id, sha256: file.sha256, sizeBytes: file.size_bytes } });
  }
  return result;
}
