import type { ButlerContextInput } from "../contracts.ts";
import type {
  ContextProjectionClass,
  ContextScopeKind,
} from "../../context/context-projection.ts";

export type ButlerContextSection = {
  id: string;
  content: string;
  sourceRevision: string;
  projectionClass: ContextProjectionClass;
  scopeKind: ContextScopeKind;
};

export type ButlerContextSnapshotCommand = {
  userRef: string;
  sessionId: string;
  projectRef?: string;
  workspacePath: string;
  sections: ButlerContextSection[];
};

export interface ContextDocumentWriter {
  persist(input: {
    scopeKind: ContextScopeKind;
    scopeId: string;
    projectionClass: ContextProjectionClass;
    sourceId: string;
    sourceRevision: string;
    content: string;
  }): string;
}

export type ButlerContextSnapshot = ButlerContextInput;
