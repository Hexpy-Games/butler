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
      mutation: { kind: "forbidden" },
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
