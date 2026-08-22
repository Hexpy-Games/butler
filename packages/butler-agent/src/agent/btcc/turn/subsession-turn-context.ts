import type { ContextAssembly } from "../../prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";
import type { ButlerExecutionPolicy } from "../contracts.ts";
import {
  normalizeSubsessionAllowedToolsAndEffects,
  normalizeSubsessionMutationScopeForEffects,
} from "../subsessions/scope.ts";

export function isSubsessionBinding(binding: StoredSessionBinding): boolean {
  return Boolean(readSubsessionMetadata(binding.metadata?.subsession));
}

export function readSubsessionMetadata(
  value: unknown,
): NonNullable<ButlerExecutionPolicy["subsession"]> | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("subsession_context_invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (!Object.keys(metadata).length) throw new Error("subsession_context_invalid");
  const relationId = optionalString(metadata.relation_id);
  const delegationId = optionalString(metadata.delegation_id);
  const taskId = optionalString(metadata.task_id);
  // Persisted SS-02/SS-02B bindings predate the explicit mode field. This is
  // the single binding-read compatibility boundary; new writers stay explicit.
  const executionMode = metadata.execution_mode === undefined
      ? "mutation"
      : metadata.execution_mode === "read_only"
      ? "read_only"
      : metadata.execution_mode === "mutation"
        ? "mutation"
        : null;
  const mutationScope = stringArray(metadata.mutation_scope);
  const allowedToolsAndEffects = stringArray(metadata.allowed_tools_and_effects);
  const projectContext = readProjectContext(metadata.project_context);
  if (!relationId || !delegationId || !taskId || !executionMode) {
    throw new Error("subsession_context_invalid");
  }
  const normalizedAllowedToolsAndEffects = normalizeSubsessionAllowedToolsAndEffects(
    allowedToolsAndEffects,
    executionMode,
  );
  return {
    relationId,
    delegationId,
    taskId,
    executionMode,
    mutationScope: executionMode === "mutation"
      ? normalizeSubsessionMutationScopeForEffects(
          mutationScope,
          normalizedAllowedToolsAndEffects,
        )
      : [],
    allowedToolsAndEffects: normalizedAllowedToolsAndEffects,
    ...(projectContext ? { projectContext } : {}),
  };
}

function readProjectContext(value: unknown): NonNullable<
  NonNullable<ButlerExecutionPolicy["subsession"]>["projectContext"]
> | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("subsession_context_invalid");
  }
  const context = value as Record<string, unknown>;
  const projectId = optionalString(context.project_id);
  if (!projectId) throw new Error("subsession_context_invalid");
  return {
    projectId,
    mandatoryHotCacheRefs: stringArray(context.mandatory_hot_cache_refs),
    optionalHotCacheRefs: stringArray(context.optional_hot_cache_refs),
  };
}

export function emptySubsessionContextAssembly(): ContextAssembly {
  return {
    staticContext: [],
    liveConfiguration: [],
    runtimeState: [],
    workingContext: [],
    retrievedContext: [],
    currentInput: [],
    references: [],
    liveConfigHash: "subsession-empty-context",
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("subsession_context_invalid");
  }
  return value.map((item) => item.trim());
}
