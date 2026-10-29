import type { Paragraph, PhrasingContent } from "mdast";
import { $createParagraphNode, $createTextNode, type LexicalNode, type TextFormatType } from "lexical";
import { $createLinkNode } from "@lexical/link";

/** Reuse the parsed tree for supported inline syntax, without a second Markdown parser/container. */
export function importTextPart(part: Paragraph): LexicalNode {
  const node = $createParagraphNode();
  return node.append(...inlineNodes(part.children));
}
function inlineNodes(parts: PhrasingContent[], formats: TextFormatType[] = []): LexicalNode[] {
  return parts.flatMap((part): LexicalNode[] => {
    if (part.type === "text") {
      const node = $createTextNode(part.value);
      new Set(formats).forEach(format => node.toggleFormat(format));
      return [node];
    }
    if (part.type === "strong" || part.type === "emphasis") {
      return inlineNodes(part.children, [...formats, part.type === "strong" ? "bold" : "italic"]);
    }
    if (part.type === "link") return [$createLinkNode(part.url, { title: part.title }).append(...inlineNodes(part.children, formats))];
    throw new Error(`Unsupported inline Markdown: ${part.type}`);
  });
}
