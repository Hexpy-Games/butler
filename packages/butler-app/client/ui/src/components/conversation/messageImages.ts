import { createContext, useContext } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import type { MessageRecord, SessionArtifactSummary } from "@/app/types";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { markdownImageFile, messageFileUrl } from "./messageMedia";

/** Opens the viewer on the message's pictures at the one with this key (a `/message-files/…` path or an image URL). */
export const MessageImageContext = createContext<((key: string) => void) | undefined>(undefined);
export const useOpenMessageImage = () => useContext(MessageImageContext);

type Keyed = ViewerImage & { key: string };

function markdownImages(text: string): Array<{ src: string; alt: string }> {
  const definitions = new Map<string, string>();
  const images: Array<{ url?: string; identifier?: string; alt?: string | null }> = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(text));
  return images.flatMap((image) => {
    const src = image.url ?? definitions.get(image.identifier ?? "");
    return src ? [{ src, alt: image.alt ?? "" }] : [];
  });
}

/** The message's pictures in reading order: images in its text, then its other image files. */
export function messageViewerImages(message: MessageRecord): Keyed[] {
  const attachments = message.attachments ?? [];
  const artifacts = message.artifacts ?? [];
  const sessionId = message.chat_id;
  const seen = new Set<string>();
  const images: Keyed[] = [];
  const add = (image: Keyed) => { if (image.src && !seen.has(image.key)) { seen.add(image.key); images.push(image); } };
  for (const { src, alt } of markdownImages(message.text)) {
    const file = markdownImageFile(src, attachments, artifacts);
    if (file?.url) add({ key: file.url, src: messageFileUrl(file), alt, caption: alt || undefined, sessionId });
    else if (/^(https?:|data:image\/|\/)/iu.test(src)) add({ key: src, src, alt, caption: alt || undefined, sessionId });
  }
  const files: Array<Pick<SessionArtifactSummary, "kind" | "url" | "signed_url" | "title">> = artifacts.length
    ? artifacts : attachments.map((file) => ({ kind: file.kind === "image" ? "image" : "file", url: file.url, signed_url: file.signed_url, title: file.safe_name }));
  for (const file of files) {
    if (file.kind === "image" && file.url) add({ key: file.url, src: messageFileUrl(file), alt: file.title, sessionId });
  }
  return images;
}

export function openMessageImage(message: MessageRecord, key: string) {
  const images = messageViewerImages(message);
  openImageViewer(images, images.findIndex((image) => image.key === key));
}
