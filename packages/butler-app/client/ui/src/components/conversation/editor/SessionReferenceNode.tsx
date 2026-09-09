import { $applyNodeReplacement, DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import type { ReactNode } from "react";
import { InlineReference, MessageSquare, Notebook } from "@/butler-ds";
import { useButlerStore } from "@/app/store";

type SerializedReference = SerializedLexicalNode & { sessionId: string; titleSnapshot: string };
export class SessionReferenceNode extends DecoratorNode<ReactNode> {
  __sessionId: string;
  __titleSnapshot: string;
  static getType() { return "session-reference"; }
  static clone(node: SessionReferenceNode) { return new SessionReferenceNode(node.__sessionId, node.__titleSnapshot, node.__key); }
  constructor(sessionId = "", titleSnapshot = "", key?: NodeKey) {
    super(key); this.__sessionId = sessionId; this.__titleSnapshot = titleSnapshot;
  }
  static importJSON(value: SerializedReference) { return $createSessionReferenceNode(value.sessionId, value.titleSnapshot); }
  exportJSON(): SerializedReference { return { ...super.exportJSON(), type: "session-reference", version: 1, sessionId: this.__sessionId, titleSnapshot: this.__titleSnapshot }; }
  createDOM() { return document.createElement("span"); }
  updateDOM() { return false; }
  isInline() { return true; }
  isKeyboardSelectable() { return true; }
  getTextContent() { return `@${this.__titleSnapshot}`; }
  reference() { const node = this.getLatest(); return { sessionId: node.__sessionId, titleSnapshot: node.__titleSnapshot }; }
  decorate() { return <ReferenceLabel {...this.reference()} />; }
}

export function $createSessionReferenceNode(sessionId: string, titleSnapshot: string) {
  return $applyNodeReplacement(new SessionReferenceNode(sessionId, titleSnapshot));
}

function ReferenceLabel({ sessionId, titleSnapshot }: { sessionId: string; titleSnapshot: string }) {
  const node = useButlerStore(state => state.navigation.space.nodes.find(node => node.kind === "session" && node.entityId === sessionId));
  return <InlineReference unavailable={!node && sessionId !== "general"}
    icon={node?.scopeProjectId ? <Notebook /> : <MessageSquare />}>{titleSnapshot}</InlineReference>;
}
