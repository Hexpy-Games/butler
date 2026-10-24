import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";

/** Resolve Markdown links/images, including reference syntax, but never code or plain text. */
export function epicAttachmentReferences(description: string): Set<string> {
  const definitions = new Map<string, string>();
  const references: Array<{ url?: string; identifier?: string }> = [];
  function visit(node: Root | RootContent) {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "link" || node.type === "image" || node.type === "linkReference" || node.type === "imageReference") references.push(node);
    if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(description));
  const files = new Set<string>();
  for (const reference of references) {
    const url = reference.url ?? definitions.get(reference.identifier ?? "");
    if (url && /^attachment:/iu.test(url)) files.add(url.slice("attachment:".length));
  }
  return files;
}
