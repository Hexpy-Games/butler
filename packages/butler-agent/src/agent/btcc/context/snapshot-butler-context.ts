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
  const classification = classifySection(section.id);
  const scope = scopeFor(command, classification.scope);
  return {
    target: classification.target,
    document: {
      scopeKind: scope.kind,
      scopeId: scope.id,
      projectionClass: classification.projectionClass,
      sourceId: section.id,
      sourceRevision: section.sourceRevision,
      content: section.content,
    },
  } as const;
}

function classifySection(id: string) {
  switch (id) {
    case "feedback-buffer":
      return classification("recentFeedbackRefs", "recent_feedback", "session");
    case "rules":
    case "hot-cache":
    case "project-hot-cache":
      return classification("mandatoryHotCacheRefs", "mandatory_hot_cache", "structural");
    case "personalization-profile":
    case "profile-projection":
    case "active-persona-reminder":
    case "first-chat-onboarding":
    case "eol":
    case "role":
    case "runtime-system-contract":
      return classification("profileRefs", "profile", "user");
    default:
      return classification("optionalHotCacheRefs", "optional_hot_cache", "structural");
  }
}

function classification(
  target: "profileRefs" | "recentFeedbackRefs" | "mandatoryHotCacheRefs" | "optionalHotCacheRefs",
  projectionClass: "profile" | "recent_feedback" | "mandatory_hot_cache" | "optional_hot_cache",
  scope: "user" | "session" | "structural",
) {
  return { target, projectionClass, scope } as const;
}

function scopeFor(
  command: ButlerContextSnapshotCommand,
  requested: "user" | "session" | "structural",
) {
  if (requested === "user") return { kind: "user" as const, id: command.userRef };
  if (requested === "session") return { kind: "session" as const, id: command.sessionId };
  return command.projectRef
    ? { kind: "project" as const, id: command.projectRef }
    : { kind: "session" as const, id: command.sessionId };
}

function observationScopes(command: ButlerContextSnapshotCommand): string[] {
  return [
    `workspace:${command.workspacePath}`,
    "web:current",
    `memory:${command.userRef}`,
    `ledger:${command.projectRef ?? command.sessionId}`,
  ];
}
