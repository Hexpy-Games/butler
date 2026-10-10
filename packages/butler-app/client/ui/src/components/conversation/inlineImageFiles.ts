import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import { markdownImageFile } from "./messageMedia";

/** Parse the same Markdown image syntax, excluding code and ordinary links. */
export function inlineImageFiles(text: string, attachments: MessageFileRef[], artifacts: SessionArtifactSummary[]) {
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const images: Array<{ url?: string; identifier?: string }> = [];
  function visit(node: Root | RootContent) {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  const files = new Set<string>();
  for (const image of images) {
    const source = image.url ?? definitions.get(image.identifier ?? "");
    const file = markdownImageFile(source, attachments, artifacts);
    if (file?.url) files.add(file.url);
  }
  return files;
}
