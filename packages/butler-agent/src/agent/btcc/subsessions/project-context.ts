import type { ContextDocumentReader } from "../../context/context-projection.ts";
import type { TurnStateRepository } from "../turn/index.ts";
import type {
  DelegationProjectContextRef,
  DelegationProjectContextSnapshot,
  SubsessionDelegationDependencies,
} from "./contracts.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";

const PROJECT_CONTEXT_SOURCES = {
  "project-hot-cache": "mandatory_hot_cache",
  "project-memory": "optional_hot_cache",
} as const;

type ProjectContextSourceId = keyof typeof PROJECT_CONTEXT_SOURCES;

export async function snapshotDelegationProjectContext(input: {
  parentSessionId: string;
  parentTurnId: string;
  projectId?: string;
  turns: Pick<TurnStateRepository, "findTurn">;
  documents: ContextDocumentReader;
}): Promise<DelegationProjectContextSnapshot | undefined> {
  const projectId = input.projectId?.trim();
  if (!projectId) return undefined;
  const parentTurn = await input.turns.findTurn(input.parentTurnId).catch(() => null);
  if (!parentTurn || parentTurn.sessionId !== input.parentSessionId ||
      parentTurn.context.projectRef !== projectId ||
      parentTurn.context.executionPolicy?.projectId !== projectId) {
    return incompleteSnapshot(
      projectId,
      ["project-hot-cache"],
      ["project-hot-cache"],
    );
  }
  const selected = new Map<ProjectContextSourceId, DelegationProjectContextRef>();
  const candidates = [
    ...parentTurn.context.mandatoryHotCacheRefs,
    ...parentTurn.context.optionalHotCacheRefs,
  ];
  for (const contextRef of candidates) {
    try {
      const document = input.documents.read(contextRef);
      if (!isProjectContextSource(document.sourceId) ||
          document.contextRef !== contextRef ||
          document.scopeKind !== "project" ||
          document.scopeId !== projectId ||
          document.projectionClass !== PROJECT_CONTEXT_SOURCES[document.sourceId]) {
        continue;
      }
      selected.set(document.sourceId, {
        context_ref: document.contextRef,
        content_sha256: document.contentSha256,
        source_id: document.sourceId,
        source_revision: document.sourceRevision,
        projection_class: document.projectionClass,
      });
    } catch {
      // Only verified project documents selected below become child authority.
    }
  }

  const requiredSourceIds: ProjectContextSourceId[] = selected.has("project-hot-cache")
    ? ["project-hot-cache"]
    : [];
  const missingSourceIds = requiredSourceIds.filter((sourceId) => !selected.has(sourceId));
  const refs = [...selected.values()];
  return {
    project_id: projectId,
    required_source_ids: requiredSourceIds,
    missing_source_ids: missingSourceIds,
    mandatory_refs: refs.filter((ref) => ref.projection_class === "mandatory_hot_cache"),
    optional_refs: refs.filter((ref) => ref.projection_class === "optional_hot_cache"),
  };
}

export async function snapshotChildProjectContext(input: {
  parentSessionId: string;
  parentTurnId: string;
  parent: Pick<StoredSessionBinding, "projectId" | "appProjectId" | "ledgerProjectId">;
  turns: Pick<TurnStateRepository, "findTurn">;
  documents: ContextDocumentReader;
}): Promise<{
  projectContext: DelegationProjectContextSnapshot | undefined;
  inheritedProject: ReturnType<typeof childProjectContextBinding>;
}> {
  const projectContext = await snapshotDelegationProjectContext({
    ...input,
    projectId: input.parent.appProjectId ?? input.parent.projectId,
  });
  return {
    projectContext,
    inheritedProject: childProjectContextBinding(projectContext, input.parent),
  };
}

export function childProjectContextBinding(
  context: DelegationProjectContextSnapshot | undefined,
  parent: Pick<StoredSessionBinding, "projectId" | "appProjectId" | "ledgerProjectId">,
): {
  sessionBinding: Pick<StoredSessionBinding, "projectId" | "appProjectId" | "ledgerProjectId">;
  metadata: Record<string, unknown>;
} | undefined {
  const appProjectId = parent.appProjectId ?? parent.projectId;
  if (!appProjectId) {
    if (context?.project_id) throw new Error("subsession_project_context_mismatch");
    return undefined;
  }
  if (context?.project_id !== appProjectId) {
    throw new Error("subsession_project_context_mismatch");
  }
  return {
    sessionBinding: {
      projectId: appProjectId,
      appProjectId,
      ...(parent.ledgerProjectId !== undefined
        ? { ledgerProjectId: parent.ledgerProjectId }
        : {}),
    },
    metadata: {
      project_id: appProjectId,
      mandatory_hot_cache_refs: context.mandatory_refs.map((ref) => ref.context_ref),
      optional_hot_cache_refs: context.optional_refs.map((ref) => ref.context_ref),
    },
  };
}

export function assertExactChildLedgerProjectIdentity(
  binding: Pick<StoredSessionBinding, "projectId" | "appProjectId" | "ledgerProjectId">,
): void {
  if ((binding.appProjectId ?? binding.projectId) && binding.ledgerProjectId === undefined) {
    throw new Error("subsession_child_ledger_project_binding_missing");
  }
}

export async function delegationProjectContextReady(
  context: DelegationProjectContextSnapshot | undefined,
  child: { sessionId: string; turnId: string },
  dependencies: Pick<SubsessionDelegationDependencies,
    "sessionBindings" | "parentTurns" | "contextDocuments">,
): Promise<boolean> {
  const binding = dependencies.sessionBindings.getBySessionId(child.sessionId);
  const turn = await dependencies.parentTurns.findTurn(child.turnId).catch(() => null);
  if (!binding || !turn) return false;
  const bindingProject = record(record(binding?.metadata).subsession).project_context;
  if (!context) {
    return !binding.projectId && bindingProject === undefined && !turn.context.projectRef &&
      !turn.context.executionPolicy?.projectId &&
      turn.context.mandatoryHotCacheRefs.length === 0 &&
      turn.context.optionalHotCacheRefs.length === 0;
  }
  const bindingContext = record(bindingProject);
  const mandatoryRefs = context.mandatory_refs.map((ref) => ref.context_ref);
  const optionalRefs = context.optional_refs.map((ref) => ref.context_ref);
  if (binding.projectId !== context.project_id ||
      bindingContext.project_id !== context.project_id ||
      !sameStrings(bindingContext.mandatory_hot_cache_refs, mandatoryRefs) ||
      !sameStrings(bindingContext.optional_hot_cache_refs, optionalRefs) ||
      turn.context.projectRef !== context.project_id ||
      turn.context.executionPolicy?.projectId !== context.project_id ||
      !sameStrings(turn.context.mandatoryHotCacheRefs, mandatoryRefs) ||
      !sameStrings(turn.context.optionalHotCacheRefs, optionalRefs)) return false;
  return [...context.mandatory_refs, ...context.optional_refs].every((ref) => {
    try {
      const document = dependencies.contextDocuments.read(ref.context_ref);
      return document.contextRef === ref.context_ref &&
        document.contentSha256 === ref.content_sha256 &&
        document.sourceId === ref.source_id &&
        document.sourceRevision === ref.source_revision &&
        document.projectionClass === ref.projection_class &&
        document.scopeKind === "project" &&
        document.scopeId === context.project_id;
    } catch {
      return false;
    }
  });
}

function incompleteSnapshot(
  projectId: string,
  requiredSourceIds: readonly string[],
  missingSourceIds: readonly string[],
): DelegationProjectContextSnapshot {
  return {
    project_id: projectId,
    required_source_ids: [...requiredSourceIds],
    missing_source_ids: [...missingSourceIds],
    mandatory_refs: [],
    optional_refs: [],
  };
}

function isProjectContextSource(value: string): value is ProjectContextSourceId {
  return Object.prototype.hasOwnProperty.call(PROJECT_CONTEXT_SOURCES, value);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
