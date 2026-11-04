import type { MessageContent } from "@/app/messageContent";
import type { ElementAttachment } from "../../../../shared/browser-element";

/** The image follows normal upload admission; its source data travels with the message. */
export function captureContent(content: MessageContent | undefined, text: string, elements: ElementAttachment[]): MessageContent | undefined {
  const captures = elements.filter(item => item.file.kind === "image" && item.metadata);
  if (!captures.length) return content;
  return {
    ...(content ?? { version: 1, parts: [{ type: "text", text }] }),
    attachment_metadata: {
      ...content?.attachment_metadata,
      ...Object.fromEntries(captures.map(item => [item.file.file_id, item.metadata])),
    },
  };
}
