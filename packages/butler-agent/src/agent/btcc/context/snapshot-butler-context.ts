import type {
  ButlerContextSection,
  ButlerContextSnapshotCommand,
  ContextDocumentWriter,
} from "./contracts.ts";

export function snapshotButlerContext(
  command: ButlerContextSnapshotCommand,
  documents: ContextDocumentWriter,
) {
  const refs = {
    profileRefs: [] as string[],
    recentFeedbackRefs: [] as string[],
    mandatoryHotCacheRefs: [] as string[],
    optionalHotCacheRefs: [] as string[],
  };
  for (const section of command.sections) {
    const projection = projectSection(command, section);
    const ref = documents.persist(projection.document);
    refs[projection.target].push(ref);
  }
  return {
    userRef: command.userRef,
    ...(command.projectRef ? { projectRef: command.projectRef } : {}),
    ...refs,
    baselineObservationScopeRefs: observationScopes(command),
  };
}

function projectSection(
  command: ButlerContextSnapshotCommand,
  section: ButlerContextSection,
) {
  const scope = scopeFor(command, section.scopeKind);
  return {
    target: targetFor(section.projectionClass),
    document: {
      scopeKind: scope.kind,
      scopeId: scope.id,
      projectionClass: section.projectionClass,
      sourceId: section.id,
      sourceRevision: section.sourceRevision,
      content: section.content,
    },
  } as const;
}

function targetFor(projectionClass: ButlerContextSection["projectionClass"]) {
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
  command: ButlerContextSnapshotCommand,
  requested: ButlerContextSection["scopeKind"],
) {
  if (requested === "user") return { kind: "user" as const, id: command.userRef };
  if (requested === "session") return { kind: "session" as const, id: command.sessionId };
  if (!command.projectRef) {
    throw new Error("BTCC project context section requires a project binding");
  }
  return { kind: "project" as const, id: command.projectRef };
}

function observationScopes(command: ButlerContextSnapshotCommand): string[] {
  return [
    `workspace:${command.workspacePath}`,
    "web:current",
    `memory:${command.userRef}`,
    ...(command.projectRef ? [`ledger:${command.projectRef}`] : []),
  ];
}
