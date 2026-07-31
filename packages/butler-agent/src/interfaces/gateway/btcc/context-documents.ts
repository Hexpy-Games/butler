import type { ButlerContextInput } from "../../../agent/btcc/contracts.ts";
import type {
  ContextProjectionClass,
  ContextScopeKind,
} from "../../../agent/context/context-projection.ts";

export type GatewayContextSection = {
  id: string;
  content: string;
  sourceRevision: string;
  projectionClass: ContextProjectionClass;
  scopeKind: ContextScopeKind;
};

export type GatewayContextSnapshotCommand = {
  userRef: string;
  sessionId: string;
  projectRef?: string;
  workspacePath: string;
  sections: GatewayContextSection[];
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

export function snapshotContextDocuments(
  command: GatewayContextSnapshotCommand,
  documents: ContextDocumentWriter,
): ButlerContextInput {
  const refs = {
    profileRefs: [] as string[],
    recentFeedbackRefs: [] as string[],
    mandatoryHotCacheRefs: [] as string[],
    optionalHotCacheRefs: [] as string[],
  };
  for (const section of command.sections) {
    const scope = scopeFor(command, section.scopeKind);
    refs[targetFor(section.projectionClass)].push(documents.persist({
      scopeKind: scope.kind,
      scopeId: scope.id,
      projectionClass: section.projectionClass,
      sourceId: section.id,
      sourceRevision: section.sourceRevision,
      content: section.content,
    }));
  }
  return {
    userRef: command.userRef,
    ...(command.projectRef ? { projectRef: command.projectRef } : {}),
    ...refs,
    baselineObservationScopeRefs: observationScopes(command),
  };
}

function targetFor(projectionClass: ContextProjectionClass) {
  switch (projectionClass) {
    case "profile":
      return "profileRefs" as const;
    case "recent_feedback":
      return "recentFeedbackRefs" as const;
    case "mandatory_hot_cache":
      return "mandatoryHotCacheRefs" as const;
    case "optional_hot_cache":
      return "optionalHotCacheRefs" as const;
  }
}

function scopeFor(
  command: GatewayContextSnapshotCommand,
  requested: ContextScopeKind,
) {
  if (requested === "user") return { kind: "user" as const, id: command.userRef };
  if (requested === "session") return { kind: "session" as const, id: command.sessionId };
  if (!command.projectRef) {
    throw new Error("BTCC project context section requires a project binding");
  }
  return { kind: "project" as const, id: command.projectRef };
}

function observationScopes(command: GatewayContextSnapshotCommand): string[] {
  return [
    `workspace:${command.workspacePath}`,
    "web:current",
    `memory:${command.userRef}`,
    ...(command.projectRef ? [`ledger:${command.projectRef}`] : []),
  ];
}
