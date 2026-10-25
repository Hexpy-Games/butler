import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import type { AttachmentListItem } from "@/butler-ds";
import { formatFileSize } from "./conversationUtils";
import { attachmentViewerKind } from "./messageImages";
import { messageFileUrl } from "./messageMedia";

/** The tile's file-type label: the name's extension in capitals, or the localized "File". */
export function attachmentExtension(name: string): string {
  const match = /\.([\p{L}\p{N}]{1,5})$/u.exec(name.trim());
  return match ? match[1]!.toLocaleUpperCase("en-US") : appCopy.conversation.attachmentFileType;
}

/** The face of a tile for one stored file: its picture, its video's first frame, or its type. */
export function attachmentTile(file: MessageFileRef): Omit<AttachmentListItem, "id" | "icon" | "blockedReason"> {
  const kind = attachmentViewerKind(file);
  const src = messageFileUrl(file);
  return {
    name: file.safe_name,
    meta: formatFileSize(file.size_bytes),
    extension: attachmentExtension(file.safe_name),
    thumbnail: kind === "image" ? { src, alt: file.safe_name } : undefined,
    video: kind === "video" ? { src } : undefined,
  };
}

/**
 * Opens an attached file that is neither a picture nor a video in the conversation's file viewer.
 * `kind: "attachment"` marks it as the user's own upload: it is shown, never run.
 */
export function openAttachmentInViewer(file: MessageFileRef, sessionId: string) {
  const artifact: SessionArtifactSummary = {
    id: file.file_id, session_id: sessionId || undefined, file_id: file.file_id, title: file.safe_name, kind: "attachment",
    safe_path_label: file.safe_name, url: file.url, signed_url: file.signed_url, size_bytes: file.size_bytes,
    created_at: file.created_at,
  };
  useButlerStore.getState().openArtifact(artifact);
}
