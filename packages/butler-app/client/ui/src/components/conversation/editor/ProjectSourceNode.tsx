import { $applyNodeReplacement, DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import type { ReactNode } from "react";
import { InlineReference, FileText } from "@/butler-ds";
import { isProjectSourceContentPart, type ProjectSourceContentPart } from "@/app/messageContent.ts";

type SerializedSource = SerializedLexicalNode & { reference: ProjectSourceContentPart };
export class ProjectSourceNode extends DecoratorNode<ReactNode> {
  __reference: ProjectSourceContentPart;
  static getType() { return "project-source-reference"; }
  static clone(node: ProjectSourceNode) { return new ProjectSourceNode(node.__reference, node.__key); }
  constructor(reference: ProjectSourceContentPart, key?: NodeKey) { super(key); this.__reference = structuredClone(reference); }
  static importJSON(value: SerializedSource) {
    if (!isProjectSourceContentPart(value.reference)) throw new Error("Invalid project source reference.");
    return $createProjectSourceNode(value.reference);
  }
  exportJSON(): SerializedSource { return { ...super.exportJSON(), type: "project-source-reference", version: 1, reference: this.reference() }; }
  createDOM() { return document.createElement("span"); }
  updateDOM() { return false; }
  isInline() { return true; }
  isKeyboardSelectable() { return true; }
  getTextContent() { return `@${this.__reference.titleSnapshot}`; }
  reference() { return structuredClone(this.getLatest().__reference); }
  decorate() { return <InlineReference icon={<FileText />}>{this.__reference.titleSnapshot}</InlineReference>; }
}
export function $createProjectSourceNode(reference: ProjectSourceContentPart) {
  return $applyNodeReplacement(new ProjectSourceNode(reference));
}
