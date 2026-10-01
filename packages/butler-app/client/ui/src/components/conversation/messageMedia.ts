import {
  absoluteGatewayUrl,
  messageFilePath,
  messageFileSource,
  type MessageFileLink,
} from "../../app/messageFileUrls.ts";
import type { MessageFileRef, SessionArtifactSummary } from "../../app/types";

/** Absolute URL for a message file (signed when known), or "#" for anything else. */
export function messageFileUrl(attachment: MessageFileLink): string {
  const source = messageFileSource(attachment);
  return source ? absoluteGatewayUrl(source) : "#";
}

/**
 * The message file a markdown image names: a `/message-files/<id>` path (with
 * the signed URL of a matching attachment or artifact) or the file name of an
 * image attachment.
 */
export function markdownImageFile(
  source: string | undefined,
  attachments: MessageFileRef[],
  artifacts: SessionArtifactSummary[] = [],
): MessageFileLink | undefined {
  if (!source) return undefined;
  const path = messageFilePath(source);
  if (path) {
    const files: MessageFileLink[] = [...attachments, ...artifacts];
    return files.find((file) => file.url === path) ?? { url: path };
  }

  const sourceFileName = normalizedFileName(source);
  if (!sourceFileName) return undefined;
  return attachments.find(
    (attachment) =>
      attachment.kind === "image" &&
      normalizedFileName(attachment.safe_name) === sourceFileName,
  );
}

export function resolveMarkdownImageSource(
  source: string | undefined,
  attachments: MessageFileRef[],
  artifacts: SessionArtifactSummary[] = [],
): string | undefined {
  if (!source) return undefined;
  const file = markdownImageFile(source, attachments, artifacts);
  return file ? messageFileUrl(file) : source;
}

function normalizedFileName(value: string): string {
  const withoutQuery = value.split(/[?#]/u)[0] ?? "";
  const fileName = withoutQuery.split(/[\\/]/u).at(-1) ?? "";
  try {
    return decodeURIComponent(fileName).toLocaleLowerCase("en-US");
  } catch {
    return fileName.toLocaleLowerCase("en-US");
  }
}
