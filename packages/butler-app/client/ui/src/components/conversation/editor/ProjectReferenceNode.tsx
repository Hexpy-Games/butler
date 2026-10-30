import { useAppLocale } from "@/app/copy.ts";
import { $applyNodeReplacement, DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import type { ReactNode } from "react";
import { Briefcase, InlineReference } from "@/butler-ds";
import { useButlerStore } from "@/app/store";

type SerializedReference = SerializedLexicalNode & { projectId: string; titleSnapshot: string };
/** A whole project referenced in the draft; sent as a `project_ref` part. */
export class ProjectReferenceNode extends DecoratorNode<ReactNode> {
  __projectId: string;
  __titleSnapshot: string;
  static getType() { return "project-reference"; }
  static clone(node: ProjectReferenceNode) { return new ProjectReferenceNode(node.__projectId, node.__titleSnapshot, node.__key); }
  constructor(projectId = "", titleSnapshot = "", key?: NodeKey) {
    super(key); this.__projectId = projectId; this.__titleSnapshot = titleSnapshot;
  }
  static importJSON(value: SerializedReference) { return $createProjectReferenceNode(value.projectId, value.titleSnapshot); }
  exportJSON(): SerializedReference { return { ...super.exportJSON(), type: "project-reference", version: 1, projectId: this.__projectId, titleSnapshot: this.__titleSnapshot }; }
  createDOM() { return document.createElement("span"); }
  updateDOM() { return false; }
  isInline() { return true; }
  isKeyboardSelectable() { return true; }
  getTextContent() { return `@${this.__titleSnapshot}`; }
  reference() { const node = this.getLatest(); return { projectId: node.__projectId, titleSnapshot: node.__titleSnapshot }; }
  decorate() { return <ProjectReferenceText {...this.reference()} />; }
}

export function $createProjectReferenceNode(projectId: string, titleSnapshot: string) {
  return $applyNodeReplacement(new ProjectReferenceNode(projectId, titleSnapshot));
}

/** The project chip; a deleted or archived project reads as unavailable. In a sent message it opens the project. */
export function ProjectReferenceText({ projectId, titleSnapshot, interactive = false }: { projectId: string; titleSnapshot: string; interactive?: boolean }) {
  useAppLocale();
  const known = useButlerStore(state => state.navigation.projects.some(project => project.id === projectId && !project.archived));
  const open = useButlerStore(state => state.openProjectDashboard);
  return <InlineReference icon={<Briefcase />} unavailable={!known}
    onClick={interactive && known ? () => open(projectId) : undefined}>{titleSnapshot}</InlineReference>;
}
