import type { OperationAuthority } from "../../core/index.ts";
import type {
  AvailablePhaseCapability,
  ObservationScopeKind,
  ResolveAvailableCapabilitiesInput,
  StructuralCapabilityDefinition,
} from "./contracts.ts";

export async function resolveAvailableCapabilities(
  input: ResolveAvailableCapabilitiesInput,
): Promise<AvailablePhaseCapability[]> {
  const definitions = await input.catalog.list();
  assertUniqueCapabilityRefs(definitions);
  const result: AvailablePhaseCapability[] = [];
  for (const definition of definitions) {
    for (const operationKind of definition.operationKinds) {
      const scopes = admittedObservationScopes(
        definition,
        operationKind,
        input.authority.observationScopeRefs,
      );
      const { operationKinds: _operationKinds, ...capability } = definition;
      if (operationKind === "observe") {
        if (scopes.length > 0) {
          result.push({ ...capability, operationKind, observationScopeRefs: scopes });
        }
        continue;
      }
      if (mutationIsAuthorized(operationKind, input.authority.mutation)) {
        result.push({ ...capability, operationKind, observationScopeRefs: [] });
      }
    }
  }
  return result;
}

function admittedObservationScopes(
  definition: StructuralCapabilityDefinition,
  operationKind: StructuralCapabilityDefinition["operationKinds"][number],
  authorizedScopes: readonly string[],
): string[] {
  if (operationKind !== "observe") return [];
  if (definition.observationScopeRefs !== undefined) {
    const declared = new Set(definition.observationScopeRefs);
    return authorizedScopes.filter((scopeRef) => declared.has(scopeRef));
  }
  if (definition.observationScopeKinds !== undefined) {
    const declared = new Set(definition.observationScopeKinds);
    return authorizedScopes.filter((scopeRef) => {
      const kind = scopeKind(scopeRef);
      return kind !== undefined && declared.has(kind);
    });
  }
  return [];
}

function scopeKind(scopeRef: string): ObservationScopeKind | undefined {
  const separator = scopeRef.indexOf(":");
  const kind = separator > 0 ? scopeRef.slice(0, separator) : "";
  return kind === "workspace" || kind === "web" || kind === "memory" || kind === "ledger"
    ? kind
    : undefined;
}

function mutationIsAuthorized(
  operationKind: StructuralCapabilityDefinition["operationKinds"][number],
  mutation: OperationAuthority["mutation"],
): boolean {
  if (operationKind === "workspace_artifact_action") {
    return mutation.kind === "workspace_only";
  }
  if (operationKind === "review_validation") {
    return mutation.kind === "validation_overlay_only";
  }
  if (operationKind === "repository_promotion") {
    return mutation.kind === "repository_promotion_only";
  }
  return false;
}

function assertUniqueCapabilityRefs(
  definitions: readonly StructuralCapabilityDefinition[],
): void {
  const refs = new Set<string>();
  for (const definition of definitions) {
    if (refs.has(definition.capabilityRef)) {
      throw new Error(`duplicate_structural_capability:${definition.capabilityRef}`);
    }
    refs.add(definition.capabilityRef);
  }
}
