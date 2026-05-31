import type { MessageFileRef } from "../../app/types";

const MESSAGE_FILE_URL_PATTERN = /^\/message-files\/file-[0-9a-f-]{36}$/iu;

export function messageFileUrl(attachment: Pick<MessageFileRef, "url">): string {
  if (!MESSAGE_FILE_URL_PATTERN.test(attachment.url)) return "#";
  const serverUrl =
    typeof window !== "undefined" ? window.butlerApp?.serverUrl : undefined;
  return serverUrl
    ? new URL(attachment.url, serverUrl).toString()
    : attachment.url;
}

export function resolveMarkdownImageSource(
  source: string | undefined,
  attachments: MessageFileRef[],
): string | undefined {
  if (!source) return undefined;
  if (MESSAGE_FILE_URL_PATTERN.test(source)) {
    return messageFileUrl({ url: source });
  }

  const sourceFileName = normalizedFileName(source);
  if (!sourceFileName) return source;

  const matchingAttachment = attachments.find(
    (attachment) =>
      attachment.kind === "image" &&
      normalizedFileName(attachment.safe_name) === sourceFileName,
  );
  return matchingAttachment ? messageFileUrl(matchingAttachment) : source;
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
