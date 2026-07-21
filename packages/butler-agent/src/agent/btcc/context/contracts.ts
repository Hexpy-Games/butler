import type { ButlerContextInput } from "../contracts.ts";

export type ButlerContextSection = {
  id: string;
  content: string;
  sourceRevision: string;
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
    scopeKind: "project" | "session" | "user";
    scopeId: string;
    projectionClass:
      | "profile"
      | "recent_feedback"
      | "mandatory_hot_cache"
      | "optional_hot_cache";
    sourceId: string;
    sourceRevision: string;
    content: string;
  }): string;
}

export type ButlerContextSnapshot = ButlerContextInput;
