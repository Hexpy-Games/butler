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

export function admitStewardContextAssembly(assembly: ContextAssembly): ContextAssembly {
  const hasDisallowedContext = [
    ...assembly.staticContext,
    ...assembly.runtimeState,
    ...assembly.workingContext,
    ...assembly.retrievedContext,
    ...assembly.currentInput,
  ].length > 0 || assembly.references.length > 0;
  if (hasDisallowedContext || !hasExactEol(assembly) ||
      assembly.liveConfiguration.length !== 1) {
    throw new Error("subsession_context_assembly_invalid");
  }
  return assembly;
}

/** Fail before durable Butler Turn admission unless one exact EOL is present. */
export function admitButlerContextAssembly(assembly: ContextAssembly): ContextAssembly {
  if (!hasExactEol(assembly)) {
    throw new Error("butler_eol_context_assembly_invalid");
  }
  return assembly;
}

function hasExactEol(assembly: ContextAssembly): boolean {
  const sections = [
    ...assembly.staticContext,
    ...assembly.liveConfiguration,
    ...assembly.runtimeState,
    ...assembly.workingContext,
    ...assembly.retrievedContext,
    ...assembly.currentInput,
  ];
  const eol = sections.filter((section) => section.id === "eol");
  return eol.length === 1 && Boolean(eol[0]?.content.trim()) &&
    eol[0]?.region === "live_configuration" &&
    eol[0].projectionClass === "profile" && eol[0].scopeKind === "user";
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
