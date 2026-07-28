import type {
  OperationAuthority,
  PhaseContract,
} from "./contracts.ts";

export function phaseOperationAuthority(
  surface: PhaseContract["operationSurface"],
  admitted: OperationAuthority,
  results: Array<{ readScopeRef: string }>,
): OperationAuthority {
  if (surface === "closed") {
    return {
      observationScopeRefs: [],
      mutation: admitted.mutation.kind === "turn_local_effect_only"
        ? admitted.mutation
        : { kind: "forbidden" },
    };
  }
  return {
    ...admitted,
    observationScopeRefs: [
      ...admitted.observationScopeRefs,
      ...results.map((result) => result.readScopeRef),
    ],
  };
}
