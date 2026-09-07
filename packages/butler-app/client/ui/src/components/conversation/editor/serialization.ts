import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, type LexicalNode, type SerializedLexicalNode } from "lexical";
import type { MessageContent, MessageContentPart } from "@/app/messageContent";
import { SessionReferenceNode, $createSessionReferenceNode } from "./SessionReferenceNode";

function appendPart(parts: MessageContentPart[], part: MessageContentPart): void {
  const last = parts.at(-1);
  if (part.type === "text" && last?.type === "text") last.text += part.text;
  else if (part.type !== "text" || part.text) parts.push(part);
}

export function $readComposerContent(): MessageContent {
  const parts: MessageContentPart[] = [];
  function visit(node: LexicalNode) {
    if (node instanceof SessionReferenceNode) appendPart(parts, { type: "session_ref", ...node.reference() });
    else if ($isTextNode(node)) appendPart(parts, { type: "text", text: node.getTextContent() });
    else if ($isLineBreakNode(node)) appendPart(parts, { type: "text", text: "\n" });
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
  }
  $getRoot().getChildren().forEach((node, index) => {
    if (index) appendPart(parts, { type: "text", text: "\n" });
    visit(node);
  });
  return { version: 1, parts };
}

export function $nodesForContent(content: MessageContent): LexicalNode[] {
  return content.parts.flatMap<LexicalNode>(part => {
    if (part.type === "session_ref") return [$createSessionReferenceNode(part.sessionId, part.titleSnapshot)];
    return part.text.split("\n").flatMap((text, index) => [
      ...(index ? [$createLineBreakNode()] : []), ...(text ? [$createTextNode(text)] : []),
    ]);
  });
}

export function $replaceComposerContent(content: MessageContent): void {
  $getRoot().clear().append($createParagraphNode().append(...$nodesForContent(content)));
}

/** Clipboard export already clips text nodes to the selection; discard all formatting. */
export function contentFromSerializedNodes(nodes: SerializedLexicalNode[]): MessageContent {
  const parts: MessageContentPart[] = [];
  function visit(raw: SerializedLexicalNode) {
    const node = raw as SerializedLexicalNode & { text?: string; sessionId?: string; titleSnapshot?: string; children?: SerializedLexicalNode[] };
    if (node.type === "session-reference" && typeof node.sessionId === "string" && typeof node.titleSnapshot === "string")
      appendPart(parts, { type: "session_ref", sessionId: node.sessionId, titleSnapshot: node.titleSnapshot });
    else if (node.type === "text" && typeof node.text === "string") appendPart(parts, { type: "text", text: node.text });
    else if (node.type === "linebreak") appendPart(parts, { type: "text", text: "\n" });
    else node.children?.forEach(visit);
  }
  nodes.forEach((node, index) => { if (index && node.type === "paragraph") appendPart(parts, { type: "text", text: "\n" }); visit(node); });
  return { version: 1, parts };
}
