import type { ChangedFileDetail, MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";

/** One row of the changed-files block: a diff (with its stored copy, if any) or a new file. */
export interface WorkingFileRow {
  key: string;
  change?: ChangedFileDetail;
  file?: MessageFileRef;
}

/** Messages stored before files carried their workspace label render exactly as before. */
export function isLegacyFileMessage(attachments: MessageFileRef[]): boolean {
  return attachments.every((attachment) => attachment.source_label == null);
}

/** The artifact summary the viewer and save action use for a stored message file. */
export function fileArtifact(attachment: MessageFileRef): SessionArtifactSummary {
  return {
    id: `artifact-${attachment.file_id}`,
    file_id: attachment.file_id,
    title: attachment.safe_name,
    kind: attachment.kind === "image" ? "image" : "file",
    safe_path_label: attachment.safe_name,
    source_label: attachment.source_label,
    deliverable: attachment.deliverable,
    url: attachment.url,
    signed_url: attachment.signed_url,
    size_bytes: attachment.size_bytes,
    created_at: attachment.created_at,
    open_action: "route",
  };
}

/**
 * Diff rows first (paired with their stored copy by `file_id`), then the files the turn
 * made that are neither delivered, paired with a diff, nor shown inline in the answer.
 */
export function workingFileRows(
  changes: ChangedFileDetail[],
  attachments: MessageFileRef[],
  inlineImageUrls: () => Set<string>,
): WorkingFileRow[] {
  const byId = new Map(attachments.map((attachment) => [attachment.file_id, attachment]));
  const diffRows = changes.map((change) => ({
    key: `change:${change.path}`,
    change,
    file: change.file_id ? byId.get(change.file_id) : undefined,
  }));
  if (isLegacyFileMessage(attachments)) return diffRows;
  const paired = new Set(changes.map((change) => change.file_id).filter(Boolean));
  const generated = attachments.filter((attachment) =>
    !attachment.deliverable && attachment.source_label != null && !paired.has(attachment.file_id));
  const inline = generated.some((file) => file.kind === "image") ? inlineImageUrls() : new Set<string>();
  return [
    ...diffRows,
    ...generated
      .filter((file) => file.kind !== "image" || !inline.has(file.url))
      .map((file) => ({ key: `file:${file.file_id}`, file })),
  ];
}
